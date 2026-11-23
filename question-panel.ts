/**
 * question-panel.ts
 *
 * `/questions [宽度]` — 打开/关闭「用户提问列表」浮动面板（停靠右上角）：
 *   - 列出当前 transcript 中可见的用户提问（序号 + 摘要；压缩感知）
 *   - 鼠标点击条目 → transcript 滚动到该提问处；回合分析详情区可用滚轮滚动
 *   - 键盘：↑↓ 选择、回车跳转（作用于当前高亮项，鼠标悬停优先）、Esc 关闭
 *   - 鼠标悬停只做高亮预览：↑↓ 会清除悬停，保证回车目标与看到的高亮一致
 *   - 宽度：默认 60%；/questions 50（列数）或 /questions 60%（百分比）调整，会话内记忆；
 *     面板打开时带参数会以新宽度重开
 *
 * 实现说明：
 *   - 面板本体走公开 API：ctx.ui.custom(overlay) + Component.handleMouse（pi-tui）。
 *   - 数据：pi 的 transcript 只渲染 sessionManager.buildContextEntries()（压缩后的活动上下文），
 *     因此列表与标记序号都基于它（不可用时本地按 compaction 规则兜底），否则压缩后序号会漂移。
 *     无可渲染文本的用户消息（纯图片/空消息）不会产生组件与 OSC 标记，直接排除。
 *   - 跳转：pi 未公开暴露 transcript 组件，这里对 TUI 内部布局对象做运行时特征检测：
 *     currentLayout → 含 scrollContentLines 的 box → ScrollView.scrollTo(row)。
 *     首选行定位利用 transcript 的 OSC 133;A 标记（UserMessageComponent 与无工具调用的
 *     AssistantMessageComponent 首行都会写入，与内置 previousPrompt/nextPrompt 跳转同源）。
 *     标记法失败时退回文本匹配：遍历 transcript 组件树找 UserMessageComponent，
 *     比较归一化文本 + 渲染首行在文档中的出现序（不再依赖标记规则）。
 */
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	type Component,
	SizeValue,
	TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	activeContextEntries,
	buildTurnFromEntries,
	collectQuestionsFromEntries,
	firstLine,
	markerOrdinalFromEntries,
	normalizeMatchText,
	type QuestionItem,
	type SessionEntryLike,
	type TurnData,
	type TurnNode,
} from "./question-logic";

// 对外保持原有导出（类型从 question-logic 重导出）
export type { QuestionItem, TurnData, TurnNode } from "./question-logic";

// ---------------------------------------------------------------------------
// 数据：活动上下文（压缩感知）→ 提问列表 / 标记序号 / 回合分析
// ---------------------------------------------------------------------------

/**
 * 当前 transcript 实际渲染的条目。
 * pi 只渲染 buildContextEntries() 的结果；被压缩掉的旧消息不在屏幕上，
 * 若仍按 getBranch() 统计，序号会从压缩点开始整体偏移（跳错位置）。
 */
function activeEntries(ctx: ExtensionCommandContext): SessionEntryLike[] {
	try {
		const entries = ctx.sessionManager.buildContextEntries();
		if (Array.isArray(entries)) return entries as SessionEntryLike[];
	} catch {
		// 旧版 pi / 异常状态：退回当前分支 + 本地压缩过滤
	}
	return activeContextEntries(ctx.sessionManager.getBranch() as SessionEntryLike[]);
}

export function collectQuestions(ctx: ExtensionCommandContext): QuestionItem[] {
	return collectQuestionsFromEntries(activeEntries(ctx));
}

/**
 * 推算「第 target 条可跳转提问」在 transcript OSC 133;A 标记序列中的序号（0 起）。
 * 标记产生规则（UserMessageComponent / AssistantMessageComponent）：
 *   - user 消息：有文本（会渲染组件）时恰好一个标记；无文本则没有
 *   - assistant 消息：content 无 toolCall part（即纯文本回复）时一个标记
 *   - 其他 role（toolResult/custom/bashExecution/…）：不产生标记
 */
export function markerOrdinalForQuestion(ctx: ExtensionCommandContext, target: number): number | null {
	return markerOrdinalFromEntries(activeEntries(ctx), target);
}

