// The governor: deterministic stops for runs that spend without progress - a
// port of xybernetex-python's core/governor.py (same limits, same stop
// messages). Each OpenClaw run is governed on its own:
//
//   maxToolCalls   tool calls in the run
//   maxSeconds     wall-clock time since the run started
//   repeatLimit    the same call (tool + arguments) this many times in a row
//
// (OpenClaw reports a run's tokens only after it ends, so there's no token
// budget here; contract fix rounds without progress are stopped in
// src/contract_runner.js.) When a limit is reached, the call that crossed it
// and every call after it are blocked with a message telling the model to stop
// and summarize, and the run gets no follow-up. Stops are logged with their
// kind and counters, never call arguments.
import { createHash } from "node:crypto";

export const STANDARD = Object.freeze({ maxToolCalls: 150, maxSeconds: 3600, repeatLimit: 4 });
const KEYS = Object.keys(STANDARD);

// "standard" -> STANDARD; an object -> STANDARD with its overrides; null/false -> no governor.
export function limitsFrom(spec) {
  if (spec === undefined || spec === null || spec === false) return null;
  if (spec === true || spec === "standard") return STANDARD;
  if (typeof spec === "object" && !Array.isArray(spec)) {
    const unknown = Object.keys(spec).filter((k) => !KEYS.includes(k));
    if (unknown.length) throw new Error(`unknown governor limits: ${unknown.join(", ")}`);
    for (const k of KEYS) {
      if (spec[k] !== undefined && spec[k] !== null && !(Number.isFinite(spec[k]) && spec[k] > 0)) {
        throw new Error(`governor.${k} must be a positive number`);
      }
    }
    return Object.freeze({ ...STANDARD, ...spec });
  }
  throw new Error('governor must be "standard" or an object of limits');
}

const STOP = {
  "tool-calls": "the run has used its budget of {n} tool calls",
  time: "the run has used its time budget of {n} seconds",
  repeat: "the same call has now been made {n} times in a row with no change",
};

export const stopMessage = (kind, n) =>
  `Stopped by Xybernetex: ${STOP[kind].replace("{n}", n)}. This call was not run, and no further calls ` +
  "will run. Stop working now and reply with a short summary of what is done and what isn't.";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const signature = (toolName, params) => createHash("sha256").update(`${toolName}\0${canonical(params ?? {})}`).digest("hex").slice(0, 16);

export function createGovernor(limits, { log = () => {}, now = Date.now, maxRuns = 500 } = {}) {
  const runs = new Map();    // runKey -> { started, calls, recent, stopped, message }
  const answers = new Map(); // toolCallId -> the answer it got (OpenClaw may ask twice)

  const runOf = (runKey) => {
    if (!runs.has(runKey)) runs.set(runKey, { started: now(), calls: 0, recent: [], stopped: null, message: null });
    while (runs.size > maxRuns) runs.delete(runs.keys().next().value);
    return runs.get(runKey);
  };

  function stop(runKey, run, kind, n) {
    run.stopped = kind;
    run.message = stopMessage(kind, n);
    try {
      log({ type: "governor_stop", runKey, reason: kind, calls: run.calls, seconds: Math.round((now() - run.started) / 100) / 10 });
    } catch { /* best-effort */ }
    return run.message;
  }

  function judge(runKey, toolName, params) {
    const run = runOf(runKey);
    if (run.stopped) return run.message;
    run.calls += 1;
    run.recent = [...run.recent, signature(toolName, params)].slice(-Math.max(limits.repeatLimit ?? 1, 1));
    if (limits.maxToolCalls && run.calls > limits.maxToolCalls) return stop(runKey, run, "tool-calls", limits.maxToolCalls);
    if (limits.maxSeconds && now() - run.started > limits.maxSeconds * 1000) return stop(runKey, run, "time", limits.maxSeconds);
    if (limits.repeatLimit && run.recent.length >= limits.repeatLimit && new Set(run.recent).size === 1) {
      return stop(runKey, run, "repeat", limits.repeatLimit);
    }
    return null;
  }

  return {
    limits,
    // before_agent_run: the run's clock starts.
    start(runKey) { runs.delete(runKey); runOf(runKey); },
    // before_tool_call: null to go on to the gate, or the stop message to block with.
    onCall(runKey, toolCallId, toolName, params) {
      if (toolCallId && answers.has(toolCallId)) return answers.get(toolCallId);
      const answer = judge(runKey, toolName, params);
      if (toolCallId) {
        answers.set(toolCallId, answer);
        while (answers.size > 5000) answers.delete(answers.keys().next().value);
      }
      return answer;
    },
    stopped: (runKey) => runs.get(runKey)?.stopped ?? null,
    end(runKey) { const kind = runs.get(runKey)?.stopped ?? null; runs.delete(runKey); return kind; },
  };
}
