import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "../scripts/build.mjs";

test("dist/index.js is current with index.ts (run npm run build)", () => {
  assert.equal(readFileSync(new URL("../dist/index.js", import.meta.url), "utf8"), build());
});

test("the compiled plugin loads and registers like the TypeScript one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xybernetex-dist-"));
  try {
    const { default: plugin } = await import("../dist/index.js");
    const hooks = new Map();
    plugin.register({ pluginConfig: { logPath: join(dir, "events.jsonl"), control: { mode: "enforce", preset: "strict" } },
      on: (name, handler) => hooks.set(name, handler) });
    assert.equal(plugin.id, "xybernetex-openclaw");
    assert.equal(hooks.get("before_tool_call")({ toolName: "exec", params: { command: "rm -rf /" } }, { agentId: "a" }).block, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
