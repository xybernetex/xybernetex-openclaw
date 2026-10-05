#!/usr/bin/env node
// Put an agent run's files back the way they were (src/undo.js).
//
//   npx xybernetex-openclaw undo --list        recent runs that changed files
//   npx xybernetex-openclaw undo               the latest one (asks first)
//   npx xybernetex-openclaw undo 2026-10-04T1  a run from the list (any unique prefix of its id)
//
// What's there now is moved to <journal>/.trash/<time>/ first, so an undo can be undone by hand.
import { parseArgs } from "node:util";

import { DEFAULT_UNDO_DIR, lastChange, laterConflicts, listRuns, undoRun } from "../src/undo.js";
import { ask } from "./prompt.mjs";

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  list: { type: "boolean", default: false },
  dir: { type: "string", default: DEFAULT_UNDO_DIR },
  yes: { type: "boolean", short: "y", default: false },
  force: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} });
if (args.help) {
  console.log(`usage: npx xybernetex-openclaw undo [--list] [run id] [--yes] [--force] [--dir path]
Restores the files an agent run changed, from Xybernetex's undo journal.`);
  process.exit(0);
}

const when = (t) => (t ? new Date(t).toLocaleString() : "?");
const count = (r) => {
  const restore = r.entries.filter((e) => e.existed).length;
  const created = r.entries.filter((e) => !e.existed).length;
  return `${restore} changed or deleted, ${created} created`;
};
const runs = listRuns(args.dir).filter((r) => r.entries?.length);
if (!runs.length) {
  console.log(`No undoable runs in ${args.dir}. The journal fills as agents change files (plugin 0.5.1 or later, undo.mode on).`);
  process.exit(0);
}

if (args.list) {
  for (const r of runs.slice(0, 20)) {
    console.log(`${r.id}${r.undoneAt ? "  (undone)" : ""}\n  ${when(r.startedAt)} - agent ${r.agentId ?? "?"} - ${count(r)}` +
      (r.prompt ? `\n  "${r.prompt.replace(/\s+/g, " ").slice(0, 100)}"` : ""));
  }
  process.exit(0);
}

const run = positionals[0]
  ? (() => {
    const hits = runs.filter((r) => r.id.startsWith(positionals[0]));
    if (hits.length !== 1) {
      console.error(hits.length ? `"${positionals[0]}" matches ${hits.length} runs; give more of the id.` : `No run "${positionals[0]}". See --list.`);
      process.exit(2);
    }
    return hits[0];
  })()
  // The run whose latest change is the most recent, so overlapping runs undo in the order their changes happened.
  : runs.filter((r) => !r.undoneAt).sort((a, b) => lastChange(b).localeCompare(lastChange(a)))[0];
if (!run) {
  console.log("Every recent run is already undone. See --list.");
  process.exit(0);
}
if (run.undoneAt && !args.force) {
  console.log(`Run ${run.id} was already undone (${when(run.undoneAt)}). Use --force to restore it again.`);
  process.exit(0);
}

console.log(`Undo the run from ${when(run.startedAt)} (agent ${run.agentId ?? "?"})` +
  (run.prompt ? `:\n  "${run.prompt.replace(/\s+/g, " ").slice(0, 140)}"` : "") + `\nin ${run.workspace}`);
for (const e of run.entries.slice(0, 15)) console.log(`  ${e.existed ? "restore" : "remove "}  ${e.rel}`);
if (run.entries.length > 15) console.log(`  ...and ${run.entries.length - 15} more`);
if (run.skipped?.length) {
  console.log(`  Not covered (${run.skipped.length}): ${[...new Set(run.skipped.map((s) => s.rel ? `${s.rel} (${s.why})` : s.why))].slice(0, 5).join("; ")}`);
}
const conflicts = laterConflicts(run, runs);
if (conflicts.length && !args.force) {
  const blockers = [...new Set(conflicts.map((c) => c.run))];
  console.log(`\nAnother run changed ${[...new Set(conflicts.map((c) => c.rel))].slice(0, 5).join(", ")} after this one did; undoing ` +
    `this one first would overwrite that work. Undo ${blockers.length > 1 ? "these runs" : "that run"} first, or pass --force:` +
    blockers.map((id) => `\n  npx xybernetex-openclaw undo ${id}`).join(""));
  process.exit(1);
}
if (!args.yes && !/^y(es)?$/i.test(await ask("\nRestore these? What's there now is kept in the journal's trash. [y/N] "))) {
  console.log("Nothing changed.");
  process.exit(0);
}
const done = undoRun(run);
console.log(`\nRestored ${done.restored.length}, removed ${done.removed.length} the run created` +
  (done.failed.length ? `, ${done.failed.length} failed (${done.failed.slice(0, 3).map((f) => `${f.rel}: ${f.error}`).join("; ")})` : "") +
  `.\nWhat was there before the undo: ${done.trash}`);
