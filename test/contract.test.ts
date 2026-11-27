/**
 * 契约测试：用真实的 pi 包（devDependency 装的版本）验证 src/jump.ts 与 src/logic.ts 对 pi 内部实现的假设。
 * pi 升级后跳转失效时，这里会指出是哪条假设不成立。
 * 不同 pi 版本的矩阵运行见 scripts/compat.mjs（pnpm run test:compat）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	Container,
	ScrollView,
	Spacer,
	Text,
	TuiAltScreen,
	VStack,
	type Component,
	type Terminal,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	AssistantMessageComponent,
	SkillInvocationMessageComponent,
	UserMessageComponent,
	initTheme,
	parseSkillBlock,
} from "@earendil-works/pi-coding-agent";
import { findTranscript, jumpToMarker, jumpToQuestion, jumpToQuestionText } from "../src/jump.ts";
import {
	activeContextEntries,
	collectQuestionsFromEntries,
	markerOrdinalFromEntries,
	normalizeMatchText,
	occurrenceOf,
	type QuestionItem,
	type SessionEntryLike,
} from "../src/logic.ts";

const ROWS = 24;
/** 搭建的布局里，transcript 下方固定输入区占的行数；视口 = ROWS - DOCK_ROWS */
const DOCK_ROWS = 1;
const OSC133_A = /\x1b\]133;A/;
const strip = (s: string): string =>
	s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\]133;[ABC](?:\x07|\x1b\\)/g, "");

/** 假终端：不碰真实 stdin/stdout，只满足 TuiAltScreen 用到的 Terminal 契约。 */
function fakeTerminal(): Terminal {
	return {
		columns: 80,
		rows: ROWS,
		kittyProtocolActive: false,
		start() {},
		stop() {},
		drainInput: async () => {},
		write() {},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
		setProgramStatus() {},
	};
}

/** 会话 content 里的一个 part。测试只关心 type 和少数字段（text/thinking/id/name/…）。 */
type Part = { type: string; text?: string; [field: string]: unknown };

const text = (value: string): Part[] => [{ type: "text", text: value }];

/** 渲染用的 assistant 消息。pi 的 AssistantMessage 还要求 api/provider/model/usage 等字段，
 *  只跟模型调用有关、与渲染和标记规则无关，所以这里不构造它们。 */
type AssistantMessageArg = ConstructorParameters<typeof AssistantMessageComponent>[0];
const assistantMessageArg = (content: Part[], stopReason?: string): AssistantMessageArg =>
	({ role: "assistant", content, stopReason, timestamp: 1 }) as unknown as AssistantMessageArg;

/** 一段会话脚本：每一步要么是用户消息，要么是 assistant 消息。 */
interface Step {
	/** 单段文本提问的简写 */
	user?: string;
	/** 原始 content（多段 text、图片等） */
	userContent?: Part[];
	assistant?: Part[];
	stopReason?: string;
}

interface Session {
	tui: TuiAltScreen;
	entries: SessionEntryLike[];
	/** 自己创建的 transcript 滚动视图：读 scrollTop 用它，比从 tui 内部反射回来更直接 */
	scrollView: ScrollView;
}

/**
 * 按 pi 的真实渲染方式搭一个 transcript：每条会话条目对应一个真实组件。
 * 返回会话条目（给 logic.ts）与已渲染一帧的 tui（给 jump.ts）。
 */
