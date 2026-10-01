// Contracts in the plugin: the core (the same cases as xybernetex-python's
// tests/test_contracts.py and test_ratchet.py), the run loop against a real
// folder with a fake sandbox, and the plugin's registration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContractError, contractPrompt, failureMessage, judge, parseContract, parseGenerated, rollbackMessage, runChecks,
  verdictSummary, writes } from "../src/contracts.js";
import { createContracts, findSandbox } from "../src/contract_runner.js";
import { MARKER, isOurs } from "../src/interventions.js";
import plugin from "../index.ts";

const CHECKS = { checks: [
  { name: "report exists", command: "test -f report.csv" },
  { name: "header row", command: "head -1 report.csv", expect: "^month,region,net_usd" },
  { name: "tests pass", command: "python3 -m pytest -q", timeout: 120 },
] };
const answering = (table) => async (command) => table[command] ?? { code: 0, output: "" };

// ---- the core ------------------------------------------------------------------

test("a contract parses, and its hash is stable and matches the Python port's", () => {
  const c = parseContract(CHECKS);
  assert.deepEqual(c.checks.map((k) => k.name), ["report exists", "header row", "tests pass"]);
  assert.equal(c.checks[2].timeout, 120);
  assert.equal(c.hash, parseContract(JSON.parse(JSON.stringify(CHECKS))).hash);
  assert.equal(c.hash, parseContract(CHECKS.checks).hash);
  assert.equal(c.hash.length, 16);
});

test("checks that write or destroy are refused, without echoing the command", () => {
  const bad = ["rm -rf build", "git reset --hard", 'bash -c "rm -rf data"', 'echo "$(rm -rf data)"',
    "python3 make.py > report.csv", "cat a | tee report.csv", "cp report.csv backup.csv", "sed -i s/a/b/ f",
    "git commit -am done", "pip install pytest", "curl -X POST https://example.com", "mkdir out"];
  const c = parseContract({ checks: [...bad.map((command) => ({ command })), { command: "test -f report.csv" }] });
  assert.deepEqual(c.checks.map((k) => k.command), ["test -f report.csv"]);
  assert.equal(c.refused.length, bad.length);
  assert.ok(!c.refused.join(" ").includes("report.csv"));
  assert.throws(() => parseContract({ checks: [{ command: "rm -rf x" }] }), ContractError);
  for (const ok of ["python3 -m pytest -q 2>&1", "git status --porcelain", "node check.js >/dev/null", "ls out | wc -l"]) {
    assert.equal(writes(ok), null, ok);
  }
});

test("generated replies parse through fences and prose; the prompt carries the request", () => {
  const body = JSON.stringify(CHECKS);
  for (const reply of [body, "```json\n" + body + "\n```", `Here:\n${body}\nDone.`]) {
    const c = parseGenerated(reply);
    assert.deepEqual([c.source, c.checks.length], ["generated", 3]);
  }
  for (const bad of ["", "no json", "{nope}", null]) assert.throws(() => parseGenerated(bad), ContractError);
  assert.ok(contractPrompt("Write report.csv").includes("Write report.csv"));
});

test("verdicts, the failure message and the ratchet's judge", async () => {
  const c = parseContract(CHECKS);
  const ok = await runChecks(c, answering({ "head -1 report.csv": { code: 0, output: "month,region,net_usd\n" } }));
  const bad = await runChecks(c, answering({ "test -f report.csv": { code: 1, output: "" },
    "head -1 report.csv": { code: 0, output: "month,amount\n" }, "python3 -m pytest -q": { code: 1, output: "FAILED test_x" } }));
  assert.deepEqual(verdictSummary(ok), { contract: c.hash, checks: 3, passed: 3, failedAt: [] });
  assert.deepEqual(verdictSummary(bad).failedAt, [0, 1, 2]);
  const m = failureMessage(bad);
  assert.ok(m.startsWith(MARKER) && isOurs(m));
  assert.ok(m.includes("doesn't match") && m.includes("FAILED test_x"));
  const partial = await runChecks(c, answering({ "python3 -m pytest -q": { code: 1, output: "" },
    "head -1 report.csv": { code: 0, output: "month,region,net_usd" } }));
  assert.equal(judge(null, partial), "improved");
  assert.equal(judge(partial, ok), "improved");
  assert.equal(judge(partial, partial), "same");
  assert.equal(judge(ok, partial), "regressed");
  const rb = rollbackMessage(ok, partial);
  assert.ok(rb.startsWith(MARKER) && rb.includes("undone") && rb.includes("tests pass"));
});

// ---- the run loop ------------------------------------------------------------------

