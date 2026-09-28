import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_ENDPOINT, describeStep, planSetup } from "../src/setup_plan.js";

const labels = (steps) => steps.map((s) => s.args.slice(0, 3).join(" "));

test("a fresh install: install, enable, conversation access, endpoint, mode, preset, key", () => {
  const steps = planSetup({ installed: false, allow: null }, { source: "/pkg", apiKey: "xyb_secret" });
  assert.deepEqual(steps[0].args, ["plugins", "install", "/pkg", "--accept-capabilities"]);
  assert.deepEqual(labels(steps), ["plugins install /pkg", "plugins enable xybernetex-openclaw",
    "config set plugins.entries.xybernetex-openclaw.hooks.allowConversationAccess",
    "config set plugins.entries.xybernetex-openclaw.config.endpoint",
    "config set plugins.entries.xybernetex-openclaw.config.control.mode",
    "config set plugins.entries.xybernetex-openclaw.config.control.preset",
    "config set plugins.entries.xybernetex-openclaw.config.apiKey"]);
  assert.equal(steps[3].args[3], DEFAULT_ENDPOINT);
  assert.equal(steps[4].args[3], "observe"); // safe default: log what it would stop
  assert.equal(steps[5].args[3], "recommended");
  assert.equal(steps[2].optional, true);
});

test("an existing allowlist is extended, never replaced; none means nothing to add", () => {
  const steps = planSetup({ installed: true, allow: ["browser", "codex"] }, {});
  const allow = steps.find((s) => s.args[2] === "plugins.allow");
  assert.deepEqual(JSON.parse(allow.args[3]), ["browser", "codex", "xybernetex-openclaw"]);
  assert.ok(!planSetup({ installed: true, allow: null }, {}).some((s) => s.args[2] === "plugins.allow"));
  assert.ok(!planSetup({ installed: true, allow: ["xybernetex-openclaw"] }, {}).some((s) => s.args[2] === "plugins.allow"));
});

test("already installed: settings only, unless --reinstall (which overwrites)", () => {
  assert.ok(!planSetup({ installed: true, allow: null }, {}).some((s) => s.args[1] === "install"));
  const re = planSetup({ installed: true, allow: null }, { source: "/pkg", reinstall: true });
  assert.deepEqual(re[0].args, ["plugins", "install", "/pkg", "--accept-capabilities", "--force"]);
});

test("a fresh install confirms the non-ClawHub source only when the operator agreed", () => {
  assert.deepEqual(planSetup({ installed: false, allow: null }, { source: "/pkg", trustSource: true })[0].args,
    ["plugins", "install", "/pkg", "--accept-capabilities", "--force"]);
  assert.ok(!planSetup({ installed: false, allow: null }, { source: "/pkg" })[0].args.includes("--force"));
});

test("the API key is never printed, and bad options are refused", () => {
  const steps = planSetup({ installed: true, allow: null }, { apiKey: "xyb_live_supersecret" });
  const keyStep = steps.find((s) => s.secret);
  assert.ok(!describeStep(keyStep).includes("supersecret"));
  assert.ok(steps.filter((s) => !s.secret).every((s) => !describeStep(s).includes("supersecret")));
  assert.ok(!planSetup({ installed: true, allow: null }, {}).some((s) => s.secret));
  assert.throws(() => planSetup({ installed: true, allow: null }, { mode: "block" }), /--mode/);
  assert.throws(() => planSetup({ installed: true, allow: null }, { preset: "paranoid" }), /--preset/);
  assert.throws(() => planSetup({ installed: true, allow: null }, { endpoint: "http://insecure/evaluate" }), /https/);
  assert.throws(() => planSetup({ installed: false, allow: null }, {}), /no plugin source/);
});
