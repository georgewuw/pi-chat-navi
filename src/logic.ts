/**
 * logic.ts
 *
 * 纯数据逻辑：会话条目 → 提问列表 / OSC 133;A 标记序号 / 回合分析数据。
 * 该文件没有任何运行时 import（只用局部类型），因此可以被 node:test 直接加载测试。
 *
 * 关键前提：pi 的 transcript 只渲染 `sessionManager.buildContextEntries()` 的结果
 * （压缩后旧消息不在屏幕上）。因此「提问列表」和「标记序号」必须基于同一份活动上下文，
 * 否则压缩后序号会整体偏移，跳转会静默落到错误位置。
 */

export interface SessionEntryLike {
	type?: string;
	id?: string;
	/** 压缩条目的保留起点 */
	firstKeptEntryId?: string;
	/** 压缩条目的摘要文本（logic.ts 不读，但条目里确实存在） */
	summary?: string;
	message?: {
		role?: string;
		content?: unknown;
		stopReason?: string;
		timestamp?: number;
		toolCallId?: string;
		isError?: boolean;
		command?: string;
		output?: string;
		exitCode?: number;
	};
}

export interface QuestionItem {
	/** 活动上下文中的提问序号（第几条可跳转的用户提问，从 0 开始） */
	index: number;
	/** 会话条目 id；压缩/追加后据此在新列表里找回同一条提问 */
	entryId?: string;
	/** 完整提问文本（用于文本匹配兜底跳转） */
	text: string;
	/** 首行摘要 */
	summary: string;
}

export type TurnNode =
	| { kind: "thinking"; id: number; text: string }
	| { kind: "text"; id: number; text: string; isFinal: boolean }
	| {
			kind: "tool";
			id: number;
			name: string;
			args: unknown;
			result: string | null;
			isError: boolean;
	  };

export interface TurnData {
	question: QuestionItem;
	/** 思考→工具→…→输出 的线性节点链 */
	nodes: TurnNode[];
}

/** 提取 content 里的 text part（content 可能是 string 或 parts 数组），按 separator 拼接。 */
function joinTextParts(content: unknown, separator: string): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
			const t = (part as { text?: string }).text;
			if (typeof t === "string") parts.push(t);
		}
	}
	return parts.join(separator);
}

/** 用户消息文本。镜像 pi 的 getUserMessageText：多段 text 直接拼接（不加分隔符）。 */
export function extractUserText(content: unknown): string {
	return joinTextParts(content, "");
}

/** 镜像 pi 的 parseSkillBlock：skill 调用消息 `<skill name=".." location="..">\n..\n</skill>[\n\n用户附加文本]`。 */
const SKILL_BLOCK = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/**
 * 用户消息在 transcript 里由 UserMessageComponent 渲染的文本；空串表示没有该组件（也就没有 OSC 标记）。
 *   - 普通消息：全部 text part 的拼接
 *   - skill 调用：pi 渲染 SkillInvocationMessageComponent（不写标记）+ 仅当有附加文本时的 UserMessageComponent，
 *     所以只取附加文本；skill-only 消息返回空串
 */
export function renderedUserText(content: unknown): string {
	const text = extractUserText(content);
	if (!text) return "";
	const skill = SKILL_BLOCK.exec(text);
	if (!skill) return text;
	return skill[4]?.trim() ?? "";
}

export function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (t) return t;
	}
	return "";
}

