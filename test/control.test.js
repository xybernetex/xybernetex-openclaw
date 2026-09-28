import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolGate } from "../src/control.js";

const rule = { id: "test-denial", agentId: "scenarios", toolName: "exec",
  paramsMatch: { command: "rm protected.txt" } };
const event = { toolName: "exec", params: { command: "rm protected.txt", timeout: 30 }, toolCallId: "call1" };
const ctx = { agentId: "scenarios", sessionKey: "test-session" };

test("default observation never blocks and logs no raw parameters", () => {
  const logs = [];
  assert.equal(createToolGate({ rules: [rule], log: (e) => logs.push(e) })(event, ctx), undefined);
  assert.equal(logs[0].enforced, false);
  assert.equal(logs[0].action, "WOULD_BLOCK");
  assert.ok(!JSON.stringify(logs).includes("protected.txt"));
});

test("enforcement blocks before an executor can run and explains recovery", () => {
  const gate = createToolGate({ mode: "enforce", rules: [rule] });
  let executed = false;
  const result = gate(event, ctx);
  if (!result?.block) executed = true;
  assert.equal(executed, false);
  assert.match(result.blockReason, /not executed/);
  assert.match(result.blockReason, /another tool/);
});

test("scope and exact parameters leave unrelated calls alone", () => {
  const gate = createToolGate({ mode: "enforce", rules: [rule] });
  assert.equal(gate(event, { agentId: "main" }), undefined);
  assert.equal(gate(event, {}), undefined);
  assert.equal(gate({ toolName: "read", params: event.params }, ctx), undefined);
  assert.equal(gate({ toolName: "exec", params: { command: "echo ok" } }, ctx), undefined);
  assert.equal(gate({ toolName: "exec" }, ctx), undefined);
});

test("a rule without parameter matches restricts that whole tool", () => {
  const gate = createToolGate({ mode: "enforce", rules: [{ ...rule, paramsMatch: {} }] });
  assert.equal(gate({ toolName: "exec", params: { command: "anything" } }, ctx).block, true);
});

test("parallel calls have independent decisions; a broken logger cannot allow a denied call", async () => {
  const gate = createToolGate({ mode: "enforce", rules: [rule], log: () => { throw Error("disk full"); } });
  const decisions = await Promise.all(Array.from({ length: 20 }, () => gate(event, ctx)));
  assert.ok(decisions.every((d) => d.block));
});

test("invalid rules fail explicitly and configuration is copied", () => {
  assert.throws(() => createToolGate({ mode: "oops" }));
  assert.throws(() => createToolGate({ rules: [{}] }));
  assert.throws(() => createToolGate({ rules: [rule, rule] }));
  assert.throws(() => createToolGate({ rules: [{ ...rule, paramsMatch: { command: 1 } }] }));
  assert.throws(() => createToolGate({ rules: [{ ...rule, riskAtLeast: "none" }] }));
  assert.throws(() => createToolGate({ rules: [{ ...rule, riskAtLeast: "catastrophic" }] }));
  const mutable = { ...rule, paramsMatch: { ...rule.paramsMatch } };
  const gate = createToolGate({ mode: "enforce", rules: [mutable] });
  mutable.paramsMatch.command = "changed";
  assert.equal(gate(event, ctx).block, true);
});

// riskAtLeast: the same classifier src/risk.js gives the observe-only
// path, now consulted by the enforcement gate.
const riskyRule = { id: "no-destructive-exec", agentId: "scenarios", toolName: "exec", riskAtLeast: "destructive" };

test("riskAtLeast matches any command risk.js classifies at or above the threshold, not just one", () => {
  const gate = createToolGate({ mode: "enforce", rules: [riskyRule] });
  assert.equal(gate({ toolName: "exec", params: { command: "rm -rf build" } }, ctx).block, true);
  assert.equal(gate({ toolName: "exec", params: { command: "Remove-Item -Recurse C:\\data" } }, ctx).block, true);
  // Below the threshold: sensitive and none both pass through.
  assert.equal(gate({ toolName: "exec", params: { command: "git push origin main" } }, ctx), undefined);
  assert.equal(gate({ toolName: "exec", params: { command: "python test.py" } }, ctx), undefined);
});

