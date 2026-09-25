import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index.ts";

test("the actual plugin registers a working gate without a remote endpoint", () => {
  const dir = mkdtempSync(join(tmpdir(), "xybernetex-registration-"));
  try {
    const hooks = new Map();
    plugin.register({
      pluginConfig: { logPath: join(dir, "events.jsonl"), control: { mode: "enforce",
        rules: [{ id: "no-exec", agentId: "scenarios", toolName: "exec" }] } },
      on: (name, handler) => hooks.set(name, handler),
    });
    assert.equal(hooks.has("after_tool_call"), true);
    assert.equal(hooks.get("before_tool_call")({ toolName: "exec", params: {} },
      { agentId: "scenarios" }).block, true);
    assert.equal(hooks.get("before_tool_call")({ toolName: "exec", params: {} },
      { agentId: "main" }), undefined);
    const logs = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(logs.some((e) => e.type === "tool_gate_ready" && e.mode === "enforce"));
    assert.ok(logs.some((e) => e.type === "tool_gate" && e.enforced));
    assert.ok(!logs.some((e) => e.type === "tool_proposal"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opt-in proposal hooks retain completed history and still enforce the gate offline", () => {
  const dir = mkdtempSync(join(tmpdir(), "xybernetex-proposals-"));
  try {
    const hooks = new Map();
    plugin.register({
      pluginConfig: { logPath: join(dir, "events.jsonl"), proposalTelemetry: true,
        control: { mode: "enforce", rules: [{ id: "no-exec", agentId: "scenarios", toolName: "exec" }] } },
      on: (name, handler) => hooks.set(name, handler),
    });
    const ctx = { runId: "proposal-run", agentId: "scenarios", toolCallId: "host-call" };
    hooks.get("after_tool_call")({ toolName: "read", params: { path: "private-path" } }, ctx);
    assert.equal(hooks.get("before_tool_call")({ toolName: "exec", params: { command: "rm private-path" } }, ctx).block, true);
    const raw = readFileSync(join(dir, "events.jsonl"), "utf8");
    const proposal = raw.trim().split("\n").map(JSON.parse).find((e) => e.type === "tool_proposal");
    assert.equal(proposal.snapshot.tool_history.length, 1);
    assert.equal(proposal.snapshot.step_number, 1);
    assert.equal(proposal.snapshot.proposed_call.tool_name, "exec");
    assert.equal(proposal.snapshot.feature_schema, "xybernetex.state.v2");
    assert.equal(proposal.toolCallId, "host-call");
    const completion = raw.trim().split("\n").map(JSON.parse).find((e) => e.type === "tool_completed");
    assert.equal(completion.toolCallId, "host-call");
    assert.equal(completion.record.tool_name, "read");
    assert.ok(!raw.includes("private-path"));
    hooks.get("agent_end")({}, ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