/** 用于文本匹配的归一化：NFKC + 小写 + 空白压缩。 */
export function normalizeMatchText(text: string): string {
	return text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function hasToolCall(content: unknown): boolean {
	const parts = Array.isArray(content) ? content : [];
	return parts.some((p) => p && typeof p === "object" && (p as { type?: string }).type === "toolCall");
}

/**
 * assistant 消息是否会写 OSC 133;A 标记。镜像 pi AssistantMessageComponent：
 *   - 含 toolCall：不写标记
 *   - 否则只有渲染出至少一行才写（组件首行带标记；0 行时直接返回）
 *   - 会渲染的内容：非空白 text、非空白 thinking，或 aborted/error 的错误提示行
 * 内容为空/纯空白的消息不渲染，也就没有标记（此前误算一个，会让之后所有序号偏移）。
 */
function assistantWritesMarker(msg: { content?: unknown; stopReason?: string }): boolean {
	if (hasToolCall(msg.content)) return false;
	if (msg.stopReason === "aborted" || msg.stopReason === "error" || msg.stopReason === "length") return true;
	const parts = Array.isArray(msg.content) ? msg.content : [];
	return parts.some((p) => {
		if (!p || typeof p !== "object") return false;
		const part = p as { type?: string; text?: unknown; thinking?: unknown };
		if (part.type === "text") return typeof part.text === "string" && part.text.trim().length > 0;
		if (part.type === "thinking") return typeof part.thinking === "string" && part.thinking.trim().length > 0;
		return false;
	});
}

/**
 * 活动上下文条目的兜底实现（当 sessionManager.buildContextEntries() 不可用时）。
 * 与 pi `buildContextEntries()` 语义一致：最新 compaction + firstKeptEntryId 起的保留区间
 * （跳过 system 消息）+ compaction 之后的条目。
 */
export function activeContextEntries(branch: SessionEntryLike[]): SessionEntryLike[] {
	let compactionIndex = -1;
	for (let i = 0; i < branch.length; i++) {
		if (branch[i]?.type === "compaction") compactionIndex = i;
	}
	if (compactionIndex < 0) return branch;

	const compaction = branch[compactionIndex]!;
	const keptIndex = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	const out: SessionEntryLike[] = [compaction];
	if (keptIndex >= 0 && keptIndex < compactionIndex) {
		for (const entry of branch.slice(keptIndex, compactionIndex)) {
			if (entry.type === "message" && entry.message?.role === "system") continue;
			out.push(entry);
		}
	}
	out.push(...branch.slice(compactionIndex + 1));
	return out;
}

/** 工具结果文本：多段 text 按行拼接（仅用于回合分析展示，与 pi 的标记规则无关）。 */
function toolResultText(content: unknown): string {
	return joinTextParts(content, "\n");
}

/** 由用户消息条目构造提问项；该消息不渲染 UserMessageComponent（无标记）时返回 null。 */
function questionFromEntry(entry: SessionEntryLike, index: number): QuestionItem | null {
	const text = renderedUserText(entry.message?.content);
	if (!text) return null;
	return {
		index,
		...(entry.id ? { entryId: entry.id } : {}),
		text,
		summary: firstLine(text) || "[empty message]",
	};
}

/** 从活动上下文条目收集可跳转的用户提问（不渲染 UserMessageComponent 的消息没有标记，排除）。 */
export function collectQuestionsFromEntries(entries: SessionEntryLike[]): QuestionItem[] {
	const out: QuestionItem[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const question = questionFromEntry(entry, out.length);
		if (question) out.push(question);
	}
	return out;
}

/** 目标之前、归一化文本相同的提问数量（文本匹配兜底用）。 */
export function occurrenceOf(questions: readonly { text: string }[], index: number): number {
	const normalized = normalizeMatchText(questions[index]!.text);
	return questions.slice(0, index).filter((q) => normalizeMatchText(q.text) === normalized).length;
}

/**
 * 面板打开时的提问列表（snapshot）里第 index 条，在当前列表（current）里的下标；找不到返回 -1。
 * 面板开着时 agent 可能继续输出或发生压缩，序号会变。
 *   - 有会话条目 id：按 id 精确找回；id 不在当前列表里说明它已被压缩掉，返回 -1，不去猜同文本的另一条
 *   - 没有 id（旧版 pi 兜底）：按文本匹配。压缩只会删掉靠前的条目，所以保持「它之后还有几条同文本」不变，
 *     由此从后往前定位，避免重复提问时 nth 超出当前数量
 */
export function remapQuestionIndex(
	snapshot: readonly QuestionItem[],
	index: number,
	current: readonly QuestionItem[],
): number {
	const item = snapshot[index];
	if (!item) return -1;
	if (item.entryId) return current.findIndex((q) => q.entryId === item.entryId);
	// 纯追加（快照是当前列表的前缀）：下标不变
	const sameTextAt = (a: QuestionItem | undefined, b: QuestionItem) =>
		a !== undefined && normalizeMatchText(a.text) === normalizeMatchText(b.text);
	if (snapshot.every((q, i) => sameTextAt(current[i], q))) return index;

	const target = normalizeMatchText(item.text);
	const same: number[] = [];
	current.forEach((q, i) => {
		if (normalizeMatchText(q.text) === target) same.push(i);
	});
	if (same.length === 0) return -1;
	// 压缩删掉靠前的重复项：从后往前数的位置保持不变，所以取「快照里它之后还有几条同文本」对应的位置
	const laterInSnapshot = snapshot.slice(index + 1).filter((q) => normalizeMatchText(q.text) === target).length;
	const fromEnd = same.length - 1 - laterInSnapshot;
	// 此前的同文本项都已被压缩掉：这条提问也已不在活动上下文里
	return fromEnd < 0 ? -1 : same[fromEnd]!;
}

/**
 * 推算「第 target 条可跳转提问」在 transcript OSC 133;A 标记序列中的序号（0 起）。
 * 标记产生规则（均按 UserMessageComponent / AssistantMessageComponent 的 render）：
 *   - user 消息：有文本（会渲染组件）时恰好一个标记；无文本则没有
 *   - assistant 消息：见 assistantWritesMarker（无 toolCall 且会渲染出内容时一个标记）
 *   - 其他 role（toolResult/custom/bashExecution/…）：不产生标记
 */
export function markerOrdinalFromEntries(entries: SessionEntryLike[], target: number): number | null {
	if (target < 0) return null;
	let markerOrdinal = 0;
	let questionOrdinal = 0;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg) continue;

		if (msg.role === "user") {
			if (!questionFromEntry(entry, 0)) continue;
			if (questionOrdinal === target) return markerOrdinal;
			questionOrdinal++;
			markerOrdinal++;
			continue;
		}

		if (msg.role === "assistant") {
			if (assistantWritesMarker(msg)) markerOrdinal++;
		}
	}
	return null;
}