test("riskAtLeast: sensitive threshold also catches destructive (tiers are ordered)", () => {
  const gate = createToolGate({ mode: "enforce", rules: [{ ...riskyRule, riskAtLeast: "sensitive" }] });
  assert.equal(gate({ toolName: "exec", params: { command: "git push" } }, ctx).block, true);
  assert.equal(gate({ toolName: "exec", params: { command: "rm -rf build" } }, ctx).block, true);
  assert.equal(gate({ toolName: "exec", params: { command: "python test.py" } }, ctx), undefined);
});

test("riskAtLeast never fires for a tool risk.js can't judge, even in enforce mode", () => {
  const gate = createToolGate({ mode: "enforce",
    rules: [{ id: "no-mcp-risk", agentId: "scenarios", toolName: "some_mcp_tool", riskAtLeast: "sensitive" }] });
  assert.equal(gate({ toolName: "some_mcp_tool", params: { anything: "x" } }, ctx), undefined);
});

test("riskAtLeast combines with paramsMatch: both conditions must hold", () => {
  const gate = createToolGate({ mode: "enforce",
    rules: [{ ...riskyRule, riskAtLeast: "sensitive", paramsMatch: { command: "git push origin main" } }] });
  assert.equal(gate({ toolName: "exec", params: { command: "git push origin main" } }, ctx).block, true);
  // Matches params but not the risk threshold.
  assert.equal(gate({ toolName: "exec", params: { command: "git status" } }, ctx), undefined);
});

test("the matched risk tier is logged, and only when riskAtLeast actually decided the match", () => {
  const logs = [];
  const gate = createToolGate({ mode: "enforce", rules: [riskyRule], log: (e) => logs.push(e) });
  gate({ toolName: "exec", params: { command: "rm -rf build" } }, ctx);
  assert.equal(logs[0].riskTier, "destructive");

  const paramsOnlyGate = createToolGate({ mode: "enforce", rules: [rule], log: (e) => logs.push(e) });
  paramsOnlyGate(event, ctx);
  assert.equal(logs[1].riskTier, null);
});

// unlessAuthorization: a rule the user's own request waives.
const approveRule = { ...riskyRule, id: "approve-destructive", action: "approve",
  approvalDescription: "A destructive command is pending.", unlessAuthorization: ["requested"] };
const labelled = (label) => () => label;
const rmTmp = { toolName: "exec", params: { command: "rm -rf tmp" } };

test("a requested call skips a rule with unlessAuthorization, and the waiver is logged", () => {
  const logs = [];
  const gate = createToolGate({ mode: "enforce", rules: [approveRule], log: (e) => logs.push(e),
    authorize: labelled("requested") });
  assert.equal(gate(rmTmp, ctx), undefined);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].type, "tool_gate_waived");
  assert.deepEqual(logs[0].ruleIds, ["approve-destructive"]);
  assert.equal(logs[0].authorization, "requested");
  assert.equal(logs[0].riskTier, "destructive");
  assert.ok(!JSON.stringify(logs).includes("rm -rf"));
});

test("own_artifact, unrequested, unlabeled and a throwing labeler never waive", () => {
  for (const authorize of [labelled("own_artifact"), labelled("unrequested"), labelled(null),
    () => { throw new Error("labeler broke"); }]) {
    const gate = createToolGate({ mode: "enforce", rules: [approveRule], authorize });
    assert.ok(gate(rmTmp, ctx)?.requireApproval, String(authorize));
  }
});

test("a waiver on one rule never lifts an overlapping rule without one", () => {
  const block = { ...riskyRule, id: "hard-block" };
  const gate = createToolGate({ mode: "enforce", rules: [approveRule, block], authorize: labelled("requested") });
  assert.equal(gate(rmTmp, ctx).block, true);
});

test("without unlessAuthorization a requested call is still gated", () => {
  const { unlessAuthorization, ...plain } = approveRule;
  const gate = createToolGate({ mode: "enforce", rules: [plain], authorize: labelled("requested") });
  assert.ok(gate(rmTmp, ctx).requireApproval);
});

test("unlessAuthorization accepts only requested", () => {
  for (const bad of [["own_artifact"], ["unrequested"], ["requested", "own_artifact"], "requested", [null]]) {
    assert.throws(() => createToolGate({ rules: [{ ...approveRule, unlessAuthorization: bad }] }), /only list requested/);
  }
});
