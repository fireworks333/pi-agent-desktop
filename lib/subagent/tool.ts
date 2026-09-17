import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  defineTool,
  getAgentDir,
  initTheme,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readSubagentConfig, type SubagentConfig } from "./config";
import { SUBAGENT_TOOL_NAME } from "./activity";
import type { SubagentActivityDetails, SubagentToolEvent } from "./activity";

export { SUBAGENT_TOOL_NAME };

/**
 * How long the worker may run before the dispatch is treated as hung.
 *
 * A worker gets a full tool set and its own context window, so a legitimate
 * task can take minutes. This bound exists to stop a wedged provider call from
 * holding the parent turn open indefinitely, not to enforce a budget.
 */
const WORKER_TIMEOUT_MS = 30 * 60 * 1000;

/** Minimum gap between streamed progress updates, to avoid flooding the UI. */
const PROGRESS_THROTTLE_MS = 700;

const WORKER_PREAMBLE = [
  "You are the execution worker for a task delegated by a planning agent. It will review your report, so be precise and complete.",
  "Work to completion using your tools. Do not ask clarifying questions: if the task is ambiguous, choose the most reasonable reading, carry it out, and note the ambiguity under Open.",
  "Finish with a report in exactly this shape, under 200 words:",
  "Outcome: one line — done, partially done, or blocked.",
  "Changed: files created, edited, or deleted, with absolute paths.",
  "Verified: the exact commands you ran and what they printed.",
  "Open: anything the planner must decide or follow up on.",
  "Report facts. No narration of your process.",
].join("\n");

const SubagentParams = Type.Object({
  task: Type.String({
    description:
      "Complete, self-contained instruction for the worker. It cannot see this conversation, so include every path, constraint, and acceptance criterion it needs.",
  }),
  cwd: Type.Optional(
    Type.String({
      description:
        "Absolute working directory for the worker. Defaults to the dispatching session's cwd.",
    }),
  ),
});

export type { SubagentActivityDetails, SubagentToolEvent };

/**
 * Server-side name for the streamed activity payload.
 *
 * The shape is shared with the client through `./activity`, which is
 * dependency-free; this alias keeps the call sites in this file readable.
 */
export type SubagentDetails = SubagentActivityDetails;


/**
 * Size bounds for the streamed details payload.
 *
 * Every update crosses the SSE wire and is capped again in
 * `lib/agent-event-wire.ts`, so the running totals here must stay well under
 * that cap even for a worker that reasons for a long time.
 */
const THINKING_TAIL_CHARS = 8000;
const OUTPUT_TAIL_CHARS = 4000;
const MAX_TOOL_EVENTS = 60;
const TOOL_SUMMARY_CHARS = 160;
/**
 * Task text kept in `details` for the activity panel row title.
 *
 * The task is already in the transcript as the tool call argument; repeating a
 * bounded copy here lets the panel title each dispatch without the client
 * having to parse tool-call arguments back out of the message stream.
 */
const TASK_TITLE_CHARS = 400;

function tail(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(value.length - limit);
}

function head(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

/** Short, single-line description of a tool call for the activity timeline. */
function summarizeToolCall(toolName: string, args: unknown): string {
  const record = (args ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  };

  let detail = "";
  switch (toolName) {
    case "bash":
    case "powershell":
      detail = pick("command");
      break;
    case "read":
    case "write":
    case "edit":
      detail = pick("path", "file_path", "filePath");
      break;
    case "grep":
    case "ffgrep":
      detail = pick("pattern");
      break;
    case "find":
    case "fffind":
    case "ls":
      detail = pick("path", "pattern", "dir");
      break;
    default:
      detail = pick("path", "file_path", "command", "query", "pattern", "url");
  }

  if (!detail) {
    try {
      detail = JSON.stringify(args ?? {});
    } catch {
      detail = "";
    }
  }

  return detail.replace(/\s+/g, " ").trim().slice(0, TOOL_SUMMARY_CHARS);
}

function addUsage(total: Usage | undefined, next: Usage): Usage {
  if (!total) return next;
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    totalTokens: total.totalTokens + next.totalTokens,
    cost: {
      input: total.cost.input + next.cost.input,
      output: total.cost.output + next.cost.output,
      cacheRead: total.cost.cacheRead + next.cost.cacheRead,
      cacheWrite: total.cost.cacheWrite + next.cost.cacheWrite,
      total: total.cost.total + next.cost.total,
    },
  };
}

/**
 * Fold the worker's transcript into the counters shown in the tool card.
 *
 * Reading the transcript once at the end keeps the streaming listener free of
 * message-shape narrowing, which matters because AgentMessage is a wide union.
 */
