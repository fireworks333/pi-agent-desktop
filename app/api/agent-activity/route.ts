import { NextResponse } from "next/server";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentActivityEntry, AgentActivityReport } from "@/lib/agent-activity-types";
import { AGENT_ACTIVITY_WINDOW_SECONDS } from "@/lib/agent-activity-types";

export const dynamic = "force-dynamic";

/**
 * Who else might be editing right now.
 *
 * Deliberately excludes pi's own footprints: `~/.agents` is pi's trusted skills
 * root and `.pi/` is pi's own config directory, so counting them would make the
 * indicator always-on and therefore useless.
 */
const KNOWN_AGENTS: {
  label: string;
  dirs: string[];
  processes: string[];
}[] = [
  { label: "Claude Code", dirs: [".claude"], processes: ["claude"] },
  { label: "Codex", dirs: [".codex"], processes: ["codex"] },
  { label: "Trae", dirs: [".trae"], processes: ["trae"] },
  { label: "ZCode", dirs: [".zcode"], processes: ["zcode", "z-code"] },
  { label: "MindFS", dirs: [".mindfs"], processes: ["mindfs"] },
  { label: "Cursor", dirs: [".cursor"], processes: ["cursor"] },
  { label: "opencode", dirs: [".opencode"], processes: ["opencode"] },
  { label: "Gemini CLI", dirs: [".gemini"], processes: ["gemini"] },
  { label: "Aider", dirs: [".aider"], processes: ["aider"] },
  { label: "Continue", dirs: [".continue"], processes: [] },
];

const MAX_ENTRIES_PER_DIR = 3000;
const MAX_DEPTH = 4;

const isWindows = process.platform === "win32";

/** Newest modification time under a directory, bounded in breadth and depth. */
function newestMtime(root: string): { path: string; mtimeMs: number } | null {
  let newest: { path: string; mtimeMs: number } | null = null;
  let budget = MAX_ENTRIES_PER_DIR;
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];

  while (stack.length > 0 && budget > 0) {
    const { dir, depth } = stack.pop() as { dir: string; depth: number };
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (budget <= 0) break;
      budget -= 1;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      try {
        const mtimeMs = statSync(full).mtimeMs;
        if (!newest || mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs };
      } catch {
        continue;
      }
    }
  }

  return newest;
}

/** Running processes whose executable name matches one of the known agents. */
function runningProcessNames(): Set<string> {
  const names = new Set<string>();
  try {
    if (isWindows) {
      const result = spawnSync("tasklist", ["/FO", "CSV", "/NH"], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      for (const line of String(result.stdout ?? "").split(/\r?\n/)) {
        const match = /^"([^"]+)"/.exec(line.trim());
        if (match) names.add(match[1].toLowerCase());
      }
    } else {
      const result = spawnSync("ps", ["-A", "-o", "comm="], {
        encoding: "utf8",
        timeout: 5000,
      });
      for (const line of String(result.stdout ?? "").split(/\r?\n/)) {
        const name = line.trim().split("/").pop();
        if (name) names.add(name.toLowerCase());
      }
    }
  } catch {
    // A missing process lister just means the file signal carries the report.
  }
  return names;
}

/** Git lock files mean a checkout, merge, or commit is in flight. */
function findGitLocks(cwd: string): string[] {
  const locks: string[] = [];
  for (const candidate of [join(cwd, ".git"), join(cwd, "..", ".git")]) {
    if (!existsSync(candidate)) continue;
    try {
      if (!statSync(candidate).isDirectory()) continue;
      for (const entry of readdirSync(candidate)) {
        if (entry.endsWith(".lock")) locks.push(join(candidate, entry));
      }
    } catch {
      continue;
    }
  }
  return locks;
}

export async function GET(req: Request) {
  const requestedCwd = new URL(req.url).searchParams.get("cwd") || process.cwd();
  const cwd = requestedCwd;
  const windowMs = AGENT_ACTIVITY_WINDOW_SECONDS * 1000;
  const now = Date.now();

  try {
    if (!existsSync(cwd)) {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    const processes = runningProcessNames();
    const home = homedir();
    const agents: AgentActivityEntry[] = [];

    for (const agent of KNOWN_AGENTS) {
      let best: AgentActivityEntry | null = null;

      for (const dirName of agent.dirs) {
        // Project-local first, then the user-level state directory.
        for (const root of [join(cwd, dirName), join(home, dirName)]) {
          if (!existsSync(root)) continue;
          const newest = newestMtime(root);
          if (!newest) continue;
          const ageMs = now - newest.mtimeMs;
          if (ageMs > windowMs) continue;
          if (!best || ageMs < best.ageMs) {
            best = {
              label: agent.label,
              source: root,
              kind: "file",
              ageMs,
              detail: newest.path,
            };
          }
        }
      }

      // A live process counts even when it has not written recently: that is
      // exactly the window where it might write next.
      const liveProcess = agent.processes.find((name) => processes.has(name));
      if (liveProcess && (!best || best.ageMs > windowMs)) {
        best = {
          label: agent.label,
          source: `process ${liveProcess}`,
          kind: "process",
          ageMs: best?.ageMs ?? 0,
          detail: `running process: ${liveProcess}`,
        };
      }

      if (best) agents.push(best);
    }

    agents.sort((a, b) => a.ageMs - b.ageMs);

    const report: AgentActivityReport = {
      windowSeconds: AGENT_ACTIVITY_WINDOW_SECONDS,
      agents,
      gitLocks: findGitLocks(cwd),
      scannedAt: new Date(now).toISOString(),
    };

    return NextResponse.json(report);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