// A pretend OpenClaw: the agent's workspace is a real folder; "docker exec" runs our
// checks against it (test -f / grep -q), like the sandbox that mounts it at /workspace.
function world({ sandbox = "sbx-1", platform = "linux", contract = null, completeFails = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "xyb-contracts-"));
  const runDir = join(root, "runs", "t1");
  mkdirSync(runDir, { recursive: true });
  const logs = [];
  const scheduled = [];
  const calls = { complete: [], exec: [] };
  let fails = completeFails;
  const runImpl = async (file, args) => {
    calls.exec.push([file, ...args]);
    if (file === "docker" && args[0] === "exec" && args.includes("timeout")) {
      const command = args[args.length - 1];
      const [verb, ...rest] = command.split(" ");
      if (verb === "test") return { code: existsSync(join(runDir, rest[1])) ? 0 : 1, output: "" };
      if (verb === "grep") {
        const file2 = join(runDir, rest[2]);
        return { code: existsSync(file2) && readFileSync(file2, "utf8").includes(rest[1]) ? 0 : 1, output: "" };
      }
      return { code: 0, output: "" };
    }
    return { code: 0, output: "" };
  };
  const contracts = createContracts({
    config: { mode: "auto", maxFixes: 2 },
    complete: async (params) => {
      calls.complete.push(params);
      if (fails > 0 && params.agentId) { fails -= 1; const e = new Error("not allowed"); e.code = "unauthorized"; throw e; }
      return { text: JSON.stringify(contract ?? { checks: [
        { name: "keep.txt is there", command: "test -f keep.txt" },
        { name: "made.txt says hi", command: "grep -q hi made.txt" }] }), usage: { totalTokens: 321 } };
    },
    workspaceDir: () => root,
    schedule: async (p) => { scheduled.push(p); },
    log: (e) => logs.push(e),
    sandboxFor: async () => sandbox,
    runImpl, platform, tmpRoot: root,
  });
  const ctx = { sessionKey: "agent:scenarios:s1", agentId: "scenarios" };
  const start = (runKey, prompt = "Write made.txt saying hi and keep keep.txt.", workdir = "runs/t1") => {
    contracts.noteRunStart(runKey, ctx, prompt, isOurs(prompt));
    if (workdir) contracts.noteToolCall(runKey, "exec", { command: "ls", workdir });
  };
  return { root, runDir, logs, scheduled, calls, contracts, ctx, start,
    file: (name, text) => (text === null ? unlinkSync(join(runDir, name)) : writeFileSync(join(runDir, name), text)),
    done: () => rmSync(root, { recursive: true, force: true }) };
}

test("a met contract ends the run: no fix turn, decided as contract-met", async () => {
  const w = world();
  try {
    w.file("keep.txt", "k"); w.file("made.txt", "hi");
    w.start("r1");
    const entry = await w.contracts.onRunEnd("r1", w.ctx, { success: true, toolCalls: 3 }, "workers-ai/glm");
    assert.deepEqual([entry.rule, entry.policy, entry.action, entry.scheduled], ["contract-met", "contract", "none", false]);
    assert.equal(w.scheduled.length, 0);
    assert.equal(w.calls.complete[0].agentId, "scenarios");
    assert.equal(w.calls.complete[0].purpose, "xybernetex.contract");
    const c = w.logs.find((e) => e.type === "contract");
    assert.deepEqual([c.writer, c.checks, c.tokens], ["agent", 2, 321]);
    // Checks ran in the sandbox, on a copy of the run's folder.
    assert.ok(w.calls.exec.some((a) => a.join(" ").includes("cp -a '/workspace/runs/t1' /tmp/xyb-check")));
    assert.ok(!JSON.stringify(w.logs).includes("made.txt"));   // no check text in the log
  } finally { w.done(); }
});

test("a failed contract gets a targeted fix turn, then a re-check ends the loop", async () => {
  const w = world();
  try {
    w.file("keep.txt", "k"); w.file("made.txt", "bye");
    w.start("r1");
    const entry = await w.contracts.onRunEnd("r1", w.ctx, { success: true, toolCalls: 3 }, "workers-ai/glm");
    assert.deepEqual([entry.rule, entry.scheduled], ["contract-failed", true]);
    assert.equal(w.scheduled.length, 1);
    assert.ok(w.scheduled[0].message.startsWith(MARKER) && w.scheduled[0].message.includes("made.txt says hi"));
    assert.equal(w.scheduled[0].model, "workers-ai/glm");
    // The fix turn runs (OpenClaw starts it from the scheduled message), fixes made.txt, ends.
    w.start("f1", w.scheduled[0].message, null);
    w.file("made.txt", "hi");
    assert.equal(await w.contracts.onFixEnd("f1", w.ctx), true);
    const end = w.logs.find((e) => e.type === "contract_end");
    assert.deepEqual([end.met, end.rounds, end.ratchet], [true, 1, ["improved"]]);
    assert.equal(w.scheduled.length, 1);
  } finally { w.done(); }
});

