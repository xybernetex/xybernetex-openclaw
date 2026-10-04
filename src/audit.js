// The audit: OpenClaw's own session history, replayed through this plugin's
// hooks exactly as they would have fired live, to show what the agents did
// before Xybernetex was there - which risky actions nobody asked for, what
// instructions were planted in what they read, which runs died while OpenClaw
// reported success, and which ones looped.
//
// The replay runs the real plugin (dist/index.js) with the strict preset in
// observe mode, so every judgment is the gate's own; nothing is stopped and
// nothing leaves the machine. The governor runs beside it (src/governor.js)
// so a loop it would have stopped doesn't hide the calls after it from the gate.
// Wall-clock time isn't replayed, so the time budget never fires here.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin from "../dist/index.js";
import { STANDARD, createGovernor } from "./governor.js";

export const textOf = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => String(c.text ?? "")).join("\n") : "");

// One line for a person: the command for a shell call, the path for a file call.
export function describeCall(toolName, params) {
  const p = params ?? {};
  const text = p.command ?? p.cmd ?? p.script ?? p.path ?? p.file_path ?? p.filePath ?? p.url ?? null;
  const shown = typeof text === "string" ? text : JSON.stringify(p);
  return `${toolName}: ${shown}`.replace(/\s+/g, " ").slice(0, 400);
}

// A session's messages -> runs: each starts at a user message and runs to the next.
export function splitRuns(messages) {
  const runs = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role !== "user") continue;
    let end = i + 1;
    while (end < messages.length && messages[end]?.role !== "user") end += 1;
    runs.push({ start: i, end, prompt: textOf(messages[i].content) });
  }
  return runs;
}

const RISK_WORD = { destructive: "destructive", sensitive: "outward-facing" };

