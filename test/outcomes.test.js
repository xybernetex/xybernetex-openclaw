import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyFollowup, createOutcomeSender, createOutcomeTracker, verifyResult } from "../src/outcomes.js";
import { MESSAGES } from "../src/interventions.js";
import plugin from "../index.ts";

// Manual timers so tests control "quiet" closes.
function clock() {
  let t = 1_000_000;
  const timers = new Set();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.add(h); return h; },
    clearTimer: (h) => timers.delete(h),
    advance(ms) {
      t += ms;
      for (const h of [...timers]) if (h.at <= t) { timers.delete(h); h.fn(); }
    },
  };
}

const decision = (over = {}) => ({ type: "intervention", runKey: "r1", sessionKey: "agent:main:s1", agentId: "main",
  mode: "act", action: "verify", probability: 0.9, rule: "verify-helps", policy: "v0-targeted", scheduled: true,
  model: "workers-ai/@cf/google/gemma-4", wasOurs: false, ...over });

test("the user's next message is classified locally: correction, repeat, thanks, new", () => {
  const req = "Write a script that parses the sales CSV and prints the total revenue per region";
  for (const msg of ["that didn't work, the totals are off", "It still fails on the header row", "you forgot the tests",
    "No, I meant per country", "nope", "this is wrong", "doesnt work", "try again"]) {
    assert.equal(classifyFollowup(req, msg), "correction", msg);
  }
  assert.equal(classifyFollowup(req, "write a script that parses the sales CSV and prints total revenue per region please"), "repeat");
  assert.equal(classifyFollowup(req, "thanks, perfect"), "thanks");
  assert.equal(classifyFollowup(req, "great"), "thanks");
  for (const msg of ["Now add a chart of the monthly totals", "fix the error in parse.py", "what's wrong with my config?",
    "No problem is too small: write docs for the parser module and add examples", "Make the report look great for the board meeting with charts per region"]) {
    assert.equal(classifyFollowup(req, msg), "new", msg);
  }
});

test("verify result: files changed means the first answer needed fixing", () => {
  assert.equal(verifyResult(null), null);
  assert.equal(verifyResult({ success: true, writes: 2 }), "fixed");
  assert.equal(verifyResult({ success: true, writes: 0 }), "confirmed");
  assert.equal(verifyResult({ success: false, writes: 1 }), "failed");
});

test("an episode joins the decision, our follow-up's work and the user's next message, then closes", async () => {
  const c = clock();
  const logged = [];
  const sent = [];
  const t = createOutcomeTracker({ log: (e) => logged.push(e), send: (e) => sent.push(e), ...c });
  t.noteUserTurn("agent:main:s1", "build the parser and its tests");
  t.noteToolCall("r1", "write", false);
  t.noteToolCall("r1", "exec", true);
  t.noteUsage("r1", 12_000);
  t.open(decision(), { success: true, retriable: false, toolCalls: 2 });
  // Our verify turn: reads, finds a bug, rewrites a file.
  t.noteFollowupStart("agent:main:s1", "r2");
  t.noteToolCall("r2", "read", false);
  t.noteToolCall("r2", "edit", false);
  t.noteUsage("r2", 5_000);
  t.noteRunEnd("r2", true);
  c.advance(90_000);
  const ep = t.noteUserTurn("agent:main:s1", "thanks, looks good");
  assert.equal(ep.user, "thanks");
  assert.equal(ep.gapSec, 90);
  assert.equal(ep.applied, "verify");
  assert.equal(ep.verify, "fixed");
  assert.deepEqual(ep.run, { success: true, retriable: false, toolCalls: 2, tokens: 12_000 });
  assert.deepEqual(ep.followup, { success: true, toolCalls: 2, writes: 1, failedCalls: 0, tokens: 5_000 });
  assert.equal(logged[0].type, "episode");
  assert.equal(t.openEpisodes(), 0);
  // Sent off the hook's path; nothing identifying or textual is in it.
  await new Promise((r) => setImmediate(r));
  const wire = JSON.stringify(sent[0]);
  assert.equal(JSON.parse(wire).verify, "fixed");
  for (const secret of ["looks good", "parser", "agent:main:s1", "r1", "r2"]) assert.ok(!wire.includes(secret), secret);
});

test("observe mode and a failed start are recorded as untreated, with certainty", () => {
  const c = clock();
  const t = createOutcomeTracker({ ...c });
  t.open(decision({ mode: "observe", scheduled: false }), { success: true, toolCalls: 3 });
  const ep = t.noteUserTurn("agent:main:s1", "that doesn't work");
  assert.deepEqual([ep.action, ep.applied, ep.probability, ep.user, ep.verify], ["verify", "none", 1, "correction", null]);
});