function buildSession(script: Step[]): Session {
	initTheme(undefined, false);
	const tui = new TuiAltScreen(fakeTerminal(), false, undefined, {});
	// 与 pi 的 createChatViewport 一致：ScrollView(documentContainer) 作 transcript，下方固定输入区，VStack 为布局根。
	// documentContainer 的结构镜像 interactive-mode：[header, loadedResources, chatContainer]，
	// 消息与 Spacer 都挂在 chatContainer 里（嵌套容器会影响文本匹配兜底的行偏移计算）。
	const header = new Container();
	header.addChild(new Text("pi header", 1, 0));
	const document = new Container();
	document.addChild(header);
	document.addChild(new Container()); // loadedResources（空）
	const chat = new Container();
	document.addChild(chat);
	const scrollView = new ScrollView(document, { follow: "end", primary: true, overscroll: "chain", scrollbar: "auto" });
	const dock: Component = { render: () => ["> input"], invalidate() {} };
	tui.setLayoutRoot(
		new VStack([
			{ component: scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]),
	);
	const entries: SessionEntryLike[] = [];
	let id = 0;
	for (const step of script) {
		const entryId = `e${id++}`;
		// 镜像 pi：chatContainer 已有内容时，用户消息前加一个 Spacer
		if (chat.children.length > 0 && (step.user !== undefined || step.userContent !== undefined)) chat.addChild(new Spacer(1));
		if (step.user !== undefined || step.userContent !== undefined) {
			// userContent：原始 content（多段 text、图片等）；user：单段文本的简写
			const content = step.userContent ?? text(step.user ?? "");
			entries.push({ id: entryId, type: "message", message: { role: "user", content } });
			// 镜像 pi interactive-mode 的 addMessageToChat：getUserMessageText 为空则不渲染；
			// skill 块渲染 SkillInvocationMessageComponent，有附加文本时再渲染 UserMessageComponent
			const userText = content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (userText) {
				const skill = parseSkillBlock(userText);
				if (skill) {
					chat.addChild(new SkillInvocationMessageComponent(skill));
					if (skill.userMessage) chat.addChild(new UserMessageComponent(skill.userMessage));
				} else {
					chat.addChild(new UserMessageComponent(userText));
				}
			}
		} else {
			const content = step.assistant ?? [];
			const stopReason = step.stopReason;
			entries.push({ id: entryId, type: "message", message: { role: "assistant", content, stopReason } });
			// 与 pi 一致：带 toolCall 的 assistant 消息仍有组件，只是不写 OSC 133;A 标记
			chat.addChild(new AssistantMessageComponent(assistantMessageArg(content, stopReason)));
		}
	}
	tui.start();
	tui.renderNow();
	return { tui, entries, scrollView };
}

/** transcript 当前渲染出的全部行（每次渲染后要重新取）。 */
function transcriptLines(tui: TUI): readonly string[] {
	const found = findTranscript(tui);
	assert.ok(found, "findTranscript 找不到 transcript：scrollContentLines / scrollView / OSC 133;A 其中之一变了");
	return found.lines;
}

/** 标记法需要的非 null 序号（assert 不会让 TS 收窄类型）。 */
function markerOrdinal(entries: SessionEntryLike[], index: number): number {
	const ordinal = markerOrdinalFromEntries(entries, index);
	assert.ok(ordinal !== null, `Q${index + 1} 推算不出标记序号`);
	return ordinal;
}

const body = (label: string): string => Array.from({ length: 4 }, (_, i) => `${label} line ${i + 1}`).join("\n\n");
/** 足够长、让 transcript 超出视口，滚动位置才有区分度 */
const bigBody = (label: string): string => Array.from({ length: 20 }, (_, i) => `${label} line ${i + 1}`).join("\n\n");

const SCRIPT: Step[] = [
	{ user: "first question about parsing" },
	{ assistant: text(body("reply one")) },
	{ user: "second question with tools" },
	{ assistant: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } }] },
	{ assistant: text(body("reply two")) },
	{ user: "repeated question" },
	{ assistant: text(body("reply three")) },
	{ user: "repeated question" },
	{ assistant: text(body("reply four")) },
	{ user: "last question" },
	{ assistant: text(body("reply five")) },
];

/** 目标提问文本在 transcript 全部行中第 n 次出现的行号（独立于被测代码，直接看渲染结果）。 */
function rowOfQuestion(lines: readonly string[], questionText: string, nth: number): number {
	let seen = 0;
	for (let row = 0; row < lines.length; row++) {
		if (strip(lines[row]).trim() === questionText && seen++ === nth) return row;
	}
	return -1;
}

