// Outcome signals: what happened after a run, observed on this machine and
// reduced to labels. Our scenario suite grades every run with a checker; a
// customer's real work has no checker, so learning which interventions pay
// off on it needs signals the plugin can see for itself:
//
//   - did the run die, and did our retry finish it
//   - did our check-your-work turn change files ("fixed": the first answer was
//     incomplete) or only look ("confirmed")
//   - what the user said next: a correction ("that didn't work", "still
//     broken"), the same request again, thanks, or something new
//
// The user's message is classified here, in memory, against their previous
// request; neither text is ever logged or sent - only the label.
//
// One episode per intervention decision (including "none"). It closes on the
// first of: the user's next message in that session, quietMs without one, or
// the session ending. A closed episode is logged locally and, when sharing is
// on, sent to the policy service (POST /outcome) as labels and counts only.

// How an episode closed. The first four come from the user's next message;
// "none" is quietMs without one; the rest close it without a user signal.
export const USER_FOLLOWUPS = Object.freeze(["correction", "repeat", "thanks", "new", "none", "session_end",
  "superseded", "evicted"]);
const FROM_USER = USER_FOLLOWUPS.slice(0, 4);

// Model ids, rules and policy names travel as labels; a rule can carry an
// error message ("decide-failed: ..."), so keep only label characters.
const asLabel = (v) => (typeof v === "string" && v ? v.replace(/[^\w.:@/+-]+/g, "_").slice(0, 200) : null);

// Tools whose successful call changes files.
const WRITE_TOOLS = /^(write|edit|multi_?edit|apply_?patch|create_?file|str_replace\w*|notebook_?edit)$/i;

// "That didn't work", "still failing", "you forgot the tests", "no, ...".
// Phrases about the last answer only - a new request like "fix the error in
// parse.py" or "what's wrong with my config?" is not a correction.
const CORRECTION = new RegExp([
  String.raw`\b(did ?n[o']?t|does ?n[o']?t|do ?n[o']?t|is ?n[o']?t|was ?n[o']?t|are ?n[o']?t|not) (work|working|run|running|pass|passing|compile|build|fix|fixed|right|correct|done|what i (asked|wanted|meant))\b`,
  String.raw`\bstill (broken|failing|fails|wrong|missing|not|doesn|errors?|crash)`,
  String.raw`\b(that'?s|this is|it'?s|that is) (wrong|incorrect|not right|broken)`,
  String.raw`\b(you|u) (forgot|missed|skipped|ignored|broke|didn'?t)\b`,
  String.raw`\b(try again|redo it|do it again|start over|same (error|problem|issue) (again|still))\b`,
  String.raw`^\s*(nope|nah)\b`,
  String.raw`^\s*no\s*[,.!]`,
].join("|"), "i");

const THANKS = /\b(thanks|thank you|thx|great|perfect|awesome|excellent|works now|that worked|it works|lgtm|looks good|good job|well done)\b/i;

const words = (text) => new Set(String(text).toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);

function similarity(a, b) {
  const x = words(a);
  const y = words(b);
  if (x.size < 3 || y.size < 3) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / (x.size + y.size - shared);
}

// The user's next message, relative to their previous request.
export function classifyFollowup(previous, next) {
  const text = String(next ?? "");
  if (CORRECTION.test(text)) return "correction";
  if (previous && similarity(previous, text) >= 0.6) return "repeat";
  if (THANKS.test(text) && text.trim().split(/\s+/).length <= 8) return "thanks";
  return "new";
}

export function verifyResult(followup) {
  if (!followup) return null;
  if (!followup.success) return "failed";
  return followup.writes > 0 ? "fixed" : "confirmed";
}

