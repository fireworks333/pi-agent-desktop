import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { projectAgentEventForClient } = await jiti.import("./agent-event-wire.ts");

test("projects Pi SDK message updates to the 0.84 delta-only wire shape", () => {
  const partial = { role: "assistant", content: [{ type: "text", text: "Hello" }] };
  const event = {
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "o", partial },
  };

  assert.deepEqual(projectAgentEventForClient(event), {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "o" },
  });
  assert.equal(event.assistantMessageEvent.partial, partial, "projection must not mutate the SDK event");
});

test("omits noisy events and minimizes agent_end", () => {
  assert.equal(projectAgentEventForClient({ type: "turn_start" }), null);
  assert.equal(projectAgentEventForClient({ type: "turn_end" }), null);
  // No details means there is nothing for the activity panel to consume.
  assert.equal(
    projectAgentEventForClient({ type: "tool_execution_update", toolCallId: "c", toolName: "bash" }),
    null,
  );
  assert.deepEqual(
    projectAgentEventForClient({ type: "agent_end", messages: [{ role: "assistant" }], willRetry: false }),
    { type: "agent_end" },
  );
});

test("forwards tool_execution_update details without the rendered content array", () => {
  const details = { model: { provider: "PM", modelId: "cheap" }, status: "running", thinking: "step" };
  assert.deepEqual(
    projectAgentEventForClient({
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "subagent",
      partialResult: { content: [{ type: "text", text: "x".repeat(1000) }], details },
    }),
    { type: "tool_execution_update", toolCallId: "call-1", toolName: "subagent", details },
  );
});

test("drops an oversized tool update instead of truncating it", () => {
  const oversized = { thinking: "x".repeat(64 * 1024) };
  assert.equal(
    projectAgentEventForClient({
      type: "tool_execution_update",
      toolCallId: "call-2",
      toolName: "subagent",
      partialResult: { details: oversized },
    }),
    null,
  );
});