/** 文字行所属组件的 OSC 133;A 标记行（组件首行，可能是空白内边距行）。 */
function markerRowAtOrBefore(lines: readonly string[], row: number): number {
	for (let r = row; r >= 0; r--) if (OSC133_A.test(lines[r])) return r;
	return -1;
}

/** 组件首行标记所在行起、第一条非空白文字（即渲染出的提问首行）。 */
function firstTextFrom(lines: readonly string[], row: number): string {
	for (let r = row; r < lines.length; r++) {
		const t = strip(lines[r]).trim();
		if (t) return t;
	}
	return "";
}

/** 跳转目标行上方留一行；ScrollView 会把滚动位置限制在可滚动范围内。 */
function expectedScrollTop(lines: readonly string[], row: number): number {
	return Math.min(Math.max(0, row - 1), Math.max(0, lines.length - (ROWS - DOCK_ROWS)));
}

/** transcript 里所有 OSC 133;A 标记所在的行号。 */
function markerRows(lines: readonly string[]): number[] {
	return lines.map((l, row) => (OSC133_A.test(l) ? row : -1)).filter((row) => row >= 0);
}

test("pi 暴露 jump.ts 依赖的内部结构", () => {
	const { tui } = buildSession(SCRIPT);
	// currentLayout 是 TuiAltScreen 的私有字段：白盒检查只能反射读取
	const layout: { root?: unknown } | undefined = Reflect.get(tui, "currentLayout");
	assert.ok(layout, "tui.currentLayout 不存在：pi 改了渲染帧的存放位置");
	assert.ok(layout.root, "currentLayout.root 不存在：pi 改了布局树根节点");

	const found = findTranscript(tui);
	assert.ok(found, "findTranscript 找不到 transcript：scrollContentLines / scrollView / OSC 133;A 其中之一变了");
	assert.equal(typeof found.scrollView.scrollTo, "function", "ScrollView.scrollTo 不存在");
	assert.equal(typeof found.scrollView.getContentWidth, "function", "ScrollView.getContentWidth 不存在");
	assert.ok(found.scrollView.child, "ScrollView.child 不存在：文本匹配兜底需要它遍历组件树");
	assert.ok(found.lines.some((l) => OSC133_A.test(l)), "transcript 行里没有 OSC 133;A 标记");
	assert.equal(typeof tui.requestRender, "function");
});

test("logic.ts 推算的标记序号与真实渲染的 OSC 133;A 标记一致", () => {
	const { tui, entries } = buildSession(SCRIPT);
	const lines = transcriptLines(tui);
	const rows = markerRows(lines);

	const questions = collectQuestionsFromEntries(entries);
	assert.equal(questions.length, 5);
	for (const q of questions) {
		const ordinal = markerOrdinal(entries, q.index);
		// 第 ordinal 个标记所属的组件，首条文字必须是这条提问的首行
		const line = firstTextFrom(lines, rows[ordinal]);
		assert.equal(line, q.summary, `Q${q.index + 1} 的标记序号 ${ordinal} 指向了 "${line}"`);
	}
	// 带 toolCall 的 assistant 消息不产生标记：5 条提问 + 5 条纯文本回复
	assert.equal(rows.length, 5 + 5);
});

test("标记法：每条提问都能滚动到正确位置", () => {
	const { tui, entries, scrollView } = buildSession(SCRIPT);
	const questions = collectQuestionsFromEntries(entries);
	const seenText = new Map<string, number>();

	for (const q of questions) {
		const nth = seenText.get(q.text) ?? 0;
		seenText.set(q.text, nth + 1);

		const lines = transcriptLines(tui);
		const row = rowOfQuestion(lines, q.text, nth);
		assert.ok(row >= 0, `渲染结果里找不到 Q${q.index + 1}`);

		const ordinal = markerOrdinal(entries, q.index);
		assert.equal(jumpToMarker(tui, ordinal), true);
		const markerRow = markerRowAtOrBefore(lines, row);
		assert.equal(scrollView.scrollTop, expectedScrollTop(lines, markerRow), `Q${q.index + 1} 滚动位置不对`);
	}
});

