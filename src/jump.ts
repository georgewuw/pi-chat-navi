/**
 * jump.ts
 *
 * 跳转：把 transcript 滚动到某条用户提问。
 * 本仓库里所有依赖 pi TUI 内部实现的代码都集中在这个文件；pi 升级后跳转失效，只需要查这里。
 * test/contract.test.ts 用真实的 pi 包验证这里的全部假设。
 *
 * pi 未公开暴露 transcript 组件，这里对 TUI 内部布局对象做运行时特征检测：
 *   currentLayout → 含 scrollContentLines 的 box → ScrollView.scrollTo(row)。
 * 首选行定位利用 transcript 的 OSC 133;A 标记（UserMessageComponent 与无工具调用的
 * AssistantMessageComponent 首行都会写入，与内置 previousPrompt/nextPrompt 跳转同源）。
 * 标记法失败时退回文本匹配：遍历 transcript 组件树找 UserMessageComponent，
 * 比较归一化文本 + 渲染首行在文档中的出现序（不再依赖标记规则）。
 */
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { normalizeMatchText } from "./logic.ts";

// ---------------------------------------------------------------------------
// 跳转：运行时特征检测 pi 内部布局（失败优雅降级）
// ---------------------------------------------------------------------------

/** 用户/纯文本 assistant 消息首行的标记（OSC 133;A）。 */
const OSC133_A = /^\x1b\]133;A/;

/** 剥颜色/光标等序列与 OSC 133 区域标记，只用于行内容比较（pi-tui 公开导出）。 */
const stripLineAnsi = stripTerminalSequences;

interface ScrollViewLike {
	scrollTo(row: number, opts?: { disableFollow?: boolean }): void;
	/** ScrollView 的唯一子组件（transcript 文档根） */
	child?: unknown;
	getContentWidth?(width: number): number;
}
interface LayoutBoxLike {
	scrollView?: unknown;
	scrollContentLines?: readonly string[];
	children?: LayoutBoxLike[];
}
interface TuiInternals {
	requestRender?: () => void;
	/** 渲染帧：{ root: 根盒, lines, primaryScrollView? }（getScrollViewBox 同源结构） */
	currentLayout?: ({ primaryScrollView?: unknown; root?: LayoutBoxLike } & LayoutBoxLike) | undefined;
}

/** 在布局树里找到 transcript 的滚动视图与全部内容行。 */
export function findTranscript(tui: TUI): { scrollView: ScrollViewLike; lines: readonly string[] } | null {
	// SAFETY: tui 是 pi 传入的 TuiAltScreen 实例，currentLayout 属性在运行时存在且未被混淆；
	// 此处仅读取布局数据，不触内部方法，字段缺失时逐层判空返回 null。
	const internals = tui as unknown as TuiInternals;
	const layout = internals.currentLayout;
	// 渲染帧形状：{ root: 根盒, lines, primaryScrollView? }，盒子树挂在 root 上
	const rootBox: LayoutBoxLike | undefined = layout?.root ?? layout;
	if (!rootBox) return null;

	const boxes: LayoutBoxLike[] = [];
	const visit = (box: LayoutBoxLike): void => {
		boxes.push(box);
		for (const child of box.children ?? []) visit(child);
	};
	visit(rootBox);

	// transcript = 滚动内容里带 OSC 133;A 标记的 scroll box
	for (const box of boxes) {
		const lines = box.scrollContentLines;
		if (!Array.isArray(lines) || lines.length === 0) continue;
		if (!lines.some((line) => OSC133_A.test(line ?? ""))) continue;

		const scrollView = (box.scrollView ?? layout?.primaryScrollView) as ScrollViewLike | undefined;
		if (!scrollView || typeof scrollView.scrollTo !== "function") return null;
		return { scrollView, lines };
	}
	return null;
}

/** 目标行上方留一行上下文，禁用「跟随最新输出」后刷新。 */
function scrollToRow(tui: TUI, scrollView: ScrollViewLike, row: number): void {
	scrollView.scrollTo(Math.max(0, row - 1), { disableFollow: true });
	// SAFETY: 仅调用公开的 requestRender（可选属性，不存在则跳过）
	(tui as unknown as TuiInternals).requestRender?.();
}

/** 标记行（组件首行，可能是空白内边距）起的第一行非空文字，已剥 ANSI/标记。 */
function firstTextFromRow(lines: readonly string[], row: number): string {
	for (let r = row; r < lines.length; r++) {
		const text = stripLineAnsi(lines[r] ?? "").trim();
		if (text) return text;
	}
	return "";
}

/**
 * 滚动到标记序列中第 ordinal 个标记行。返回是否成功。
 * expectedFirstLine：目标提问的首行摘要。标记行的实际文字与它不符，说明标记序号已错位
 * （pi 改了标记规则），此时不滚动、返回 false，让调用方退回文本匹配，避免静默跳错。
 */
