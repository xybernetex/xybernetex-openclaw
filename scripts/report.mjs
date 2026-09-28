#!/usr/bin/env node
// Builds the customer report from the plugin's local log.
//
//   npx xybernetex-openclaw report           last 7 days -> xybernetex-report.html
//   node scripts/report.mjs                  (the same, from a checkout)
//   node scripts/report.mjs --days 30 --out march.html
//   node scripts/report.mjs --log D:\logs\xyb.jsonl --json
import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { summarize, recommendations } from "../src/report.js";
import { renderReport } from "../src/report_html.js";

const { values: args } = parseArgs({ options: {
  log: { type: "string", default: join(homedir(), ".openclaw", "xybernetex-supervisor.jsonl") },
  days: { type: "string", default: "7" },
  out: { type: "string", default: "xybernetex-report.html" },
  title: { type: "string", default: "Xybernetex agent report" },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} });
if (args.help) {
  console.log("usage: report.mjs [--log path] [--days 7] [--out report.html] [--title text] [--json]");
  process.exit(0);
}
const days = Number(args.days);
if (!Number.isFinite(days) || days <= 0) {
  console.error("--days must be a positive number");
  process.exit(2);
}

const entries = [];
try {
  const lines = createInterface({ input: createReadStream(args.log, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* a torn last line from a live gateway */ }
  }
} catch (err) {
  console.error(`can't read ${args.log}: ${err.message}`);
  process.exit(1);
}

const to = Date.now();
const summary = summarize(entries, { from: to - days * 86_400_000, to });
if (args.json) {
  console.log(JSON.stringify({ ...summary, recommendations: recommendations(summary) }, null, 2));
} else {
  const out = resolve(args.out);
  writeFileSync(out, renderReport(summary, { title: args.title }));
  const s = summary;
  console.log(`Xybernetex report, last ${days} day(s): ${s.runs.seen} runs, ${s.calls.total} tool calls, ` +
    `${s.gate.held + s.gate.blocked} stopped by the gate (${s.gate.wouldHold + s.gate.wouldBlock} more in observe mode), ` +
    `${s.runs.died} runs died, ${s.tokens.total.toLocaleString("en-US")} tokens.`);
  for (const r of recommendations(s)) console.log(`  - ${r}`);
  console.log(`wrote ${out}`);
}