test("文本匹配兜底：不依赖标记也能定位每条提问（含重复提问）", () => {
	const { tui, entries, scrollView } = buildSession(SCRIPT);
	const questions = collectQuestionsFromEntries(entries);
	const seenText = new Map<string, number>();

	for (const q of questions) {
		const nth = seenText.get(q.text) ?? 0;
		seenText.set(q.text, nth + 1);

		const lines = transcriptLines(tui);
		const row = rowOfQuestion(lines, q.text, nth);
		scrollView.scrollTo(0, { disableFollow: true });

		const occurrence = occurrenceOf(questions, q.index);
		assert.equal(occurrence, nth);
		assert.equal(jumpToQuestionText(tui, q.text, occurrence), true, `Q${q.index + 1} 文本匹配失败`);
		assert.equal(scrollView.scrollTop, expectedScrollTop(lines, row), `Q${q.index + 1} 文本匹配位置不对`);
	}
});

test("无标记序号时直接走文本匹配", () => {
	const { tui, entries, scrollView } = buildSession(SCRIPT);
	const questions = collectQuestionsFromEntries(entries);
	const lines = transcriptLines(tui);
	const q = questions[4];
	const row = rowOfQuestion(lines, q.text, 0);

	assert.equal(jumpToQuestion(tui, { markerOrdinal: null, text: q.text, summary: q.summary, occurrence: 0 }), true);
	assert.equal(scrollView.scrollTop, expectedScrollTop(lines, row));
	assert.ok(normalizeMatchText(q.text).length > 0);
});

/** 各种形态的 assistant 消息：标记规则必须与真实组件一致，否则之后所有序号都会偏移。 */
const ODD_ASSISTANTS: { name: string; step: Step }[] = [
	{ name: "空 content", step: { assistant: [] } },
	{ name: "纯空白 text", step: { assistant: text("   \n ") } },
	{ name: "纯空白 thinking", step: { assistant: [{ type: "thinking", thinking: "  " }] } },
	{ name: "只有 thinking", step: { assistant: [{ type: "thinking", thinking: "pondering the problem" }] } },
	{ name: "aborted 且无内容", step: { assistant: [], stopReason: "aborted" } },
	{ name: "error 且无内容", step: { assistant: [], stopReason: "error" } },
	{ name: "length 截断且无内容", step: { assistant: [], stopReason: "length" } },
];

for (const { name, step } of ODD_ASSISTANTS) {
	test(`标记规则与真实组件一致：${name}`, () => {
		const script: Step[] = [{ user: "before odd message" }, step, { user: "after odd message" }, { assistant: text(body("final reply")) }];
		const { tui, entries } = buildSession(script);
		const lines = transcriptLines(tui);
		const rows = markerRows(lines);

		for (const q of collectQuestionsFromEntries(entries)) {
			const ordinal = markerOrdinal(entries, q.index);
			const actual = firstTextFrom(lines, rows[ordinal]);
			assert.equal(actual, q.summary, `「${name}」之后 Q${q.index + 1} 的标记序号 ${ordinal} 指向了 "${actual}"`);
		}
	});
}

test("标记序号错位时，jumpToQuestion 退回文本匹配并落在正确位置", () => {
	const { tui, entries, scrollView } = buildSession(SCRIPT);
	const questions = collectQuestionsFromEntries(entries);
	const lines = transcriptLines(tui);

	const target = questions[0];
	const wrongOrdinal = markerOrdinal(entries, 2); // 故意用 Q3 的标记序号，模拟 pi 改了标记规则
	scrollView.scrollTo(0, { disableFollow: true });

	// 直接用错位序号走标记法：必须拒绝（返回 false），且不能滚动
	assert.equal(jumpToMarker(tui, wrongOrdinal, target.summary), false);
	assert.equal(scrollView.scrollTop, 0, "校验失败时不应滚动");

	// 统一入口：标记法被拒后，文本匹配兜底落在 Q1
	const ok = jumpToQuestion(tui, {
		markerOrdinal: wrongOrdinal,
		text: target.text,
		summary: target.summary,
		occurrence: 0,
	});
	assert.equal(ok, true);
	assert.equal(scrollView.scrollTop, expectedScrollTop(lines, rowOfQuestion(lines, target.text, 0)));
});

