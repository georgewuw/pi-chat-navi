/**
 * panel.ts
 *
 * 「用户提问列表」面板组件（列表视图 + 回合分析视图）。只负责状态、键鼠和渲染，
 * 不碰会话数据和 transcript：数据由 index.ts 传入，跳转通过回调完成。
 *   - 键盘：↑↓ 选择、回车跳转（作用于当前选中项）、→/d 回合分析、Esc 关闭（分析内先返回列表）
 *   - 鼠标：仅回合分析详情区的滚轮；单击/双击/悬停均无效果
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { firstLine, type QuestionItem, type TurnData, type TurnNode } from "./logic.ts";

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
// 面板组件
// ---------------------------------------------------------------------------

const MAX_VISIBLE_ROWS = 18;
/** 面板最大高度占终端行数的比例（与 overlayOptions.maxHeight 保持一致） */
export const PANEL_HEIGHT_RATIO = 0.7;

/**
 * 重线框绘制：列表视图与回合分析视图共用。
 * 与 pi-session-nav 一致：border 颜色、内容两侧各留 1 格。
 */
class Frame {
	readonly innerW: number;
	/** 可用内容宽度（已扣除两侧边框与留白） */
	readonly contentW: number;

	constructor(
		private readonly theme: Theme,
		width: number,
	) {
		this.innerW = Math.max(1, width - 2);
		this.contentW = Math.max(1, this.innerW - 2);
	}

	border(text: string): string {
		return this.theme.fg("border", text);
	}

	/** 一行内容：截断并补齐到内容宽度；active 时整行高亮；rightEdge 可替换右边框（详情区用作滚动条） */
	row(body: string, opts: { active?: boolean; rightEdge?: string } = {}): string {
		const fitted = truncateToWidth(body, this.contentW, "…");
		const inner = ` ${fitted}${" ".repeat(Math.max(0, this.contentW - visibleWidth(fitted)))} `;
		return (
			this.border("┃") +
			(opts.active ? this.theme.style(inner, { fg: "accent", bold: true }) : inner) +
			(opts.rightEdge ?? this.border("┃"))
		);
	}

	top(title: string): string {
		const fitted = truncateToWidth(title, Math.max(1, this.innerW - 1), "…");
		return this.border(`┏${fitted}${"━".repeat(Math.max(0, this.innerW - visibleWidth(fitted)))}┓`);
	}

	separator(): string {
		return this.border("┣" + "━".repeat(this.innerW) + "┫");
	}

	bottom(): string {
		return this.border("┗" + "━".repeat(this.innerW) + "┛");
	}

	/** 左右两端对齐的标题行；放不下时退化为截断的单段 */
	header(left: string, right: string): string {
		if (!right) return left;
		const gap = this.contentW - visibleWidth(left) - visibleWidth(right);
		return gap >= 1 ? left + " ".repeat(gap) + right : truncateToWidth(`${left} ${right}`, this.contentW, "…");
	}
}

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
	private cachedRows = -1;
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
		this.cachedRows = -1;
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
		const count = this.visibleCount();
		if (this.selected < this.offset) this.offset = this.selected;
		if (this.selected > this.offset + count - 1) this.offset = this.selected - count + 1;
		// 终端被放大（可见行数变多）后，offset 不能让列表尾部留空
		this.offset = Math.max(0, Math.min(Math.max(0, this.items.length - count), this.offset));
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
			// 回车/空格：跳转到当前选中项
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
		// 终端高度变化也会改变可见行数，必须纳入缓存键
		const rows = this.tui.terminal?.rows ?? 0;
		if (width === this.cachedWidth && rows === this.cachedRows && this.cachedVersion === this.version) {
			return this.cachedLines;
		}
		// 渲染前先让滚动偏移适应当前可见行数（终端放大后不留空行/不隐藏前面的条目）
		if (this.view === "turn") this.ensureNodeVisible();
		else this.ensureSelectedVisible();
		const lines = this.view === "turn" ? this.renderTurn(width) : this.renderList(width);
		this.cachedLines = lines;
		this.cachedWidth = width;
		this.cachedRows = rows;
		this.cachedVersion = this.version;
		return lines;
	}

	private renderList(width: number): string[] {
		const theme = this.theme;
		const f = new Frame(theme, width);
		const row = (body: string): string => f.row(body);
		const lines: string[] = [f.top(` Navigate conversation · ${this.items.length} messages `), row("")];

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
			lines.push(f.row(`${marker}${num} ${item.summary}`, { active }));
		}

		// 列表下方的省略提示行（仅展示，不可选中）
		if (this.offset + count < this.items.length) lines.push(row(theme.fg("dim", "  ↓ more")));

		// 底部：空行 + dim 提示 + 底边框（与 pi-session-nav 一致）
		lines.push(row(""));
		const hint = `↑↓ select · Enter jump · →/d analyze · Esc close`;
		lines.push(row(theme.fg("dim", hint)));
		lines.push(f.bottom());

		return lines;
	}

	// -----------------------------------------------------------------------
	// 回合分析视图
	// -----------------------------------------------------------------------

	private renderTurn(width: number): string[] {
		const theme = this.theme;
		const turn = this.turn!;
		const f = new Frame(theme, width);
		const contentW = f.contentW;
		const row = (body: string): string => f.row(body);
		const separator = (): string => f.separator();
		const header = (left: string, right: string): string => f.header(left, right);
		const { treeRows, detailRows } = this.turnLayout();

		const lines: string[] = [f.top(` Analysis · Q${turn.question.index + 1} `)];

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
			lines.push(f.row(body, { active }));
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
			const rightEdge = !scrollable
				? undefined
				: r >= thumbTop && r < thumbTop + thumbSize
					? theme.fg("borderAccent", "█")
					: theme.fg("borderMuted", "│");
			lines.push(f.row(text, { rightEdge }));
		}
		this.detailBottom = lines.length - 1;

		lines.push(separator());
		const hint = `↑↓ select · ←/Esc back · t ${this.chainOnly ? "thinking-only" : "all"} · wheel detail`;
		lines.push(row(theme.fg("dim", hint)));
		lines.push(f.bottom());

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
