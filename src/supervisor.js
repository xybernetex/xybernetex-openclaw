// Observe-only supervisor core: tracks each agent run's tool calls and token
// spend, asks the Xybernetex policy what it would do after every completed
// tool call, and logs the answer. Nothing here changes what the agent does -
// that's deliberate for this first pass, whose job is to collect real
// trajectories (and the policy's would-be decisions on them) before any
// decision is ever enforced.
//
// Kept free of OpenClaw imports so it can be tested with plain node:test;
// index.ts only wires OpenClaw's hooks to these methods.
import { createHash } from "node:crypto";

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
  tokenBudgetPerRun = 1_000_000,
  requestTimeoutMs = 5_000,
  maxTrackedRuns = 200,
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
      run = { toolCount: 0, toolTail: [], recentActions: [], tokensUsed: 0, sawTokenUsage: false,
              queue: Promise.resolve() };
    }
    runs.set(runKey, run);
    while (runs.size > maxTrackedRuns) runs.delete(runs.keys().next().value);
    return run;
  }

  // Token spend per run, when llm_output is visible to the plugin (it needs
  // OpenClaw's conversation-access grant). Without it, cost falls back to
  // step count against the step budget - see snapshotFor.
  function recordTokens(runKey, usage) {
    const total = usage?.total ?? (usage?.input ?? 0) + (usage?.output ?? 0);
    if (!Number.isFinite(total) || total <= 0) return;
    const run = getRun(runKey);
    run.tokensUsed += total;
    run.sawTokenUsage = true;
  }

  function snapshotFor(run, runKey, { step, toolTail, tokensAtStep }) {
    const cost = run.sawTokenUsage
      ? { cost_so_far: tokensAtStep, cost_budget: tokenBudgetPerRun, cost_basis: "tokens" }
      : { cost_so_far: step, cost_budget: maxToolCallsPerRun, cost_basis: "steps" };
    return {
      snapshot: {
        run_id: runKey,
        objective: "",
        step_number: step,
        max_steps: maxToolCallsPerRun,
        recent_actions: [...run.recentActions],
        tool_history: toolTail,
        cost_so_far: cost.cost_so_far,
        cost_budget: cost.cost_budget,
        goal_drift_score: null,
      },
      costBasis: cost.cost_basis,
    };
  }

  async function evaluate(run, runKey, atCall) {
    const { snapshot, costBasis } = snapshotFor(run, runKey, atCall);
    const started = now();
    const entry = { runKey, step: atCall.step, toolName: atCall.toolName, sessionKey: atCall.sessionKey,
                    costBasis, snapshot };
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
  function recordToolCall(runKey, { toolName, params, error, sessionKey }) {
    const run = getRun(runKey);
    const errorText = typeof error === "string" ? error : error ? String(error) : "";
    run.toolTail.push({
      tool_name: toolName,
      params: { h: hashParams(params) },
      success: !errorText,
      timed_out: Boolean(errorText) && TIMEOUT_PATTERN.test(errorText),
    });
    if (run.toolTail.length > TOOL_TAIL) run.toolTail.shift();
    run.toolCount += 1;
    const atCall = { step: run.toolCount, toolTail: [...run.toolTail], tokensAtStep: run.tokensUsed,
                     toolName, sessionKey };
    run.queue = run.queue.then(() => evaluate(run, runKey, atCall));
    return run.queue;
  }

  function endRun(runKey) {
    runs.delete(runKey);
  }

  return { recordToolCall, recordTokens, endRun, trackedRuns: () => runs.size };
}
