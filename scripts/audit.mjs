#!/usr/bin/env node
// What your agents already did: reads OpenClaw's session history (read-only)
// and replays it through Xybernetex's gate and governor (src/audit.js).
//
//   npx xybernetex-openclaw audit                 last 30 days -> xybernetex-audit.html
//   npx xybernetex-openclaw audit --days 7 --agent main
//   npx xybernetex-openclaw audit --json
//
// Needs Node 22.5+ (node:sqlite) and, for compressed history, zstd support
// (Node 22.15+). Never writes to OpenClaw's files; works with the gateway running.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import zlib from "node:zlib";

const { values: args } = parseArgs({ options: {
  days: { type: "string", default: "30" },
  agent: { type: "string" },
  "state-dir": { type: "string", default: process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw") },
  out: { type: "string", default: "xybernetex-audit.html" },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} });
if (args.help) {
  console.log(`usage: npx xybernetex-openclaw audit [--days 30] [--agent id] [--out file.html] [--json] [--state-dir path]
Replays your OpenClaw session history through the Xybernetex gate and governor, read-only, on this machine.`);
  process.exit(0);
}
const days = Number(args.days);
if (!Number.isFinite(days) || days <= 0) {
  console.error("--days must be a positive number");
  process.exit(2);
}

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  console.error(`The audit reads OpenClaw's history with node:sqlite, which needs Node 22.5 or newer (this is ${process.version}).`);
  process.exit(1);
}
const { replaySessions } = await import("../src/audit.js");
const { headline, renderAudit } = await import("../src/audit_html.js");

const agentsDir = join(args["state-dir"], "agents");
if (!existsSync(agentsDir)) {
  console.error(`No OpenClaw agents found in ${agentsDir}. Point --state-dir at your OpenClaw state folder.`);
  process.exit(1);
}
const since = Date.now() - days * 86_400_000;
const sessions = [];
let skippedCompressed = 0;
for (const agentId of readdirSync(agentsDir)) {
  if (args.agent && agentId !== args.agent) continue;
  const dbPath = join(agentsDir, agentId, "agent", "openclaw-agent.sqlite");
  if (!existsSync(dbPath)) continue;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    // Whole sessions that were active in the window, so each run has its full context.
    const rows = db.prepare(`SELECT w.session_key AS key, e.session_id AS id, e.event_json AS json, e.event_zstd AS zst
      FROM transcript_events e JOIN session_windows w ON w.session_id = e.session_id
      WHERE e.session_id IN (SELECT session_id FROM transcript_events WHERE created_at >= ?)
      ORDER BY e.session_id, e.seq`).iterate(since);
    let current = null;
    for (const r of rows) {
      if (!current || current.sessionId !== r.id) {
        current = { agentId, sessionKey: r.key, sessionId: r.id, messages: [] };
        // Our own self-test sessions aren't the user's work.
        if (!String(r.key).includes("xybernetex-selftest")) sessions.push(current);
      }
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
  } catch (err) {
    console.error(`skipped agent ${agentId}: ${err.message}`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

if (!sessions.length) {
  console.log(`No OpenClaw sessions in the last ${days} day(s)${args.agent ? ` for agent ${args.agent}` : ""}.`);
  process.exit(0);
}
process.stderr.write(`Replaying ${sessions.length.toLocaleString("en-US")} session(s)...\n`);
const audit = replaySessions(sessions);

if (args.json) {
  console.log(JSON.stringify(audit, null, 2));
} else {
  const out = resolve(args.out);
  writeFileSync(out, renderAudit(audit, { days }));
  console.log(`Xybernetex audit, last ${days} day(s): ${audit.agents.length} agent(s), ` +
    `${audit.runs.toLocaleString("en-US")} runs, ${audit.toolCalls.toLocaleString("en-US")} tool calls`);
  for (const line of headline(audit)) console.log(`  - ${line}`);
  if (skippedCompressed) console.log(`  (${skippedCompressed} compressed history entries skipped: this Node has no zstd; use Node 22.15+)`);
  console.log(`wrote ${out}`);
}