/** 构建第 ordinal 条提问（0 起）的回合分析数据。找不到提问时返回 null。 */
export function buildTurnFromEntries(entries: SessionEntryLike[], ordinal: number): TurnData | null {
	let questionOrdinal = 0;
	let question: QuestionItem | null = null;
	const nodes: TurnNode[] = [];
	const pendingTools = new Map<string, TurnNode & { kind: "tool" }>();

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg) continue;

		// 到达下一条用户消息：回合结束
		if (msg.role === "user") {
			if (question) break;
			const candidate = questionFromEntry(entry, ordinal);
			if (!candidate) continue;
			if (questionOrdinal === ordinal) question = candidate;
			questionOrdinal++;
			continue;
		}
		if (!question) continue;

		if (msg.role === "assistant") {
			const parts = Array.isArray(msg.content) ? msg.content : [];
			for (const part of parts) {
				const p = part as { type?: string };
				if (p.type === "thinking") {
					const t = (part as { thinking?: string }).thinking ?? "";
					nodes.push({ kind: "thinking", id: nodes.length, text: t });
				} else if (p.type === "toolCall") {
					const tc = part as { id?: string; name?: string; arguments?: unknown };
					const node: TurnNode & { kind: "tool" } = {
						kind: "tool",
						id: nodes.length,
						name: tc.name ?? "(unknown)",
						args: tc.arguments,
						result: null,
						isError: false,
					};
					nodes.push(node);
					if (tc.id) pendingTools.set(tc.id, node);
				} else if (p.type === "text") {
					const t = ((part as { text?: string }).text ?? "").trim();
					if (t) nodes.push({ kind: "text", id: nodes.length, text: t, isFinal: false });
				}
			}
		} else if (msg.role === "toolResult") {
			const node = msg.toolCallId ? pendingTools.get(msg.toolCallId) : undefined;
			if (node) {
				node.result = toolResultText(msg.content).trim() || "(empty)";
				node.isError = msg.isError === true;
				pendingTools.delete(msg.toolCallId!);
			}
		} else if (msg.role === "bashExecution") {
			nodes.push({
				kind: "tool",
				id: nodes.length,
				name: "!bash",
				args: msg.command ?? "",
				result: (msg.output ?? "").trim() || "(empty)",
				isError: msg.exitCode !== undefined && msg.exitCode !== 0,
			});
		}
	}

	if (!question) return null;
	// 回合内最后一个文本节点标记为「输出」
	for (let i = nodes.length - 1; i >= 0; i--) {
		if (nodes[i].kind === "text") {
			(nodes[i] as { isFinal: boolean }).isFinal = true;
			break;
		}
	}
	return { question, nodes };
}
