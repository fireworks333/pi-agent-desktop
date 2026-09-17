import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const agentEventsSource = await readFile(new URL("./[id]/events/route.ts", import.meta.url), "utf8");
const runningEventsSource = await readFile(new URL("./running/events/route.ts", import.meta.url), "utf8");
const eventWireSource = await readFile(new URL("../../../lib/agent-event-wire.ts", import.meta.url), "utf8");

test("agent SSE projects SDK events onto the fields consumed by the web client", () => {
  assert.match(eventWireSource, /OMITTED_EVENT_TYPES = new Set\(\["turn_start", "turn_end"\]\)/);
  assert.match(eventWireSource, /delete assistantMessageEvent\.partial/);
  // tool_execution_update carries the subagent's live details to the activity
  // panel. Only `details` crosses the wire, and anything over the cap is
  // dropped rather than truncated, so one tool cannot blow up the stream.
  assert.match(eventWireSource, /event\.type === "tool_execution_update"/);
  assert.match(eventWireSource, /details: partialResult\.details/);
  assert.match(eventWireSource, /MAX_TOOL_UPDATE_BYTES/);
  assert.match(eventWireSource, /event\.type === "agent_end"\) return \{ type: "agent_end" \}/);
  assert.match(agentEventsSource, /const clientEvent = projectAgentEventForClient\(event\)/);
});

test("SSE routes reuse one TextEncoder per stream", () => {
  for (const source of [agentEventsSource, runningEventsSource]) {
    assert.equal((source.match(/new TextEncoder\(\)/g) ?? []).length, 1);
    assert.match(source, /controller\.enqueue\(encoder\.encode\(text\)\)/);
    assert.match(source, /controller\.enqueue\(encoder\.encode\(":\\n\\n"\)\)/);
  }
});

test("SSE routes clean up safely when the response consumer cancels", () => {
  for (const source of [agentEventsSource, runningEventsSource]) {
    assert.match(source, /let dispose = \(\) => \{\}/);
    assert.match(source, /if \(closed\) return/);
    assert.match(source, /try \{ controller\.close\(\); \} catch/);
    assert.match(source, /cancel\(\) \{\s*dispose\(\);/);
  }
});