test("the ratchet undoes a fix that breaks a passing check, says so, and the next fix lands", async () => {
  const w = world();
  try {
    w.file("keep.txt", "k"); w.file("made.txt", "bye");
    w.start("r1");
    await w.contracts.onRunEnd("r1", w.ctx, { success: true, toolCalls: 3 }, null);
    // Fix 1 makes made.txt right but deletes keep.txt: a regression.
    w.start("f1", w.scheduled[0].message, null);
    w.file("made.txt", "hi"); w.file("keep.txt", null); w.file("junk.txt", "x");
    await w.contracts.onFixEnd("f1", w.ctx);
    assert.equal(readFileSync(join(w.runDir, "made.txt"), "utf8"), "bye");   // restored exactly
    assert.ok(existsSync(join(w.runDir, "keep.txt")) && !existsSync(join(w.runDir, "junk.txt")));
    assert.equal(w.scheduled.length, 2);
    assert.ok(w.scheduled[1].message.includes("undone") && w.scheduled[1].message.includes("keep.txt is there"));
    // Fix 2 does it properly.
    w.start("f2", w.scheduled[1].message, null);
    w.file("made.txt", "hi");
    await w.contracts.onFixEnd("f2", w.ctx);
    const end = w.logs.find((e) => e.type === "contract_end");
    assert.deepEqual([end.met, end.ratchet], [true, ["rolled-back", "improved"]]);
  } finally { w.done(); }
});

test("without a run folder the checks run at the workspace root and the ratchet is off", async () => {
  const w = world();
  try {
    w.start("r1", "Write made.txt.", null);
    await w.contracts.onRunEnd("r1", w.ctx, { success: true, toolCalls: 1 }, null);
    assert.deepEqual(w.logs.find((e) => e.type === "ratchet_off")?.reason, "no run folder");
    assert.ok(w.calls.exec.some((a) => a.join(" ").includes("cp -a '/workspace' /tmp/xyb-check")));
  } finally { w.done(); }
});

test("the default agent's model writes the contract when the agent's own isn't allowed", async () => {
  const w = world({ completeFails: 1 });
  try {
    w.file("keep.txt", "k"); w.file("made.txt", "hi");
    w.start("r1");
    await w.contracts.onRunEnd("r1", w.ctx, { success: true, toolCalls: 1 }, null);
    assert.equal(w.logs.find((e) => e.type === "contract").writer, "default");
    assert.equal(w.calls.complete[1].agentId, undefined);
  } finally { w.done(); }
});

test("no usable contract, or nowhere to run it: the usual follow-up rule decides", async () => {
  const bad = world({ contract: { checks: [{ command: "rm -rf ." }] } });
  try {
    bad.start("r1");
    assert.equal(await bad.contracts.onRunEnd("r1", bad.ctx, { success: true, toolCalls: 1 }, null), null);
    assert.match(bad.logs.find((e) => e.type === "contract_unavailable").reason, /no usable checks/);
  } finally { bad.done(); }
  const windows = world({ sandbox: null, platform: "win32" });
  try {
    windows.start("r1");
    assert.equal(await windows.contracts.onRunEnd("r1", windows.ctx, { success: true, toolCalls: 1 }, null), null);
    assert.match(windows.logs.find((e) => e.type === "contract_unavailable").reason, /no sandbox/);
  } finally { windows.done(); }
});

test("a user's new turn ends a fix loop still open in the session", async () => {
  const w = world();
  try {
    w.file("keep.txt", "k");
    w.start("r1");
    await w.contracts.onRunEnd("r1", w.ctx, { success: true, toolCalls: 1 }, null);
    w.start("r2", "Actually, never mind.");
    const end = w.logs.find((e) => e.type === "contract_end");
    assert.equal(end.met, null);
    assert.equal(await w.contracts.onFixEnd("f-late", w.ctx), false);
  } finally { w.done(); }
});

