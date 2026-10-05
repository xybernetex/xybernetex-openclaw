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
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { DEFAULT_STATE_DIR, readSessions } from "./history.mjs";

const { values: args } = parseArgs({ options: {
  days: { type: "string", default: "30" },
  agent: { type: "string" },
  "state-dir": { type: "string", default: DEFAULT_STATE_DIR },
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

let history;
try {
  history = await readSessions({ stateDir: args["state-dir"], since: Date.now() - days * 86_400_000, agent: args.agent });
} catch (err) {
  console.error(`The audit can't read OpenClaw's history: ${err.message}`);
  process.exit(1);
}
const { replaySessions } = await import("../src/audit.js");
const { headline, renderAudit } = await import("../src/audit_html.js");
const { sessions, skippedCompressed } = history;

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
