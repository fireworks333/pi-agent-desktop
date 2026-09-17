/* eslint-disable @typescript-eslint/no-require-imports --
 * Loaded with `node --require`, which only accepts CommonJS, so require() is
 * the only import form that works in this file. */
/**
 * Windows recursive-delete shim for the desktop packaging step.
 *
 * Why this exists: on this machine every file deletion is intercepted by the
 * host security layer that routes deletes through the Recycle Bin. That costs
 * roughly 9.5 ms per entry (creating is 0.48 ms), and Node's unlink-based
 * recursive `fs.rm` has been observed to deadlock outright inside that
 * interception — the process sits with a frozen CPU time and frozen I/O
 * counters, never completing. Windows' own delete APIs go through a different
 * path and complete, so the build routes its deletions through PowerShell.
 *
 * `cmd.exe /c rmdir` was tried first and fails here with "the filename,
 * directory name, or volume label syntax is incorrect" (exit 123), so the shim
 * drives .NET directly instead.
 *
 * Load it with:  NODE_OPTIONS="--require <abs path to this file>"
 * It intentionally replaces NODE_OPTIONS, which also drops the host's
 * safe-delete preload from the build process.
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawnSync } = require("node:child_process");

function pathExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function powerShellDelete(target) {
  // Single-quoted PowerShell string literal: only ' needs escaping.
  const literal = `'${target.replace(/'/g, "''")}'`;
  const isDirectory = pathExists(target) && fs.lstatSync(target).isDirectory();
  const script = isDirectory
    ? `[System.IO.Directory]::Delete(${literal}, $true)`
    : `[System.IO.File]::Delete(${literal})`;

  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, encoding: "utf8" },
  );
}

function nativeRemove(target, options) {
  const force = Boolean(options && options.force);

  if (typeof target !== "string") {
    throw new TypeError("recursive-delete shim only supports string paths");
  }
  if (!pathExists(target)) {
    if (force) return;
    const missing = new Error(`ENOENT: no such file or directory, rm '${target}'`);
    missing.code = "ENOENT";
    throw missing;
  }

  const result = powerShellDelete(target);

  if (pathExists(target)) {
    const detail = String(result.stderr || "").trim().slice(0, 300);
    const failed = new Error(
      `EPERM: native remove failed (exit ${result.status}) for '${target}'${detail ? `: ${detail}` : ""}`,
    );
    failed.code = "EPERM";
    throw failed;
  }
}

fsp.rm = async (target, options) => nativeRemove(target, options);
fsp.rmdir = async (target, options) => nativeRemove(target, { ...options, force: true });

if (fs.promises) {
  fs.promises.rm = fsp.rm;
  fs.promises.rmdir = fsp.rmdir;
}

fs.rmSync = (target, options) => nativeRemove(target, options);
fs.rmdirSync = (target, options) => nativeRemove(target, { ...options, force: true });

fs.rm = (target, options, callback) => {
  const done = typeof options === "function" ? options : callback;
  try {
    nativeRemove(target, typeof options === "function" ? {} : options);
    if (done) process.nextTick(done, null);
  } catch (error) {
    if (done) process.nextTick(done, error);
    else throw error;
  }
};

fs.rmdir = (target, options, callback) => {
  const done = typeof options === "function" ? options : callback;
  try {
    nativeRemove(target, { ...(typeof options === "function" ? {} : options), force: true });
    if (done) process.nextTick(done, null);
  } catch (error) {
    if (done) process.nextTick(done, error);
    else throw error;
  }
};