// ---------------------------------------------------------------------------
// 审查文档 R1–R3 与测试盲区（P4）
// ---------------------------------------------------------------------------

const skillText = (extra?: string): string =>
	`<skill name="review" location="/skills/review/SKILL.md">\nSKILL BODY\n</skill>${extra === undefined ? "" : `\n\n${extra}`}`;

/** 对每条提问：标记法落点正确、文本匹配兜底落点正确。 */
function assertEveryQuestionJumps(script: Step[], label: string): { questions: QuestionItem[] } {
	const { tui, entries, scrollView } = buildSession(script);
	const questions = collectQuestionsFromEntries(entries);
	assert.ok(questions.length > 0, `${label}: 没有提问`);
	const lines = transcriptLines(tui);
	const rows = markerRows(lines);

	for (const q of questions) {
		const ordinal = markerOrdinal(entries, q.index);
		// 标记序号指向的组件，首条文字必须是这条提问的首行（独立于被测的校验逻辑）
		assert.equal(firstTextFrom(lines, rows[ordinal]), q.summary, `${label}: Q${q.index + 1} 标记序号错位`);

		scrollView.scrollTo(0, { disableFollow: true });
		const ok = jumpToQuestion(tui, {
			markerOrdinal: ordinal,
			text: q.text,
			summary: q.summary,
			occurrence: occurrenceOf(questions, q.index),
		});
		assert.equal(ok, true, `${label}: Q${q.index + 1} 跳转失败`);
		assert.equal(scrollView.scrollTop, expectedScrollTop(lines, rows[ordinal]), `${label}: Q${q.index + 1} 落点不对`);
	}
	return { questions };
}

test("skill 消息：有附加文本的按附加文本跳转，skill-only 不进列表，且不让之后的序号漂移 (R2/R3)", () => {
	const { questions } = assertEveryQuestionJumps(
		[
			{ user: "plain question" },
			{ assistant: text(body("reply one")) },
			{ user: skillText("please review this") },
			{ assistant: text(body("reply two")) },
			{ user: skillText() }, // skill-only：只渲染 SkillInvocationMessageComponent，没有标记
			{ assistant: text(body("reply three")) },
			{ user: "question after skill" },
			{ assistant: text(body("reply four")) },
		],
		"skill",
	);
	assert.deepEqual(
		questions.map((q) => q.text),
		["plain question", "please review this", "question after skill"],
	);
});

test("用户消息形态：多段 text 拼接、图片+文本、纯图片 (P4-3)", () => {
	const { questions } = assertEveryQuestionJumps(
		[
			{ userContent: [{ type: "text", text: "part one " }, { type: "text", text: "part two" }] },
			{ assistant: text(body("reply one")) },
			{ userContent: [{ type: "image", data: "x", mimeType: "image/png" }] }, // 纯图片：不渲染、不进列表
			{ assistant: text(body("reply two")) },
			{ userContent: [{ type: "image", data: "x", mimeType: "image/png" }, { type: "text", text: "with image" }] },
			{ assistant: text(body("reply three")) },
		],
		"content-shapes",
	);
	// 多段 text 与 pi 一样直接拼接，不加换行
	assert.deepEqual(
		questions.map((q) => q.text),
		["part one part two", "with image"],
	);
});

test("跨角色相同首行：assistant 回复与提问首行相同，两条路径都不跳错 (P4-4)", () => {
	assertEveryQuestionJumps(
		[
			{ user: "echo this line" },
			{ assistant: text("echo this line") },
			{ user: "second" },
			{ assistant: text("echo this line\n\nmore") },
			{ user: "echo this line" },
			{ assistant: text(body("reply")) },
		],
		"cross-role",
	);
});