test("quiet runs close as 'none', sessions close as 'session_end', and a new decision supersedes the old", () => {
  const c = clock();
  const logged = [];
  const t = createOutcomeTracker({ log: (e) => logged.push(e), quietMs: 60_000, ...c });
  t.open(decision({ action: "none", scheduled: false, probability: 0.1 }), { success: true, toolCalls: 1 });
  c.advance(61_000);
  assert.equal(logged.at(-1).user, "none");
  assert.equal(logged.at(-1).gapSec, null);

  t.open(decision({ action: "retry", scheduled: true, probability: 0.9 }), { success: false, retriable: true, toolCalls: 0 });
  t.noteFollowupStart("agent:main:s1", "r9");
  t.noteRunEnd("r9", true);
  t.endSession("agent:main:s1");
  assert.equal(logged.at(-1).user, "session_end");
  assert.equal(logged.at(-1).followup.success, true); // the retry finished the run

  t.open(decision({ runKey: "a", rule: "decide-failed: socket hang up" }), { success: true, toolCalls: 1 });
  t.open(decision({ runKey: "b" }), { success: true, toolCalls: 1 });
  assert.equal(logged.at(-1).user, "superseded");
  assert.equal(logged.at(-1).gapSec, null); // not the user's doing
  assert.equal(logged.at(-1).rule, "decide-failed:_socket_hang_up"); // a label the service accepts
  assert.equal(t.openEpisodes(), 1);
});

test("a follow-up that starts - or even ends - before its decision is logged still attaches", () => {
  const c = clock();
  const t = createOutcomeTracker({ ...c });
  t.noteFollowupStart("agent:main:s1", "r2");
  t.noteToolCall("r2", "write", false);
  t.noteRunEnd("r2", true);
  t.open(decision(), { success: true, toolCalls: 4 });
  const ep = t.noteUserTurn("agent:main:s1", "now deploy it");
  assert.equal(ep.verify, "fixed");
  assert.equal(ep.user, "new");
});

test("the sender posts labels to /outcome next to /evaluate", async () => {
  const calls = [];
  const send = createOutcomeSender({ endpoint: "https://api.example/evaluate", apiKey: "k",
    fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 204 }); } });
  await send({ user: "new" });
  assert.equal(calls[0].url, "https://api.example/outcome");
  assert.equal(calls[0].init.headers.authorization, "Bearer k");
  assert.deepEqual(JSON.parse(calls[0].init.body), { episode: { user: "new" } });
  const failing = createOutcomeSender({ endpoint: "https://api.example/evaluate", apiKey: "k",
    fetchImpl: async () => new Response("no", { status: 500 }) });
  await assert.rejects(failing({}), /HTTP 500/);
});

test("the plugin logs an episode end to end, and sends nothing without an endpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xybernetex-outcomes-"));
  try {
    const hooks = new Map();
    plugin.register({
      pluginConfig: { logPath: join(dir, "events.jsonl"), interventions: { mode: "observe" } },
      on: (name, handler) => hooks.set(name, handler),
    });
    const c = { sessionKey: "agent:main:s9", agentId: "main", inputProvenance: { kind: "external_user" } };
    hooks.get("before_agent_run")({ runId: "run1", prompt: "summarize the logs into report.md" }, c);
    hooks.get("after_tool_call")({ runId: "run1", toolName: "write", params: { path: "report.md" } }, c);
    hooks.get("agent_end")({ runId: "run1", success: true, durationMs: 1000 }, c);
    hooks.get("llm_output")({ runId: "run1", provider: "workers-ai", model: "@cf/x", usage: { total: 900 } }, c);
    await new Promise((r) => setTimeout(r, 600));
    hooks.get("before_agent_run")({ runId: "run2", prompt: "that's wrong, it skipped the errors" }, c);
    // Our own turn must never close an episode or count as the user's message.
    hooks.get("before_agent_run")({ runId: "run3", prompt: MESSAGES.verify }, c);

    const logs = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(logs.find((e) => e.type === "interventions_ready").shareOutcomes, false);
    const episodes = logs.filter((e) => e.type === "episode");
    assert.equal(episodes.length, 1);
    assert.deepEqual([episodes[0].user, episodes[0].applied, episodes[0].run.tokens, episodes[0].model],
      ["correction", "none", 900, "workers-ai/@cf/x"]);
    assert.ok(!JSON.stringify(logs).includes("skipped the errors")); // the message itself is never logged
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a held-out run keeps its propensity; a decision nobody carried out is untreated for certain", () => {
  const c = clock();
  const logged = [];
  const t = createOutcomeTracker({ log: (e) => logged.push(e), ...c });
  const run = { success: true, retriable: false, toolCalls: 2 };
  t.open(decision({ sessionKey: "a", action: "none", probability: 0.1, rule: "verify-held-out", scheduled: false }), run);
  t.open(decision({ sessionKey: "b", mode: "observe", scheduled: false }), run);
  t.open(decision({ sessionKey: "c", mode: "observe", action: "none", probability: 0.1, scheduled: false }), run);
  t.open(decision({ sessionKey: "d", scheduled: false }), run); // act mode, but the turn couldn't start
  t.open(decision({ sessionKey: "e" }), run);
  for (const key of ["a", "b", "c", "d", "e"]) t.endSession(key);
  assert.deepEqual(logged.map((e) => [e.sessionKey, e.applied, e.probability]),
    [["a", "none", 0.1], ["b", "none", 1], ["c", "none", 1], ["d", "none", 1], ["e", "verify", 0.9]]);
});
