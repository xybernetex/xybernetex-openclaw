import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolGate } from "../src/control.js";

const rule = { id: "review-write", agentId: "scenarios", toolName: "write", action: "approve",
  paramsMatch: { path: "/workspace/test.txt" }, approvalDescription: "Overwrite the disposable sandbox test file.",
  approvalTimeoutMs: 1000 };
const event = { toolName: "write", params: { path: "/workspace/test.txt", content: "SECRET_TEST_CONTENT" } };
const ctx = { agentId: "scenarios", sessionKey: "test" };

test("approval is per-call with only allow-once and deny; private content stays out of prompt and logs", () => {
  const logs = [];
  const gate = createToolGate({ mode: "enforce", rules: [rule], log: (e) => logs.push(e) });
  const first = gate(event, ctx).requireApproval;
  assert.deepEqual(first.allowedDecisions, ["allow-once", "deny"]);
  assert.equal(first.timeoutMs, 1000);
  first.onResolution("allow-once");
  const second = gate(event, ctx).requireApproval;
  assert.ok(second);
  assert.notEqual(logs[0].gateId, logs[2].gateId);
  assert.equal(logs[0].paramsHash, logs[1].paramsHash);
  assert.equal(logs[1].allowed, true);
  assert.ok(!JSON.stringify([first, logs]).includes("SECRET_TEST_CONTENT"));
});

test("deny, timeout, cancellation and unexpected resolutions never log an allowance", () => {
  const logs = [];
  const gate = createToolGate({ mode: "enforce", rules: [rule], log: (e) => logs.push(e) });
  for (const resolution of ["deny", "timeout", "cancelled", "allow-always", undefined]) {
    gate(event, ctx).requireApproval.onResolution(resolution);
    assert.equal(logs.at(-1).allowed, false);
  }
});

test("a matching block wins over approval regardless of rule order", () => {
  const block = { id: "never-write", agentId: "scenarios", toolName: "write" };
  for (const rules of [[rule, block], [block, rule]]) {
    const result = createToolGate({ mode: "enforce", rules })(event, ctx);
    assert.equal(result.block, true);
    assert.equal(result.requireApproval, undefined);
  }
});

test("observe logs a suggestion without creating a pending approval", () => {
  const logs = [];
  assert.equal(createToolGate({ rules: [rule], log: (e) => logs.push(e) })(event, ctx), undefined);
  assert.equal(logs[0].action, "WOULD_REQUEST_USER");
});

test("concurrent requests retain their own original call fingerprints", async () => {
  const logs = [];
  const gate = createToolGate({ mode: "enforce", rules: [rule], log: (e) => logs.push(e) });
  const calls = await Promise.all(["first", "second"].map((content) => gate(
    { ...event, params: { ...event.params, content } }, ctx)));
  const originals = logs.map((e) => e.paramsHash);
  calls[1].requireApproval.onResolution("deny");
  calls[0].requireApproval.onResolution("allow-once");
  assert.notEqual(originals[0], originals[1]);
  assert.equal(logs[2].paramsHash, originals[1]);
  assert.equal(logs[3].paramsHash, originals[0]);
});

test("broken logging does not bypass approval, and invalid approval rules fail registration", () => {
  const gate = createToolGate({ mode: "enforce", rules: [rule], log: () => { throw Error("full"); } });
  const approval = gate(event, ctx).requireApproval;
  assert.deepEqual(approval.allowedDecisions, ["allow-once", "deny"]);
  assert.doesNotThrow(() => approval.onResolution("deny"));
  for (const patch of [{ approvalDescription: "" }, { approvalTimeoutMs: 0 },
    { approvalTimeoutMs: Infinity }, { action: "allow" }]) {
    assert.throws(() => createToolGate({ rules: [{ ...rule, ...patch }] }));
  }
});

test("switching back to observe removes enforcement and unmatched commands remain permitted", () => {
  const block = { id: "exact", agentId: "scenarios", toolName: "exec", paramsMatch: { command: "rm test" } };
  const call = { toolName: "exec", params: { command: "rm test" } };
  assert.equal(createToolGate({ mode: "enforce", rules: [block] })(call, ctx).block, true);
  assert.equal(createToolGate({ mode: "observe", rules: [block] })(call, ctx), undefined);
  assert.equal(createToolGate({ mode: "enforce", rules: [block] })(
    { ...call, params: { command: "rm  test" } }, ctx), undefined);
});
