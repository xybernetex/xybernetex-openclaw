// Interventions: after a run ends, the control plane may give it one more
// turn in the same session - a "continue" when the run died, or a "check
// your work" when it finished.
//
// The turn is started the way a person at the terminal would: a detached
// `openclaw agent --session-key <same session> --message ...` on the gateway
// host (the route behind the measured +11 points). OpenClaw's plugin-facing
// alternatives don't work for us as of 2026.9.6: scheduleSessionTurn is a
// silent no-op for any plugin not bundled with OpenClaw, and runs started
// through POST /hooks/agent crash in OpenClaw (DataCloneError) while their
// failure notices wake the agent's main session.
//
// Our turns carry a marker line. A run that starts with it is ours: it never
// triggers another intervention, and src/authz.js never treats it as the
// user's request. Every attempt - successful or not - counts against a
// per-session cap and a gateway-wide rate limit, so no failure mode can loop.
//
// decide(summary) picks the intervention; the default is the fixed v0 rule.
// Every decision is logged with its probability (for off-policy evaluation);
// turns are only started in "act" mode.
import { spawn as nodeSpawn } from "node:child_process";

export const MARKER = "[xybernetex]";

export const MESSAGES = Object.freeze({
  retry: `${MARKER} Your previous turn ended before the task was finished (the model's response couldn't be used). ` +
    "Continue the original task from where it stopped. Check what's already done first, then finish the rest.",
  verify: `${MARKER} Before I accept this, check your work against the original request:\n` +
    "1. Re-read the request and confirm every part of it is done.\n" +
    "2. For each file you created or changed, confirm it exists at the requested path with the expected content.\n" +
    "3. If you reported a command's output or test results, re-run it and make sure your answer matches what it actually prints.\n" +
    "4. Check the edge cases and exact formats the request mentions.\n" +
    "If anything is missing or wrong, fix it now. Then give your final answer again in full.",
});

export const isOurs = (prompt) => typeof prompt === "string" && prompt.trimStart().startsWith(MARKER);

// Failures worth a retry: the model gave nothing usable. Not user aborts,
// not approval denials, not policy blocks.
const RETRIABLE = /incomplete_turn|format|timed?\s*out|timeout|overloaded|rate.?limit|stream|empty (response|output)|unusable|no final answer/i;
const NOT_RETRIABLE = /abort|cancel|denied|approval|blocked|policy/i;

export function retriable(error) {
  const e = String(error ?? "");
  return RETRIABLE.test(e) && !NOT_RETRIABLE.test(e);
}

// When a run's last model turn ends on an unsuccessful stop reason (a length
// cutoff, every time seen), OpenClaw's finalization gives up and appends its
// own reply in the model's place: "The tool run finished, but no final
// summary was produced...", marked by an idempotencyKey ending in
// ":settled-finalization-fallback". The text is matched too, in case the key
// changes. Graded: 0 of 3 such runs in the 2026-09-28 hard2 batch delivered
// the task, and they were half of the Terminal-Bench failures on 2026-09-29.
const FALLBACK_KEY = /:settled-finalization-fallback$/;
const FALLBACK_TEXT = /^The tool run finished, but no final (summary|answer) was produced/i;

function replyText(m) {
  if (typeof m?.content === "string") return m.content;
  return Array.isArray(m?.content)
    ? m.content.map((c) => (c?.type === "text" ? String(c.text ?? "") : "")).join("") : "";
}

export function isFallbackReply(m) {
  if (m?.role !== "assistant") return false;
  return (typeof m.idempotencyKey === "string" && FALLBACK_KEY.test(m.idempotencyKey)) || FALLBACK_TEXT.test(replyText(m).trim());
}