/** 构建第 ordinal 条提问（0 起）的回合分析数据。找不到提问时返回 null。 */
export function buildTurn(ctx: ExtensionCommandContext, ordinal: number): TurnData | null {
	return buildTurnFromEntries(activeEntries(ctx), ordinal);
}

/** 工具参数摘要（单行、限宽） */
function briefArgs(v: unknown, max = 36): string {
	let s: string;
	try {
		s = typeof v === "string" ? v : (JSON.stringify(v) ?? "null");
	} catch {
		s = String(v);
	}
	s = s.replace(/\s+/g, " ").trim();
	return s ? truncateToWidth(s, max, "…") : "{}";
}

// ---------------------------------------------------------------------------
// 跳转：运行时特征检测 pi 内部布局（失败优雅降级）
// ---------------------------------------------------------------------------

/** 用户/纯文本 assistant 消息首行的标记（OSC 133;A）。 */
const OSC133_A = /^\x1b\]133;A/;

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

/** 滚动到标记序列中第 ordinal 个标记行。返回是否成功。 */
export function jumpToMarker(tui: TUI, ordinal: number): boolean {
	const found = findTranscript(tui);
	if (!found) return false;

	let seen = -1;
	for (let row = 0; row < found.lines.length; row++) {
		if (!OSC133_A.test(found.lines[row] ?? "")) continue;
		seen++;
		if (seen === ordinal) {
			// 目标行上方留一行上下文
			found.scrollView.scrollTo(Math.max(0, row - 1), { disableFollow: true });
			// SAFETY: 仅调用公开的 requestRender（可选属性，不存在则跳过）
			(tui as unknown as TuiInternals).requestRender?.();
			return true;
		}
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

/** 递归遍历组件树（children + 单 child），带环检测。 */
function walkComponents(root: unknown, out: TextualComponent[] = [], seen = new Set<unknown>()): TextualComponent[] {
	if (!root || typeof root !== "object" || seen.has(root)) return out;
	seen.add(root);
	const component = root as TextualComponent;
	out.push(component);
	if (Array.isArray(component.children)) {
		for (const child of component.children) walkComponents(child, out, seen);
	}
	if (component.child && component.child !== root) walkComponents(component.child, out, seen);
	return out;
}

/** UserMessageComponent 的特征：原始 text + rebuild() + render()。 */
function isUserMessageComponent(c: TextualComponent): boolean {
	return typeof c.text === "string" && typeof c.rebuild === "function" && typeof c.render === "function";
}

const CSI_SEQ = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC133_SEQ = /\x1b\]133;[ABC](?:\x07|\x1b\\)/g;

/** 剥颜色/光标等序列、以及 OSC 133 区域标记，只用于行内容比较。 */
function stripLineAnsi(line: string): string {
	return line.replace(CSI_SEQ, "").replace(OSC133_SEQ, "");
}

/**
 * 文本匹配兜底：在 transcript 组件树里找第 occurrence 个文本相同的 UserMessageComponent，
 * 再用它渲染后的首行在文档中的出现序定位行号。
 *
 * occurrence = 目标提问之前、文本归一化后相同的提问数量（由调用方按 collectQuestions 计算）。
 */
export function jumpToQuestionText(tui: TUI, questionText: string, occurrence: number): boolean {
	const found = findTranscript(tui);
	if (!found) return false;
	const scrollView = found.scrollView;
	const doc = scrollView.child;
	if (!doc) return false;

	const users = walkComponents(doc).filter(isUserMessageComponent);
	const targetNorm = normalizeMatchText(questionText);
	const matches = users.filter((c) => normalizeMatchText(c.text as string) === targetNorm);
	const target = matches[occurrence];
	if (!target) return false;

	const columns = tui.terminal?.columns ?? 80;
	const width = Math.max(1, scrollView.getContentWidth?.(columns) ?? columns);
	const anchor = (target.render?.(width) ?? [])
		.map(stripLineAnsi)
		.find((line) => line.trim().length > 0);
	if (!anchor) return false;

	// 同一条首行可能重复，统计目标之前所有用户组件中该行的总出现次数
	const countAnchor = (lines: readonly string[]): number =>
		lines.reduce((count, line) => count + (stripLineAnsi(line) === anchor ? 1 : 0), 0);
	let sameBefore = 0;
	for (const component of users) {
		if (component === target) break;
		sameBefore += countAnchor(component.render?.(width) ?? []);
	}

	let seen = 0;
	for (let row = 0; row < found.lines.length; row++) {
		if (stripLineAnsi(found.lines[row] ?? "") !== anchor) continue;
		if (seen++ !== sameBefore) continue;
		// 目标行上方留一行上下文
		scrollView.scrollTo(Math.max(0, row - 1), { disableFollow: true });
		(tui as unknown as TuiInternals).requestRender?.();
		return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// 面板组件
// ---------------------------------------------------------------------------

const MAX_VISIBLE_ROWS = 18;
/** 回合分析：树可视行数 / 详情区行数 */
const TREE_VISIBLE_ROWS = 8;
const DETAIL_ROWS = 10;

export class QuestionPanelComponent implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly items: QuestionItem[];
	private readonly jump: (index: number) => void;
	private readonly onClose: () => void;

	private readonly turnLoader: (ordinal: number) => TurnData | null;

	private selected = 0;
	/** 鼠标悬停的条目序号；null 表示无 */
	private hover: number | null = null;
	/** 列表滚动偏移（条目数） */
	private offset = 0;
	private version = 0;

	// 回合分析视图状态
	private view: "list" | "turn" = "list";
	private turn: TurnData | null = null;
	/** 仅显示思维链 */
	private chainOnly = false;
	/** 选中节点在 visibleNodes 中的序号 */
	private nodeSel = 0;
	private treeOffset = 0;
	private detailOffset = 0;
	private hoverNode: number | null = null;

	// render 时记录的命中区域
	private itemYs: number[] = [];
	private nodeYs: number[] = [];
	/** 详情内容行范围（含端点） */
	private detailTop = -1;
	private detailBottom = -1;
	/** Markdown 组件缓存（输出节点详情） */
	private mdCache: { key: string; theme: unknown; md: Markdown } | null = null;

	// 渲染缓存
	private cachedLines: string[] = [];
	private cachedWidth = 0;
	private cachedVersion = -1;

	constructor(
		tui: TUI,
		theme: Theme,
		items: QuestionItem[],
		jump: (index: number) => void,
		turnLoader: (ordinal: number) => TurnData | null,
		onClose: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.items = items;
		this.jump = jump;
		this.turnLoader = turnLoader;
		this.onClose = onClose;
		this.selected = items.length - 1;
		this.itemYs = new Array(items.length).fill(-1);
	}

	close(): void {
		this.onClose();
	}

	invalidate(): void {
		this.cachedWidth = 0;
		this.mdCache = null;
	}

	private bump(): void {
		this.version++;
		this.tui.requestRender();
	}

	private visibleCount(): number {
		return Math.min(this.items.length, MAX_VISIBLE_ROWS);
	}

	private maxOffset(): number {
		return Math.max(0, this.items.length - this.visibleCount());
	}

	private ensureSelectedVisible(): void {
		if (this.selected < this.offset) this.offset = this.selected;
		const last = this.offset + this.visibleCount() - 1;
		if (this.selected > last) this.offset = this.selected - this.visibleCount() + 1;
	}

	private jumpTo(index: number): void {
		this.selected = index;
		this.jump(index);
	}

	/** 当前树视图可见节点（chainOnly 时仅思考） */
	private visibleNodes(): TurnNode[] {
		if (!this.turn) return [];
		return this.chainOnly ? this.turn.nodes.filter((n) => n.kind === "thinking") : this.turn.nodes;
	}

	private ensureNodeVisible(): void {
		const total = this.visibleNodes().length;
		const view = Math.min(total, TREE_VISIBLE_ROWS);
		if (this.nodeSel < this.treeOffset) this.treeOffset = this.nodeSel;
		if (this.nodeSel > this.treeOffset + view - 1) this.treeOffset = this.nodeSel - view + 1;
		this.treeOffset = Math.max(0, Math.min(Math.max(0, total - view), this.treeOffset));
	}

	private selectNode(pos: number): void {
		const total = this.visibleNodes().length;
		if (total === 0) return;
		this.nodeSel = Math.max(0, Math.min(total - 1, pos));
		this.detailOffset = 0;
		this.ensureNodeVisible();
		this.bump();
	}

	/** 列表双击/d：进入该提问的回合分析 */
	private enterTurn(index: number): void {
		const turn = this.turnLoader(this.items[index]!.index);
		if (!turn) return;
		this.selected = index;
		this.turn = turn;
		this.view = "turn";
		this.chainOnly = false;
		this.nodeSel = 0;
		this.treeOffset = 0;
		this.detailOffset = 0;
		this.hover = null;
		this.hoverNode = null;
		this.bump();
	}

	private backToList(): void {
		this.view = "list";
		this.turn = null;
		this.mdCache = null;
		this.hover = null;
		this.hoverNode = null;
		this.bump();
	}

	handleInput(data: string): boolean {
		if (this.view === "turn") {
			if (matchesKey(data, "escape") || matchesKey(data, "left")) {
				this.backToList();
				return true;
			}
			if (matchesKey(data, "up")) {
				// 键盘导航时清除鼠标悬停，否则悬停项会盖住键盘选中项（看起来像没反应）
				this.hoverNode = null;
				this.selectNode(this.nodeSel - 1);
				return true;
			}
			if (matchesKey(data, "down")) {
				this.hoverNode = null;
				this.selectNode(this.nodeSel + 1);
				return true;
			}
			if (data === "t" || data === "T") {
				this.chainOnly = !this.chainOnly;
				this.nodeSel = 0;
				this.treeOffset = 0;
				this.detailOffset = 0;
				this.bump();
				return true;
			}
			if (matchesKey(data, "return")) {
				// 回车：定位到该提问在 transcript 的位置
				this.jump(this.turn!.question.index);
				return true;
			}
			return true;
		}

		// 列表视图
		if (matchesKey(data, "escape")) {
			this.close();
			return true;
		}
		if (matchesKey(data, "up")) {
			// 键盘导航时清除鼠标悬停，否则悬停项会盖住键盘选中项（看起来像没反应）
			this.hover = null;
			if (this.selected > 0) {
				this.selected--;
				this.ensureSelectedVisible();
				this.bump();
			}
			return true;
		}
		if (matchesKey(data, "down")) {
			this.hover = null;
			if (this.selected < this.items.length - 1) {
				this.selected++;
				this.ensureSelectedVisible();
				this.bump();
			}
			return true;
		}
		if (matchesKey(data, "return") || data === " ") {
			// 回车/空格：与点击一致，作用于当前高亮项（悬停优先于键盘选中）
			this.jumpTo(this.hover !== null ? this.hover : this.selected);
			return true;
		}
		if (data === "d" || data === "D" || matchesKey(data, "right")) {
			this.enterTurn(this.selected);
			return true;
		}
		return true;
	}

	private nodeAt(y: number): number {
		for (let i = 0; i < this.nodeYs.length; i++) {
			if (this.nodeYs[i] === y) return i;
		}
		return -1;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "move") {
			if (this.view === "turn") {
				const pos = this.nodeAt(event.y);
				const next = pos >= 0 ? pos : null;
				if (next !== this.hoverNode) {
					this.hoverNode = next;
					this.bump();
				}
				return { handled: true, render: false };
			}
			const pos = this.itemAt(event.y);
			const next = pos >= 0 ? pos : null;
			if (next !== this.hover) {
				this.hover = next;
				this.bump();
			}
			return { handled: true, render: false };
		}

		if (event.type === "wheel" && this.view === "turn") {
			// 仅保留回合分析详情区的滚轮滚动（列表与节点树不响应滚轮）
			if (event.y >= this.detailTop && event.y <= this.detailBottom) {
				const step = Math.max(-3, Math.min(3, event.wheelDelta ?? -1));
				if (step !== 0) {
					this.detailOffset = Math.max(0, this.detailOffset + step);
					this.bump();
				}
			}
			return { handled: true, render: true };
		}

		if (event.type === "click" && event.button === "left") {
			if (this.view === "turn") {
				const pos = this.nodeAt(event.y);
				if (pos >= 0) this.selectNode(pos);
				return { handled: true, render: false };
			}
			const idx = this.itemAt(event.y);
			if (idx >= 0) {
				// 双击进入回合分析；单击跳转定位
				if (event.clickCount === 2) this.enterTurn(idx);
				else this.jumpTo(idx);
			}
			return { handled: true, render: false };
		}

		return { handled: true, render: false };
	}

	/** y 行对应的条目序号；不在条目行上返回 -1。 */
	private itemAt(y: number): number {
		for (let i = 0; i < this.itemYs.length; i++) {
			if (this.itemYs[i] === y) return i;
		}
		return -1;
	}

	render(width: number): string[] {
		if (width === this.cachedWidth && this.cachedVersion === this.version) {
			return this.cachedLines;
		}
		const lines = this.view === "turn" ? this.renderTurn(width) : this.renderList(width);
		this.cachedLines = lines;
		this.cachedWidth = width;
		this.cachedVersion = this.version;
		return lines;
	}

	private renderList(width: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		this.itemYs = new Array(this.items.length).fill(-1);

		const innerW = Math.max(10, width - 2);
		// 内容行：│ + 填充到 innerW + │
		const boxLine = (body: string): string => {
			const padded = body + " ".repeat(Math.max(0, innerW - visibleWidth(body)));
			return "│" + truncateToWidth(padded, innerW, "") + "│";
		};

		// 顶边框：┌─ 提问列表（N）──────┐
		const titleSeg = "─" + theme.fg("accent", theme.bold(` 提问列表（${this.items.length}）`)) + "─";
		const fill = Math.max(0, width - 2 - visibleWidth(titleSeg));
		const top = "┌" + titleSeg + theme.fg("dim", "─".repeat(fill)) + "┐";
		lines.push(truncateToWidth(top, width, ""));

		// 条目行
		const count = this.visibleCount();
		for (let row = 0; row < count; row++) {
			const idx = this.offset + row;
			if (idx >= this.items.length) break;
			const item = this.items[idx]!;
			const active = this.hover === idx || (this.hover === null && this.selected === idx);
			const marker = active ? "> " : "  ";
			const num = String(idx + 1).padStart(2, " ");
			const body = truncateToWidth(`${marker}${num} ${item.summary}`, innerW, "…");
			lines.push(boxLine(active ? theme.style(body, { fg: "accent", bold: true }) : body));
			this.itemYs[idx] = lines.length - 1;
		}

		// 分隔线 + 底部提示 + 底边框
		lines.push("├" + "─".repeat(innerW) + "┤");
		const range =
			this.maxOffset() > 0
				? `（${this.offset + 1}-${Math.min(this.items.length, this.offset + count)}/${this.items.length}）`
				: "";
		const hint = ` 回车/点击 跳转 · 双击/d 分析 · ↑↓ 选择${range} · Esc 关闭 `;
		lines.push(boxLine(theme.fg("dim", truncateToWidth(hint, innerW, "…"))));
		lines.push("└" + "─".repeat(innerW) + "┘");

		return lines;
	}

	// -----------------------------------------------------------------------
	// 回合分析视图
	// -----------------------------------------------------------------------

	private renderTurn(width: number): string[] {
		const theme = this.theme;
		const turn = this.turn!;
		const lines: string[] = [];
		const innerW = Math.max(10, width - 2);
		const boxLine = (body: string): string => {
			const padded = body + " ".repeat(Math.max(0, innerW - visibleWidth(body)));
			return "│" + truncateToWidth(padded, innerW, "") + "│";
		};

		// 顶边框：┌─ 回合分析 · 第N问 ────┐
		const titleSeg =
			"─" + theme.fg("accent", theme.bold(` 回合分析 · 第${turn.question.index + 1}问 `)) + "─";
		const fill = Math.max(0, width - 2 - visibleWidth(titleSeg));
		const top = "┌" + titleSeg + theme.fg("dim", "─".repeat(fill)) + "┐";
		lines.push(truncateToWidth(top, width, ""));

		// 提问行
		lines.push(boxLine(theme.fg("dim", truncateToWidth(` 问  ${turn.question.summary}`, innerW, "…"))));

		// 节点树
		const nodes = this.visibleNodes();
		this.nodeYs = new Array(nodes.length).fill(-1);
		const view = Math.min(nodes.length, TREE_VISIBLE_ROWS);
		for (let row = 0; row < view; row++) {
			const pos = this.treeOffset + row;
			if (pos >= nodes.length) break;
			const node = nodes[pos]!;
			const connector = pos === nodes.length - 1 ? "└─" : "├─";
			const active = this.hoverNode === pos || (this.hoverNode === null && this.nodeSel === pos);
			let label: string;
			let summary: string;
			switch (node.kind) {
				case "thinking":
					label = "思考";
					summary = firstLine(node.text) || "(空)";
					break;
				case "text":
					label = node.isFinal ? "输出" : "文本";
					summary = firstLine(node.text);
					break;
				case "tool": {
					label = "工具";
					const status =
						node.result === null ? "·无结果" : node.isError ? "·出错" : `·${node.result.split("\n").length}行`;
					summary = `${node.name} ${briefArgs(node.args)} ${status}`;
					break;
				}
			}
			const head = `${connector} ${label} `;
			const body = head + truncateToWidth(summary, Math.max(4, innerW - visibleWidth(head) - 1), "…");
			lines.push(boxLine(active ? theme.style(body, { fg: "accent", bold: true }) : body));
			this.nodeYs[pos] = lines.length - 1;
		}

		// 详情标题（含树滚动范围与思维链标记）
		lines.push("├" + "─".repeat(innerW) + "┤");
		const selNode = nodes[this.nodeSel];
		const kindLabel = selNode
			? selNode.kind === "thinking"
				? "思考"
				: selNode.kind === "tool"
					? `工具 ${selNode.name}`
					: selNode.isFinal
						? "输出（Markdown）"
						: "文本"
			: "（无节点）";
		const treeRange =
			nodes.length > view
				? ` ${this.treeOffset + 1}-${Math.min(nodes.length, this.treeOffset + view)}/${nodes.length}`
				: "";
		const detailTitle = ` 详情 · ${kindLabel}${treeRange}${this.chainOnly ? " · 仅思维链" : ""} `;
		lines.push(
			"├" +
				theme.fg("dim", detailTitle) +
				theme.fg("dim", "─".repeat(Math.max(0, innerW - visibleWidth(detailTitle)))) +
				"┤",
		);

		// 详情内容
		const dw = Math.max(8, innerW - 2);
		const detail = selNode ? this.detailLines(selNode, dw) : ["(无节点)"];
		this.detailTop = lines.length;
		for (let r = 0; r < DETAIL_ROWS; r++) {
			const idx = this.detailOffset + r;
			const text = idx < detail.length ? detail[idx]! : "";
			lines.push(boxLine(" " + text));
		}
		this.detailBottom = lines.length - 1;

		// 底部提示 + 底边框
		lines.push("├" + "─".repeat(innerW) + "┤");
		const hint = ` ↑↓ 节点 · 回车 定位提问 · t 仅思维链(${this.chainOnly ? "开" : "关"}) · ←/Esc 返回 · 滚轮 详情 `;
		lines.push(boxLine(theme.fg("dim", truncateToWidth(hint, innerW, "…"))));
		lines.push("└" + "─".repeat(innerW) + "┘");

		return lines;
	}

	/** 节点详情行（已按宽度 wrap，可直接进详情区） */
	private detailLines(node: TurnNode, dw: number): string[] {
		const theme = this.theme;
		const wrap = (text: string): string[] => {
			const out: string[] = [];
			for (const line of text.split("\n")) {
				const wrapped = wrapTextWithAnsi(line, dw);
				out.push(...(wrapped.length > 0 ? wrapped : [""]));
			}
			return out.length > 0 ? out : ["(空)"];
		};

		if (node.kind === "thinking") return wrap(node.text);

		if (node.kind === "text") {
			if (!node.isFinal) return wrap(node.text);
			// 最终输出：Markdown 渲染（按节点+宽度缓存，主题变化时重建；
			// 主题未初始化等异常时退回纯文本 wrap）
			try {
				const mdTheme = getMarkdownTheme();
				const key = `${node.id}:${dw}`;
				if (!this.mdCache || this.mdCache.key !== key || this.mdCache.theme !== mdTheme) {
					this.mdCache = { key, theme: mdTheme, md: new Markdown(node.text, 0, 0, mdTheme) };
				}
				return [...this.mdCache.md.render(dw)];
			} catch {
				return wrap(node.text);
			}
		}

		// 工具节点：名称 + 参数 + 结果
		const head: string[] = [
			theme.fg("accent", `工具 ${node.name}`) + (node.isError ? "  " + theme.fg("error", "出错") : ""),
			"",
			theme.fg("dim", "参数:"),
		];
		let argsLines: string[];
		try {
			const s = typeof node.args === "string" ? node.args : (JSON.stringify(node.args, null, 2) ?? String(node.args));
			argsLines = wrap(s);
		} catch {
			argsLines = wrap(String(node.args));
		}
		const resHead =
			node.result === null
				? ["", theme.fg("dim", "结果: (未返回)")]
				: ["", theme.fg("dim", `结果${node.isError ? "(出错)" : ""}:`)];
		const resLines = node.result === null ? [] : wrap(node.result);
		return [...head, ...argsLines, ...resHead, ...resLines];
	}
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// 面板打开期间非空；此时 /questions 充当「关闭」
	let closePanel: (() => void) | null = null;
	// 面板宽度：列数或百分比字符串；/questions 50 、 /questions 60% 可调（会话内记忆）
	let panelWidth: SizeValue = "60%";

	/** 解析宽度参数；null 表示未提供或非法（非法时已 notify） */
	function parseWidthArg(args: string, notify: (msg: string, type: "warning") => void): SizeValue | null | false {
		const t = args.trim();
		if (!t) return null;
		const m = /^(\d{1,3})(%?)$/.exec(t);
		if (!m) {
			notify("宽度参数非法；用法：/questions 50（列）或 /questions 60%（百分比）", "warning");
			return false;
		}
		const n = Number(m[1]);
		if (m[2]) {
			if (n < 20 || n > 100) {
				notify("百分比宽度需在 20–100 之间", "warning");
				return false;
			}
			return `${n}%` as SizeValue;
		}
		if (n < 30 || n > 500) {
			notify("列宽度需在 30–500 之间", "warning");
			return false;
		}
		return n;
	}

	pi.registerCommand("questions", {
		description:
			"打开/关闭提问列表面板（单击跳转、双击进入回合分析；/questions 50 或 /questions 60% 调整宽度）",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("question-panel 需要交互式（tui）模式", "error");
				return;
			}

			const parsed = parseWidthArg(args ?? "", (msg) => ctx.ui.notify(msg, "warning"));
			if (parsed === false) return;
			if (parsed !== null) panelWidth = parsed;

			if (closePanel) {
				closePanel();
				if (parsed === null) return; // 无参数：纯关闭；带参数：换宽度重开
			}

			const questions = collectQuestions(ctx);
			if (questions.length === 0) {
				ctx.ui.notify("当前会话还没有用户提问", "info");
				return;
			}

			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					const panel = new QuestionPanelComponent(
						tui,
						theme,
						questions,
						(index) => {
							const item = questions[index]!;
							const ordinal = markerOrdinalForQuestion(ctx, item.index);
							if (ordinal !== null && jumpToMarker(tui, ordinal)) return;
							// 标记法失效（例如 pi 调整了 OSC 133;A 规则）→ 文本匹配兜底
							const normalized = normalizeMatchText(item.text);
							const occurrence = questions
								.slice(0, index)
								.filter((q) => normalizeMatchText(q.text) === normalized).length;
							if (!jumpToQuestionText(tui, item.text, occurrence)) {
								ctx.ui.notify("跳转失败：无法定位 transcript（pi 内部结构可能已变化）", "warning");
							}
						},
						(ordinal) => buildTurn(ctx, ordinal),
						() => {
							closePanel = null;
							done(undefined);
						},
					);
					closePanel = () => panel.close();
					return panel;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "top-right",
						margin: 1,
						width: panelWidth,
						minWidth: 36,
						maxHeight: "70%",
					},
				},
			);
		},
	});
}
