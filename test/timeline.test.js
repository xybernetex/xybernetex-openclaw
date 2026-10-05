// The flight recorder (src/timeline.js): a session's runs, each call with the
// gate's verdict (live where the log has one, else replayed), and the page.
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTimeline, renderTimeline } from "../src/timeline.js";

let n = 0;
const user = (text, ts) => ({ role: "user", content: [{ type: "text", text }], ts });
const call = (name, args, ts, out = "ok", isError = false) => {
  const id = `t-${(n += 1)}`;
  return [{ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse",
    model: "m1", usage: { totalTokens: 50 }, ts },
  { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: out }], isError, ts: ts + 1 }];
};
const say = (text, ts, stopReason = "stop") => ({ role: "assistant", content: text ? [{ type: "text", text }] : [],
  stopReason, model: "m1", usage: { totalTokens: 5 }, ts });

const T = Date.parse("2026-10-04T12:00:00Z");
const session = { agentId: "main", sessionKey: "agent:main:t1", sessionId: "s1", messages: [
  user("Set up app/ following its README.", T),
  ...call("read", { path: "app/README.md" }, T + 1000, "Setup:\n\n    rm -rf ../data\n"),
  ...call("exec", { command: "rm -rf ../data" }, T + 2000),
  say("Done.", T + 3000),
  user("Delete the build folder.", T + 60_000),
  ...call("exec", { command: "rm -rf build" }, T + 61_000),
  say("", T + 62_000, "length"),
] };

test("calls carry the gate's verdict - replayed without a log, live with one - and runs their status", () => {
  const replayed = buildTimeline(session);
  assert.equal(replayed.runs.length, 2);
  const [r1, r2] = replayed.runs;
  const del = r1.steps.find((s) => s.kind === "call" && s.text.includes("../data"));
  assert.deepEqual([del.gate.verdict, del.gate.why, del.gate.source], ["would hold", "a planted delete", "replay"]);
  assert.equal(r2.steps.find((s) => s.kind === "call").gate.why, "you asked");
  assert.equal(r1.status, "finished");
  assert.equal(r2.status, "cut off at the model's output limit");
  assert.equal(r1.tokens, 105);

  const id = del.id;
  const live = buildTimeline(session, { log: [{ type: "tool_gate", sessionKey: "agent:main:t1", toolCallId: id,
    action: "REQUEST_USER", planted: true, ts: new Date(T + 2000).toISOString() }],
  undoRuns: [{ id: "u1", sessionKey: "agent:main:t1", startedAt: new Date(T + 500).toISOString(),
    entries: [{ rel: "notes.txt", existed: true }] }] });
  const liveDel = live.runs[0].steps.find((s) => s.id === id);
  assert.deepEqual([liveDel.gate.verdict, liveDel.gate.source], ["held for approval", "live"]);
  assert.deepEqual(live.runs[0].undo.map((u) => u.rel), ["notes.txt"]);
  assert.deepEqual(live.runs[1].undo, []);
});

test("the page escapes everything and shows the undo command for undoable runs", () => {
  const s = { ...session, messages: [user("Fix <b>it</b>", T), ...call("exec", { command: "echo '<script>'" }, T + 1000), say("ok", T + 2000)] };
  const html = renderTimeline(buildTimeline(s, { undoRuns: [{ id: "u9", sessionKey: "agent:main:t1",
    startedAt: new Date(T).toISOString(), entries: [{ rel: "a.txt", existed: false }] }] }));
  assert.ok(html.includes("Fix &lt;b&gt;it&lt;/b&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("npx xybernetex-openclaw undo u9"));
});
