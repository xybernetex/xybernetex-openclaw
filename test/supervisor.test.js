import { test } from "node:test";
import assert from "node:assert/strict";

import { createSupervisor, hashParams } from "../src/supervisor.js";

// Fake policy endpoint: records every request and answers with `decide`
// (optionally after a per-request delay, to scramble completion order).
function fakeEndpoint({ decide = () => "CONTINUE", delayMs = () => 0, status = 200 } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, headers: init.headers, rawBody: init.body, snapshot: body.snapshot });
    await new Promise((r) => setTimeout(r, delayMs(requests.length)));
    const payload = status === 200 ? { action: decide(body.snapshot), action_probs: {}, value: 0 } : { error: "nope" };
    return new Response(JSON.stringify(payload), { status });
  };
  return { requests, fetchImpl };
}

function supervisorWith(endpoint, opts = {}) {
  const logs = [];
  const supervisor = createSupervisor({
    endpoint: "https://policy.test/evaluate",
    apiKey: "k",
    fetchImpl: endpoint.fetchImpl,
    log: (e) => logs.push(e),
    ...opts,
  });
  return { supervisor, logs };
}

test("params are hashed independent of key order, and never sent raw", async () => {
  assert.equal(hashParams({ a: 1, b: { c: [1, 2] } }), hashParams({ b: { c: [1, 2] }, a: 1 }));
  assert.notEqual(hashParams({ a: 1 }), hashParams({ a: 2 }));

  const endpoint = fakeEndpoint();
  const { supervisor } = supervisorWith(endpoint);
  await supervisor.recordToolCall("r", { toolName: "write_file", params: { path: "/secret/notes.txt", body: "hunter2" } });
  const [req] = endpoint.requests;
  assert.equal(req.headers.authorization, "Bearer k");
  assert.ok(!req.rawBody.includes("hunter2") && !req.rawBody.includes("/secret/"));
  assert.deepEqual(req.snapshot.tool_history[0].params, { h: hashParams({ path: "/secret/notes.txt", body: "hunter2" }) });
});

test("tool calls become snapshot entries with step numbers and outcomes", async () => {
  const endpoint = fakeEndpoint();
  const { supervisor } = supervisorWith(endpoint, { maxToolCallsPerRun: 30 });
  supervisor.recordToolCall("r", { toolName: "read_file", params: {} });
  supervisor.recordToolCall("r", { toolName: "fetch_url", params: {}, error: "ECONNREFUSED" });
  await supervisor.recordToolCall("r", { toolName: "fetch_url", params: {}, error: "Request timed out after 30s" });

  const snap = endpoint.requests[2].snapshot;
  assert.equal(snap.step_number, 3);
  assert.equal(snap.max_steps, 30);
  assert.deepEqual(snap.tool_history.map(({ success, timed_out }) => [success, timed_out]),
                   [[true, false], [false, false], [false, true]]);
});

test("each evaluation sees every earlier decision, even when responses arrive out of order", async () => {
  // Earlier requests answer slower than later ones would.
  const endpoint = fakeEndpoint({ decide: (s) => (s.step_number % 2 ? "REPLAN" : "CONTINUE"),
                                  delayMs: (n) => 30 - n * 5 });
  const { supervisor } = supervisorWith(endpoint);
  const pending = [1, 2, 3, 4].map(() => supervisor.recordToolCall("r", { toolName: "t", params: {} }));
  await Promise.all(pending);
  assert.deepEqual(endpoint.requests.map((r) => r.snapshot.recent_actions), [
    [], ["REPLAN"], ["REPLAN", "CONTINUE"], ["REPLAN", "CONTINUE", "REPLAN"],
  ]);
});

test("only the tail the policy reads is sent: 8 tool calls, 16 actions", async () => {
  const endpoint = fakeEndpoint();
  const { supervisor } = supervisorWith(endpoint);
  let last;
  for (let i = 0; i < 25; i++) last = supervisor.recordToolCall("r", { toolName: "t", params: { i } });
  await last;
  const snap = endpoint.requests.at(-1).snapshot;
  assert.equal(snap.step_number, 25);
  assert.equal(snap.tool_history.length, 8);
  assert.equal(snap.tool_history.at(-1).params.h, hashParams({ i: 24 }));
  assert.equal(snap.recent_actions.length, 16);
});

test("cost is tool calls against the per-run budget", async () => {
  const endpoint = fakeEndpoint();
  const { supervisor } = supervisorWith(endpoint, { maxToolCallsPerRun: 40 });
  supervisor.recordToolCall("r", { toolName: "t", params: {} });
  await supervisor.recordToolCall("r", { toolName: "t", params: {} });
  const snap = endpoint.requests[1].snapshot;
  assert.deepEqual([snap.cost_so_far, snap.cost_budget, snap.max_steps], [2, 40, 40]);
});

test("endpoint failures are logged and don't advance the action history", async () => {
  const failing = fakeEndpoint({ status: 503 });
  const { supervisor, logs } = supervisorWith(failing);
  supervisor.recordToolCall("r", { toolName: "t", params: {} });
  await supervisor.recordToolCall("r", { toolName: "t", params: {} });
  assert.match(logs[0].error, /HTTP 503: nope/);
  assert.deepEqual(failing.requests[1].snapshot.recent_actions, []);

  const { supervisor: offline, logs: offlineLogs } = supervisorWith({
    fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND"); },
  });
  await offline.recordToolCall("r", { toolName: "t", params: {} });
  assert.match(offlineLogs[0].error, /ENOTFOUND/);
});

test("runs are tracked independently and evicted oldest-first", async () => {
  const endpoint = fakeEndpoint();
  const { supervisor } = supervisorWith(endpoint, { maxTrackedRuns: 2 });
  await supervisor.recordToolCall("a", { toolName: "t", params: {} });
  await supervisor.recordToolCall("b", { toolName: "t", params: {} });
  await supervisor.recordToolCall("c", { toolName: "t", params: {} });
  assert.equal(supervisor.trackedRuns(), 2);
  await supervisor.recordToolCall("a", { toolName: "t", params: {} }); // evicted, so it starts over
  assert.equal(endpoint.requests.at(-1).snapshot.step_number, 1);

  supervisor.endRun("a");
  assert.equal(supervisor.trackedRuns(), 1);
});
