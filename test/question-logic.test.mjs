import test from "node:test";
import assert from "node:assert/strict";
import {
	activeContextEntries,
	buildTurnFromEntries,
	collectQuestionsFromEntries,
	extractUserText,
	markerOrdinalFromEntries,
	normalizeMatchText,
} from "../question-logic.ts";

const text = (value) => [{ type: "text", text: value }];
const user = (id, content, timestamp = 42) => ({
	id,
	type: "message",
	message: { role: "user", content: typeof content === "string" ? text(content) : content, timestamp },
});
const assistant = (id, content, timestamp = 42) => ({
	id,
	type: "message",
	message: { role: "assistant", content, timestamp },
});
const toolCall = (id = "t1") => ({ type: "toolCall", id, name: "read", arguments: {} });
const compaction = (id, firstKeptEntryId) => ({ id, type: "compaction", firstKeptEntryId, summary: "s" });

test("no compaction: active context keeps branch order", () => {
	const branch = [user("u1", "hello"), assistant("a1", text("hi")), user("u2", "bye")];
	assert.deepEqual(activeContextEntries(branch).map((e) => e.id), ["u1", "a1", "u2"]);
	const questions = collectQuestionsFromEntries(branch);
	assert.deepEqual(questions.map((q) => q.summary), ["hello", "bye"]);
	assert.equal(markerOrdinalFromEntries(branch, 0), 0);
	// u1 标记 0，a1 无 toolCall 标记 1，u2 标记 2
	assert.equal(markerOrdinalFromEntries(branch, 1), 2);
});

test("compaction drops summarized prefix from list and marker ordinals", () => {
	const branch = [
		user("old", "old question"),
		assistant("oldA", text("old reply")),
		user("kept", "kept question"),
		compaction("c1", "kept"),
		assistant("newA", text("new reply")),
		user("new", "new question"),
	];
	const active = activeContextEntries(branch);
	assert.deepEqual(active.map((e) => e.id), ["c1", "kept", "newA", "new"]);

	const questions = collectQuestionsFromEntries(active);
	assert.deepEqual(questions.map((q) => q.summary), ["kept question", "new question"]);

	// 只统计活动上下文：kept=0，newA=1，new=2（按旧 branch 会算成 4）
	assert.equal(markerOrdinalFromEntries(active, 0), 0);
	assert.equal(markerOrdinalFromEntries(active, 1), 2);
});

test("compaction with missing firstKeptEntryId keeps only compaction + post entries", () => {
	const branch = [user("old", "old"), compaction("c1", "missing"), user("new", "new")];
	assert.deepEqual(activeContextEntries(branch).map((e) => e.id), ["c1", "new"]);
});

test("textless user messages (image-only/empty) are excluded and produce no marker", () => {
	const branch = [
		user("img", [{ type: "image", data: "abc" }]),
		user("empty", [""]),
		user("q1", "first"),
		assistant("a1", [toolCall()]),
		user("q2", "second"),
	];
	const questions = collectQuestionsFromEntries(branch);
	assert.deepEqual(questions.map((q) => q.summary), ["first", "second"]);
	// 无文本 user 不产生组件/标记；带 toolCall 的 assistant 也不产生
	assert.equal(markerOrdinalFromEntries(branch, 0), 0);
	assert.equal(markerOrdinalFromEntries(branch, 1), 1);
});

test("assistant markers follow the toolCall rule", () => {
	const branch = [
		user("u1", "q"),
		assistant("a1", [toolCall()]), // 无标记
		assistant("a2", text("answer")), // 标记
		user("u2", "q2"),
	];
	assert.equal(markerOrdinalFromEntries(branch, 1), 2);
});

test("buildTurn works on the active context and skips textless user messages", () => {
	const branch = [
		user("old", "old question"),
		assistant("oldA", text("old reply")),
		compaction("c1", "kept"),
		user("kept", "kept question"),
		assistant("a1", [{ type: "thinking", thinking: "hmm" }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } }, { type: "text", text: "partial" }]),
		{ id: "r1", type: "message", message: { role: "toolResult", toolCallId: "t1", content: text("ok"), isError: false } },
		user("img", [{ type: "image", data: "x" }]),
		user("next", "next question"),
	];
	const active = activeContextEntries(branch);
	const turn = buildTurnFromEntries(active, 0);
	assert.ok(turn);
	assert.equal(turn.question.summary, "kept question");
	assert.deepEqual(
		turn.nodes.map((n) => n.kind),
		["thinking", "tool", "text"],
	);
	assert.equal(turn.nodes[1].result, "ok");
	assert.equal(turn.nodes[1].isError, false);
	assert.equal(turn.nodes[2].isFinal, true);

	// 第二个提问是 next（跳过图片消息）
	const second = buildTurnFromEntries(active, 1);
	assert.ok(second);
	assert.equal(second.question.summary, "next question");
});

test("normalizeMatchText handles whitespace and unicode normalization", () => {
	assert.equal(normalizeMatchText("  Hello\n  World  "), "hello world");
	assert.equal(normalizeMatchText("ＡＢＣ　１２３"), "abc 123");
});

test("extractUserText joins text parts only", () => {
	assert.equal(extractUserText("raw"), "raw");
	assert.equal(
		extractUserText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]),
		"a\nb",
	);
	assert.equal(extractUserText([{ type: "image" }]), "");
});
