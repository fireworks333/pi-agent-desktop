import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
// Relative, not "@/lib/atomic-file": this module is reached from rpc-manager,
// which the node test runner loads through jiti with no tsconfig path aliases.
// A value import through `@/` resolves in Next but throws MODULE_NOT_FOUND there.
import { writePrivateFileAtomicSync } from "../atomic-file";

/**
 * The model a delegated worker runs on.
 *
 * Provider plus model id, the same pair `set_model` commands and session
 * model-change entries use, so it can be resolved straight against
 * `ModelRuntime.getModel()`.
 */
export interface SubagentWorkerModel {
  provider: string;
  modelId: string;
}

/**
 * Subagent (worker) configuration.
 *
 * A `null` workerModel means "inherit whatever model the dispatching session is
 * on" — the pre-existing SDK behaviour for an agent definition that omits
 * `model`. That keeps the feature inert until the user actually picks a model,
 * rather than silently switching delegation to some default.
 */
export interface SubagentConfig {
  workerModel: SubagentWorkerModel | null;
  /**
   * When true, the main model is told to prefer delegating tasks to the worker
   * instead of doing them inline.
   *
   * This only changes the guidance baked into a session's tool definition, so a
   * session created before the flag was set keeps its old guidance until it is
   * recreated.
   */
  autoDispatch: boolean;
}

const CONFIG_FILE_NAME = "subagent-config.json";

export const DEFAULT_SUBAGENT_CONFIG: SubagentConfig = { workerModel: null, autoDispatch: false };

export function getSubagentConfigPath(): string {
  return join(getAgentDir(), CONFIG_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accept only a well-formed provider/modelId pair.
 *
 * This file is user-editable and is read on every tool invocation, so a
 * malformed or partially-written file must degrade to "inherit the session
 * model" instead of throwing inside a tool call.
 */
export function normalizeSubagentConfig(value: unknown): SubagentConfig {
  if (!isRecord(value)) return { workerModel: null, autoDispatch: false };

  const autoDispatch = value.autoDispatch === true;

  const rawWorker = value.workerModel;
  if (!isRecord(rawWorker)) return { workerModel: null, autoDispatch };

  const provider = typeof rawWorker.provider === "string" ? rawWorker.provider.trim() : "";
  const modelId = typeof rawWorker.modelId === "string" ? rawWorker.modelId.trim() : "";
  if (!provider || !modelId) return { workerModel: null, autoDispatch };

  return { workerModel: { provider, modelId }, autoDispatch };
}

export function readSubagentConfig(): SubagentConfig {
  const configPath = getSubagentConfigPath();
  if (!existsSync(configPath)) return { workerModel: null, autoDispatch: false };

  try {
    return normalizeSubagentConfig(JSON.parse(readFileSync(configPath, "utf8")));
  } catch {
    return { workerModel: null, autoDispatch: false };
  }
}

export function writeSubagentConfig(config: SubagentConfig): void {
  const agentDir = getAgentDir();
  mkdirSync(agentDir, { recursive: true });
  writePrivateFileAtomicSync(
    getSubagentConfigPath(),
    `${JSON.stringify(config, null, 2)}\n`,
  );
}