// sessions: [{ agentId, sessionKey, sessionId, messages: [{ role, content, ..., ts }] }]
export function replaySessions(sessions, { preset = "strict", repeatLimit = STANDARD.repeatLimit,
  maxToolCalls = STANDARD.maxToolCalls } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "xybernetex-audit-"));
  const hooks = new Map();
  const logPath = join(dir, "replay.jsonl");
  plugin.register({ pluginConfig: { logPath, control: { mode: "observe", preset } }, on: (name, fn) => hooks.set(name, fn) });
  const hook = (name, event, ctx) => { try { return hooks.get(name)?.(event, ctx); } catch { return undefined; } };
  const governor = createGovernor({ ...STANDARD, maxSeconds: null, repeatLimit, maxToolCalls });

  const calls = new Map();       // toolCallId -> where and what
  const passed = new Map();      // runId -> the success we reported, to spot deaths OpenClaw called successes
  const runInfo = new Map();     // runId -> { agentId, sessionKey, ts, prompt }
  const loops = [];
  const tokens = new Map();      // model -> tokens
  let runCount = 0;
  let callCount = 0;
  let first = Infinity;
  let last = -Infinity;
  try {
    for (const s of sessions) {
      const ctxBase = { sessionKey: s.sessionKey, agentId: s.agentId };
      for (const [i, run] of splitRuns(s.messages).entries()) {
        const runId = `${s.sessionId}:${i}`;
        const msgs = s.messages.slice(run.start, run.end);
        const ts = msgs[0]?.ts ?? null;
        if (ts) { first = Math.min(first, ts); last = Math.max(last, ts); }
        runCount += 1;
        runInfo.set(runId, { agentId: s.agentId, sessionKey: s.sessionKey, ts, prompt: run.prompt.slice(0, 200) });
        hook("before_agent_run", { prompt: run.prompt, runId }, { ...ctxBase, runId });
        governor.start(runId);
        let looped = false;
        const pending = new Map();
        for (const m of msgs) {
          if (m.role === "assistant") {
            if (m.usage && m.model) tokens.set(m.model, (tokens.get(m.model) ?? 0) + (Number(m.usage.totalTokens) || 0));
            for (const c of Array.isArray(m.content) ? m.content : []) {
              if (c?.type !== "toolCall") continue;
              callCount += 1;
              const call = { toolName: c.name, params: c.arguments ?? {}, toolCallId: c.id, runId };
              calls.set(c.id, { ...ctxBase, runId, ts: m.ts, toolName: c.name, text: describeCall(c.name, c.arguments) });
              pending.set(c.id, call);
              hook("before_tool_call", call, { ...ctxBase, runId, toolCallId: c.id });
              const stop = governor.onCall(runId, c.id, c.name, c.arguments ?? {});
              if (stop && !looped) {
                looped = true;
                const kind = governor.stopped(runId) ?? (/in a row/.test(stop) ? "repeat" : "tool-calls");
                loops.push({ ...ctxBase, runId, ts: m.ts, kind, text: describeCall(c.name, c.arguments) });
              }
            }
          } else if (m.role === "toolResult") {
            const call = pending.get(m.toolCallId);
            hook("after_tool_call", { toolName: m.toolName ?? call?.toolName, params: call?.params ?? {}, runId,
              toolCallId: m.toolCallId, result: m.content, error: m.isError ? textOf(m.content).slice(0, 200) : undefined },
            { ...ctxBase, runId, toolCallId: m.toolCallId });
          }
        }
        governor.end(runId);
        const lastReply = [...msgs].reverse().find((m) => m.role === "assistant");
        const success = !["error", "aborted"].includes(lastReply?.stopReason);
        passed.set(runId, success);
        hook("agent_end", { success, error: success ? undefined : lastReply?.errorMessage,
          messages: s.messages.slice(0, run.end), durationMs: (msgs.at(-1)?.ts ?? ts) - ts }, { ...ctxBase, runId });
      }
      hook("session_end", {}, ctxBase);
    }

    const log = readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const at = (id) => calls.get(id) ?? {};
    const planted = log.filter((e) => e.type === "planted_delete_seen").map((e) => ({ ...at(e.toolCallId),
      agentId: e.agentId, sessionKey: e.sessionKey, targets: e.targets }));
    // A held call after the agent read a planted delete in the same session most likely came from it.
    const plantedSince = new Map();
    for (const p of planted) if (!plantedSince.has(p.sessionKey) || (p.ts ?? 0) < plantedSince.get(p.sessionKey)) plantedSince.set(p.sessionKey, p.ts ?? 0);
    // A call held only because it touches a target held earlier (followsHold) is left out: live, the first
    // call would have been held, so this one wouldn't have happened as recorded.
    const unrequested = log.filter((e) => e.type === "tool_gate" && !e.followsHold).map((e) => {
      const c = at(e.toolCallId);
      return { ts: c.ts ?? null, agentId: e.agentId, sessionKey: e.sessionKey, toolName: e.toolName, text: c.text ?? e.toolName,
        risk: e.planted ? "destructive" : RISK_WORD[e.riskTier] ?? e.riskTier ?? "risky",
        planted: e.planted === true || (plantedSince.has(e.sessionKey) && (c.ts ?? Infinity) >= plantedSince.get(e.sessionKey)) };
    });
    const waived = log.filter((e) => e.type === "tool_gate_waived");
    const ends = log.filter((e) => e.type === "run_end");
    const silent = ends.filter((e) => passed.get(e.runKey) === true && e.success === false)
      .map((e) => ({ ...runInfo.get(e.runKey), reason: e.error }));
    const reported = ends.filter((e) => passed.get(e.runKey) === false)
      .map((e) => ({ ...runInfo.get(e.runKey), reason: e.error }));
    const agents = [...new Set(sessions.map((s) => s.agentId))];
    return {
      window: { from: Number.isFinite(first) ? first : null, to: Number.isFinite(last) ? last : null },
      agents, sessions: sessions.length, runs: runCount, toolCalls: callCount,
      risky: { total: unrequested.length + waived.length, requested: waived.filter((e) => e.authorization === "requested").length,
        ownFiles: waived.filter((e) => e.waiver === "own_files" || e.authorization === "own_artifact").length,
        unrequested },
      planted, deaths: { silent, reported }, loops,
      tokens: [...tokens.entries()].sort((a, b) => b[1] - a[1]).map(([model, total]) => ({ model, total })),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