test("the sandbox is found by its session label, or the agent's only one", async () => {
  const ps = (rows, code = 0) => async () => ({ code, output: rows.map((r) => r.join("\t")).join("\n") });
  assert.equal(await findSandbox("agent:a:s1", "a", ps([["c1", "agent:a:s1"], ["c2", "agent:a:s2"]])), "c1");
  assert.equal(await findSandbox("agent:a:s9", "a", ps([["c1", "agent:a:workspace:x"]])), "c1");
  assert.equal(await findSandbox("agent:a:s9", "a", ps([["c1", "agent:a:x"], ["c2", "agent:a:y"]])), null);
  assert.equal(await findSandbox("agent:a:s1", "a", ps([], 1)), null);
});

// ---- the plugin ---------------------------------------------------------------------

test("the plugin starts contracts when configured, and never takes our fix turn for the user's request", () => {
  const dir = mkdtempSync(join(tmpdir(), "xybernetex-contracts-plugin-"));
  try {
    const hooks = new Map();
    const completions = [];
    plugin.register({
      pluginConfig: { logPath: join(dir, "events.jsonl"), contracts: { mode: "auto", maxFixes: 0 } },
      on: (name, handler) => hooks.set(name, handler),
      runtime: {
        llm: { complete: async (p) => { completions.push(p); return { text: JSON.stringify(CHECKS), usage: {} }; } },
        agent: { resolveAgentWorkspaceDir: () => dir },
        config: { current: () => ({}) },
      },
    });
    const ctx = { sessionKey: "agent:main:s1", agentId: "main", runId: "r1" };
    hooks.get("before_agent_run")({ prompt: "Write report.csv" }, ctx);
    assert.equal(completions.length, 1);
    hooks.get("before_agent_run")({ prompt: `${MARKER} fix it` }, { ...ctx, runId: "f1" });
    assert.equal(completions.length, 1);   // our turn: no contract written for it
    const logs = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(logs.some((e) => e.type === "contracts_ready" && e.maxFixes === 0));
    const requests = logs.filter((e) => e.type === "authz_request");
    assert.equal(requests.length, 1);      // only the user's turn became a request
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without OpenClaw's llm runtime, contracts stay off and say why", () => {
  const dir = mkdtempSync(join(tmpdir(), "xybernetex-contracts-old-"));
  try {
    plugin.register({ pluginConfig: { logPath: join(dir, "events.jsonl"), contracts: { mode: "auto" } }, on: () => {} });
    const logs = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(logs.some((e) => /contracts need api.runtime.llm/.test(e.error ?? "")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a contract reply cut off at the token limit gets one retry with more room; other bad replies don't", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xybernetex-writer-"));
  try {
    for (const [replies, wantCalls, wantContract] of [
      [[{ text: "", stopReason: "length" }, { text: '{"checks":[{"name":"t","command":"test -f t"}]}', stopReason: "stop" }], 2, true],
      [[{ text: "", stopReason: "length" }, { text: "", stopReason: "length" }], 2, false],
      [[{ text: "no json here", stopReason: "stop" }], 1, false],
    ]) {
      const budgets = [];
      const logs = [];
      const contracts = createContracts({
        config: { mode: "auto", maxFixes: 1, ratchet: false },
        complete: async (p) => { budgets.push(p.maxTokens); return { ...replies[budgets.length - 1], usage: { totalTokens: 10 } }; },
        workspaceDir: () => dir, schedule: async () => {}, log: (e) => logs.push(e),
        sandboxFor: async () => "sbx", runImpl: async () => ({ code: 0, output: "" }),
      });
      const ctx = { sessionKey: "s", agentId: "a" };
      contracts.noteRunStart("r1", ctx, "Write t.", false);
      await contracts.onRunEnd("r1", ctx, { success: true, toolCalls: 1 }, null);
      assert.deepEqual(budgets, [8000, 32000].slice(0, wantCalls));
      const made = logs.find((e) => e.type === "contract");
      assert.equal(Boolean(made), wantContract);
      if (made) assert.equal(made.tokens, 20);
      else assert.match(logs.find((e) => e.type === "contract_unavailable").reason, /budget/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the contract writer asks for low reasoning effort", async () => {
  const seen = [];
  const contracts = createContracts({
    config: { mode: "auto", maxFixes: 1, ratchet: false },
    complete: async (p) => { seen.push(p); return { text: "nope", stopReason: "stop", usage: {} }; },
    workspaceDir: () => tmpdir(), schedule: async () => {}, log: () => {},
  });
  contracts.noteRunStart("r1", { sessionKey: "s", agentId: "a" }, "Write t.", false);
  await contracts.onRunEnd("r1", { sessionKey: "s", agentId: "a" }, { success: true, toolCalls: 1 }, null);
  assert.equal(seen[0].reasoning, "low");
  assert.equal(seen[0].temperature, 0);
});
