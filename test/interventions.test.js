import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventEmitter } from "node:events";
import { MARKER, MESSAGES, createCliScheduler, createInterventions, createRemoteDecider, decideV0, isOurs, retriable } from "../src/interventions.js";
import plugin from "../index.ts";

const ctx = { sessionKey: "agent:main:s1", agentId: "main" };

test("v0 retries runs that died on unusable output, verifies finished runs that did work", () => {
  assert.equal(decideV0({ success: false, error: "incomplete_turn: model stopped", toolCalls: 3 }).action, "retry");
  assert.equal(decideV0({ success: false, error: "Request timed out before a response was generated", toolCalls: 0 }).action, "retry");
  assert.equal(decideV0({ success: false, error: "Run aborted by user", toolCalls: 3 }).action, "none");
  assert.equal(decideV0({ success: false, error: "approval denied", toolCalls: 3 }).action, "none");
  assert.equal(decideV0({ success: true, toolCalls: 0 }).action, "none");
  assert.deepEqual(decideV0({ success: true, toolCalls: 4 }), { action: "verify", probability: 1, rule: "v0-verify" });
  assert.deepEqual(decideV0({ success: true, toolCalls: 4 }, { verifyRate: 0.3, random: () => 0.9 }),
    { action: "none", probability: 0.7, rule: "v0-verify" });
  assert.equal(retriable("format error in tool call"), true);
  assert.equal(retriable("user cancelled"), false);
});

test("act mode schedules the turn in the same session; observe mode only logs", async () => {
  const scheduled = [];
  const logs = [];
  const act = createInterventions({ config: { mode: "act" }, log: (e) => logs.push(e),
    schedule: async (p) => { scheduled.push(p); return { id: "job1" }; } });
  const entry = await act.onRunEnd("r1", ctx, { success: true, toolCalls: 5, model: "workers-ai/@cf/x" });
  assert.equal(entry.action, "verify");
  assert.equal(entry.scheduled, true);
  assert.equal(scheduled[0].sessionKey, "agent:main:s1");
  assert.equal(scheduled[0].message, MESSAGES.verify);
  assert.ok(scheduled[0].message.startsWith(MARKER));
  assert.equal(scheduled[0].model, "workers-ai/@cf/x"); // the follow-up runs on the same model

  const quiet = [];
  const observe = createInterventions({ config: {}, log: (e) => logs.push(e), schedule: async (p) => { quiet.push(p); } });
  const e2 = await observe.onRunEnd("r2", ctx, { success: false, error: "incomplete_turn", toolCalls: 2 });
  assert.equal(e2.action, "retry");
  assert.equal(e2.scheduled, false);
  assert.equal(quiet.length, 0);
});

test("our own turns never trigger another intervention (no loops), and the session is capped", async () => {
  const scheduled = [];
  const iv = createInterventions({ config: { mode: "act" }, schedule: async (p) => { scheduled.push(p); return {}; } });
  await iv.onRunEnd("r1", ctx, { success: true, toolCalls: 3 });
  assert.equal(iv.noteRunStart("r2", MESSAGES.verify), true);
  assert.equal(await iv.onRunEnd("r2", ctx, { success: true, toolCalls: 2 }), null);
  assert.equal(scheduled.length, 1);
  for (let i = 3; i < 10; i += 1) await iv.onRunEnd(`r${i}`, ctx, { success: true, toolCalls: 1 });
  assert.equal(scheduled.length, 3); // maxPerSession
  assert.equal(iv.noteRunStart("r11", "delete the build folder"), false);
});

test("agent filters, a failing scheduler, and bad config", async () => {
  const iv = createInterventions({ config: { mode: "act", agentIds: ["scenarios"] }, schedule: async () => { throw new Error("cron down"); } });
  assert.equal(await iv.onRunEnd("r1", ctx, { success: true, toolCalls: 3 }), null); // agent "main" not listed
  const e = await iv.onRunEnd("r2", { ...ctx, agentId: "scenarios" }, { success: true, toolCalls: 3 });
  assert.equal(e.scheduled, false);
  assert.match(e.error, /cron down/);
  assert.throws(() => createInterventions({ config: { mode: "maybe" }, schedule: async () => {} }), /observe or act/);
  assert.throws(() => createInterventions({ config: { verifyRate: 2 }, schedule: async () => {} }), /0-1/);
  assert.equal(isOurs(`  ${MARKER} hi`), true);
});

test("the CLI scheduler starts a detached openclaw agent turn in the same session, on the same model", async () => {
  const spawned = [];
  const spawn = (node, args, opts) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.unref = () => { child.unrefed = true; };
    spawned.push({ node, args, opts, child });
    setImmediate(() => child.emit("spawn"));
    return child;
  };
  const schedule = createCliScheduler({ entry: "/oc/openclaw.mjs", node: "/bin/node", spawn, delayMs: 0 });
  assert.deepEqual(await schedule({ sessionKey: "agent:main:s1", agentId: "main", message: MESSAGES.verify,
    model: "workers-ai/@cf/zai-org/glm-5.3-flash" }), { pid: 4242 });
  const { node, args, opts, child } = spawned[0];
  assert.equal(node, "/bin/node");
  assert.deepEqual(args.slice(0, 6), ["/oc/openclaw.mjs", "agent", "--agent", "main", "--session-key", "agent:main:s1"]);
  assert.equal(args[args.indexOf("--message") + 1], MESSAGES.verify);
  assert.equal(args[args.indexOf("--model") + 1], "workers-ai/@cf/zai-org/glm-5.3-flash");
  assert.equal(opts.detached, true);
  assert.equal(child.unrefed, true);

  const broken = createCliScheduler({ entry: "/oc/openclaw.mjs", delayMs: 0, spawn: () => {
    const c = new EventEmitter(); setImmediate(() => c.emit("error", new Error("ENOENT"))); return c; } });
  await assert.rejects(broken({ sessionKey: "s", message: "m" }), /ENOENT/);
});

