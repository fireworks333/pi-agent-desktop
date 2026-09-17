/**
 * Dependency-free shapes for the subagent activity panel.
 *
 * These live in their own module on purpose: the client renders this data, and
 * importing `./tool` (or anything that reaches the pi SDK) from a component
 * would drag the whole agent runtime into the browser bundle.
 */

/** Tool name used on both sides of the wire to identify a subagent dispatch. */
export const SUBAGENT_TOOL_NAME = "subagent";

/** One worker tool invocation, as shown in the activity timeline. */
export interface SubagentToolEvent {
  seq: number;
  name: string;
  /** Short single-line description, e.g. the bash command or the file path. */
  summary: string;
  status: "running" | "ok" | "error";
}

export interface SubagentActivityDetails {
  model: { provider: string; modelId: string };
  modelSource: "configured" | "inherited";
  cwd: string;
  /** The delegated task, truncated. Shown as the row title in the activity list. */
  task: string;
  status: "running" | "done" | "failed";
  /** Short human label for what the worker is doing right now. */
  phase: string;
  /** Tail of the worker's reasoning. Never rendered in the main transcript. */
  thinking: string;
  tools: SubagentToolEvent[];
  /** Tail of the worker's user-visible text output. */
  output: string;
  turns: number;
  /** Names only, in call order. */
  toolCalls: string[];
  outputChars: number;
  durationMs: number;
  tokens?: { input: number; output: number; total: number };
  costUsd?: number;
}

/** The live subagent state for one dispatch, keyed by tool call id. */
export interface SubagentActivity {
  toolCallId: string;
  details: SubagentActivityDetails;
  /** True once the dispatch settled, including failures. */
  finished: boolean;
  updatedAt: number;
}

/**
 * How many finished dispatches the activity list keeps.
 *
 * The list is a rolling log of what the workers did this session; keeping it
 * bounded stops a long session from growing an unbounded blob of reasoning in
 * client memory.
 */
export const MAX_TRACKED_DISPATCHES = 12;

/**
 * Merge one dispatch into the list, newest first.
 *
 * Running dispatch... entries sort above finished ones so the active worker is
 * always at the top, which is the one Jin actually wants to watch.
 */
export function upsertSubagentActivity(
  list: readonly SubagentActivity[],
  next: SubagentActivity,
): SubagentActivity[] {
  const without = list.filter((entry) => entry.toolCallId !== next.toolCallId);
  const merged = [next, ...without];
  merged.sort((a, b) => {
    const aRunning = !a.finished ? 1 : 0;
    const bRunning = !b.finished ? 1 : 0;
    if (aRunning !== bRunning) return bRunning - aRunning;
    return b.updatedAt - a.updatedAt;
  });
  return merged.slice(0, MAX_TRACKED_DISPATCHES);
}

/** First line of the task, trimmed for use as a row title. */
export function subagentTaskTitle(task: string): string {
  const firstLine = task.split("\n").find((line) => line.trim().length > 0) ?? "";
  const trimmed = firstLine.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed || "Dispatch";
}

/**
 * Narrow an unknown wire payload to subagent activity details.
 *
 * Note the wire carries the worker's own view of each dispatch; the task text
 * is added by the UI when the tool call starts, because the streamed `details`
 * payload is capped and deliberately omits it.
 */
export function readSubagentActivityDetails(value: unknown): SubagentActivityDetails | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const model = candidate.model as { provider?: unknown; modelId?: unknown } | undefined;
  if (!model || typeof model.provider !== "string" || typeof model.modelId !== "string") return null;
  if (typeof candidate.status !== "string") return null;

  const tools = Array.isArray(candidate.tools)
    ? candidate.tools.filter((entry): entry is SubagentToolEvent => {
        if (typeof entry !== "object" || entry === null) return false;
        const item = entry as Record<string, unknown>;
        return typeof item.name === "string" && typeof item.status === "string";
      })
    : [];

  return {
    model: { provider: model.provider, modelId: model.modelId },
    modelSource: candidate.modelSource === "inherited" ? "inherited" : "configured",
    cwd: typeof candidate.cwd === "string" ? candidate.cwd : "",
    task: typeof candidate.task === "string" ? candidate.task : "",
    status: candidate.status as SubagentActivityDetails["status"],
    phase: typeof candidate.phase === "string" ? candidate.phase : "",
    thinking: typeof candidate.thinking === "string" ? candidate.thinking : "",
    tools,
    output: typeof candidate.output === "string" ? candidate.output : "",
    turns: typeof candidate.turns === "number" ? candidate.turns : 0,
    toolCalls: Array.isArray(candidate.toolCalls)
      ? candidate.toolCalls.filter((name): name is string => typeof name === "string")
      : [],
    outputChars: typeof candidate.outputChars === "number" ? candidate.outputChars : 0,
    durationMs: typeof candidate.durationMs === "number" ? candidate.durationMs : 0,
    ...(candidate.tokens && typeof candidate.tokens === "object"
      ? { tokens: candidate.tokens as SubagentActivityDetails["tokens"] }
      : {}),
    ...(typeof candidate.costUsd === "number" ? { costUsd: candidate.costUsd } : {}),
  };
}
