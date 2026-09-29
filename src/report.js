// Turns the plugin's local log into the numbers a customer cares about:
// what the gate stopped, how runs ended, where tokens went, and whether the
// policy service was healthy. Pure: entries in, summary out, so it's tested
// directly; scripts/report.mjs does the file reading and rendering.
//
// Everything here comes from the log as written - hashes and labels, never
// command text - so a report is safe to share with the Xybernetex team.

const RISKS = ["destructive", "sensitive", "none"];
const LOOP_LENGTH = 3; // identical calls in a row that count as a loop

const agentOf = (sessionKey) => (typeof sessionKey === "string" && sessionKey.startsWith("agent:")
  ? sessionKey.split(":")[1] || null : null);

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

// One record per completed tool call, from whichever line carried it: the
// policy entry (decision or failed decision) or a local tool_completed line.
function callRecord(e) {
  if (e.type === "tool_completed" && e.record) {
    return { runKey: e.runKey, sessionKey: e.sessionKey, step: e.step, ...e.record };
  }
  const last = e.snapshot?.tool_history?.at?.(-1);
  if (!e.type && last && "latencyMs" in e) return { runKey: e.runKey, sessionKey: e.sessionKey, step: e.step, ...last };
  return null;
}

export function summarize(entries, { from = null, to = null } = {}) {
  const inWindow = (e) => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && (from === null || t >= from) && (to === null || t < to);
  };
  const rows = entries.filter((e) => e && typeof e === "object" && inWindow(e));

  const calls = new Map(); // runKey|step -> record (a call can appear on two lines)
  const runs = new Map(); // runKey -> { agent, tokens, model, end }
  const run = (key) => {
    if (!runs.has(key)) runs.set(key, { agent: null, tokens: null, model: null, end: null });
    return runs.get(key);
  };
  const gate = { held: 0, blocked: 0, wouldHold: 0, wouldBlock: 0, allowed: 0, denied: 0, waived: 0,
    unrequestedStopped: 0, byTool: {} };
  const policy = { decisions: 0, errors: 0, latencies: [], actions: {} };
  // The gate's settings are logged once, when the gateway loads the plugin -
  // often long before the window opens - so take the last load before it ends.
  let mode = null;
  let preset = null;
  let loadedAt = -Infinity;
  for (const e of entries) {
    const t = Date.parse(e?.ts);
    if (e?.type === "tool_gate_ready" && Number.isFinite(t) && (to === null || t < to) && t >= loadedAt) {
      loadedAt = t;
      mode = e.mode ?? null;
      preset = e.preset ?? "none";
    }
  }

  for (const e of rows) {
    const rec = callRecord(e);
    if (rec && rec.runKey) {
      calls.set(`${rec.runKey}|${rec.step}`, rec);
      run(rec.runKey).agent ??= agentOf(rec.sessionKey);
    }
    if (!e.type && "latencyMs" in e) {
      if (e.error) policy.errors += 1;
      else {
        policy.decisions += 1;
        policy.latencies.push(e.latencyMs);
        const a = e.decision?.action ?? "unknown";
        policy.actions[a] = (policy.actions[a] ?? 0) + 1;
      }
    }
    if (e.runUsage && e.runKey) {
      const r = run(e.runKey);
      r.tokens = (r.tokens ?? 0) + (Number(e.runUsage.total) || 0);
      r.model = e.model ?? r.model;
    }
    if (e.type === "run_end" && e.runKey) {
      const r = run(e.runKey);
      r.end = { success: e.success === true, error: e.error ?? null, durationMs: e.durationMs ?? null };
      r.agent ??= e.agentId ?? agentOf(e.sessionKey);
    }
    if (e.type === "tool_gate") {
      const key = { REQUEST_USER: "held", BLOCK_ACTION: "blocked", WOULD_REQUEST_USER: "wouldHold", WOULD_BLOCK: "wouldBlock" }[e.action];
      if (key) gate[key] += 1;
      if (e.authorization === "unrequested" && e.riskTier === "destructive") gate.unrequestedStopped += 1;
      gate.byTool[e.toolName] = (gate.byTool[e.toolName] ?? 0) + 1;
    }
    if (e.type === "tool_gate_resolution") gate[e.allowed ? "allowed" : "denied"] += 1;
    if (e.type === "tool_gate_waived") gate.waived += 1;
  }

  // Calls: risk and authorization mix, failures, loops.
  const risk = Object.fromEntries([...RISKS, "unjudged"].map((k) => [k, 0]));
  const riskyAuth = { requested: 0, own_artifact: 0, unrequested: 0, unlabeled: 0 };
  let failed = 0;
  let timedOut = 0;
  const perRun = new Map();
  for (const c of calls.values()) {
    risk[RISKS.includes(c.risk) ? c.risk : "unjudged"] += 1;
    if (c.risk === "destructive" || c.risk === "sensitive") {
      riskyAuth[c.authorization in riskyAuth ? c.authorization : "unlabeled"] += 1;
    }
    if (c.success === false) failed += 1;
    if (c.timed_out) timedOut += 1;
    if (!perRun.has(c.runKey)) perRun.set(c.runKey, []);
    perRun.get(c.runKey).push(c);
  }
  let loopingRuns = 0;
  for (const list of perRun.values()) {
    list.sort((a, b) => a.step - b.step);
    let streak = 1;
    for (let i = 1; i < list.length; i += 1) {
      const same = list[i].tool_name === list[i - 1].tool_name && list[i].params?.h === list[i - 1].params?.h;
      streak = same ? streak + 1 : 1;
      if (streak >= LOOP_LENGTH) { loopingRuns += 1; break; }
    }
  }

  // Runs: outcomes, duration, tokens.
  const all = [...runs.values()];
  const ended = all.filter((r) => r.end);
  const died = ended.filter((r) => !r.end.success);
  const durations = ended.map((r) => r.end.durationMs).filter((d) => typeof d === "number").sort((a, b) => a - b);
  const withTokens = all.filter((r) => r.tokens !== null);
  const tokensTotal = withTokens.reduce((s, r) => s + r.tokens, 0);
  const tokensOnDied = died.filter((r) => r.tokens !== null).reduce((s, r) => s + r.tokens, 0);
  const byModel = {};
  for (const r of withTokens) {
    const m = r.model ?? "unknown";
    byModel[m] ??= { runs: 0, tokens: 0 };
    byModel[m].runs += 1;
    byModel[m].tokens += r.tokens;
  }
  const errorKinds = {};
  for (const r of died) {
    const kind = (r.end.error ?? "no error reported").split(/[:\n]/)[0].trim().slice(0, 60) || "no error reported";
    errorKinds[kind] = (errorKinds[kind] ?? 0) + 1;
  }
  const byAgent = {};
  for (const r of all) {
    const a = r.agent ?? "unknown";
    byAgent[a] ??= { runs: 0, died: 0 };
    byAgent[a].runs += 1;
    if (r.end && !r.end.success) byAgent[a].died += 1;
  }

  // Interventions (src/interventions.js): what was decided, what actually
  // ran, and how our follow-up turns ended. A follow-up's outcome is the next
  // "outcome" line in the same session after the decision that started it.
  const iv = { decided: { retry: 0, verify: 0, none: 0 }, started: { retry: 0, verify: 0 },
    outcomes: { retry: { n: 0, ok: 0 }, verify: { n: 0, ok: 0 } }, fallbacks: 0, modes: {} };
  const pending = new Map(); // sessionKey -> action awaiting its outcome
  for (const e of rows.filter((x) => x.type === "intervention").sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
    if (e.action === "outcome") {
      const action = pending.get(e.sessionKey);
      if (action) {
        iv.outcomes[action].n += 1;
        if (e.success) iv.outcomes[action].ok += 1;
        pending.delete(e.sessionKey);
      }
      continue;
    }
    if (e.action in iv.decided) iv.decided[e.action] += 1;
    if (e.mode) iv.modes[e.mode] = (iv.modes[e.mode] ?? 0) + 1;
    if (e.fallbackReason) iv.fallbacks += 1;
    if (e.scheduled && e.action in iv.started) {
      iv.started[e.action] += 1;
      pending.set(e.sessionKey, e.action);
    }
  }

  // Outcomes (src/outcomes.js): what happened after each decision, by what
  // was actually applied. The user's next message is the closest thing to a
  // grade a real run gets: a correction or a repeat means the answer missed.
  const outcomes = { episodes: 0, byApplied: {}, verify: { fixed: 0, confirmed: 0, failed: 0 },
    retry: { n: 0, finished: 0 } };
  for (const e of rows.filter((x) => x.type === "episode")) {
    outcomes.episodes += 1;
    const a = e.applied ?? "none";
    const g = (outcomes.byApplied[a] ??= { n: 0, replied: 0, correction: 0, repeat: 0, thanks: 0, new: 0 });
    g.n += 1;
    if (["correction", "repeat", "thanks", "new"].includes(e.user)) {
      g.replied += 1;
      g[e.user] += 1;
    }
    if (a === "verify" && e.verify in outcomes.verify) outcomes.verify[e.verify] += 1;
    if (a === "retry" && e.followup) {
      outcomes.retry.n += 1;
      if (e.followup.success) outcomes.retry.finished += 1;
    }
  }

  const times = rows.map((e) => Date.parse(e.ts)).filter(Number.isFinite);
  const lat = [...policy.latencies].sort((a, b) => a - b);
  return {
    window: { from: from ?? (times.length ? Math.min(...times) : null), to: to ?? (times.length ? Math.max(...times) : null) },
    gateConfig: { mode, preset },
    runs: { seen: all.length, ended: ended.length, died: died.length, loopingRuns,
      medianDurationMs: percentile(durations, 0.5), errorKinds, byAgent },
    calls: { total: calls.size, failed, timedOut, risk, riskyAuth },
    gate,
    tokens: { total: tokensTotal, runsWithUsage: withTokens.length,
      perRun: withTokens.length ? Math.round(tokensTotal / withTokens.length) : null, onDiedRuns: tokensOnDied, byModel },
    policy: { decisions: policy.decisions, errors: policy.errors, actions: policy.actions,
      p50Ms: percentile(lat, 0.5), p95Ms: percentile(lat, 0.95) },
    interventions: iv,
    outcomes,
  };
}