test("a failing scheduler can't loop: attempts count, and there's a gateway-wide rate limit", async () => {
  let calls = 0;
  const failing = createInterventions({ config: { mode: "act" }, schedule: async () => { calls += 1; throw new Error("down"); } });
  for (let i = 0; i < 10; i += 1) await failing.onRunEnd(`r${i}`, ctx, { success: true, toolCalls: 2 });
  assert.equal(calls, 3); // per-session cap counts failed attempts too

  let t = 0;
  let started = 0;
  const busy = createInterventions({ config: { mode: "act" }, now: () => t, schedule: async () => { started += 1; return {}; } });
  for (let i = 0; i < 30; i += 1) await busy.onRunEnd(`q${i}`, { ...ctx, sessionKey: `agent:main:s${i}` }, { success: true, toolCalls: 2 });
  assert.equal(started, 10); // maxPerMinute
  t += 61_000;
  await busy.onRunEnd("later", { ...ctx, sessionKey: "agent:main:later" }, { success: true, toolCalls: 2 });
  assert.equal(started, 11);
});

test("the plugin wires it up: decisions are logged, and our turn is never the user's request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xybernetex-interventions-"));
  try {
    const hooks = new Map();
    plugin.register({
      pluginConfig: { logPath: join(dir, "events.jsonl"), interventions: { mode: "observe" },
        control: { mode: "enforce", preset: "recommended" } },
      on: (name, handler) => hooks.set(name, handler),
    });
    const c = { sessionKey: "agent:main:s9", agentId: "main", inputProvenance: { kind: "external_user" } };
    hooks.get("before_agent_run")({ runId: "run1", prompt: "tidy the repo" }, c);
    hooks.get("after_tool_call")({ runId: "run1", toolName: "read", params: {} }, c);
    hooks.get("agent_end")({ runId: "run1", success: true, durationMs: 1000 }, c);
    hooks.get("llm_output")({ runId: "run1", provider: "workers-ai", model: "@cf/zai-org/glm-5.3-flash", usage: {} }, c);
    await new Promise((r) => setTimeout(r, 600));

    // Our follow-up arrives: it must not become the user's "request" (so it
    // can't authorize a delete), and its end is logged as an outcome.
    hooks.get("before_agent_run")({ runId: "run2", prompt: MESSAGES.verify }, c);
    const gate = hooks.get("before_tool_call")({ runId: "run2", toolName: "exec", params: { command: "rm -rf build" } }, c);
    assert.ok(gate?.requireApproval, "a delete in our turn is still unrequested");
    hooks.get("agent_end")({ runId: "run2", success: true }, c);
    await new Promise((r) => setTimeout(r, 600));

    const logs = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(logs.some((e) => e.type === "interventions_ready" && e.mode === "observe"));
    const iv = logs.filter((e) => e.type === "intervention");
    assert.deepEqual(iv.map((e) => e.action), ["verify", "outcome"]);
    assert.equal(iv[0].model, "workers-ai/@cf/zai-org/glm-5.3-flash");
    assert.equal(iv[0].scheduled, false); // observe mode never starts a turn
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the remote decider sends only the run's shape and falls back to v0 when the service can't answer", async () => {
  const sent = [];
  const decide = createRemoteDecider({ endpoint: "https://api.example/evaluate", apiKey: "k",
    fetchImpl: async (url, init) => { sent.push({ url, init }); return new Response(JSON.stringify({ action: "verify", probability: 0.9, rule: "verify-helps", policy: "v0-targeted" })); } });
  const d = await decide({ success: true, toolCalls: 4, model: "m", error: "secret error text", durationMs: 5 });
  assert.deepEqual(d, { action: "verify", probability: 0.9, rule: "verify-helps", policy: "v0-targeted" });
  assert.equal(sent[0].url, "https://api.example/intervene");
  assert.deepEqual(JSON.parse(sent[0].init.body), { summary: { success: true, retriable: false, toolCalls: 4, model: "m" } });
  assert.ok(!sent[0].init.body.includes("secret error text"));

  const down = createRemoteDecider({ endpoint: "https://api.example/evaluate", apiKey: "k", fetchImpl: async () => { throw new Error("offline"); } });
  const f = await down({ success: false, error: "incomplete_turn", toolCalls: 1 });
  assert.deepEqual({ action: f.action, rule: f.rule, policy: f.policy }, { action: "retry", rule: "fallback:v0-retry-on-death", policy: "local-v0" });
  assert.match(f.fallbackReason, /offline/);
  const junk = createRemoteDecider({ endpoint: "https://api.example/evaluate", apiKey: "k",
    fetchImpl: async () => new Response(JSON.stringify({ action: "delete-everything" })) });
  assert.equal((await junk({ success: true, toolCalls: 0 })).policy, "local-v0");
});
