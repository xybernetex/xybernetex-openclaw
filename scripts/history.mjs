// OpenClaw's session history, read-only: each agent's transcript events from
// ~/.openclaw/agents/<id>/agent/openclaw-agent.sqlite (node:sqlite, Node 22.5+),
// decompressing zstd entries when this Node can (22.15+). Shared by `audit` and
// `timeline`; never writes, and works with the gateway running.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";

export const DEFAULT_STATE_DIR = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw");

export async function sqlite() {
  try {
    return (await import("node:sqlite")).DatabaseSync;
  } catch {
    throw new Error(`reading OpenClaw's history needs node:sqlite, in Node 22.5 or newer (this is ${process.version})`);
  }
}

// [{ agentId, sessionKey, sessionId, messages: [{ role, content, ..., ts }] }], whole sessions active since `since`.
// `match(sessionKey)` filters sessions; `skip` drops the self-test's own sessions.
export async function readSessions({ stateDir = DEFAULT_STATE_DIR, since = 0, agent = null, match = null, skipSelftest = true } = {}) {
  const DatabaseSync = await sqlite();
  const agentsDir = join(stateDir, "agents");
  if (!existsSync(agentsDir)) throw new Error(`no OpenClaw agents in ${agentsDir}; pass --state-dir`);
  const sessions = [];
  let skippedCompressed = 0;
  for (const agentId of readdirSync(agentsDir)) {
    if (agent && agentId !== agent) continue;
    const dbPath = join(agentsDir, agentId, "agent", "openclaw-agent.sqlite");
    if (!existsSync(dbPath)) continue;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare(`SELECT w.session_key AS key, e.session_id AS id, e.event_json AS json, e.event_zstd AS zst
        FROM transcript_events e JOIN session_windows w ON w.session_id = e.session_id
        WHERE e.session_id IN (SELECT session_id FROM transcript_events WHERE created_at >= ?)
        ORDER BY e.session_id, e.seq`).iterate(since);
      let current = null;
      let keep = false;
      for (const r of rows) {
        if (!current || current.sessionId !== r.id) {
          current = { agentId, sessionKey: r.key, sessionId: r.id, messages: [] };
          keep = !(skipSelftest && String(r.key).includes("xybernetex-selftest")) && (!match || match(String(r.key)));
          if (keep) sessions.push(current);
        }
        if (!keep) continue;
        let text = r.json;
        if (text === null || text === undefined) {
          if (typeof zlib.zstdDecompressSync !== "function") { skippedCompressed += 1; continue; }
          text = zlib.zstdDecompressSync(r.zst).toString("utf8");
        }
        let e;
        try { e = JSON.parse(text); } catch { continue; }
        if (e?.type !== "message" || !e.message) continue;
        const m = e.message;
        if (!["user", "assistant", "toolResult"].includes(m.role)) continue;
        current.messages.push({ ...m, ts: Date.parse(e.timestamp) || m.timestamp || null });
      }
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  }
  return { sessions, skippedCompressed };
}