function summarizeTranscript(messages: readonly unknown[]): {
  turns: number;
  usage: Usage | undefined;
} {
  let turns = 0;
  let usage: Usage | undefined;

  for (const entry of messages) {
    const candidate = entry as { role?: string; usage?: Usage };
    if (candidate.role !== "assistant") continue;
    turns += 1;
    if (candidate.usage) usage = addUsage(usage, candidate.usage);
  }

  return { turns, usage };
}

/**
 * Text for the tool card inside the main transcript.
 *
 * Deliberately short: status, model, current phase, and the most recent tool
 * names. The worker's reasoning and output live in `details` and are rendered
 * by the subagent activity panel, not here.
 */
function renderProgress(details: SubagentDetails): string {
  const lines: string[] = [];
  const suffix = details.modelSource === "configured" ? "" : ", inherited model";
  lines.push(`Subagent (${details.model.modelId}) — ${details.status}${suffix}`);

  const running = details.tools.filter((t) => t.status === "running");
  const label = running.length > 0 ? `running ${running.map((t) => t.name).join(", ")}` : details.phase;
  if (label) lines.push(label);

  if (details.toolCalls.length > 0) {
    const recent = details.toolCalls.slice(-6).join(", ");
    const extra = details.toolCalls.length > 6 ? ` (+${details.toolCalls.length - 6} more)` : "";
    lines.push(`Tools: ${recent}${extra}`);
  }

  return lines.join("\n");
}


/**
 * Build the delegation tool for one session.
 *
 * This is a factory rather than a module-level constant because
 * `promptGuidelines` is baked into the tool definition, and the "dispatch by
 * default" preference has to be reflected in that guidance. The caller reads
 * the config when the session is created; a session that already exists keeps
 * the guidance it was created with.
 *
 * The worker is a real in-process AgentSession: its own context window, its own
 * transcript, and its own model. Nothing here spawns a `pi` subprocess — the
 * desktop app ships no `pi` executable on PATH, and `process.argv[1]` under the
 * bundled Next.js server points at the server entry, so the subprocess
 * invocation shape used by the SDK's reference subagent example cannot work
 * here. Running in-process also means the worker inherits this app's auth,
 * models, skills, and project-trust decisions for free.
 */