// Plain-language next steps, most important first.
export function recommendations(s) {
  const out = [];
  const unrequestedRan = s.calls.riskyAuth.unrequested;
  if (s.gateConfig.mode !== "enforce" && (s.gate.wouldHold + s.gate.wouldBlock) > 0) {
    out.push(`The gate is in observe mode, so ${s.gate.wouldHold + s.gate.wouldBlock} risky call(s) it would have stopped ran anyway. ` +
      "Switch control.mode to \"enforce\" once these look right.");
  }
  if (s.gateConfig.mode !== null && s.gateConfig.preset === "none") {
    out.push("No control preset is set. control.preset \"recommended\" holds destructive actions nobody asked for, across every agent.");
  }
  if (unrequestedRan > 0) {
    out.push(`${unrequestedRan} risky call(s) ran that the user's own messages never asked for. Review them by paramsHash in the log.`);
  }
  if (s.runs.died > 0 && s.runs.ended > 0) {
    out.push(`${s.runs.died} of ${s.runs.ended} runs ended without finishing (${Math.round(100 * s.runs.died / s.runs.ended)}%). ` +
      "In Xybernetex testing, a same-model retry finished about a third of the runs that had died.");
  }
  if (s.gate.denied > 0) {
    out.push(`${s.gate.denied} approval(s) were denied or expired. Unattended runs (cron, one-shot CLI) can't show an ` +
      "approval prompt, so OpenClaw denies them automatically; check that's what you want for those agents.");
  }
  if (s.runs.loopingRuns > 0) {
    out.push(`${s.runs.loopingRuns} run(s) repeated the same call ${LOOP_LENGTH}+ times in a row: likely loops burning tokens.`);
  }
  if (s.policy.decisions + s.policy.errors > 0 && s.policy.errors / (s.policy.decisions + s.policy.errors) > 0.02) {
    out.push(`${s.policy.errors} policy request(s) failed. Agents kept working (the plugin fails open), but check the endpoint and key.`);
  }
  const iv = s.interventions;
  const wouldHelp = iv ? iv.decided.retry + iv.decided.verify - iv.started.retry - iv.started.verify : 0;
  if (iv && (iv.modes.observe ?? 0) > 0 && wouldHelp > 0) {
    out.push(`${wouldHelp} run(s) would have gotten a follow-up (a retry or a check-your-work turn) but interventions are in ` +
      "observe mode. In Xybernetex testing a check-your-work turn lifted task completion by about 10 points; " +
      "set interventions.mode to \"act\" to turn them on.");
  }
  const ov = s.outcomes?.verify;
  const checked = ov ? ov.fixed + ov.confirmed : 0;
  if (checked >= 5 && ov.fixed / checked >= 0.2) {
    out.push(`Check-your-work turns changed files in ${ov.fixed} of ${checked} runs (${Math.round(100 * ov.fixed / checked)}%): ` +
      "the first answer was incomplete more often than it looked.");
  }
  const none = s.outcomes?.byApplied?.none;
  if (none && none.replied >= 10 && (none.correction + none.repeat) / none.replied >= 0.25) {
    out.push(`After ${none.correction + none.repeat} of ${none.replied} runs without a follow-up, the user's next message ` +
      "corrected the answer or asked again. Those are the runs a check-your-work turn is for.");
  }
  if (iv?.fallbacks > 0) {
    out.push(`${iv.fallbacks} intervention decision(s) fell back to the local rule because the policy service didn't answer.`);
  }
  if (!out.length) out.push("Nothing needs attention this period.");
  return out;
}
