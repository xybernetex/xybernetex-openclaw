import { test } from "node:test";
import assert from "node:assert/strict";

import { summarize, recommendations } from "../src/report.js";
import { renderReport } from "../src/report_html.js";

const T = (min) => new Date(Date.UTC(2026, 8, 28, 10, min)).toISOString();
const call = (runKey, step, rec, min = step) => ({ ts: T(min), runKey, sessionKey: "agent:main:s1", step,
  latencyMs: 60 + step, decision: { action: "CONTINUE" },
  snapshot: { tool_history: [{ tool_name: "exec", params: { h: `h${step}` }, success: true, timed_out: false, ...rec }] } });

const LOG = [
  { ts: T(0), type: "tool_gate_ready", mode: "enforce", preset: "recommended", ruleIds: ["preset-destructive-approve"] },
  call("r1", 1, { risk: "none" }),
  call("r1", 2, { risk: "destructive", authorization: "requested" }),
  call("r1", 3, { risk: "sensitive", authorization: "unrequested", success: false }),
  // r2 loops: the same call three times in a row.
  call("r2", 1, { risk: "none", params: { h: "same" } }),
  call("r2", 2, { risk: "none", params: { h: "same" } }),
  call("r2", 3, { risk: "none", params: { h: "same" }, timed_out: true }),
  // A local-only record, and a failed policy request for the same run.
  { ts: T(5), type: "tool_completed", runKey: "r3", sessionKey: "agent:ops:s2", step: 1,
    record: { tool_name: "write", params: { h: "w" }, success: true, risk: "none" } },
  { ts: T(5), runKey: "r3", step: 2, latencyMs: 5000, error: "The operation was aborted due to timeout",
    snapshot: { tool_history: [{ tool_name: "exec", params: { h: "x" }, success: true }] } },
  { ts: T(6), type: "tool_gate", action: "REQUEST_USER", toolName: "exec", riskTier: "destructive", authorization: "unrequested" },
  { ts: T(6), type: "tool_gate_resolution", allowed: false, decision: "deny" },
  { ts: T(7), type: "tool_gate", action: "BLOCK_ACTION", toolName: "exec", riskTier: "destructive", authorization: "unrequested" },
  { ts: T(7), type: "tool_gate_waived", toolName: "exec" },
  { ts: T(8), runKey: "r1", runUsage: { total: 1000 }, model: "glm" },
  { ts: T(8), runKey: "r2", runUsage: { total: 3000 }, model: "glm" },
  { ts: T(8), runKey: "r3", runUsage: { total: 500 }, model: "kimi" },
  { ts: T(9), type: "run_end", runKey: "r1", agentId: "main", success: true, durationMs: 60000 },
  { ts: T(9), type: "run_end", runKey: "r2", agentId: "main", success: false, error: "incomplete_turn: model stalled", durationMs: 90000 },
  { ts: T(9), type: "run_end", runKey: "r3", agentId: "ops", success: true, durationMs: 30000 },
  { ts: "2020-01-01T00:00:00Z", type: "run_end", runKey: "old", success: false },
];

test("the summary counts calls, risk, authorization, loops and gate outcomes", () => {
  const s = summarize(LOG, { from: Date.parse(T(0)), to: Date.parse(T(59)) });
  assert.deepEqual(s.gateConfig, { mode: "enforce", preset: "recommended" });
  assert.equal(s.calls.total, 8);
  assert.deepEqual(s.calls.risk, { destructive: 1, sensitive: 1, none: 5, unjudged: 1 });
  assert.deepEqual(s.calls.riskyAuth, { requested: 1, own_artifact: 0, unrequested: 1, unlabeled: 0 });
  assert.equal(s.calls.failed, 1);
  assert.equal(s.calls.timedOut, 1);
  assert.equal(s.runs.loopingRuns, 1);
  assert.deepEqual({ held: s.gate.held, blocked: s.gate.blocked, denied: s.gate.denied, waived: s.gate.waived,
    unrequestedStopped: s.gate.unrequestedStopped }, { held: 1, blocked: 1, denied: 1, waived: 1, unrequestedStopped: 2 });
  assert.equal(s.policy.decisions, 6);
  assert.equal(s.policy.errors, 1);
});

test("runs: outcomes, durations, tokens and where they went", () => {
  const s = summarize(LOG, { from: Date.parse(T(0)), to: Date.parse(T(59)) });
  assert.equal(s.runs.seen, 3); // the 2020 entry is outside the window
  assert.equal(s.runs.died, 1);
  assert.equal(s.runs.medianDurationMs, 60000);
  assert.deepEqual(s.runs.errorKinds, { incomplete_turn: 1 });
  assert.deepEqual(s.runs.byAgent, { main: { runs: 2, died: 1 }, ops: { runs: 1, died: 0 } });
  assert.equal(s.tokens.total, 4500);
  assert.equal(s.tokens.perRun, 1500);
  assert.equal(s.tokens.onDiedRuns, 3000);
  assert.deepEqual(s.tokens.byModel, { glm: { runs: 2, tokens: 4000 }, kimi: { runs: 1, tokens: 500 } });
});