export function createOutcomeTracker({ log = () => {}, send = null, quietMs = 30 * 60_000, maxTracked = 500,
  now = () => Date.now(), setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimer = (t) => clearTimeout(t) } = {}) {
  const runs = new Map(); // runKey -> { toolCalls, writes, failedCalls, tokens }
  const episodes = new Map(); // sessionKey -> open episode
  const followups = new Map(); // runKey of our follow-up -> sessionKey
  // A follow-up that starts (or even ends) before its episode opens: the
  // decision is logged only once the turn is started, and the two race.
  const early = new Map(); // sessionKey -> { runKey, ended, success }
  const lastRequest = new Map(); // sessionKey -> the user's previous request (memory only)

  const bound = (map) => { while (map.size > maxTracked) map.delete(map.keys().next().value); };
  const counters = (runKey) => {
    if (!runs.has(runKey)) {
      runs.set(runKey, { toolCalls: 0, writes: 0, failedCalls: 0, tokens: null });
      bound(runs);
    }
    return runs.get(runKey);
  };

  function close(sessionKey, user) {
    const ep = episodes.get(sessionKey);
    if (!ep) return null;
    episodes.delete(sessionKey);
    clearTimer(ep.timer);
    const run = runs.get(ep.runKey) ?? {};
    const fu = ep.followupRunKey ? runs.get(ep.followupRunKey) : null;
    const followup = ep.followupEnded ? { success: ep.followupSuccess, toolCalls: fu?.toolCalls ?? 0,
      writes: fu?.writes ?? 0, failedCalls: fu?.failedCalls ?? 0, tokens: fu?.tokens ?? null } : null;
    const episode = {
      model: ep.model, mode: ep.mode, action: ep.action, applied: ep.applied, probability: ep.probability,
      rule: ep.rule, policy: ep.policy,
      run: { success: ep.success, retriable: ep.retriable, toolCalls: ep.toolCalls, tokens: run.tokens ?? null },
      followup,
      verify: ep.applied === "verify" ? verifyResult(followup) : null,
      user,
      gapSec: FROM_USER.includes(user) ? Math.round((now() - ep.lastEnd) / 1000) : null,
    };
    runs.delete(ep.runKey);
    if (ep.followupRunKey) {
      runs.delete(ep.followupRunKey);
      followups.delete(ep.followupRunKey);
    }
    try { log({ type: "episode", sessionKey, agentId: ep.agentId, runKey: ep.runKey, ...episode }); } catch { /* best-effort */ }
    if (send) Promise.resolve().then(() => send(episode)).catch(() => {});
    return episode;
  }

  return {
    // after_tool_call, every run.
    noteToolCall(runKey, toolName, failed) {
      const c = counters(runKey);
      c.toolCalls += 1;
      if (failed) c.failedCalls += 1;
      else if (WRITE_TOOLS.test(String(toolName ?? ""))) c.writes += 1;
    },

    // llm_output, which may land before or after the run ends.
    noteUsage(runKey, total) {
      if (typeof total === "number" && Number.isFinite(total)) counters(runKey).tokens = (counters(runKey).tokens ?? 0) + total;
    },

    // before_agent_run for a user's turn (not ours): closes the open episode
    // with how the user followed up, then remembers this request for the next.
    noteUserTurn(sessionKey, prompt) {
      if (!sessionKey || typeof prompt !== "string") return null;
      const closed = episodes.has(sessionKey) ? close(sessionKey, classifyFollowup(lastRequest.get(sessionKey), prompt)) : null;
      lastRequest.set(sessionKey, prompt);
      bound(lastRequest);
      return closed;
    },

    // before_agent_run for one of our follow-up turns.
    noteFollowupStart(sessionKey, runKey) {
      if (!sessionKey) return;
      followups.set(runKey, sessionKey);
      bound(followups);
      const ep = episodes.get(sessionKey);
      if (!ep) {
        early.set(sessionKey, { runKey, ended: false, success: null });
        bound(early);
      } else if (!ep.followupRunKey) {
        ep.followupRunKey = runKey;
      }
    },

    // agent_end for any run: attaches our follow-up's result to its episode.
    noteRunEnd(runKey, success) {
      const sessionKey = followups.get(runKey);
      if (!sessionKey) return;
      const pending = early.get(sessionKey);
      if (pending?.runKey === runKey) {
        Object.assign(pending, { ended: true, success: success === true });
        return;
      }
      const ep = episodes.get(sessionKey);
      if (!ep || ep.followupRunKey !== runKey) return;
      ep.followupEnded = true;
      ep.followupSuccess = success === true;
      ep.lastEnd = now();
      clearTimer(ep.timer);
      ep.timer = setTimer(() => close(sessionKey, "none"), quietMs);
    },

    // After an intervention decision (src/interventions.js entry) on a user's
    // run. What was applied: the decided action only if its turn was started.
    open(entry, summary) {
      const sessionKey = entry?.sessionKey;
      if (!sessionKey || entry.wasOurs) return;
      if (episodes.has(sessionKey)) close(sessionKey, "superseded");
      const applied = entry.scheduled ? entry.action : "none";
      const ep = {
        runKey: entry.runKey, agentId: entry.agentId ?? null, model: asLabel(entry.model), mode: entry.mode,
        action: entry.action, applied, rule: asLabel(entry.rule), policy: asLabel(entry.policy),
        // The chance of what was actually applied. In act mode that's the
        // decision's own probability - including a "none" the rule held out,
        // which is what makes untreated runs comparable (0.4.1 recorded 1 for
        // those). A decision nobody carried out (observe mode, a follow-up
        // that couldn't start) left the run untreated for certain.
        probability: entry.mode === "act" && applied === entry.action ? entry.probability : 1,
        success: summary.success === true, retriable: summary.retriable === true, toolCalls: summary.toolCalls ?? 0,
        lastEnd: now(), followupRunKey: null, followupEnded: false, followupSuccess: null, timer: null,
      };
      const pending = early.get(sessionKey);
      early.delete(sessionKey);
      if (pending && entry.scheduled) {
        ep.followupRunKey = pending.runKey;
        if (pending.ended) Object.assign(ep, { followupEnded: true, followupSuccess: pending.success });
      }
      ep.timer = setTimer(() => close(sessionKey, "none"), quietMs);
      episodes.set(sessionKey, ep);
      while (episodes.size > maxTracked) close(episodes.keys().next().value, "evicted");
    },

    endSession(sessionKey) {
      close(sessionKey, "session_end");
      lastRequest.delete(sessionKey);
      early.delete(sessionKey);
    },

    openEpisodes: () => episodes.size,
  };
}

// send() for createOutcomeTracker: POST /outcome next to /evaluate. Labels
// and counts only; failures are dropped (outcomes are best-effort telemetry).
export function createOutcomeSender({ endpoint, apiKey, fetchImpl = fetch, timeoutMs = 3000 }) {
  const url = endpoint.replace(/\/evaluate\/?$/, "") + "/outcome";
  return async (episode) => {
    const res = await fetchImpl(url, { method: "POST", signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ episode }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  };
}
