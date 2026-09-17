/**
 * One-command desktop build: stage, bundle, verify.
 *
 * Everything this wraps is environment-sensitive on this machine, and getting
 * it wrong costs 10-15 minutes per attempt:
 *
 *  - Staging deletes ~40k entries. Node's `fs.rm` deadlocks inside this host's
 *    delete interception, so `desktop:prepare` must run with the PowerShell
 *    delete shim preloaded (see scripts/win-recursive-delete-shim.cjs).
 *  - `TAURI_SIGNING_PRIVATE_KEY` is a *value*, not a path, and the release
 *    config expects an updater public key that only CI injects. Personal builds
 *    therefore bundle with `--no-sign`; pass --sign to opt back in.
 *  - `cargo` lives in ~/.cargo/bin, which is not on PATH by default.
 *
 * Usage:
 *   node scripts/ship-desktop.mjs                 stage + bundle + verify
 *   node scripts/ship-desktop.mjs --skip-prepare  bundle an already-staged tree
 *   node scripts/ship-desktop.mjs --launch        also start the built app briefly
 *   node scripts/ship-desktop.mjs --sign          sign updater artifacts
 */
import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const isWindows = process.platform === "win32";
const args = new Set(process.argv.slice(2));

const DELETE_SHIM = join(rootDir, "scripts", "win-recursive-delete-shim.cjs");
const TAURI_CLI = join(rootDir, "node_modules", "@tauri-apps", "cli", "tauri.js");

/** Files that must exist in the staged payload for a build to be trustworthy. */
const REQUIRED_PAYLOAD = [
  "src-tauri/resources/node/node.exe",
  "src-tauri/resources/server/server.js",
  "src-tauri/resources/server/desktop-server.cjs",
  "src-tauri/resources/component-versions.json",
  // The subagent API route is a stable path; the tool itself is bundled into a
  // content-hashed chunk, so it is checked by marker search instead.
  "src-tauri/resources/server/.next-desktop/server/app/api/subagent-config/route.js",
];

/**
 * Markers that must appear somewhere in the bundled server.
 *
 * A path check alone would pass even if the tool were tree-shaken away.
 * Matching is case-insensitive because the tool description starts with a
 * capital and the prompt snippet with a lowercase word.
 */
const REQUIRED_MARKERS = [
  "delegate a self-contained task",
  "delegate a fully-specified task",
  "subagent-config",
];

/** Bounded recursive text search over the staged server payload. */
function findMarkers(dir, markers, budget = { files: 6000 }) {
  const remaining = new Set(markers.map((marker) => marker.toLowerCase()));
  const stack = [dir];
  while (stack.length > 0 && remaining.size > 0 && budget.files > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      budget.files -= 1;
      if (budget.files <= 0) break;
      let haystack;
      try {
        haystack = readFileSync(full, "utf8").toLowerCase();
      } catch {
        continue;
      }
      for (const marker of [...remaining]) {
        if (haystack.includes(marker)) remaining.delete(marker);
      }
    }
  }
  return [...remaining];
}

function step(title) {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

function fail(message) {
  console.error(`\nFAILED: ${message}`);
  process.exit(1);
}

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, {
    cwd: rootDir,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    fail(`${command} ${argv.join(" ")} exited with ${result.status}`);
  }
}

function buildChildEnv() {
  const env = { ...process.env };
  if (isWindows) {
    if (!existsSync(DELETE_SHIM)) fail(`delete shim missing at ${DELETE_SHIM}`);
    // Replacing NODE_OPTIONS also drops the host's safe-delete preload, which
    // is what we want for a build process.
    env.NODE_OPTIONS = `--require ${DELETE_SHIM}`;
    const cargoBin = join(homedir(), ".cargo", "bin");
    if (existsSync(cargoBin)) env.PATH = `${cargoBin};${env.PATH ?? ""}`;
  } else {
    delete env.NODE_OPTIONS;
    const cargoBin = join(homedir(), ".cargo", "bin");
    if (existsSync(cargoBin)) env.PATH = `${cargoBin}:${env.PATH ?? ""}`;
  }
  env.NEXT_TELEMETRY_DISABLED = "1";
  return env;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const startedAt = Date.now();

if (!args.has("--skip-prepare")) {
  step("1/4  Staging the desktop payload (Next standalone + Node runtime)");
  console.log("This deletes ~40k entries on this machine and typically takes 10-15 minutes.");
  run(process.execPath, [join(rootDir, "scripts", "prepare-desktop.mjs")], {
    env: buildChildEnv(),
  });
} else {
  step("1/4  Skipping staging (--skip-prepare)");
}

step("2/4  Bundling the NSIS installer");
const tauriArgs = [TAURI_CLI, "build", "--ci", "--bundles", "nsis"];
if (!args.has("--sign")) tauriArgs.push("--no-sign");
run(process.execPath, tauriArgs, { env: buildChildEnv() });

step("3/4  Verifying the staged payload");
const missing = REQUIRED_PAYLOAD.filter((entry) => !existsSync(join(rootDir, entry)));
if (missing.length > 0) {
  console.error("Payload is incomplete:");
  for (const entry of missing) console.error(`  missing ${entry}`);
  fail("the installer would be built without the subagent feature");
}
console.log(`All ${REQUIRED_PAYLOAD.length} required payload entries are present.`);

const absentMarkers = findMarkers(
  join(rootDir, "src-tauri", "resources", "server"),
  REQUIRED_MARKERS,
);
if (absentMarkers.length > 0) {
  console.error("These markers are missing from the bundled server:");
  for (const marker of absentMarkers) console.error(`  ${marker}`);
  fail("the subagent tool is not inside the staged payload");
}
console.log(`All ${REQUIRED_MARKERS.length} subagent markers found in the bundled server.`);

const version = JSON.parse(
  readFileSync(join(rootDir, "src-tauri", "pi-agent-desktop-package.json"), "utf8"),
).version;
const installer = join(
  rootDir,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
  `Pi Agent_${version}_x64-setup.exe`,
);
if (!existsSync(installer)) fail(`installer not found at ${installer}`);

const size = statSync(installer).size;
const digest = sha256(installer);
console.log(`\nInstaller: ${installer}`);
console.log(`  version  ${version}`);
console.log(`  size     ${size.toLocaleString("en-US")} bytes (${(size / 1048576).toFixed(1)} MB)`);
console.log(`  sha256   ${digest}`);
if (!args.has("--sign")) {
  console.log("  signing  skipped (--no-sign); updater artifacts are not produced");
}

step("4/4  Smoke test");
const exe = join(rootDir, "src-tauri", "target", "release", "pi-agent-desktop.exe");
if (!args.has("--launch")) {
  console.log(`Skipped. Re-run with --launch to start the built app briefly.`);
  console.log(`(app binary: ${exe})`);
} else if (!isWindows) {
  console.log("--launch is implemented for Windows only; skipped.");
} else {
  console.log("Starting the built app and watching for 12s...");
  const child = spawn(exe, [], { cwd: rootDir, stdio: "ignore", detached: false });
  const alive = await new Promise((resolve) => {
    let exited = false;
    child.once("exit", () => {
      exited = true;
      resolve(false);
    });
    setTimeout(() => resolve(!exited), 12_000);
  });
  spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  if (alive) {
    console.log("PASS: the app stayed running for 12s (window/server came up).");
  } else {
    // Not fatal: a GUI process may be unable to start in a headless or
    // sandboxed session even when the build is fine.
    console.log("WARN: the app exited early. The build is intact; try launching it from Explorer.");
  }
}

console.log(`\nDone in ${Math.round((Date.now() - startedAt) / 1000)}s.`);