export function createSubagentTool(config: SubagentConfig = readSubagentConfig()) {
  const promptGuidelines = [
    "Put every path, constraint, and acceptance criterion in the subagent task — the worker has no access to this conversation.",
    "After a subagent returns, verify its report against the repository before trusting it; the report describes intent, not guaranteed outcome.",
    ...(config.autoDispatch
      ? [
          "Delegation is enabled by default for this session: for any task that is fully specifiable and independently verifiable — multi-file edits, mechanical refactors, running a command suite, gathering facts — dispatch it to the subagent rather than doing it inline, then review the returned report before accepting it.",
          "Do not delegate trivial single-step questions, decisions that need this conversation's context, or work whose result you cannot check; those are cheaper to do directly.",
        ]
      : []),
  ];

  return defineTool({
    name: SUBAGENT_TOOL_NAME,
    label: "Subagent",
    description: [
      "Delegate a self-contained task to a worker agent that runs on a separate, cheaper model with its own isolated context window.",
      "Use it for work you can specify completely and then verify on return: bulk edits, mechanical refactors, repetitive file work, running a command suite and reporting results.",
      "The worker cannot see this conversation and will not ask questions, so put every path and acceptance criterion in `task`.",
      "It returns a structured report — outcome, changed files, verification output, open questions — which you then review before deciding whether to accept, correct, or re-dispatch.",
    ].join(" "),
    promptSnippet: "subagent: delegate a fully-specified task to a cheaper worker model with an isolated context",
    promptGuidelines,
    parameters: SubagentParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const dispatchConfig = readSubagentConfig();
      const workerCwd = params.cwd?.trim() || ctx.cwd;

      initTheme();
      const services = await createAgentSessionServices({
        cwd: workerCwd,
        agentDir: getAgentDir(),
    });

    let model = ctx.model;
    let modelSource: SubagentDetails["modelSource"] = "inherited";

    if (dispatchConfig.workerModel) {
      const configured = services.modelRuntime.getModel(
        dispatchConfig.workerModel.provider,
        dispatchConfig.workerModel.modelId,
      );
      if (!configured) {
        throw new Error(
          `Subagent model "${dispatchConfig.workerModel.provider}/${dispatchConfig.workerModel.modelId}" is not available. ` +
            "Pick another model for the subagent, or clear the setting to let it inherit the session model.",
        );
      }
      model = configured;
      modelSource = "configured";
    }

    if (!model) {
      throw new Error(
        "No model available for the subagent: none is configured and the dispatching session has no active model.",
      );
    }

    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(workerCwd),
      model,
      ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel as ThinkingLevel } : {}),
      // Keep the worker from recursively delegating to itself.
      excludeTools: [SUBAGENT_TOOL_NAME],
    });

    const startedAt = Date.now();
    const toolEvents: SubagentToolEvent[] = [];
    const runningToolSeqs = new Map<string, number>();
    let streamedText = "";
    let thinkingText = "";
    let phase = "starting";
    let status: SubagentDetails["status"] = "running";
    let lastEmit = 0;

    const details = (): SubagentDetails => ({
      model: { provider: model.provider, modelId: model.id },
      modelSource,
      cwd: workerCwd,
      task: head(params.task, TASK_TITLE_CHARS),
      status,
      phase,
      thinking: tail(thinkingText, THINKING_TAIL_CHARS),
      tools: toolEvents.map((entry) => ({ ...entry })),
      output: tail(streamedText, OUTPUT_TAIL_CHARS),
      turns: 0,
      toolCalls: toolEvents.map((entry) => entry.name),
      outputChars: streamedText.length,
      durationMs: Date.now() - startedAt,
    });

    const emit = (force: boolean) => {
      if (!onUpdate) return;
      const now = Date.now();
      if (!force && now - lastEmit < PROGRESS_THROTTLE_MS) return;
      lastEmit = now;
      const snapshot = details();
      onUpdate({ content: [{ type: "text", text: renderProgress(snapshot) }], details: snapshot });
    };

    const unsubscribe = session.subscribe((event) => {
      switch (event.type) {
        case "tool_execution_start": {
          const entry: SubagentToolEvent = {
            seq: toolEvents.length + 1,
            name: event.toolName,
            summary: summarizeToolCall(event.toolName, event.args),
            status: "running",
          };
          toolEvents.push(entry);
          runningToolSeqs.set(event.toolCallId, entry.seq);
          if (toolEvents.length > MAX_TOOL_EVENTS) toolEvents.splice(0, toolEvents.length - MAX_TOOL_EVENTS);
          phase = `running ${event.toolName}`;
          emit(true);
          break;
        }
        case "tool_execution_end": {
          const seq = runningToolSeqs.get(event.toolCallId);
          const entry = seq === undefined ? undefined : toolEvents.find((item) => item.seq === seq);
          if (entry) entry.status = event.isError ? "error" : "ok";
          runningToolSeqs.delete(event.toolCallId);
          phase = event.isError ? `${event.toolName} failed` : "reviewing results";
          emit(true);
          break;
        }
        case "message_update": {
          const inner = event.assistantMessageEvent;
          if (inner.type === "text_delta") {
            streamedText += inner.delta;
            phase = "writing";
            emit(false);
          } else if (inner.type === "thinking_delta") {
            thinkingText += inner.delta;
            phase = "thinking";
            emit(false);
          } else if (inner.type === "thinking_start") {
            phase = "thinking";
            emit(true);
          }
          break;
        }
        default:
          break;
      }
    });

    const abortWorker = () => {
      void session.abort();
    };
    if (signal) {
      if (signal.aborted) abortWorker();
      else signal.addEventListener("abort", abortWorker, { once: true });
    }
    const timeout = setTimeout(abortWorker, WORKER_TIMEOUT_MS);

    let output = "";
    let summary: ReturnType<typeof summarizeTranscript> = { turns: 0, usage: undefined };
    let failure: unknown;

    try {
      await session.prompt(`${WORKER_PREAMBLE}\n\n---\n\nTask:\n${params.task}`);
      output = (session.getLastAssistantText() ?? streamedText).trim();
      summary = summarizeTranscript(session.state.messages);
    } catch (error) {
      failure = error;
      output = streamedText.trim();
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortWorker);
      unsubscribe();
      session.dispose();
    }

    if (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      status = "failed";
      phase = "failed";
      emit(true);
      throw new Error(
        signal?.aborted
          ? "Subagent dispatch was aborted before the worker finished."
          : `Subagent failed: ${reason}`,
      );
    }

    status = "done";
    phase = "done";

    const finalDetails: SubagentDetails = {
      ...details(),
      turns: summary.turns,
      outputChars: output.length,
      durationMs: Date.now() - startedAt,
      ...(summary.usage
        ? {
            tokens: {
              input: summary.usage.input,
              output: summary.usage.output,
              total: summary.usage.totalTokens,
            },
            costUsd: summary.usage.cost.total,
          }
        : {}),
    };

    onUpdate?.({ content: [{ type: "text", text: renderProgress(finalDetails) }], details: finalDetails });

    if (!output) {
      throw new Error(
        "Subagent finished without producing a report. It may have hit its timeout or stopped early; re-dispatch with a narrower task.",
      );
    }

    return {
      content: [
        {
          type: "text",
          text: `${output}\n\n[subagent: ${finalDetails.model.provider}/${finalDetails.model.modelId}, ${finalDetails.turns} turns, $${(finalDetails.costUsd ?? 0).toFixed(4)}]`,
        },
      ],
      details: finalDetails,
    };
    },
  });
}