export function jumpToMarker(tui: TUI, ordinal: number, expectedFirstLine?: string): boolean {
	const found = findTranscript(tui);
	if (!found) return false;

	let seen = -1;
	for (let row = 0; row < found.lines.length; row++) {
		if (!OSC133_A.test(found.lines[row] ?? "")) continue;
		seen++;
		if (seen !== ordinal) continue;
		if (expectedFirstLine !== undefined) {
			// 标记行的文字可能被渲染截断，但不会比原文更长：只接受「实际文字是提问首行的前缀」。
			// 反方向（实际文字更长）会放过指向另一条以相同开头的消息的错位序号。
			const actual = normalizeMatchText(firstTextFromRow(found.lines, row));
			const expected = normalizeMatchText(expectedFirstLine);
			if (!actual || !expected.startsWith(actual)) return false;
			// 实际文字很短时前缀没有区分度（"a" 是几乎所有文字的前缀），要求整行相同
			if (actual.length < 8 && actual !== expected) return false;
		}
		scrollToRow(tui, found.scrollView, row);
		return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// 跳转兜底：文本匹配（pi 改动标记规则时仍可用）
// ---------------------------------------------------------------------------

interface TextualComponent {
	text?: unknown;
	rebuild?: unknown;
	child?: unknown;
	children?: unknown[];
	render?(width: number): string[];
}

/** UserMessageComponent 的特征：原始 text + rebuild() + render()。 */
function isUserMessageComponent(c: TextualComponent): boolean {
	return typeof c.text === "string" && typeof c.rebuild === "function" && typeof c.render === "function";
}

interface DocIndex {
	users: TextualComponent[];
	/** 每个 UserMessageComponent 在文档行里的起始偏移（按各组件 render 的行数累加） */
	offsets: Map<unknown, number>;
}

/**
 * 遍历组件树，按渲染顺序累加每个组件的行数，记录每个 UserMessageComponent 的起始行偏移。
 * 定位不依赖字符串匹配：即使 assistant 回复与提问首行相同、或中间有 Spacer/DynamicBorder，偏移也是对的。
 * 前提：容器（有 children 数组）占的行数等于其 children 占行数之和；叶子组件占 render().length 行。
 */
function indexDocument(root: unknown, width: number): DocIndex {
	const users: TextualComponent[] = [];
	const offsets = new Map<unknown, number>();
	const seen = new Set<unknown>();
	let offset = 0;
	const visit = (node: unknown): void => {
		if (!node || typeof node !== "object" || seen.has(node)) return;
		seen.add(node);
		const c = node as TextualComponent;
		if (isUserMessageComponent(c)) {
			users.push(c);
			offsets.set(node, offset);
			offset += (c.render?.(width) ?? []).length;
			return;
		}
		if (Array.isArray(c.children)) {
			for (const child of c.children) visit(child);
			return;
		}
		offset += (c.render?.(width) ?? []).length;
	};
	visit(root);
	return { users, offsets };
}

/**
 * 文本匹配兜底：在 transcript 组件树里找第 occurrence 个文本相同的 UserMessageComponent，
 * 再按它在文档里的渲染偏移定位行号。
 *
 * 用组件树偏移而非字符串匹配：`found.lines` 含所有组件（含 assistant 回复）的行，
 * 同一首行字符串可能出现在 assistant 回复中；按渲染顺序累加各组件行数得到的偏移不会误配。
 * occurrence = 目标提问之前、文本归一化后相同的提问数量（由调用方按 collectQuestions 计算）。
 */
export function jumpToQuestionText(tui: TUI, questionText: string, occurrence: number): boolean {
	const found = findTranscript(tui);
	if (!found) return false;
	const scrollView = found.scrollView;
	const doc = scrollView.child;
	if (!doc) return false;

	const columns = tui.terminal?.columns ?? 80;
	const width = Math.max(1, scrollView.getContentWidth?.(columns) ?? columns);
	const { users, offsets } = indexDocument(doc, width);

	const targetNorm = normalizeMatchText(questionText);
	const target = users.filter((c) => normalizeMatchText(c.text as string) === targetNorm)[occurrence];
	if (!target) return false;

	const start = offsets.get(target);
	if (start === undefined) return false;

	const targetLines = (target.render?.(width) ?? []).map(stripLineAnsi);
	const firstNonEmpty = targetLines.findIndex((l) => l.trim().length > 0);
	if (firstNonEmpty < 0) return false;

	const row = start + firstNonEmpty;
	if (row >= found.lines.length) return false;
	scrollToRow(tui, scrollView, row);
	return true;
}

// ---------------------------------------------------------------------------
// 统一入口：标记法优先，失败退回文本匹配
// ---------------------------------------------------------------------------

export interface JumpTarget {
	/** 目标提问在 OSC 133;A 标记序列中的序号；无法推算时为 null（直接走文本匹配） */
	markerOrdinal: number | null;
	/** 完整提问文本 */
	text: string;
	/** 首行摘要，用于校验标记法的落点 */
	summary: string;
	/** 目标之前归一化文本相同的提问数量 */
	occurrence: number;
}

/** 滚动到目标提问。返回是否成功；失败时调用方负责提示用户。 */
export function jumpToQuestion(tui: TUI, target: JumpTarget): boolean {
	if (target.markerOrdinal !== null && jumpToMarker(tui, target.markerOrdinal, target.summary)) return true;
	// 标记法失效或落点与提问不符（例如 pi 调整了 OSC 133;A 规则）→ 文本匹配兜底
	return jumpToQuestionText(tui, target.text, target.occurrence);
}
