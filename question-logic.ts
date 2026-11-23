/**
 * question-logic.ts
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
	firstKeptEntryId?: string;
	message?: {
		role?: string;
		content?: unknown;
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

/** 提取 user/assistant 消息的 text part（content 可能是 string 或 parts 数组）。 */
export function extractUserText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const part of content) {
			if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
				const t = (part as { text?: string }).text;
				if (typeof t === "string") parts.push(t);
			}
		}
		return parts.join("\n");
	}
	return "";
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

/** 从活动上下文条目收集可跳转的用户提问（无文本的消息不渲染组件，排除）。 */
export function collectQuestionsFromEntries(entries: SessionEntryLike[]): QuestionItem[] {
	const out: QuestionItem[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg || msg.role !== "user") continue;
		const text = extractUserText(msg.content);
		// pi 的 getUserMessageText() 为空时不会创建 UserMessageComponent；
		// 只贴图/空消息没有 OSC 标记，列出来也跳不过去。
		if (!text) continue;
		out.push({
			index: out.length,
			text,
			summary: firstLine(text) || "[空白消息]",
		});
	}
	return out;
}

/**
 * 推算「第 target 条可跳转提问」在 transcript OSC 133;A 标记序列中的序号（0 起）。
 * 标记产生规则（均按 UserMessageComponent / AssistantMessageComponent 的 render）：
 *   - user 消息：有文本（会渲染组件）时恰好一个标记；无文本则没有
 *   - assistant 消息：content 无 toolCall part 时一个标记
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
			if (extractUserText(msg.content).length === 0) continue;
			if (questionOrdinal === target) return markerOrdinal;
			questionOrdinal++;
			markerOrdinal++;
			continue;
		}

		if (msg.role === "assistant") {
			if (!hasToolCall(msg.content)) markerOrdinal++;
		}
	}
	return null;
}

function partText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
			const t = (part as { text?: string }).text;
			if (typeof t === "string") parts.push(t);
		}
	}
	return parts.join("\n");
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
			if (extractUserText(msg.content).length === 0) continue;
			if (questionOrdinal === ordinal) {
				const text = extractUserText(msg.content);
				question = {
					index: ordinal,
					text,
					summary: firstLine(text) || "[空白消息]",
				};
			}
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
				node.result = partText(msg.content).trim() || "(空)";
				node.isError = msg.isError === true;
				pendingTools.delete(msg.toolCallId!);
			}
		} else if (msg.role === "bashExecution") {
			nodes.push({
				kind: "tool",
				id: nodes.length,
				name: "!bash",
				args: msg.command ?? "",
				result: (msg.output ?? "").trim() || "(空)",
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
