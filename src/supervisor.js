// Observe-only supervisor core: tracks each agent run's tool calls, asks the
// Xybernetex policy what it would do after every completed
// tool call, and logs the answer. Nothing here changes what the agent does -
// that's deliberate for this first pass, whose job is to collect real
// trajectories (and the policy's would-be decisions on them) before any
// decision is ever enforced.
//
// Kept free of OpenClaw imports so it can be tested with plain node:test;
// index.ts only wires OpenClaw's hooks to these methods.
import { createHash } from "node:crypto";

import { classifyToolCall } from "./risk.js";

// The Worker's features only look at the last 8 tool calls and last 16
// supervisor actions, so only that tail is ever sent.
const TOOL_TAIL = 8;
const ACTION_TAIL = 16;

const TIMEOUT_PATTERN = /timed?\s*out|timeout|ETIMEDOUT/i;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// Tool params never leave the machine - the policy only needs to know whether
// two calls were identical (its loop detector), which a hash of the
// key-order-independent JSON answers exactly.
export function hashParams(params) {
  let text;
  try {
    text = canonicalJson(params ?? {});
  } catch {
    text = String(params); // cyclic or otherwise unserializable: best effort
  }
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function createSupervisor({
  endpoint,
  apiKey,
  maxToolCallsPerRun = 50,
  requestTimeoutMs = 5_000,
  maxTrackedRuns = 200,
  proposalTelemetry = false,
  fetchImpl = fetch,
  log = () => {},
  now = () => Date.now(),
}) {
  const runs = new Map(); // runKey -> run state; Map order doubles as LRU order

  function getRun(runKey) {
    let run = runs.get(runKey);
    if (run) {
      runs.delete(runKey); // re-insert to mark most recently used
    } else {
      run = { toolCount: 0, toolTail: [], recentActions: [], queue: Promise.resolve() };
    }
    runs.set(runKey, run);
    while (runs.size > maxTrackedRuns) runs.delete(runs.keys().next().value);
    return run;
  }

  // Cost is measured in tool calls against the step budget. OpenClaw only
  // reports token usage once a run has finished (llm_output, as a run total;
  // model_call_ended carries no token counts as of 2026.9.6), so tokens can't
  // inform decisions mid-run - index.ts logs the run total for later analysis.
  function snapshotFor(run, runKey, { step, toolTail }) {
    return {
      run_id: runKey,
      objective: "",
      step_number: step,
      max_steps: maxToolCallsPerRun,
      recent_actions: [...run.recentActions],
      tool_history: toolTail,
      cost_so_far: step,
      cost_budget: maxToolCallsPerRun,
      goal_drift_score: null,
      feature_schema: "xybernetex.state.v1",
    };
  }

  async function evaluate(run, runKey, atCall) {
    const snapshot = snapshotFor(run, runKey, atCall);
    const started = now();
    const entry = { runKey, step: atCall.step, toolName: atCall.toolName, sessionKey: atCall.sessionKey, snapshot };
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ snapshot }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        log({ ...entry, latencyMs: now() - started, error: `HTTP ${res.status}: ${body.error ?? "no body"}` });
        return;
      }
      // The policy was trained with its own past decisions as input, so they
      // feed forward exactly as if enforced - even though nothing is here.
      run.recentActions.push(body.action);
      if (run.recentActions.length > ACTION_TAIL) run.recentActions.shift();
      log({ ...entry, latencyMs: now() - started, decision: body });
    } catch (err) {
      log({ ...entry, latencyMs: now() - started, error: String(err?.message ?? err) });
    }
  }

  // Called for every completed tool call. Captures the run's state as of this
  // call synchronously, then queues the evaluation behind the run's previous
  // one so each request sees every decision made before it. Returns that
  // queued promise (tests await it; the hook doesn't).
  function recordToolCall(runKey, { toolName, params, error, sessionKey, toolCallId }) {
    const run = getRun(runKey);
    const errorText = typeof error === "string" ? error : error ? String(error) : "";
    const record = {
      tool_name: toolName,
      params: { h: hashParams(params) },
      success: !errorText,
      timed_out: Boolean(errorText) && TIMEOUT_PATTERN.test(errorText),
    };
    // Judged here, from the params, before they're reduced to a hash; left
    // off for tools risk.js doesn't know, so the server judges the name.
    const risk = classifyToolCall(toolName, params);
    if (risk !== null) record.risk = risk;
    run.toolTail.push(record);
    if (run.toolTail.length > TOOL_TAIL) run.toolTail.shift();
    run.toolCount += 1;
    if (proposalTelemetry) {
      try { log({ type: "tool_completed", runKey, sessionKey, toolCallId, step: run.toolCount, record }); }
      catch { /* best-effort telemetry */ }
    }
    const atCall = { step: run.toolCount, toolTail: [...run.toolTail], toolName, sessionKey };
    if (!endpoint || !apiKey) return Promise.resolve();
    run.queue = run.queue.then(() => evaluate(run, runKey, atCall));
    return run.queue;
  }

  function endRun(runKey) {
    runs.delete(runKey);
  }

  // Capture pending intent separately: no fabricated outcome, no step/cost
  // increment, no policy request and no mutation of completed-call history.
  function recordProposal(runKey, { toolName, params, toolCallId, sessionKey }) {
    const run = getRun(runKey);
    const proposed = { tool_name: toolName, params: { h: hashParams(params) },
      tool_call_id: toolCallId ?? null, risk: classifyToolCall(toolName, params) };
    const snapshot = { ...snapshotFor(run, runKey, { step: run.toolCount, toolTail: [...run.toolTail] }),
      feature_schema: "xybernetex.state.v2", proposed_call: proposed };
    log({ type: "tool_proposal", runKey, sessionKey, toolCallId, snapshot });
    return snapshot;
  }

  return { recordToolCall, recordProposal, endRun, trackedRuns: () => runs.size };
}
