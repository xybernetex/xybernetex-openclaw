// The undo journal (src/undo.js): what a call touches is copied aside before
// it runs, and undoRun puts it back - on real files in a temp workspace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUndoJournal, hostPath, laterConflicts, listRuns, plannedPaths, undoRun } from "../src/undo.js";
import plugin from "../index.ts";

function world() {
  const base = mkdtempSync(join(tmpdir(), "xyb-undo-"));
  const ws = join(base, "ws");
  const root = join(base, "journal");
  mkdirSync(join(ws, "sub", "data"), { recursive: true });
  writeFileSync(join(ws, "sub", "data", "keep.txt"), "precious");
  writeFileSync(join(ws, "notes.txt"), "original notes");
  writeFileSync(join(ws, "a.log"), "a");
  writeFileSync(join(ws, "b.log"), "b");
  let t = Date.parse("2026-10-04T10:00:00Z");
  const journal = (opts = {}) => createUndoJournal({ root, workspaceFor: () => ws, now: () => (t += 1000), ...opts });
  return { base, ws, root, journal, done: () => rmSync(base, { recursive: true, force: true }) };
}

test("paths: followed through cd, mapped from the sandbox, refused outside the workspace or behind a variable", () => {
  const planned = plannedPaths("exec", { command: "cd sub && rm -rf data && echo x > out.txt" });
  assert.deepEqual(planned.map((p) => [p.cwd, p.path]), [["sub", "data"], ["sub", "out.txt"]]);
  assert.deepEqual(plannedPaths("write", { path: "notes.txt", content: "x" }).map((p) => p.path), ["notes.txt"]);
  assert.match(plannedPaths("exec", { command: "rm -rf $HOME/stuff" })[0].unresolved, /variable/);
  const ws = join(tmpdir(), "ws");
  assert.equal(hostPath(ws, { path: "/workspace/a/b.txt", cwd: "" }).rel, join("a", "b.txt"));
  assert.equal(hostPath(ws, { path: "../../etc/passwd", cwd: "" }).reason, "outside the workspace");
  assert.equal(hostPath(ws, { path: ".", cwd: "" }).reason, "the whole workspace");
  assert.equal(hostPath(ws, { path: "~/x", cwd: "" }).reason, "outside the workspace");
});

test("a run that deletes a folder, overwrites a file and creates one is undone exactly", () => {
  const w = world();
  try {
    const j = w.journal();
    j.noteRunStart("r1", { agentId: "main", sessionKey: "s" }, "Clean up the project.");
    j.beforeCall("r1", "exec", { command: "rm -rf sub/data" });
    rmSync(join(w.ws, "sub", "data"), { recursive: true });
    j.beforeCall("r1", "write", { path: "notes.txt" });
    writeFileSync(join(w.ws, "notes.txt"), "clobbered");
    j.beforeCall("r1", "write", { path: "new.txt" });
    writeFileSync(join(w.ws, "new.txt"), "made by the agent");
    j.beforeCall("r1", "write", { path: "notes.txt" });   // the first state is what's kept
    j.endRun("r1");

    const [run] = listRuns(w.root);
    assert.equal(run.prompt, "Clean up the project.");
    assert.deepEqual(run.entries.map((e) => [e.rel, e.existed]),
      [[join("sub", "data"), true], ["notes.txt", true], ["new.txt", false]]);
    const done = undoRun(run);
    assert.equal(readFileSync(join(w.ws, "sub", "data", "keep.txt"), "utf8"), "precious");
    assert.equal(readFileSync(join(w.ws, "notes.txt"), "utf8"), "original notes");
    assert.ok(!existsSync(join(w.ws, "new.txt")));
    assert.deepEqual([done.restored.length, done.removed.length, done.failed.length], [2, 1, 0]);
    assert.equal(readFileSync(join(done.trash, "notes.txt"), "utf8"), "clobbered");   // the undo can be undone
    assert.ok(listRuns(w.root)[0].undoneAt);
  } finally { w.done(); }
});

