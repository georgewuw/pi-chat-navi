/**
 * index.ts — 扩展入口
 *
 * `/questions [宽度]` 打开/关闭右上角的提问列表浮动面板：
 *   - 宽度：默认 60%；/questions 50（列数）或 /questions 60%（百分比），会话内记忆；
 *     面板已打开时带参数会以新宽度重开
 *
 * 本文件把三部分接起来：logic.ts（会话数据）、panel.ts（面板 UI）、jump.ts（transcript 跳转）。
 * 面板走公开 API：ctx.ui.custom(overlay) + Component.handleMouse。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SizeValue } from "@earendil-works/pi-tui";
import { jumpToQuestion } from "./jump.ts";
import {
	activeContextEntries,
	buildTurnFromEntries,
	collectQuestionsFromEntries,
	markerOrdinalFromEntries,
	occurrenceOf,
	remapQuestionIndex,
	type SessionEntryLike,
} from "./logic.ts";
import { PANEL_HEIGHT_RATIO, QuestionPanelComponent } from "./panel.ts";

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

/** 解析宽度参数。null：未提供；false：非法（已 notify）。 */
export function parseWidthArg(args: string, notify: (msg: string) => void): SizeValue | null | false {
	const t = args.trim();
	if (!t) return null;
	const m = /^(\d{1,3})(%?)$/.exec(t);
	if (!m) {
		notify("Invalid width; usage: /questions 50 (columns) or /questions 60% (percentage)");
		return false;
	}
	const n = Number(m[1]);
	if (m[2]) {
		if (n < 20 || n > 100) {
			notify("Percentage width must be between 20 and 100");
			return false;
		}
		return `${n}%` as SizeValue;
	}
	if (n < 30 || n > 500) {
		notify("Column width must be between 30 and 500");
		return false;
	}
	return n;
}

export default function (pi: ExtensionAPI) {
	// 面板打开期间非空；此时 /questions 充当「关闭」
	let closePanel: (() => void) | null = null;
	// 面板宽度（会话内记忆）
	let panelWidth: SizeValue = "60%";

	pi.registerCommand("questions", {
		description:
			"Open/close the questions panel (↑↓ select, Enter jump, → analyze; /questions 50 or /questions 60% sets width)",
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

			const questions = collectQuestionsFromEntries(activeEntries(ctx));
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
							// 面板开着时 agent 可能继续输出或压缩：每次跳转都按当前活动上下文重新推算
							const entries = activeEntries(ctx);
							const current = collectQuestionsFromEntries(entries);
							const currentIndex = remapQuestionIndex(questions, index, current);
							if (currentIndex < 0) {
								ctx.ui.notify("Jump failed: this question is no longer in the active context", "warning");
								return;
							}
							const item = current[currentIndex]!;
							const ok = jumpToQuestion(tui, {
								markerOrdinal: markerOrdinalFromEntries(entries, currentIndex),
								text: item.text,
								summary: item.summary,
								occurrence: occurrenceOf(current, currentIndex),
							});
							if (!ok) {
								ctx.ui.notify("Jump failed: cannot locate transcript (pi internals may have changed)", "warning");
							}
						},
						(ordinal) => {
							const entries = activeEntries(ctx);
							const current = collectQuestionsFromEntries(entries);
							const currentIndex = remapQuestionIndex(questions, ordinal, current);
							const turn = currentIndex < 0 ? null : buildTurnFromEntries(entries, currentIndex);
							if (!turn) ctx.ui.notify("Analysis unavailable: this question is no longer in the active context", "warning");
							return turn;
						},
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
