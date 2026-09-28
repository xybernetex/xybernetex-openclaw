import { test } from "node:test";
import assert from "node:assert/strict";

import { createFinalizeVerifier, DEFAULT_INSTRUCTION } from "../src/verify.js";

function setup(opts = {}) {
  const calls = new Map([["run-a", 3]]);
  const logs = [];
  const verify = createFinalizeVerifier({ agentIds: ["scenarios"], runKeyOf: (e, c) => e?.runId ?? c?.runId,
    toolCallsFor: (k) => calls.get(k) ?? 0, log: (e) => logs.push(e), ...opts });
  return { verify, calls, logs };
}
const ctx = { agentId: "scenarios", sessionKey: "s" };

test("a run that did work is asked for one verification pass, with a bounded retry", () => {
  const { verify, logs } = setup();
  const out = verify({ runId: "run-a" }, ctx);
  assert.equal(out.action, "revise");
  assert.equal(out.retry.instruction, DEFAULT_INSTRUCTION);
  assert.equal(out.retry.maxAttempts, 1);
  assert.equal(out.retry.idempotencyKey, "xybernetex-verify-before-finish");
  assert.equal(logs[0].type, "finalize_verify");
});

test("each run is asked at most once, even if the host would ask again", () => {
  const { verify } = setup();
  assert.equal(verify({ runId: "run-a" }, ctx).action, "revise");
  assert.equal(verify({ runId: "run-a" }, ctx), undefined);
});

test("other agents and runs with no tool calls are left alone", () => {
  const { verify } = setup();
  assert.equal(verify({ runId: "run-a" }, { agentId: "main" }), undefined);
  assert.equal(verify({ runId: "chat-only" }, ctx), undefined);
});

test("minToolCalls: 0 also verifies runs that made no tool calls", () => {
  const { verify } = setup({ minToolCalls: 0 });
  assert.equal(verify({ runId: "chat-only" }, ctx).action, "revise");
});

test("a custom instruction replaces the default; a broken logger doesn't change the decision", () => {
  const { verify } = setup({ instruction: "Check the tests pass.", log: () => { throw new Error("disk"); } });
  assert.equal(verify({ runId: "run-a" }, ctx).retry.instruction, "Check the tests pass.");
});

test("invalid settings fail registration", () => {
  const base = { runKeyOf: () => "r", toolCallsFor: () => 1 };
  for (const bad of [{}, { agentIds: [] }, { agentIds: [""] }, { agentIds: ["a"], instruction: "" },
    { agentIds: ["a"], instruction: "x".repeat(1001) }, { agentIds: ["a"], minToolCalls: -1 }]) {
    assert.throws(() => createFinalizeVerifier({ ...base, ...bad }), JSON.stringify(bad));
  }
});
