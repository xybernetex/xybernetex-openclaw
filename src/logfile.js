// OpenClaw registers a plugin more than once while a gateway starts (seconds
// apart, possibly in separate threads), so each "ready" line was logged two or
// three times. loggedRecently() checks the end of the log for the same entry
// (ignoring its timestamp) written within `withinMs`, so a startup line is
// written once. Best-effort: any read problem means "not logged".
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const TAIL_BYTES = 64 * 1024;

export function loggedRecently(logPath, entry, withinMs = 120_000, now = Date.now()) {
  let fd;
  try {
    fd = openSync(logPath, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const want = JSON.stringify(entry);
    for (const line of buf.toString("utf8").split("\n").reverse()) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const at = Date.parse(row.ts ?? "");
      if (!Number.isFinite(at) || now - at > withinMs) break;
      const { ts, ...rest } = row;
      if (JSON.stringify(rest) === want) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}
