/**
 * Client-safe shapes for the concurrent-agent detector.
 *
 * Kept separate from the scanner itself: the scanner reads the filesystem and
 * the process table, neither of which can be pulled into a browser bundle.
 */

/** One agent that looks active, and why we think so. */
export interface AgentActivityEntry {
  /** Display name, e.g. "Claude Code". */
  label: string;
  /** Directory or process this signal came from. */
  source: string;
  /** Signal kind, so the UI can explain itself. */
  kind: "process" | "file";
  /** Milliseconds since the newest evidence. */
  ageMs: number;
  /** Newest evidence path or process name, for the tooltip. */
  detail: string;
}

export interface AgentActivityReport {
  /** Seconds an agent counts as "still active" after its newest write. */
  windowSeconds: number;
  /** Newest-per-agent, most recent first. */
  agents: AgentActivityEntry[];
  /** Git lock files, which mean a checkout or commit is in flight. */
  gitLocks: string[];
  /** ISO timestamp of when the scan ran. */
  scannedAt: string;
}

export const AGENT_ACTIVITY_WINDOW_SECONDS = 180;

export function hasActiveAgents(report: AgentActivityReport | null): boolean {
  return Boolean(report && (report.agents.length > 0 || report.gitLocks.length > 0));
}

export function describeAgentActivity(report: AgentActivityReport | null): string {
  if (!report) return "No scan yet";
  if (!hasActiveAgents(report)) return "No other agent activity detected";
  const parts: string[] = [];
  if (report.agents.length > 0) {
    parts.push(`${report.agents.length} other agent${report.agents.length === 1 ? "" : "s"}`);
  }
  if (report.gitLocks.length > 0) parts.push(`${report.gitLocks.length} git lock${report.gitLocks.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