// The commonest deaths don't look like deaths: agent_end says success: true.
// Either the model returned nothing usable (OpenClaw's incomplete_turn: an
// empty final assistant message, stopReason "length" in every case seen on
// 2026-09-28), or OpenClaw substituted its fallback reply for a cut-off
// answer (above). So: if the run's last reply is the fallback, or nothing the
// model said since the last user message has any text or tool call, the run
// died. Returns the error to use in its place, or null (including when
// there's no transcript, i.e. no conversation-access grant).
export function emptyRunError(messages) {
  if (!Array.isArray(messages) || !messages.length) return null;
  let start = messages.length;
  while (start > 0 && messages[start - 1]?.role !== "user") start -= 1;
  if (start === 0 && messages[0]?.role !== "user") return null; // no user turn in view: can't tell
  const replies = messages.slice(start).filter((m) => m?.role === "assistant");
  if (!replies.length) return null;
  if (isFallbackReply(replies.at(-1))) {
    const real = replies.filter((m) => !isFallbackReply(m)).at(-1);
    return `no final answer: OpenClaw substituted its fallback reply (stopReason ${real?.stopReason ?? "unknown"})`;
  }
  const said = (m) => (typeof m.content === "string" ? m.content.trim() !== ""
    : Array.isArray(m.content) && m.content.some((c) => c?.type === "toolCall" || (c?.type === "text" && String(c.text ?? "").trim())));
  if (replies.some(said)) return null;
  return `empty response from the model (stopReason ${replies.at(-1)?.stopReason ?? "unknown"})`;
}

// The other half: a run OpenClaw ends as aborted comes with success: false
// and no error at all, but its final assistant message says why - e.g.
// errorMessage "request timed out" (a model call that timed out: worth a
// retry) versus a user's stop ("aborted": never retried, see NOT_RETRIABLE).
export function lastReplyError(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role === "user") return null;
    if (m?.role === "assistant") return typeof m.errorMessage === "string" && m.errorMessage ? m.errorMessage.slice(0, 200) : null;
  }
  return null;
}

// v0: retry runs that died; verify finished runs that did real work. The
// verify probability is configurable (explore < 1 keeps some finished runs
// unverified so outcomes can be compared).
export function decideV0(summary, { verifyRate = 1, random = Math.random } = {}) {
  if (!summary.success) {
    return retriable(summary.error) ? { action: "retry", probability: 1, rule: "v0-retry-on-death" }
      : { action: "none", probability: 1, rule: "v0-not-retriable" };
  }
  if (summary.toolCalls < 1) return { action: "none", probability: 1, rule: "v0-no-work" };
  const verify = random() < verifyRate;
  return { action: verify ? "verify" : "none", probability: verify ? verifyRate : 1 - verifyRate, rule: "v0-verify" };
}

// decide() backed by the policy service (POST /intervene next to /evaluate).
// Sends only the run's shape - success, whether a failure looks retriable,
// tool-call count, model id - never prompts, files or error text. Falls back
// to the local v0 rule (logged as such) if the service can't answer.
export function createRemoteDecider({ endpoint, apiKey, fetchImpl = fetch, timeoutMs = 3000, fallback = (s) => decideV0(s) }) {
  const url = endpoint.replace(/\/evaluate\/?$/, "") + "/intervene";
  return async (summary) => {
    try {
      const res = await fetchImpl(url, { method: "POST", signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ summary: { success: summary.success, retriable: retriable(summary.error),
          toolCalls: summary.toolCalls, model: summary.model ?? null } }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !["none", "retry", "verify"].includes(out.action)) throw new Error(`HTTP ${res.status} ${out.error ?? ""}`.trim());
      return { action: out.action, probability: out.probability, rule: out.rule, policy: out.policy ?? null };
    } catch (err) {
      const local = fallback(summary);
      return { ...local, rule: `fallback:${local.rule}`, policy: "local-v0", fallbackReason: String(err?.message ?? err).slice(0, 120) };
    }
  };
}

// schedule() for createInterventions: a detached `openclaw agent` turn in the
// same session, on the same model. `entry` is OpenClaw's own entry script
// (the gateway runs from it, so process.argv[1] by default).
export function createCliScheduler({ entry = process.argv[1], node = process.execPath, spawn = nodeSpawn,
  delayMs = 1500, timeoutSec = 900 } = {}) {
  return async ({ sessionKey, agentId, message, model }) => {
    if (!entry) throw new Error("can't find the openclaw entry script");
    // Let the run that just ended finish settling before the next turn lands.
    await new Promise((r) => setTimeout(r, delayMs));
    const args = [entry, "agent", "--session-key", sessionKey, "--message", message, "--timeout", String(timeoutSec), "--json"];
    if (agentId) args.splice(2, 0, "--agent", agentId);
    if (model) args.push("--model", model);
    const child = spawn(node, args, { detached: true, stdio: "ignore", windowsHide: true });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    return { pid: child.pid };
  };
}

