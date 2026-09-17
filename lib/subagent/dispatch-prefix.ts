/**
 * Per-turn delegation policy injected ahead of the user's message.
 *
 * The tool's `promptGuidelines` are part of the system prompt, which models
 * treat as background instruction and routinely ignore. Worse, those
 * guidelines are baked in once when the session is created, so toggling the
 * setting had no effect on an open session.
 *
 * Injecting the policy as the leading block of the user turn fixes both
 * problems: it is read fresh on every prompt (the toggle takes effect on the
 * next message), and models follow an instruction attached to the request far
 * more reliably than one buried in the system preamble.
 *
 * This block does not carry the enforcement on its own. `rpc-manager.ts`
 * removes the mutating tools from the session at the same time, so a model that
 * ignores the text still has no way to edit a file or run a command itself.
 * The text explains that situation rather than pretending to be a hard rule.
 */

import type { SubagentConfig } from "./config";

/**
 * Wrapping the policy in an XML-ish tag keeps models from reading it as part
 * of the request itself, and mirrors the convention most instruction-tuned
 * models were trained on.
 */
const OPEN_TAG = "<delegation-policy>";
const CLOSE_TAG = "</delegation-policy>";

/**
 * Build the policy block for one user turn, or null when delegation is off.
 *
 * Deliberately short: it is prepaid on every turn, including turns where the
 * user only asks a question and nothing gets dispatched.
 */
export function buildDelegationPrefix(config: SubagentConfig): string | null {
  if (!config.autoDispatch) return null;

  const modelLine = config.workerModel
    ? `The worker runs on ${config.workerModel.provider}/${config.workerModel.modelId}, separate from your own context.`
    : "The worker inherits your current model but keeps its own isolated context.";

  return [
    OPEN_TAG,
    "Delegation is ON: you are the orchestrator for this session, not the executor.",
    modelLine,
    "You do not have the tools to modify files or run commands. Every piece of work has to go to the `subagent` tool, and you act on what it reports back.",
    "So for each request, dispatch to `subagent` as your first action. Write `task` as a complete, self-contained spec — every file path, acceptance criterion, and constraint — because the worker cannot see this conversation and will not ask questions.",
    "Then review its report, verify the claims against the repository using your read-only tools, and summarize the result for the user.",
    "Respond inline only when the request is a pure question that needs no work, or needs this conversation's context to answer.",
    CLOSE_TAG,
  ].join("\n");
}

/** True when a prompt has already been prefixed, guarding against double injection. */
export function hasDelegationPrefix(message: string): boolean {
  return message.trimStart().startsWith(OPEN_TAG);
}

/** Prepend the policy block to a user message. */
export function applyDelegationPrefix(message: string, config: SubagentConfig): string {
  if (hasDelegationPrefix(message)) return message;
  const prefix = buildDelegationPrefix(config);
  if (!prefix) return message;
  return `${prefix}\n\n${message}`;
}

/**
 * Remove the policy block for display.
 *
 * The block is addressed to the model, not the person: showing it in the
 * transcript buries the user's own words under a wall of boilerplate. The
 * session file keeps the injected text, so later turns still see the policy.
 */
export function stripDelegationPrefix(message: string): string {
  const trimmed = message.trimStart();
  if (!trimmed.startsWith(OPEN_TAG)) return message;
  const closeIndex = trimmed.indexOf(CLOSE_TAG);
  if (closeIndex === -1) return message;
  return trimmed.slice(closeIndex + CLOSE_TAG.length).replace(/^[\r\n]+/, "");
}
