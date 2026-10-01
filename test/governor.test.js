// The governor: the same limits and messages as xybernetex-python's
// core/governor.py, a stopped run in the plugin, and contract fix rounds that
// stop when they make no progress.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STANDARD, createGovernor, limitsFrom, stopMessage } from "../src/governor.js";
import { createContracts } from "../src/contract_runner.js";
import plugin from "../index.ts";

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("the tool-call budget stops the call that crosses it and every one after, logged once", () => {
  const logs = [];
  const g = createGovernor({ maxToolCalls: 2 }, { log: (e) => logs.push(e) });
  g.start("r");
  assert.equal(g.onCall("r", "c1", "exec", { command: "a" }), null);
  assert.equal(g.onCall("r", "c2", "exec", { command: "b" }), null);
  const stop = g.onCall("r", "c3", "exec", { command: "c" });
  assert.match(stop, /^Stopped by Xybernetex: the run has used its budget of 2 tool calls/);
  assert.equal(g.onCall("r", "c4", "exec", { command: "d" }), stop);
  assert.equal(g.onCall("r", "c3", "exec", { command: "c" }), stop);   // asked again: the same answer
  assert.deepEqual(logs.map((e) => e.reason), ["tool-calls"]);
  assert.ok(!JSON.stringify(logs).includes('"a"'));
  assert.equal(g.end("r"), "tool-calls");
});

test("time runs from the run's start; only consecutive identical calls are a repeat", () => {
  const c = clock();
  const g = createGovernor({ maxSeconds: 60, repeatLimit: 3 }, { now: c.now });
  g.start("r");
  const same = { command: "pytest -q" };
  for (const [i, p] of [same, same, { command: "cat log" }, same, same].entries()) assert.equal(g.onCall("r", `c${i}`, "exec", p), null);
  assert.match(g.onCall("r", "c9", "exec", same), /3 times in a row/);
  g.start("r2");
  c.advance(61_000);
  assert.match(g.onCall("r2", "d1", "exec", { command: "ls" }), /time budget of 60 seconds/);
});

test("limits: standard, overrides, mistakes; the messages match the Python port's", () => {
  assert.equal(limitsFrom(undefined), null);
  assert.deepEqual(limitsFrom("standard"), STANDARD);
  assert.deepEqual(limitsFrom({ repeatLimit: 3 }), { ...STANDARD, repeatLimit: 3 });
  assert.throws(() => limitsFrom({ maxCalls: 3 }), /unknown governor limits/);
  assert.throws(() => limitsFrom({ maxSeconds: -1 }), /positive/);
  assert.equal(stopMessage("repeat", 4), "Stopped by Xybernetex: the same call has now been made 4 times in a row with no " +
    "change. This call was not run, and no further calls will run. Stop working now and reply with a short summary of " +
    "what is done and what isn't.");
});

test("in the plugin, a run that repeats itself is stopped and gets no follow-up", () => {
  const dir = mkdtempSync(join(tmpdir(), "xybernetex-governor-"));
  try {
    const hooks = new Map();
    plugin.register({ pluginConfig: { logPath: join(dir, "events.jsonl"), governor: { repeatLimit: 3 },
      interventions: { mode: "observe" } }, on: (name, handler) => hooks.set(name, handler) });
    const ctx = { runId: "r1", agentId: "main", sessionKey: "s" };
    hooks.get("before_agent_run")({ prompt: "Make the tests pass." }, ctx);
    const call = (id) => hooks.get("before_tool_call")({ toolName: "exec", params: { command: "pytest -q" }, toolCallId: id }, ctx);
    assert.equal(call("c1"), undefined);
    assert.equal(call("c2"), undefined);
    const third = call("c3");
    assert.equal(third.block, true);
    assert.match(third.blockReason, /3 times in a row/);
    hooks.get("agent_end")({ success: true, messages: [] }, ctx);
    const logs = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(logs.some((e) => e.type === "governor_ready" && e.repeatLimit === 3));
    assert.equal(logs.find((e) => e.type === "run_end").governor, "repeat");
    assert.equal(logs.find((e) => e.type === "intervention").rule, "governor-repeat");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract fix rounds stop after noProgressRounds without improvement", async () => {
  const logs = [];
  const scheduled = [];
  const dir = mkdtempSync(join(tmpdir(), "xybernetex-noprogress-"));
  try {
    const contracts = createContracts({
      config: { mode: "auto", maxFixes: 5, noProgressRounds: 2, ratchet: false },
      complete: async () => ({ text: JSON.stringify({ checks: [{ name: "never", command: "test -f never" }] }), usage: {} }),
      workspaceDir: () => dir, schedule: async (p) => { scheduled.push(p); }, log: (e) => logs.push(e),
      sandboxFor: async () => "sbx", runImpl: async (file, args) => ({ code: args.includes("timeout") ? 1 : 0, output: "" }),
    });
    const ctx = { sessionKey: "s", agentId: "a" };
    contracts.noteRunStart("r1", ctx, "Write never.", false);
    await contracts.onRunEnd("r1", ctx, { success: true, toolCalls: 1 }, null);
    for (const fix of ["f1", "f2"]) {
      contracts.noteRunStart(fix, ctx, "[xybernetex] fix", true);
      await contracts.onFixEnd(fix, ctx);
    }
    assert.equal(scheduled.length, 2);   // the first fix, then one more; the second stall ends it
    assert.ok(logs.some((e) => e.type === "governor_stop" && e.reason === "no-progress"));
    assert.deepEqual(logs.find((e) => e.type === "contract_end").ratchet, ["same", "same"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