test("globs expand; over the budget or outside the workspace is recorded as not undoable", () => {
  const w = world();
  try {
    const j = w.journal({ maxRunMb: 0.0000001 });   // ~0.1 byte: even a 1-byte file is over
    j.noteRunStart("r1", { agentId: "main" }, "x");
    j.beforeCall("r1", "exec", { command: "rm *.log && rm -rf ../elsewhere" });
    j.endRun("r1");
    const [run] = listRuns(w.root);
    assert.deepEqual(run.entries, []);
    assert.deepEqual(run.skipped.map((s) => s.why.replace(/\d+/, "N")), ["over the N MB undo budget", "over the N MB undo budget",
      "outside the workspace"]);
    const k = w.journal();
    k.noteRunStart("r2", { agentId: "main" }, "y");
    k.beforeCall("r2", "exec", { command: "rm *.log" });
    k.endRun("r2");
    assert.deepEqual(listRuns(w.root)[0].entries.map((e) => e.rel).sort(), ["a.log", "b.log"]);
  } finally { w.done(); }
});

test("a later run that touched the same file is a conflict; old runs are pruned", () => {
  const w = world();
  try {
    const j = w.journal({ keepRuns: 2 });
    for (const r of ["r1", "r2", "r3"]) {
      j.noteRunStart(r, { agentId: "main" }, r);
      j.beforeCall(r, "write", { path: "notes.txt" });
      j.endRun(r);
    }
    const runs = listRuns(w.root);
    assert.equal(runs.length, 2);
    const older = runs.at(-1);
    assert.deepEqual(laterConflicts(older, runs).map((c) => c.rel), ["notes.txt"]);
    assert.deepEqual(laterConflicts(runs[0], runs), []);
  } finally { w.done(); }
});

test("in the plugin, a call the gate lets through is journaled; a blocked one isn't", () => {
  const w = world();
  try {
    const hooks = new Map();
    plugin.register({ pluginConfig: { logPath: join(w.base, "events.jsonl"), undo: { dir: w.root },
      control: { mode: "enforce", preset: "strict" } },
    on: (name, fn) => hooks.set(name, fn),
    runtime: { agent: { resolveAgentWorkspaceDir: () => w.ws }, config: { current: () => ({}) } } });
    const ctx = { runId: "r1", agentId: "main", sessionKey: "s" };
    hooks.get("before_agent_run")({ prompt: "Delete notes.txt please." }, ctx);
    assert.equal(hooks.get("before_tool_call")({ toolName: "exec", params: { command: "rm notes.txt" }, toolCallId: "c1" }, ctx), undefined);
    const held = hooks.get("before_tool_call")({ toolName: "exec", params: { command: "rm -rf sub" }, toolCallId: "c2" }, ctx);
    assert.equal(held.block, true);   // nobody asked: strict blocks it, so nothing to journal
    hooks.get("agent_end")({ success: true, messages: [] }, ctx);
    const [run] = listRuns(w.root);
    assert.deepEqual(run.entries.map((e) => e.rel), ["notes.txt"]);
    const logs = readFileSync(join(w.base, "events.jsonl"), "utf8");
    assert.match(logs, /"undo_ready"/);
    assert.match(logs, /"undo_saved"/);
  } finally { w.done(); }
});

test("overlapping runs: undo follows the order files were touched, not the order runs started", async () => {
  // Found live 2026-10-05: an interactive run started first and paused; a one-shot run started later, deleted
  // notes.txt, and the interactive run then rewrote it. Ordering by run start undid them in the wrong order.
  const { lastChange } = await import("../src/undo.js");
  const w = world();
  try {
    const j = w.journal();
    j.noteRunStart("A", { agentId: "main" }, "interactive");   // starts first
    j.noteRunStart("B", { agentId: "main" }, "cron");          // starts second...
    j.beforeCall("B", "exec", { command: "rm notes.txt" });    // ...but touches the file first
    rmSync(join(w.ws, "notes.txt"));
    j.beforeCall("A", "write", { path: "notes.txt" });         // A recreates it afterwards
    writeFileSync(join(w.ws, "notes.txt"), "rewritten by A");
    j.endRun("B");
    j.endRun("A");
    const runs = listRuns(w.root);
    const A = runs.find((r) => r.prompt === "interactive");
    const B = runs.find((r) => r.prompt === "cron");
    assert.deepEqual(laterConflicts(B, runs).map((c) => [c.rel, c.run]), [["notes.txt", A.id]]);  // A changed it after B
    assert.deepEqual(laterConflicts(A, runs), []);
    assert.ok(lastChange(A) > lastChange(B));   // so A is what a bare `undo` picks first
    undoRun(A);
    assert.ok(!existsSync(join(w.ws, "notes.txt")));            // back to B's state: deleted
    undoRun(B);
    assert.equal(readFileSync(join(w.ws, "notes.txt"), "utf8"), "original notes");
  } finally { w.done(); }
});
