// Renders a summary from src/report.js as a single self-contained HTML page
// in the Xybernetex style. Every value is escaped: model names, agent ids
// and error kinds come from the log.
import { recommendations } from "./report.js";

export const STYLE = `
:root{--bg:#030508;--panel:#0c1220;--text:#e8f2ff;--muted:#8fa4c4;--dim:#536987;--cyan:#00d4ff;--green:#00e59a;--amber:#ff9f1c;--red:#ff5e6c;--line:rgba(0,212,255,.12)}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:32px 16px}
.wrap{max-width:980px;margin:0 auto}
.brand{font:700 14px ui-monospace,Consolas,monospace;letter-spacing:4px}.brand b{color:var(--cyan)}
h1{font-size:30px;line-height:1.2;margin:18px 0 4px}
.sub{color:var(--muted);font-size:14px}
h2{font:700 12px ui-monospace,Consolas,monospace;letter-spacing:2px;text-transform:uppercase;color:var(--cyan);margin:36px 0 12px}
.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:26px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px}
.card .label{color:var(--muted);font:700 11px ui-monospace,Consolas,monospace;letter-spacing:1.5px;text-transform:uppercase}
.card .value{font-size:30px;font-weight:700;margin:6px 0 2px}
.card .note{color:var(--dim);font-size:13px}
.card.good .value{color:var(--green)}.card.warn .value{color:var(--amber)}.card.bad .value{color:var(--red)}.card.info .value{color:var(--cyan)}
.recs{list-style:none;background:var(--panel);border:1px solid rgba(255,159,28,.25);border-radius:8px;padding:6px 18px}
.recs li{padding:10px 0;border-bottom:1px solid var(--line);color:var(--muted)}.recs li:last-child{border:0}
.recs li::before{content:"→ ";color:var(--amber);font-weight:700}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th{text-align:left;color:var(--dim);font:700 11px ui-monospace,Consolas,monospace;letter-spacing:1.5px;text-transform:uppercase;padding:10px 14px;border-bottom:1px solid var(--line)}
td{padding:10px 14px;border-bottom:1px solid var(--line);color:var(--muted)}tr:last-child td{border:0}td:first-child{color:var(--text)}
.bar{display:flex;height:14px;border-radius:7px;overflow:hidden;background:var(--panel)}
.legend{display:flex;flex-wrap:wrap;gap:16px;margin-top:10px;color:var(--muted);font-size:13px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}
.r-d{background:var(--red)}.r-s{background:var(--amber)}.r-n{background:var(--green)}.r-u{background:var(--dim)}
.a-u{background:var(--red)}.a-r{background:var(--green)}.a-o{background:var(--cyan)}.a-l{background:var(--dim)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.empty{color:var(--dim);font-size:14px}
footer{margin-top:40px;color:var(--dim);font:12px ui-monospace,Consolas,monospace}
@media (max-width:760px){.cards{grid-template-columns:1fr 1fr}.two{grid-template-columns:1fr}h1{font-size:24px}}
`;

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
export const num = (n) => (n === null || n === undefined ? "–" : Number(n).toLocaleString("en-US"));
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "–");
export const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : "–");
const secs = (ms) => (ms === null || ms === undefined ? "–" : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60_000).toFixed(1)} min`);

export function card(label, value, note, tone = "") {
  return `<div class="card ${tone}"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>` +
    `<div class="note">${esc(note)}</div></div>`;
}

export function table(head, rows) {
  if (!rows.length) return `<p class="empty">Nothing recorded.</p>`;
  return `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>` +
    rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
}

function bar(parts) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!total) return `<p class="empty">No calls recorded.</p>`;
  return `<div class="bar">${parts.filter((p) => p.value).map((p) =>
    `<span class="${p.cls}" style="width:${(100 * p.value) / total}%" title="${esc(p.label)}: ${p.value}"></span>`).join("")}</div>` +
    `<div class="legend">${parts.map((p) => `<span><i class="${p.cls}"></i>${esc(p.label)} ${num(p.value)}</span>`).join("")}</div>`;
}

export function renderReport(s, { title = "Xybernetex agent report", generatedAt = new Date() } = {}) {
  const stopped = s.gate.held + s.gate.blocked;
  const wouldStop = s.gate.wouldHold + s.gate.wouldBlock;
  const recs = recommendations(s);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style></head><body><div class="wrap">
<div class="brand">XYBERNETEX<b>.</b></div>
<h1>${esc(title)}</h1>
<div class="sub">${day(s.window.from)} to ${day(s.window.to)} · gate ${esc(s.gateConfig.mode ?? "not loaded")}` +
    `${s.gateConfig.preset ? ` · preset ${esc(s.gateConfig.preset)}` : ""}</div>

<div class="cards">
${card("Agent runs", num(s.runs.seen), `${num(s.calls.total)} tool calls`, "info")}
${card("Finished cleanly", s.runs.ended ? pct(s.runs.ended - s.runs.died, s.runs.ended) : "–", `${num(s.runs.died)} runs died`, s.runs.died ? "warn" : "good")}
${card(s.gateConfig.mode === "enforce" ? "Risky calls stopped" : "Would have stopped", num(s.gateConfig.mode === "enforce" ? stopped : wouldStop),
    `${num(s.gate.unrequestedStopped)} destructive and unrequested`, (stopped || wouldStop) ? "bad" : "good")}
${card("Tokens", num(s.tokens.total), `${num(s.tokens.perRun)} per run`, "info")}
</div>

<h2>What to do next</h2>
<ul class="recs">${recs.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>

<h2>Safety</h2>
<div class="two">
${table(["Gate outcome", "Count"], [
    ["Held for approval", num(s.gate.held)], ["Blocked", num(s.gate.blocked)],
    ["Would hold (observe mode)", num(s.gate.wouldHold)], ["Would block (observe mode)", num(s.gate.wouldBlock)],
    ["Approved by a person", num(s.gate.allowed)], ["Denied or expired", num(s.gate.denied)],
    ["Requested by the user, ran without a prompt", num(s.gate.waived)]])}
${table(["Tool", "Gate events"], Object.entries(s.gate.byTool).sort((a, b) => b[1] - a[1]).map(([t, n]) => [t, num(n)]))}
</div>
<h2>Risk of every call</h2>
${bar([{ label: "Destructive", value: s.calls.risk.destructive, cls: "r-d" }, { label: "Sensitive", value: s.calls.risk.sensitive, cls: "r-s" },
    { label: "Harmless", value: s.calls.risk.none, cls: "r-n" }, { label: "Not judged", value: s.calls.risk.unjudged, cls: "r-u" }])}
<h2>Who asked for the risky calls that ran</h2>
${bar([{ label: "The user asked", value: s.calls.riskyAuth.requested, cls: "a-r" }, { label: "Agent's own files", value: s.calls.riskyAuth.own_artifact, cls: "a-o" },
    { label: "Nobody asked", value: s.calls.riskyAuth.unrequested, cls: "a-u" }, { label: "Unlabeled", value: s.calls.riskyAuth.unlabeled, cls: "a-l" }])}

<h2>Reliability</h2>
<div class="two">
${table(["Measure", "Value"], [
    ["Runs finished", `${num(s.runs.ended - s.runs.died)} of ${num(s.runs.ended)}`], ["Runs that died", num(s.runs.died)],
    ["Median run time", secs(s.runs.medianDurationMs)], ["Runs stuck in a loop", num(s.runs.loopingRuns)],
    ["Failed tool calls", `${num(s.calls.failed)} (${pct(s.calls.failed, s.calls.total)})`], ["Timed-out tool calls", num(s.calls.timedOut)]])}
${table(["Why runs died", "Runs"], Object.entries(s.runs.errorKinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, num(n)]))}
</div>
${s.interventions && (s.interventions.decided.retry + s.interventions.decided.verify + s.interventions.decided.none) ? `<h2>Interventions</h2>
${table(["Follow-up", "Decided", "Started", "Finished cleanly"], [
    ["Retry a run that died", num(s.interventions.decided.retry), num(s.interventions.started.retry),
      s.interventions.outcomes.retry.n ? `${num(s.interventions.outcomes.retry.ok)} of ${num(s.interventions.outcomes.retry.n)}` : "–"],
    ["Check your work", num(s.interventions.decided.verify), num(s.interventions.started.verify),
      s.interventions.outcomes.verify.n ? `${num(s.interventions.outcomes.verify.ok)} of ${num(s.interventions.outcomes.verify.n)}` : "–"],
    ["No follow-up", num(s.interventions.decided.none), "–", "–"]])}` : ""}
${s.outcomes?.episodes ? `<h2>What happened next</h2>
${table(["After", "Runs", "User replied", "Corrected or asked again", "Thanked"],
    [["No follow-up", "none"], ["A retry", "retry"], ["A check-your-work turn", "verify"]]
      .filter(([, k]) => s.outcomes.byApplied[k])
      .map(([label, k]) => { const g = s.outcomes.byApplied[k];
        return [label, num(g.n), num(g.replied), g.replied ? `${num(g.correction + g.repeat)} (${pct(g.correction + g.repeat, g.replied)})` : "–",
          g.replied ? num(g.thanks) : "–"]; }))}
