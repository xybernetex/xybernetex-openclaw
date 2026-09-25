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
    assert.equal(hooks.has("after_tool_call"), false);
    assert.equal(hooks.get("before_tool_call")({ toolName: "exec", params: {} },
      { agentId: "scenarios" }).block, true);
    assert.equal(hooks.get("before_tool_call")({ toolName: "exec", params: {} },
      { agentId: "main" }), undefined);
    const logs = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(logs.some((e) => e.type === "tool_gate_ready" && e.mode === "enforce"));
    assert.ok(logs.some((e) => e.type === "tool_gate" && e.enforced));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
