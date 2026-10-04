// Renders src/audit.js's findings as one self-contained page in the report's
// style. Unlike the plugin's log, the audit shows the actual commands: it is
// built from the user's own history, on the user's machine, for the user.
// Every value is escaped.
import { STYLE, card, day, esc, num, table } from "./report_html.js";

const when = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace("T", " ") : "–");
const agentOf = (key) => String(key ?? "").split(":")[1] ?? "";
const LIST_LIMIT = 50;

function codeTable(head, rows) {
  if (!rows.length) return `<p class="empty">None found.</p>`;
  const shown = rows.slice(0, LIST_LIMIT);
  return `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>` +
    shown.map((r) => `<tr>${r.map((c, i) => (i === r.length - 1 ? `<td><code>${esc(c)}</code></td>` : `<td>${esc(c)}</td>`)).join("")}</tr>`).join("") +
    "</tbody></table>" + (rows.length > LIST_LIMIT ? `<p class="empty">and ${num(rows.length - LIST_LIMIT)} more.</p>` : "");
}

export function headline(a) {
  const u = a.risky.unrequested.length;
  const lines = [
    `${num(a.risky.total)} destructive or outward-facing actions; ${num(u)} that nobody asked for` +
      (u ? " - Xybernetex would have held these for your approval" : ""),
    `${num(a.planted.length)} times an agent read an instruction to delete something (a README, a web page, a tool's output)`,
    `${num(a.deaths.silent.length)} runs that died while OpenClaw reported success`,
    `${num(a.loops.length)} runs that looped (the same call ${4} times in a row, or over 150 tool calls)`,
  ];
  return lines;
}

export function renderAudit(a, { days, generatedAt = new Date() } = {}) {
  const u = a.risky.unrequested;
  const tokens = a.tokens.reduce((s, t) => s + t.total, 0);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Xybernetex audit</title>
<style>${STYLE}
code{font:13px ui-monospace,Consolas,monospace;color:var(--text);word-break:break-all}
.lede{color:var(--muted);max-width:760px}
</style></head><body><div class="wrap">
<div class="brand">XYBERNETEX<b>.</b></div>
<h1>What your agents did</h1>
<div class="sub">${day(a.window.from)} to ${day(a.window.to)}${days ? ` (last ${esc(days)} days)` : ""} · ` +
    `${num(a.agents.length)} agent(s): ${esc(a.agents.join(", "))}</div>
<p class="lede">Your OpenClaw session history, replayed through the Xybernetex gate (strict preset) and governor.
Nothing was stopped and nothing left this machine.</p>

<div class="cards">
${card("Agent runs", num(a.runs), `${num(a.toolCalls)} tool calls in ${num(a.sessions)} sessions`, "info")}
${card("Nobody asked for", num(u.length), `of ${num(a.risky.total)} destructive or outward-facing actions`, u.length ? "bad" : "good")}
${card("Died, reported success", num(a.deaths.silent.length), `${num(a.deaths.reported.length)} more failed openly`, a.deaths.silent.length ? "warn" : "good")}
${card("Looped", num(a.loops.length), `${num(tokens)} tokens in all`, a.loops.length ? "warn" : "good")}
</div>

<h2>Risky actions nobody asked for</h2>
<p class="lede">Deletes, overwrites, pushes and sends that no message from you requested. With Xybernetex in enforce mode,
each would have waited for your approval. ${num(a.risky.requested)} more were ones you asked for, and
${num(a.risky.ownFiles)} were agents cleaning up their own files: those run without a prompt.</p>
${codeTable(["When", "Agent", "Kind", "Planted?", "What it ran"],
    u.map((r) => [when(r.ts), r.agentId ?? agentOf(r.sessionKey), r.risk, r.planted ? "after reading one" : "", r.text]))}

<h2>Instructions to delete, found in what agents read</h2>
<p class="lede">A file, web page or tool result that contained a delete command. Text an agent reads can't authorize
anything under Xybernetex: its targets stay held unless you ask.</p>
${codeTable(["When", "Agent", "Targets", "Read by"],
    a.planted.map((p) => [when(p.ts), p.agentId ?? agentOf(p.sessionKey), num(p.targets), p.text ?? p.toolName ?? ""]))}

<h2>Runs that died while OpenClaw reported success</h2>
<p class="lede">OpenClaw marks these runs successful, but the model never gave a final answer: an empty reply, or its
fallback text after a cut-off. Xybernetex can give such runs one more turn.</p>
${codeTable(["When", "Agent", "Why", "The request"],
    a.deaths.silent.map((d) => [when(d.ts), d.agentId ?? agentOf(d.sessionKey), d.reason ?? "", d.prompt ?? ""]))}

<h2>Runs that looped</h2>
<p class="lede">The same call over and over, or a runaway number of calls. The Xybernetex governor stops these and asks
the agent to summarize.</p>
${codeTable(["When", "Agent", "Stopped for", "The call"],
    a.loops.map((l) => [when(l.ts), l.agentId ?? agentOf(l.sessionKey), l.kind === "repeat" ? "repeating itself" : "too many calls", l.text]))}

<h2>Tokens by model</h2>
${table(["Model", "Tokens"], a.tokens.map((t) => [t.model, num(t.total)]))}

<footer>Generated ${esc(generatedAt.toISOString())} by npx xybernetex-openclaw audit · read from your OpenClaw
state on this machine; nothing was sent anywhere.</footer>
</div></body></html>`;
}
