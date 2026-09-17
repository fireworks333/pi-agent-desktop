import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface AgentEventLike {
  type: string;
  [key: string]: unknown;
}

type SdkMessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;

const OMITTED_EVENT_TYPES = new Set(["turn_start", "turn_end"]);

/**
 * Cap on a projected `tool_execution_update` payload.
 *
 * The SDK's event carries the tool's full `partialResult`, whose rendered
 * `content` array grows without bound on long-running tools — which is why
 * these updates were dropped from the wire entirely. Only `details` is
 * forwarded now, and the subagent tool keeps its own details small. This cap is
 * a backstop for any other tool that emits a large details object: over the
 * limit the update is dropped, which is the previous behaviour rather than a
 * new failure mode.
 */
const MAX_TOOL_UPDATE_BYTES = 48 * 1024;

/** Projects in-process SDK events onto Pi 0.84's linear-size JSON wire shape. */
export function projectAgentEventForClient(event: AgentEventLike): AgentEventLike | null {
  if (OMITTED_EVENT_TYPES.has(event.type)) return null;
  if (event.type === "message_update") {
    const sdkEvent = event as unknown as SdkMessageUpdateEvent;
    const assistantMessageEvent = { ...sdkEvent.assistantMessageEvent } as unknown as Record<string, unknown>;
    delete assistantMessageEvent.partial;
    return { type: "message_update", assistantMessageEvent };
  }
  if (event.type === "tool_execution_update") {
    // `partialResult.content` is the tool's own rendered output and is omitted;
    // `details` is the structured channel the UI reads.
    const partialResult = event.partialResult as { details?: unknown } | undefined;
    if (!partialResult || partialResult.details === undefined) return null;
    const projected: AgentEventLike = {
      type: "tool_execution_update",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      details: partialResult.details,
    };
    return JSON.stringify(projected).length > MAX_TOOL_UPDATE_BYTES ? null : projected;
  }
  if (event.type === "agent_end") return { type: "agent_end" };
  return event;
}