test("recommendations point at what to change", () => {
  const s = summarize(LOG, { from: Date.parse(T(0)), to: Date.parse(T(59)) });
  const recs = recommendations(s).join("\n");
  assert.match(recs, /1 risky call\(s\) ran that the user's own messages never asked for/);
  assert.match(recs, /1 of 3 runs ended without finishing/);
  assert.match(recs, /repeated the same call/);
  assert.match(recs, /denied or expired/);
  assert.doesNotMatch(recs, /observe mode/);

  const observing = summarize([{ ts: T(0), type: "tool_gate_ready", mode: "observe" },
    { ts: T(1), type: "tool_gate", action: "WOULD_REQUEST_USER", toolName: "exec" }]);
  assert.match(recommendations(observing).join("\n"), /observe mode, so 1 risky call/);
  assert.match(recommendations(observing).join("\n"), /No control preset/);
  assert.deepEqual(recommendations(summarize([])), ["Nothing needs attention this period."]);
});

test("the gate's settings come from its last load, even when that was before the window", () => {
  const log = [{ ts: "2026-09-01T00:00:00Z", type: "tool_gate_ready", mode: "observe", preset: "none" },
    { ts: "2026-09-10T00:00:00Z", type: "tool_gate_ready", mode: "enforce", preset: "strict" },
    { ts: "2026-09-30T00:00:00Z", type: "tool_gate_ready", mode: "observe" }];
  const s = summarize(log, { from: Date.parse("2026-09-20T00:00:00Z"), to: Date.parse("2026-09-27T00:00:00Z") });
  assert.deepEqual(s.gateConfig, { mode: "enforce", preset: "strict" });
  // An older plugin that didn't log a preset reads as "none".
  assert.equal(summarize(log).gateConfig.preset, "none");
});

test("the HTML report escapes everything taken from the log", () => {
  const evil = [...LOG, { ts: T(9), runKey: "r9", runUsage: { total: 1 }, model: "<img src=x onerror=alert(1)>" }];
  const html = renderReport(summarize(evil, { from: Date.parse(T(0)), to: Date.parse(T(59)) }), { title: "Acme <weekly>" });
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("Acme &lt;weekly&gt;"));
  assert.match(html, /Risky calls stopped/);
});

test("interventions: decided vs started, follow-up outcomes, and the observe-mode nudge", () => {
  const S = "agent:main:s1";
  const log = [
    { ts: T(1), type: "intervention", sessionKey: S, mode: "act", action: "verify", scheduled: true },
    { ts: T(2), type: "intervention", sessionKey: S, mode: "act", action: "outcome", success: true, wasOurs: true },
    { ts: T(3), type: "intervention", sessionKey: "agent:main:s2", mode: "act", action: "retry", scheduled: true, fallbackReason: "offline" },
    { ts: T(4), type: "intervention", sessionKey: "agent:main:s2", mode: "act", action: "outcome", success: false, wasOurs: true },
    { ts: T(5), type: "intervention", sessionKey: "agent:main:s3", mode: "act", action: "none", scheduled: false },
  ];
  const s = summarize(log, { from: Date.parse(T(0)), to: Date.parse(T(59)) });
  assert.deepEqual(s.interventions.decided, { retry: 1, verify: 1, none: 1 });
  assert.deepEqual(s.interventions.started, { retry: 1, verify: 1 });
  assert.deepEqual(s.interventions.outcomes, { retry: { n: 1, ok: 0 }, verify: { n: 1, ok: 1 } });
  assert.match(recommendations(s).join("\n"), /1 intervention decision\(s\) fell back/);
  assert.match(renderReport(s), /Check your work<\/td><td>1<\/td><td>1<\/td><td>1 of 1/);

  const observing = summarize([{ ts: T(1), type: "intervention", sessionKey: S, mode: "observe", action: "verify", scheduled: false }]);
  assert.match(recommendations(observing).join("\n"), /1 run\(s\) would have gotten a follow-up/);
});

test("outcomes: what the user said next, by what was applied, and what verify and retry turns did", () => {
  const ep = (min, applied, user, extra = {}) => ({ ts: T(min), type: "episode", applied, user, ...extra });
  const log = [
    ...[1, 2, 3, 4, 5].map((m) => ep(m, "verify", "thanks", { verify: "fixed", followup: { success: true } })),
    ...[6, 7, 8, 9, 10].map((m) => ep(m, "verify", "none", { verify: "confirmed", followup: { success: true } })),
    ep(11, "retry", "new", { followup: { success: true } }),
    ep(12, "retry", "none", { followup: { success: false } }),
    ...Array.from({ length: 12 }, (_, i) => ep(20 + i, "none", i < 4 ? "correction" : i < 5 ? "repeat" : "new")),
    ep(40, "none", "session_end"),
  ];
  const s = summarize(log, { from: Date.parse(T(0)), to: Date.parse(T(59)) });
  assert.equal(s.outcomes.episodes, 25);
  assert.deepEqual(s.outcomes.verify, { fixed: 5, confirmed: 5, failed: 0 });
  assert.deepEqual(s.outcomes.retry, { n: 2, finished: 1 });
  assert.deepEqual(s.outcomes.byApplied.none, { n: 13, replied: 12, correction: 4, repeat: 1, thanks: 0, new: 7 });
  const recs = recommendations(s).join("\n");
  assert.match(recs, /changed files in 5 of 10 runs \(50%\)/);
  assert.match(recs, /After 5 of 12 runs without a follow-up/);
  const html = renderReport(s);
  assert.match(html, /What happened next/);
  assert.match(html, /No follow-up<\/td><td>13<\/td><td>12<\/td><td>5 \(42%\)/);
  assert.match(html, /Finished on the retry<\/td><td>1</);
});
