#!/usr/bin/env node
// The flight recorder: one OpenClaw session as a timeline page (src/timeline.js).
//
//   npx xybernetex-openclaw timeline              your most recent session -> xybernetex-timeline.html
//   npx xybernetex-openclaw timeline --list       recent sessions
//   npx xybernetex-openclaw timeline cart-fix     the latest session whose key contains "cart-fix"
//
// Read-only: OpenClaw's history, the plugin's log and the undo journal. Needs Node 22.5+.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { DEFAULT_STATE_DIR, readSessions } from "./history.mjs";

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  list: { type: "boolean", default: false },
  agent: { type: "string" },
  days: { type: "string", default: "30" },
  "state-dir": { type: "string", default: DEFAULT_STATE_DIR },
  log: { type: "string", default: join(homedir(), ".openclaw", "xybernetex-supervisor.jsonl") },
  "undo-dir": { type: "string" },
  out: { type: "string", default: "xybernetex-timeline.html" },
  help: { type: "boolean", short: "h", default: false },
} });
if (args.help) {
  console.log(`usage: npx xybernetex-openclaw timeline [session key part] [--list] [--agent id] [--days 30] [--out file.html]
One session as a timeline: requests, replies, every tool call with the gate's verdict, deaths, loops, follow-ups and undoable files.`);
  process.exit(0);
}

const lastTs = (s) => s.messages.at(-1)?.ts ?? 0;
let sessions;
try {
  ({ sessions } = await readSessions({ stateDir: args["state-dir"], since: Date.now() - Number(args.days) * 86_400_000,
    agent: args.agent, match: positionals[0] ? (key) => key.includes(positionals[0]) : null }));
} catch (err) {
  console.error(`Can't read OpenClaw's history: ${err.message}`);
  process.exit(1);
}
sessions = sessions.filter((s) => s.messages.some((m) => m.role === "user")).sort((a, b) => lastTs(b) - lastTs(a));
if (!sessions.length) {
  console.log(`No sessions${positionals[0] ? ` matching "${positionals[0]}"` : ""} in the last ${args.days} day(s).`);
  process.exit(0);
}
if (args.list) {
  for (const s of sessions.slice(0, 15)) {
    const runs = s.messages.filter((m) => m.role === "user").length;
    console.log(`${s.sessionKey}\n  ${new Date(lastTs(s)).toLocaleString()} - agent ${s.agentId} - ${runs} run(s)`);
  }
  process.exit(0);
}

const session = sessions[0];
let log = [];
try {
  log = readFileSync(args.log, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.sessionKey === session.sessionKey);
} catch { /* no plugin log: replayed verdicts only */ }
const { DEFAULT_UNDO_DIR, listRuns } = await import("../src/undo.js");
const { buildTimeline, renderTimeline } = await import("../src/timeline.js");
const timeline = buildTimeline(session, { log, undoRuns: listRuns(args["undo-dir"] ?? DEFAULT_UNDO_DIR) });
const out = resolve(args.out);
writeFileSync(out, renderTimeline(timeline));
const calls = timeline.runs.reduce((n, r) => n + r.calls, 0);
const flagged = timeline.runs.flatMap((r) => r.steps).filter((s) => s.gate?.risky).length;
console.log(`${session.sessionKey}: ${timeline.runs.length} run(s), ${calls} tool calls, ${flagged} the gate holds or would hold` +
  `${timeline.runs.some((r) => r.status !== "finished") ? `, ${timeline.runs.filter((r) => r.status !== "finished").length} not finished cleanly` : ""}`);
console.log(`wrote ${out}`);
