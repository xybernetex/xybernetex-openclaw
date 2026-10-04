// The openclaw CLI for setup, the self-test and friends: its entry script run
// with this node when it's an npm install (avoids Windows .cmd shims),
// otherwise the binary on PATH.
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export function findOpenClaw() {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of ["openclaw.cmd", "openclaw"]) {
      const shim = join(dir, name);
      if (!existsSync(shim) || !statSync(shim).isFile()) continue;
      const entry = join(dir, "node_modules", "openclaw", "openclaw.mjs");
      if (existsSync(entry)) return [process.execPath, entry];
      if (name === "openclaw") return [shim];
    }
  }
  return null;
}

export function runner(oc) {
  return (argv, { quiet = false, timeoutMs } = {}) => {
    const p = spawnSync(oc[0], [...oc.slice(1), ...argv], { encoding: "utf8", windowsHide: true, timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024 });
    if (!quiet && p.status !== 0) process.stderr.write((p.stderr || p.stdout || "").slice(-1500));
    return p;
  };
}

// The first JSON value in a CLI's output (it may print a banner first).
export function firstJson(text) {
  const start = String(text ?? "").search(/[[{]/);
  try { return start < 0 ? null : JSON.parse(text.slice(start)); } catch { return null; }
}
