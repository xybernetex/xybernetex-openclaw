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
  const mutable = { ...rule, paramsMatch: { ...rule.paramsMatch } };
  const gate = createToolGate({ mode: "enforce", rules: [mutable] });
  mutable.paramsMatch.command = "changed";
  assert.equal(gate(event, ctx).block, true);
});