export function createInterventions({ schedule, log = () => {}, config = {}, decide = null, random = Math.random,
  maxPerSession = 3, maxPerMinute = 10, now = () => Date.now(), maxTracked = 500 }) {
  const mode = config.mode ?? "observe";
  if (!["observe", "act"].includes(mode)) throw new Error("interventions.mode must be observe or act");
  const agentIds = config.agentIds ?? null;
  if (agentIds !== null && (!Array.isArray(agentIds) || agentIds.some((a) => typeof a !== "string"))) {
    throw new Error("interventions.agentIds must be a list of agent ids");
  }
  const verifyRate = config.verifyRate ?? 1;
  if (typeof verifyRate !== "number" || verifyRate < 0 || verifyRate > 1) throw new Error("interventions.verifyRate must be 0-1");
  const chooser = decide ?? ((s) => decideV0(s, { verifyRate, random }));
  // A stronger model for the follow-up turn: on our benchmark a same-model retry finished 35% of dead
  // runs, a stronger model's 62%. Unset: the run's own model.
  const escalate = config.escalate ?? {};
  for (const [k, v] of Object.entries(escalate)) {
    if (!["retry", "verify"].includes(k) || typeof v !== "string" || !v.trim()) {
      throw new Error("interventions.escalate is { retry?: model ref, verify?: model ref }");
    }
  }
  const ours = new Set(); // runKeys of runs we started
  const perSession = new Map(); // sessionKey -> attempts so far
  const recent = []; // attempt timestamps, gateway-wide

  const bounded = (set) => { while (set.size > maxTracked) set.delete(set.values().next().value); };

  return {
    // before_agent_run: remember whether this run is one of ours.
    noteRunStart(runKey, prompt) {
      if (isOurs(prompt)) {
        ours.add(runKey);
        bounded(ours);
        return true;
      }
      return false;
    },

    // agent_end: decide, log, and (in act mode) start the next turn.
    async onRunEnd(runKey, ctx, summary) {
      const sessionKey = ctx?.sessionKey;
      if (!sessionKey || (agentIds && !agentIds.includes(ctx?.agentId))) return null;
      const wasOurs = ours.delete(runKey);
      const base = { type: "intervention", runKey, sessionKey, agentId: ctx?.agentId, mode, wasOurs,
        success: summary.success, toolCalls: summary.toolCalls, model: summary.model ?? null };
      if (wasOurs) {
        // The outcome of an intervention, for the report and for training.
        try { log({ ...base, action: "outcome" }); } catch { /* best-effort */ }
        return null;
      }
      const t = now();
      while (recent.length && recent[0] <= t - 60_000) recent.shift();
      const attempts = perSession.get(sessionKey) ?? 0;
      let decision;
      try {
        decision = attempts >= maxPerSession ? { action: "none", probability: 1, rule: "session-cap" }
          : recent.length >= maxPerMinute ? { action: "none", probability: 1, rule: "rate-limit" }
            : await chooser(summary);
      } catch (err) {
        decision = { action: "none", probability: 1, rule: `decide-failed: ${String(err?.message ?? err).slice(0, 80)}` };
      }
      const entry = { ...base, action: decision.action, probability: decision.probability, rule: decision.rule,
        policy: decision.policy ?? "local-v0", ...(decision.fallbackReason ? { fallbackReason: decision.fallbackReason } : {}),
        scheduled: false };
      if (mode === "act" && (decision.action === "retry" || decision.action === "verify")) {
        // Counted before trying, so a failing scheduler can never loop.
        perSession.set(sessionKey, attempts + 1);
        while (perSession.size > maxTracked) perSession.delete(perSession.keys().next().value);
        recent.push(t);
        try {
          const stronger = escalate[decision.action] ?? null;
          if (stronger) entry.escalatedTo = stronger;
          const handle = await schedule({ sessionKey, agentId: ctx?.agentId, message: MESSAGES[decision.action],
            model: stronger ?? summary.model ?? null });
          entry.scheduled = Boolean(handle);
        } catch (err) {
          entry.error = String(err?.message ?? err).slice(0, 200);
        }
      }
      try { log(entry); } catch { /* best-effort */ }
      return entry;
    },
  };
}
