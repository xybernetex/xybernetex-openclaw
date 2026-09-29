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

test("the recommended preset holds unrequested destructive calls from any agent, for approval", () => {
  const logs = [];
  const gate = createToolGate({ mode: "enforce", preset: "recommended", log: (e) => logs.push(e),
    authorize: () => "unrequested" });
  assert.deepEqual(gate.ruleIds, ["preset-destructive-approve"]);
  const held = gate({ toolName: "exec", params: { command: "rm -rf build" } }, { agentId: "any-agent" });
  assert.equal(held.requireApproval.severity, "warning");
  assert.match(held.requireApproval.description, /didn't ask for/);
  // Harmless and outward-facing calls run; so do tools the classifier can't judge.
  assert.equal(gate({ toolName: "exec", params: { command: "ls" } }, { agentId: "any-agent" }), undefined);
  assert.equal(gate({ toolName: "exec", params: { command: "git push" } }, { agentId: "any-agent" }), undefined);
  assert.equal(gate({ toolName: "mystery_tool", params: {} }, { agentId: "any-agent" }), undefined);
  assert.equal(logs[0].ruleId, "preset-destructive-approve");
});

test("presets waive destructive calls the user's own turn requested", () => {
  const logs = [];
  const gate = createToolGate({ mode: "enforce", preset: "strict", log: (e) => logs.push(e),
    authorize: () => "requested" });
  assert.equal(gate({ toolName: "exec", params: { command: "rm -rf build" } }, { agentId: "main" }), undefined);
  assert.equal(logs[0].type, "tool_gate_waived");
});

test("the strict preset blocks unrequested destruction and holds unrequested outward actions", () => {
  const gate = createToolGate({ mode: "enforce", preset: "strict", authorize: () => "unrequested" });
  assert.equal(gate({ toolName: "exec", params: { command: "git reset --hard" } }, { agentId: "main" }).block, true);
  assert.ok(gate({ toolName: "exec", params: { command: "git push origin main" } }, { agentId: "main" }).requireApproval);
  assert.equal(gate({ toolName: "exec", params: { command: "npm test" } }, { agentId: "main" }), undefined);
});

test("operator rules extend a preset; bad presets, colliding ids and bare tool wildcards are rejected", () => {
  const gate = createToolGate({ preset: "recommended", rules: [rule] });
  assert.deepEqual(gate.ruleIds, ["preset-destructive-approve", "test-denial"]);
  assert.deepEqual(createToolGate({ preset: "none" }).ruleIds, []);
  assert.throws(() => createToolGate({ preset: "paranoid" }), /control.preset must be one of none, recommended, strict/);
  assert.throws(() => createToolGate({ preset: "recommended", rules: [{ ...rule, id: "preset-destructive-approve" }] }),
    /duplicate control rule id/);
  assert.throws(() => createToolGate({ rules: [{ id: "all", agentId: "*", toolName: "*" }] }), /needs riskAtLeast/);
});

// The 2026-09-29 demo run: held `rm -rf customer-data` in a CLI run, OpenClaw's
// "approval unavailable" error, then `mv customer-data customer-data.removed-backup`.
const preset = (logs = [], extra = {}) => createToolGate({ mode: "enforce", preset: "recommended",
  log: (e) => logs.push(e), authorize: () => "unrequested", ...extra });
const demo = { agentId: "main", sessionKey: "demo" };
const exec = (command) => ({ toolName: "exec", params: { command } });

test("a hold no one can approve says why, and later holds in the session block with that reason", () => {
  const logs = [];
  const gate = preset(logs);
  const first = gate(exec("rm -rf ../customer-data"), demo).requireApproval;
  assert.match(first.timeoutReason, /didn't ask for this/);
  first.onResolution("cancelled");
  const second = gate(exec("rm -rf /tmp/other-data"), demo);
  assert.equal(second.block, true);
  assert.match(second.blockReason, /user didn't ask for this/);
  assert.match(second.blockReason, /deletions the user asks for directly, is not affected/);
  assert.equal(logs.at(-1).approvalUnavailable, true);
  assert.equal(logs.at(-1).action, "BLOCK_ACTION");
  // Other sessions still get a real approval.
  assert.ok(gate(exec("rm -rf /tmp/other-data"), { ...demo, sessionKey: "other" }).requireApproval);
});

test("after a hold, moving, renaming or overwriting the held target is held too", () => {
  const logs = [];
  const gate = preset(logs);
  assert.ok(gate(exec("rm -rf ../customer-data"), demo).requireApproval);
  for (const cmd of ["mv /root/oc-workspace/customer-data /root/oc-workspace/customer-data.removed-backup",
    "cp -r empty ../customer-data", "echo x > customer-data/customers.csv"]) {
    const held = gate(exec(cmd), demo);
    assert.equal(held?.block, true, cmd);
    assert.match(held.blockReason, /customer-data, which was held a moment ago/);
  }
  assert.equal(gate({ toolName: "write", params: { path: "customer-data/new.csv", content: "" } }, demo).block, true);
  assert.equal(logs.at(-1).followsHold, true);
  assert.ok(!JSON.stringify(logs).includes("customer-data"));
  // Reading it, touching other paths, and other sessions are unaffected.
  assert.equal(gate(exec("cat ../customer-data/customers.csv"), demo), undefined);
  assert.equal(gate(exec("mv build build.old"), demo), undefined);
  assert.equal(gate(exec("mv customer-data backup"), { ...demo, sessionKey: "other" }), undefined);
});

test("a held target the user then asks to delete or move is no longer held", () => {
  const gate = preset([], { requestsTarget: (_ctx, target) => target === "../customer-data" });
  assert.ok(gate(exec("rm -rf ../customer-data"), demo).requireApproval);
  assert.equal(gate(exec("mv ../customer-data /tmp/archive"), demo), undefined);
});

test("observe mode remembers holds too, but only logs the follow-through", () => {
  const logs = [];
  const gate = createToolGate({ preset: "recommended", log: (e) => logs.push(e), authorize: () => "unrequested" });
  assert.equal(gate(exec("rm -rf data"), demo), undefined);
  assert.equal(gate(exec("mv data data.bak"), demo), undefined);
  assert.equal(logs.at(-1).followsHold, true);
  assert.equal(logs.at(-1).action, "WOULD_BLOCK");
});

test("operator rules keep their own block reason; only who-asked rules explain the request", () => {
  const block = createToolGate({ mode: "enforce", rules: [rule] })(event, ctx);
  assert.match(block.blockReason, /Xybernetex rule 'test-denial' prohibits/);
  const strict = createToolGate({ mode: "enforce", preset: "strict", authorize: () => "unrequested" });
  assert.match(strict(exec("rm -rf data"), demo).blockReason, /user didn't ask for this/);
});

test("an agent wildcard in an operator rule covers every agent", () => {
  const gate = createToolGate({ mode: "enforce", rules: [{ ...rule, agentId: "*" }] });
  assert.equal(gate(event, { agentId: "main" }).block, true);
  assert.equal(gate(event, {}).block, true);
});
