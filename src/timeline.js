// The flight recorder: one OpenClaw session as a timeline - every request,
// reply and tool call (with the command itself), what the gate decided and
// why, where a run died or looped, what follow-ups ran, and which files undo
// can put back. Built from the session's transcript (scripts/history.mjs),
// the plugin's log where it has entries for the session, and the undo
// journal; calls the log doesn't cover get the gate's verdict by replay
// (src/audit.js, strict preset). Local only.
import { describeCall, replaySessions, splitRuns, textOf } from "./audit.js";
import { STYLE, esc, num } from "./report_html.js";

const clock = (t) => (t ? new Date(t).toISOString().slice(11, 19) : "");
const offset = (t, t0) => {
  if (!t || !t0) return "";
  const s = Math.max(0, Math.round((t - t0) / 1000));
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const LIVE = { REQUEST_USER: "held for approval", BLOCK_ACTION: "blocked", WOULD_REQUEST_USER: "would hold (observe)",
  WOULD_BLOCK: "would block (observe)" };

export function buildTimeline(session, { log = [], undoRuns = [] } = {}) {
  const mine = log.filter((e) => e.sessionKey === session.sessionKey);
  const live = new Map();
  for (const e of mine) {
    if (e.type === "tool_gate" && e.toolCallId) live.set(e.toolCallId, { verdict: LIVE[e.action] ?? e.action, risky: true,
      why: e.planted ? "a planted delete" : e.followsHold ? "touches a held target" : "nobody asked" });
    if (e.type === "tool_gate_waived" && e.toolCallId) live.set(e.toolCallId, { verdict: "ran",
      why: e.waiver === "own_files" ? "its own files" : e.authorization === "requested" ? "you asked" : "waived" });
  }
  const replay = replaySessions([session]);
  const sim = new Map(replay.risky.unrequested.map((u) => [u.toolCallId, u]));
  const simOk = new Map(replay.waivedCalls.map((w) => [w.toolCallId, w.why]));
  const runs = splitRuns(session.messages).map((r, i) => {
    const runId = `${session.sessionId}:${i}`;
    const msgs = session.messages.slice(r.start, r.end);
    const t0 = msgs[0]?.ts ?? null;
    const tEnd = session.messages[r.end]?.ts ?? Infinity;
    const steps = [];
    const calls = new Map();
    let tokens = 0;
    let model = null;
    let lastStop = null;
    for (const m of msgs.slice(1)) {
      if (m.role === "assistant") {
        if (m.usage) tokens += Number(m.usage.totalTokens) || 0;
        model = m.model ?? model;
        lastStop = m.stopReason ?? lastStop;
        const said = textOf(m.content).trim();
        if (said) steps.push({ kind: "reply", ts: m.ts, text: said });
        for (const c of Array.isArray(m.content) ? m.content : []) {
          if (c?.type !== "toolCall") continue;
          const g = live.get(c.id);
          const s = sim.get(c.id);
          const step = { kind: "call", ts: m.ts, id: c.id, text: describeCall(c.name, c.arguments),
            gate: g ? { ...g, source: "live" } : s ? { verdict: "would hold", risky: true, source: "replay",
              why: s.planted ? "a planted delete" : `${s.risk}, nobody asked` }
              : simOk.has(c.id) ? { verdict: "ran", source: "replay", why: simOk.get(c.id) } : null };
          calls.set(c.id, step);
          steps.push(step);
        }
      } else if (m.role === "toolResult") {
        const step = calls.get(m.toolCallId);
        if (step) Object.assign(step, { result: cut(textOf(m.content).trim(), 1200), error: m.isError === true });
      }
    }
    const inWindow = (e) => { const t = Date.parse(e.ts ?? ""); return t >= (t0 ?? 0) - 5000 && t < tEnd + 120_000; };
    const end = mine.filter((e) => e.type === "run_end" && inWindow(e)).at(0);
    const followups = mine.filter((e) => e.type === "intervention" && inWindow(e) && e.action !== "none")
      .map((e) => ({ action: e.action, scheduled: e.scheduled, model: e.escalatedTo ?? null }));
    const silent = replay.deaths.silent.find((d) => d.runId === runId);
    const loop = replay.loops.find((l) => l.runId === runId);
    const undo = undoRuns.filter((u) => u.sessionKey === session.sessionKey && Date.parse(u.startedAt) >= (t0 ?? 0) - 5000
      && Date.parse(u.startedAt) < tEnd).flatMap((u) => u.entries.map((e) => ({ rel: e.rel, existed: e.existed, run: u.id, undone: Boolean(u.undoneAt) })));
    const status = end?.governor ? `stopped by the governor (${end.governor})`
      : silent ? `died: ${silent.reason}` : end && end.success === false ? `failed: ${end.error ?? "no reason given"}`
        : lastStop === "error" || lastStop === "aborted" ? `ended with ${lastStop}`
          : lastStop === "length" ? "cut off at the model's output limit" : "finished";
    return { index: i + 1, t0, prompt: r.prompt, steps, tokens, model, status, loop: loop?.text ?? null, followups, undo,
      calls: steps.filter((s) => s.kind === "call").length, seconds: t0 && msgs.at(-1)?.ts ? Math.round((msgs.at(-1).ts - t0) / 1000) : null };
  });
  return { agentId: session.agentId, sessionKey: session.sessionKey, runs };
}

function gateBadge(g) {
  if (!g) return "";
  const tone = g.risky ? (g.verdict.startsWith("would") ? "warn" : "bad") : "good";
  return `<span class="badge ${tone}" title="${esc(g.source === "replay" ? "the gate's verdict, replayed" : "logged live")}">` +
    `${esc(g.verdict)} · ${esc(g.why)}</span>`;
}

export function renderTimeline(t, { generatedAt = new Date() } = {}) {
  const runHtml = t.runs.map((r) => `
<section class="run">
<div class="runhead"><span class="n">Run ${r.index}</span> ${esc(r.t0 ? new Date(r.t0).toISOString().replace("T", " ").slice(0, 19) : "")}
 · ${num(r.calls)} tool calls · ${r.seconds !== null ? `${num(r.seconds)} s` : "–"} · ${num(r.tokens)} tokens${r.model ? ` · ${esc(r.model)}` : ""}
 <span class="badge ${r.status === "finished" ? "good" : "bad"}">${esc(r.status)}</span>${r.loop ? ` <span class="badge warn">looped</span>` : ""}</div>
<div class="req">${esc(cut(r.prompt, 2000))}</div>
<ol class="steps">${r.steps.map((s) => s.kind === "reply"
    ? `<li class="reply"><span class="t">${offset(s.ts, r.t0)}</span><div>${esc(cut(s.text, 1500))}</div></li>`
    : `<li class="call${s.error ? " err" : ""}"><span class="t">${offset(s.ts, r.t0)}</span><div><code>${esc(s.text)}</code> ${gateBadge(s.gate)}` +
      (s.result ? `<details><summary>${s.error ? "error" : "result"}</summary><pre>${esc(s.result)}</pre></details>` : "") + "</div></li>").join("")}
</ol>
${r.loop ? `<p class="note warn">The governor would have stopped this run at the repeated call: <code>${esc(r.loop)}</code></p>` : ""}
${r.followups.length ? `<p class="note">Follow-up: ${r.followups.map((f) => `${esc(f.action)}${f.model ? ` on ${esc(f.model)}` : ""}${f.scheduled ? "" : " (decided, not run)"}`).join(", ")}</p>` : ""}
${r.undo.length ? `<p class="note">Files this run changed that undo can put back${r.undo.every((u) => u.undone) ? " (already undone)" : ""}: ${r.undo.slice(0, 12).map((u) => `<code>${esc(u.rel)}</code>`).join(" ")}${r.undo.length > 12 ? ` and ${r.undo.length - 12} more` : ""}<br><code>npx xybernetex-openclaw undo ${esc(r.undo[0].run)}</code></p>` : ""}
</section>`).join("\n");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Xybernetex timeline</title>
<style>${STYLE}
code{font:13px ui-monospace,Consolas,monospace;color:var(--text);word-break:break-all}
.run{margin:28px 0;padding-top:8px;border-top:1px solid var(--line)}
.runhead{color:var(--muted);font-size:14px}.runhead .n{color:var(--cyan);font:700 13px ui-monospace,Consolas,monospace;margin-right:6px}
.req{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--cyan);border-radius:6px;padding:12px 14px;margin:12px 0;white-space:pre-wrap}
.steps{list-style:none;padding:0;margin:0}.steps li{display:grid;grid-template-columns:56px 1fr;gap:10px;padding:7px 0;border-bottom:1px solid var(--line)}
.steps .t{color:var(--dim);font:12px ui-monospace,Consolas,monospace;padding-top:2px}.steps .reply div{color:var(--muted);white-space:pre-wrap}
.steps .err code{color:var(--red)}
details summary{color:var(--dim);font-size:12px;cursor:pointer;margin-top:4px}pre{white-space:pre-wrap;color:var(--muted);font:12px ui-monospace,Consolas,monospace;margin:6px 0}
.badge{display:inline-block;font:700 11px ui-monospace,Consolas,monospace;border-radius:4px;padding:1px 7px;margin-left:6px;border:1px solid currentColor}
.badge.good{color:var(--green)}.badge.warn{color:var(--amber)}.badge.bad{color:var(--red)}
.note{color:var(--muted);font-size:14px}.note.warn{color:var(--amber)}
</style></head><body><div class="wrap">
<div class="brand">XYBERNETEX<b>.</b></div>
<h1>${esc(t.sessionKey)}</h1>
<div class="sub">agent ${esc(t.agentId)} · ${num(t.runs.length)} run(s) · gate badges are the live decision where the plugin logged one, else the strict preset replayed</div>
${runHtml || '<p class="empty">No runs in this session.</p>'}
<footer>Generated ${esc(generatedAt.toISOString())} by npx xybernetex-openclaw timeline · from your OpenClaw history on this machine; nothing was sent anywhere.</footer>
</div></body></html>`;
}