<div class="two" style="margin-top:12px">
${table(["Check-your-work result", "Runs"], [["Fixed something (changed files)", num(s.outcomes.verify.fixed)],
    ["Confirmed the answer", num(s.outcomes.verify.confirmed)], ["Didn't finish", num(s.outcomes.verify.failed)]])}
${table(["Retries", "Runs"], [["Retried", num(s.outcomes.retry.n)], ["Finished on the retry", num(s.outcomes.retry.finished)]])}
</div>` : ""}

<h2>Agents</h2>
${table(["Agent", "Runs", "Died"], Object.entries(s.runs.byAgent).sort((a, b) => b[1].runs - a[1].runs)
    .map(([a, v]) => [a, num(v.runs), `${num(v.died)} (${pct(v.died, v.runs)})`]))}

<h2>Spend</h2>
<div class="two">
${table(["Measure", "Tokens"], [["Total", num(s.tokens.total)], ["Per run", num(s.tokens.perRun)],
    ["On runs that died", `${num(s.tokens.onDiedRuns)} (${pct(s.tokens.onDiedRuns, s.tokens.total)})`]])}
${table(["Model", "Runs", "Tokens"], Object.entries(s.tokens.byModel).sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([m, v]) => [m, num(v.runs), num(v.tokens)]))}
</div>

<h2>Policy service</h2>
${table(["Measure", "Value"], [["Decisions served", num(s.policy.decisions)], ["Failed requests", num(s.policy.errors)],
    ["Median latency", s.policy.p50Ms === null ? "–" : `${num(s.policy.p50Ms)} ms`], ["95th percentile latency", s.policy.p95Ms === null ? "–" : `${num(s.policy.p95Ms)} ms`],
    ...Object.entries(s.policy.actions).sort((a, b) => b[1] - a[1]).map(([a, n]) => [`Recommended ${a}`, num(n)])])}

<footer>Generated ${esc(generatedAt.toISOString().replace("T", " ").slice(0, 16))} UTC from the local Xybernetex log.
Contains labels and hashes only, never prompts, files or command text.</footer>
</div></body></html>`;
}
