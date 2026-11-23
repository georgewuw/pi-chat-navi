/**
 * question-panel.ts
 *
 * `/questions [宽度]` — 打开/关闭「用户提问列表」浮动面板（停靠右上角）：
 *   - 列出当前 transcript 中可见的用户提问（序号 + 摘要；压缩感知）
 *   - 鼠标：仅回合分析详情区滚轮（右侧滚动条）；单击/双击/悬停均无效果
 *   - 键盘：↑↓ 选择、回车跳转（作用于当前选中项）、Esc 关闭
 *   - 鼠标：点击跳转/进入分析；悬停无效果；回合分析详情区支持滚轮
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
/** 面板最大高度占终端行数的比例（与 overlayOptions.maxHeight 保持一致） */
const PANEL_HEIGHT_RATIO = 0.7;

export class QuestionPanelComponent implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly items: QuestionItem[];
	private readonly jump: (index: number) => void;
	private readonly onClose: () => void;

	private readonly turnLoader: (ordinal: number) => TurnData | null;

	private selected = 0;
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
	/** 上次渲染的详情总行数（用于滚轮 clamp） */
	private detailLen = 0;

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
		this.ensureSelectedVisible();
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
		// 列表固定行：顶/底边框、上下空行、提示行（5）+ 上/下 more 提示（≤2）
		const terminalRows = this.tui.terminal?.rows ?? 40;
		const budget = Math.max(3, Math.floor(terminalRows * PANEL_HEIGHT_RATIO) - 7);
		return Math.min(this.items.length, MAX_VISIBLE_ROWS, budget);
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

	/**
	 * 回合分析可用行数：按终端高度分配节点区/详情区。
	 * 固定行：顶/底边框、提问行、3 条分隔线、2 个区块标题、提示行（共 9 行）。
	 */
	private turnLayout(): { treeRows: number; detailRows: number } {
		const terminalRows = this.tui.terminal?.rows ?? 40;
		const panelRows = Math.max(12, Math.floor(terminalRows * PANEL_HEIGHT_RATIO));
		const contentRows = Math.max(4, panelRows - 9);
		const treeRows = Math.max(2, Math.min(8, Math.round(contentRows * 0.4)));
		return { treeRows, detailRows: Math.max(2, contentRows - treeRows) };
	}

	private ensureNodeVisible(): void {
		const total = this.visibleNodes().length;
		const view = Math.min(total, this.turnLayout().treeRows);
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

	/** 列表 d/→：进入该提问的回合分析 */
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
		this.bump();
	}

	private backToList(): void {
		this.view = "list";
		this.turn = null;
		this.mdCache = null;
		this.bump();
	}

	handleInput(data: string): boolean {
		if (this.view === "turn") {
			if (matchesKey(data, "escape") || matchesKey(data, "left")) {
				this.backToList();
				return true;
			}
			if (matchesKey(data, "up")) {
				this.selectNode(this.nodeSel - 1);
				return true;
			}
			if (matchesKey(data, "down")) {
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
			if (this.selected > 0) {
				this.selected--;
				this.ensureSelectedVisible();
				this.bump();
			}
			return true;
		}
		if (matchesKey(data, "down")) {
			if (this.selected < this.items.length - 1) {
				this.selected++;
				this.ensureSelectedVisible();
				this.bump();
			}
			return true;
		}
		if (matchesKey(data, "return") || data === " ") {
			// 回车/空格：与点击一致，作用于当前选中项
			this.jumpTo(this.selected);
			return true;
		}
		if (data === "d" || data === "D" || matchesKey(data, "right")) {
			this.enterTurn(this.selected);
			return true;
		}
		return true;
	}


	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && this.view === "turn") {
			// 仅保留回合分析详情区的滚轮滚动（列表与节点树不响应滚轮）
			if (event.y >= this.detailTop && event.y <= this.detailBottom) {
				const step = Math.max(-3, Math.min(3, event.wheelDelta ?? -1));
				const maxOffset = Math.max(0, this.detailLen - this.turnLayout().detailRows);
				const next = Math.max(0, Math.min(maxOffset, this.detailOffset + step));
				if (next !== this.detailOffset) {
					this.detailOffset = next;
					this.bump();
				}
			}
			return { handled: true, render: true };
		}

		return { handled: true, render: false };
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

		// 与 pi-session-nav 一致：重线框 + border 颜色（主题里 border 是蓝色）、内容两侧各留 1 格
		const innerW = Math.max(1, width - 2);
		const contentW = Math.max(1, innerW - 2);
		const border = (text: string): string => theme.fg("border", text);
		const padded = (body: string): string => {
			const fitted = truncateToWidth(body, contentW, "…");
			return ` ${fitted}${ " ".repeat(Math.max(0, contentW - visibleWidth(fitted))) } `;
		};
		const row = (body: string): string => border("┃") + padded(body) + border("┃");

		// 顶边框：┏ Navigate conversation · N messages ━━━┓
		const title = truncateToWidth(
			` Navigate conversation · ${this.items.length} messages `,
			Math.max(1, innerW - 1),
			"…",
		);
		lines.push(border(`┏${title}${"━".repeat(Math.max(0, innerW - visibleWidth(title)))}┓`));
		lines.push(row(""));

		// 列表上方的省略提示行（仅展示，不可选中）
		const count = this.visibleCount();
		if (this.offset > 0) lines.push(row(theme.fg("dim", "  ↑ more")));

		// 条目行
		for (let rowIdx = 0; rowIdx < count; rowIdx++) {
			const idx = this.offset + rowIdx;
			if (idx >= this.items.length) break;
			const item = this.items[idx]!;
			const active = this.selected === idx;
			const marker = active ? "> " : "  ";
			const num = String(idx + 1).padStart(2, " ");
			const body = padded(`${marker}${num} ${item.summary}`);
			lines.push(
				border("┃") +
					(active ? theme.style(body, { fg: "accent", bold: true }) : body) +
					border("┃"),
			);
		}

		// 列表下方的省略提示行（仅展示，不可选中）
		if (this.offset + count < this.items.length) lines.push(row(theme.fg("dim", "  ↓ more")));

		// 底部：空行 + dim 提示 + 底边框（与 pi-session-nav 一致）
		lines.push(row(""));
		const hint = `↑↓ select · Enter jump · →/d analyze · Esc close`;
		lines.push(row(theme.fg("dim", hint)));
		lines.push(border("┗" + "━".repeat(innerW) + "┛"));

		return lines;
	}

	// -----------------------------------------------------------------------
	// 回合分析视图
	// -----------------------------------------------------------------------

	private renderTurn(width: number): string[] {
		const theme = this.theme;
		const turn = this.turn!;
		const lines: string[] = [];
		const innerW = Math.max(1, width - 2);
		const contentW = Math.max(1, innerW - 2);
		const border = (text: string): string => theme.fg("border", text);
		const padded = (body: string): string => {
			const fitted = truncateToWidth(body, contentW, "…");
			return ` ${fitted}${ " ".repeat(Math.max(0, contentW - visibleWidth(fitted))) } `;
		};
		const row = (body: string): string => border("┃") + padded(body) + border("┃");
		const separator = (): string => border("┣" + "━".repeat(innerW) + "┫");
		const header = (left: string, right: string): string => {
			if (!right) return left;
			const gap = contentW - visibleWidth(left) - visibleWidth(right);
			return gap >= 1 ? left + " ".repeat(gap) + right : truncateToWidth(`${left} ${right}`, contentW, "…");
		};
		const { treeRows, detailRows } = this.turnLayout();

		// 顶边框：┏ Analysis · QN ━━━┓
		const title = truncateToWidth(
			` Analysis · Q${turn.question.index + 1} `,
			Math.max(1, innerW - 1),
			"…",
		);
		lines.push(border(`┏${title}${"━".repeat(Math.max(0, innerW - visibleWidth(title)))}┓`));

		// 提问行
		lines.push(row(`${theme.fg("accent", "Question:")}  ${turn.question.summary}`));
		lines.push(separator());

		// 节点区：标题行（左：选中序号/总数，右：可视范围）+ 固定行数的节点列表
		const nodes = this.visibleNodes();
		const view = Math.min(nodes.length, treeRows);
		const selectedLabel = nodes.length === 0 ? "0/0" : `${this.nodeSel + 1}/${nodes.length}`;
		const nodeRange =
			nodes.length > view
				? `${this.treeOffset + 1}-${Math.min(nodes.length, this.treeOffset + view)}/${nodes.length}`
				: "";
		const nodeHeader = `${theme.fg("accent", "Nodes")}${theme.fg("dim", ` · ${selectedLabel}${this.chainOnly ? " · thinking only" : ""}`)}`;
		lines.push(row(header(nodeHeader, nodeRange ? theme.fg("dim", nodeRange) : "")));

		for (let r = 0; r < treeRows; r++) {
			const pos = this.treeOffset + r;
			const node = pos < nodes.length ? nodes[pos] : undefined;
			if (!node) {
				lines.push(row(r === 0 && nodes.length === 0 ? theme.fg("dim", "(no nodes)") : ""));
				continue;
			}
			const active = pos === this.nodeSel;
			let label: string;
			let summary: string;
			switch (node.kind) {
				case "thinking":
					label = "Thinking";
					summary = firstLine(node.text) || "(Empty)";
					break;
				case "text":
					label = node.isFinal ? "Output" : "Text";
					summary = firstLine(node.text);
					break;
				case "tool": {
					label = "Tool";
					const status =
						node.result === null ? "·no result" : node.isError ? "·error" : `·${node.result.split("\n").length} lines`;
					summary = `${node.name} ${briefArgs(node.args)} ${status}`;
					break;
				}
			}
			const marker = active ? "› " : "  ";
			const body = `${marker}${label.padEnd(9)}${summary}`;
			lines.push(
				border("┃") +
					(active ? theme.style(padded(body), { fg: "accent", bold: true }) : padded(body)) +
					border("┃"),
			);
		}

		lines.push(separator());

		// 详情区：标题行（左：类型，右：可视范围）+ 内容（右边框列兼作滚动条）
		const selNode = nodes[this.nodeSel];
		const kindLabel = selNode
			? selNode.kind === "thinking"
				? "Thinking"
				: selNode.kind === "tool"
					? `Tool ${selNode.name}${selNode.isError ? " (error)" : ""}`
					: selNode.isFinal
						? "Output (Markdown)"
						: "Text"
			: "(no node)";
		const detail = selNode ? this.detailLines(selNode, contentW) : ["(no node)"];
		this.detailLen = detail.length;
		const maxDetailOffset = Math.max(0, detail.length - detailRows);
		const start = Math.max(0, Math.min(this.detailOffset, maxDetailOffset));
		const scrollable = detail.length > detailRows;
		const detailRange = scrollable
			? `${start + 1}-${Math.min(detail.length, start + detailRows)}/${detail.length}`
			: "";
		const detailHeader = `${theme.fg("accent", "Detail")}${theme.fg("dim", ` · ${kindLabel}`)}`;
		lines.push(row(header(detailHeader, detailRange ? theme.fg("dim", detailRange) : "")));

		const thumbSize = scrollable
			? Math.max(1, Math.min(detailRows, Math.round((detailRows * detailRows) / detail.length)))
			: 0;
		const thumbTop =
			scrollable && maxDetailOffset > 0 ? Math.round((start / maxDetailOffset) * (detailRows - thumbSize)) : 0;
		this.detailTop = lines.length;
		for (let r = 0; r < detailRows; r++) {
			const idx = start + r;
			const text = idx < detail.length ? detail[idx]! : "";
			const right = !scrollable
				? border("┃")
				: r >= thumbTop && r < thumbTop + thumbSize
					? theme.fg("borderAccent", "█")
					: theme.fg("borderMuted", "│");
			lines.push(border("┃") + padded(text) + right);
		}
		this.detailBottom = lines.length - 1;

		lines.push(separator());
		const hint = `↑↓ select · ←/Esc back · t ${this.chainOnly ? "thinking-only" : "all"} · wheel detail`;
		lines.push(row(theme.fg("dim", hint)));
		lines.push(border("┗" + "━".repeat(innerW) + "┛"));

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
			return out.length > 0 ? out : ["(Empty)"];
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

		// 工具节点：参数 + 结果（名称/错误状态已在详情标题里）
		const head: string[] = [theme.fg("dim", "Args:")];
		let argsLines: string[];
		try {
			const s = typeof node.args === "string" ? node.args : (JSON.stringify(node.args, null, 2) ?? String(node.args));
			argsLines = wrap(s);
		} catch {
			argsLines = wrap(String(node.args));
		}
		const resHead =
			node.result === null
				? ["", theme.fg("dim", "Result: (not returned)")]
				: ["", theme.fg("dim", `Result${node.isError ? " (error)" : ""}:`)];
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
			notify("Invalid width; usage: /questions 50 (columns) or /questions 60% (percentage)", "warning");
			return false;
		}
		const n = Number(m[1]);
		if (m[2]) {
			if (n < 20 || n > 100) {
				notify("Percentage width must be between 20 and 100", "warning");
				return false;
			}
			return `${n}%` as SizeValue;
		}
		if (n < 30 || n > 500) {
			notify("Column width must be between 30 and 500", "warning");
			return false;
		}
		return n;
	}

	pi.registerCommand("questions", {
			description:
			"Open/close the questions panel (click to jump, double-click for turn analysis; /questions 50 or /questions 60% sets width)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("question-panel requires interactive (tui) mode", "error");
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
				ctx.ui.notify("No user questions in this session yet", "info");
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
								ctx.ui.notify("Jump failed: cannot locate transcript (pi internals may have changed)", "warning");
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
						maxHeight: `${Math.round(PANEL_HEIGHT_RATIO * 100)}%`,
					},
				},
			);
		},
	});
}
