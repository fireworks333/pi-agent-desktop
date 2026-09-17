import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  readSubagentActivityDetails,
  upsertSubagentActivity,
  subagentTaskTitle,
  MAX_TRACKED_DISPATCHES,
  SUBAGENT_TOOL_NAME,
} = await jiti.import("./activity.ts");

/** Minimal dispatch record factory — only the fields the ordering cares about. */
function dispatch(id, { running = false, at = 0 } = {}) {
  return { toolCallId: id, task: "", details: {}, finished: !running, updatedAt: at };
}

test("updates a dispatch in place instead of duplicating it", () => {
  const merged = upsertSubagentActivity(
    [dispatch("a"), dispatch("b")],
    dispatch("a", { running: true, at: 99 }),
  );
  assert.deepEqual(merged.map((entry) => entry.toolCallId), ["a", "b"]);
  assert.equal(merged.length, 2);
});

test("pins the running worker above finished ones regardless of recency", () => {
  const merged = upsertSubagentActivity(
    [dispatch("older-done", { at: 10 }), dispatch("still-going", { running: true, at: 1 })],
    dispatch("newest-done", { at: 999 }),
  );
  assert.deepEqual(merged.map((entry) => entry.toolCallId), [
    "still-going",
    "newest-done",
    "older-done",
  ]);
});

test("sorts settled dispatches newest first", () => {
  const merged = upsertSubagentActivity(
    [dispatch("second", { at: 20 })],
    dispatch("third", { at: 30 }),
  );
  assert.deepEqual(merged.map((entry) => entry.toolCallId), ["third", "second"]);
});

test("bounds the list so long sessions cannot accumulate worker reasoning", () => {
  let list = [];
  for (let i = 0; i < MAX_TRACKED_DISPATCHES + 5; i += 1) {
    list = upsertSubagentActivity(list, dispatch(`id-${i}`, { at: i }));
  }
  assert.equal(list.length, MAX_TRACKED_DISPATCHES);
  // The oldest forced out is the one with the smallest timestamp.
  assert.equal(list.some((entry) => entry.toolCallId === "id-0"), false);
});

test("uses the first non-blank task line as the row title", () => {
  assert.equal(subagentTaskTitle("\n\n  Refactor the parser  \nmore"), "Refactor the parser");
  assert.equal(subagentTaskTitle(""), "Dispatch");
  assert.equal(subagentTaskTitle("x".repeat(200)).length, 120);
});

const valid = {
  model: { provider: "PM", modelId: "cheap-model" },
  modelSource: "configured",
  cwd: "C:\\work",
  status: "running",
  phase: "thinking",
  thinking: "reasoning",
  tools: [
    { seq: 1, name: "bash", summary: "npm test", status: "ok" },
    { seq: 2, name: "read", summary: "app/page.tsx", status: "running" },
    { seq: 3, name: "broken" },
  ],
  output: "text",
  turns: 2,
  toolCalls: ["bash", "read"],
  outputChars: 4,
  durationMs: 1200,
};

test("the subagent tool name matches the wire contract", () => {
  assert.equal(SUBAGENT_TOOL_NAME, "subagent");
});

test("accepts a well-formed activity payload", () => {
  const parsed = readSubagentActivityDetails(valid);
  assert.equal(parsed?.model.modelId, "cheap-model");
  assert.equal(parsed?.status, "running");
  assert.equal(parsed?.thinking, "reasoning");
  assert.equal(parsed?.turns, 2);
});

test("drops tool entries that are not well formed", () => {
  const parsed = readSubagentActivityDetails(valid);
  assert.deepEqual(parsed?.tools.map((tool) => tool.name), ["bash", "read"]);
});

test("rejects payloads without a usable model or status", () => {
  assert.equal(readSubagentActivityDetails(null), null);
  assert.equal(readSubagentActivityDetails("nope"), null);
  assert.equal(readSubagentActivityDetails({ status: "running" }), null);
  assert.equal(readSubagentActivityDetails({ model: { provider: "PM" }, status: "running" }), null);
  assert.equal(readSubagentActivityDetails({ model: { provider: "PM", modelId: "m" } }), null);
});

test("tolerates missing optional fields", () => {
  const parsed = readSubagentActivityDetails({
    model: { provider: "PM", modelId: "m" },
    status: "done",
  });
  assert.equal(parsed?.thinking, "");
  assert.deepEqual(parsed?.tools, []);
  assert.equal(parsed?.turns, 0);
  assert.equal(parsed?.modelSource, "configured");
  assert.equal(parsed?.costUsd, undefined);
});

test("carries cost and token totals through when present", () => {
  const parsed = readSubagentActivityDetails({
    ...valid,
    status: "done",
    tokens: { input: 10, output: 20, total: 30 },
    costUsd: 0.0042,
  });
  assert.deepEqual(parsed?.tokens, { input: 10, output: 20, total: 30 });
  assert.equal(parsed?.costUsd, 0.0042);
});
