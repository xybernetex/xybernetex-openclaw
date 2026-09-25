import { test } from "node:test";
import assert from "node:assert/strict";
import { createSupervisor } from "../src/supervisor.js";

test("pending telemetry is local and does not fabricate outcomes or consume budget", async () => {
  const logs = [];
  let requests = 0;
  const supervisor = createSupervisor({ log: (e) => logs.push(e), fetchImpl: () => { requests++; throw Error("offline"); } });
  const first = supervisor.recordProposal("run", { toolName: "exec", params: { command: "rm private.txt" }, toolCallId: "p1" });
  assert.equal(first.step_number, 0);
  assert.equal(first.tool_history.length, 0);
  assert.equal(first.proposed_call.risk, "destructive");
  assert.equal(Object.hasOwn(first.proposed_call, "success"), false);
  assert.equal(requests, 0);
  await supervisor.recordToolCall("run", { toolName: "read", params: { path: "secret" } });
  const next = supervisor.recordProposal("run", { toolName: "read", params: { path: "secret" } });
  assert.equal(next.step_number, 1);
  assert.equal(next.cost_so_far, 1);
  assert.equal(next.feature_schema, "xybernetex.state.v2");
  assert.equal(next.tool_history.length, 1);
  assert.equal(requests, 0);
  assert.ok(!JSON.stringify(logs).includes("private.txt"));
  assert.ok(!JSON.stringify(logs).includes("secret"));
  supervisor.endRun("run");
  assert.equal(supervisor.trackedRuns(), 0);
});

test("v1 remote inference never receives the pending proposal", async () => {
  const requests = [];
  const supervisor = createSupervisor({ endpoint: "https://policy.test", apiKey: "test", fetchImpl: async (_, opts) => {
    requests.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ action: "CONTINUE" }));
  } });
  supervisor.recordProposal("r", { toolName: "exec", params: { command: "echo ok" } });
  await supervisor.recordToolCall("r", { toolName: "exec", params: { command: "echo ok" } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].snapshot.feature_schema, "xybernetex.state.v1");
  assert.equal(Object.hasOwn(requests[0].snapshot, "proposed_call"), false);
});