test("压缩后的活动上下文：列表、标记序号与渲染一致 (P4-5)", () => {
	// pi 只渲染压缩后的活动上下文：这里只给 transcript 渲染保留区间，entries 用 activeContextEntries 推导
	const full: SessionEntryLike[] = [
		{ id: "old1", type: "message", message: { role: "user", content: text("old question") } },
		{ id: "oldA", type: "message", message: { role: "assistant", content: text("old reply") } },
		{ id: "keep1", type: "message", message: { role: "user", content: text("kept question") } },
		{ id: "keepA", type: "message", message: { role: "assistant", content: text(body("kept reply")) } },
		{ id: "c1", type: "compaction", firstKeptEntryId: "keep1", summary: "s" },
		{ id: "new1", type: "message", message: { role: "user", content: text("new question") } },
		{ id: "newA", type: "message", message: { role: "assistant", content: text(body("new reply")) } },
	];
	const active = activeContextEntries(full);
	assert.deepEqual(
		active.filter((e) => e.type === "message").map((e) => e.id),
		["keep1", "keepA", "new1", "newA"],
	);
	const script: Step[] = active
		.filter((e) => e.type === "message")
		.map((entry) => {
			const message = entry.message ?? {};
			const content = (message.content ?? []) as Part[];
			// 这些消息都是单段文本：取首段 text（等同 pi 的 getUserMessageText）
			return message.role === "user" ? { user: content[0]?.text ?? "" } : { assistant: content };
		});
	const { questions } = assertEveryQuestionJumps(script, "compaction");
	assert.deepEqual(
		questions.map((q) => q.text),
		["kept question", "new question"],
	);
});

test("jumpToMarker：正确序号通过校验，错位序号被拒；实际文字比提问更长的错位也被拒 (R1)", () => {
	const { tui, entries, scrollView } = buildSession([
		{ user: "hello" },
		{ assistant: text(bigBody("reply")) },
		{ user: "hello world, and a longer second question" },
		{ assistant: text(bigBody("reply two")) },
	]);
	const questions = collectQuestionsFromEntries(entries);

	// 正确序号 + 校验：通过并滚动
	scrollView.scrollTo(0, { disableFollow: true });
	assert.equal(jumpToMarker(tui, markerOrdinal(entries, 1), questions[1].summary), true);
	assert.ok(scrollView.scrollTop > 0, "正确序号应当滚动");

	// 目标 "hello"，但序号指向 "hello world, ..."（以目标为前缀的更长文字）：必须拒绝
	scrollView.scrollTo(0, { disableFollow: true });
	assert.equal(jumpToMarker(tui, markerOrdinal(entries, 1), "hello"), false);
	assert.equal(scrollView.scrollTop, 0, "被拒绝时不应滚动");
});

test("文本匹配兜底单独验证：assistant 回复与提问首行相同时不跳到回复上 (P4-4)", () => {
	const { tui, entries, scrollView } = buildSession([
		{ user: "echo this line" },
		{ assistant: text("echo this line\n\n" + bigBody("a1")) },
		{ user: "second" },
		{ assistant: text(bigBody("a2")) },
		{ user: "echo this line" },
		{ assistant: text(bigBody("a3")) },
	]);
	const questions = collectQuestionsFromEntries(entries);
	const lines = transcriptLines(tui);
	const rows = markerRows(lines);

	for (const q of questions) {
		// 期望落点：提问的文字行（跳过 assistant 回复里的同文行）。重复提问用 nth 区分；
		// 提问文字行 = 该提问标记行之后的第一条文字行
		const markerRow = rows[markerOrdinal(entries, q.index)];
		let textRow = markerRow;
		while (textRow < lines.length && !strip(lines[textRow]).trim()) textRow++;
		const expected = expectedScrollTop(lines, textRow);

		scrollView.scrollTo(0, { disableFollow: true });
		// 直接调兜底，不经过标记法
		assert.equal(jumpToQuestionText(tui, q.text, occurrenceOf(questions, q.index)), true, `Q${q.index + 1} 兜底失败`);
		assert.equal(scrollView.scrollTop, expected, `Q${q.index + 1} 兜底落在了错误位置（可能是 assistant 回复）`);
	}
});
