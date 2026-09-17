/**
 * Regression baseline for the test suite.
 *
 * `npm test` on Windows previously reported "1..0" because cmd.exe does not
 * strip single quotes, so the glob patterns reached node verbatim and matched
 * nothing. That is fixed, but the deeper problem remains: this machine has a
 * set of environment-dependent failures (Windows symlink behaviour, DOM-only
 * component renders, Mermaid) that have nothing to do with the code. Comparing
 * raw failure *counts* therefore proves nothing.
 *
 * This command compares the failing-test *set* against a recorded baseline and
 * reports what actually changed:
 *
 *   node scripts/test-baseline.mjs --save   record the current failures
 *   node scripts/test-baseline.mjs          report added / fixed against it
 *
 * Exit code is 1 when the run introduced failures the baseline did not have,
 * so it can gate a change.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const baselinePath = join(rootDir, ".test-baseline.json");
const SEARCH_DIRS = ["app", "lib", "scripts", "components", "hooks"];

function collectTestFiles(dir) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectTestFiles(full));
    } else if (entry.name.endsWith(".test.mjs")) {
      found.push(relative(rootDir, full).replaceAll("\\", "/"));
    }
  }
  return found;
}

const testFiles = SEARCH_DIRS.flatMap((dir) => collectTestFiles(join(rootDir, dir))).sort();

if (testFiles.length === 0) {
  console.error("No test files found — refusing to record an empty baseline.");
  process.exit(1);
}

console.log(`Running ${testFiles.length} test files...`);
const run = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: rootDir,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, NODE_OPTIONS: "" },
});

const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
const failing = [
  ...output.matchAll(/^not ok \d+ - (.+)$/gm),
].map((match) => match[1].replace(/\s+\(#\d+\)$/, "").trim()).sort();

const summary = /^# (tests|pass|fail) \d+$/gm;
const counts = Object.fromEntries(
  [...output.matchAll(/^# (tests|pass|fail) (\d+)$/gm)].map((m) => [m[1], Number(m[2])]),
);
void summary;

console.log(
  `Result: ${counts.tests ?? "?"} tests, ${counts.pass ?? "?"} passed, ${counts.fail ?? "?"} failed`,
);

if (process.argv.includes("--save")) {
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ savedAt: new Date().toISOString(), failing }, null, 2)}\n`,
  );
  console.log(`Saved ${failing.length} known failures to ${relative(rootDir, baselinePath)}`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
} catch {
  console.error(
    `No baseline recorded. Run \`node scripts/test-baseline.mjs --save\` on a known-good tree first.`,
  );
  process.exit(2);
}

const previous = new Set(baseline.failing ?? []);
const current = new Set(failing);

const added = [...current].filter((name) => !previous.has(name)).sort();
const fixed = [...previous].filter((name) => !current.has(name)).sort();

console.log(`\nBaseline recorded ${baseline.savedAt} with ${previous.size} failures.`);

if (added.length === 0 && fixed.length === 0) {
  console.log("No change in the failing set.");
  process.exit(0);
}

if (added.length > 0) {
  console.log(`\nNEW FAILURES (${added.length}) — these are regressions:`);
  for (const name of added) console.log(`  + ${name}`);
}
if (fixed.length > 0) {
  console.log(`\nFIXED (${fixed.length}) — these now pass:`);
  for (const name of fixed) console.log(`  - ${name}`);
}

process.exit(added.length > 0 ? 1 : 0);
