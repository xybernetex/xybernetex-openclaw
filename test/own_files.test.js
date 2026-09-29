// Deletes of the agent's own files (authz ownsFiles and the gate's "own_files"
// waiver). xybernetex-python's tests/test_own_files.py holds the same cases.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAuthorizationTracker } from "../src/authz.js";
import { createToolGate } from "../src/control.js";

const REQUEST = "Build a small CLI for the key-value store in kv.py, with tests.";

function session() {
  const t = createAuthorizationTracker();
  t.setRequest("s", REQUEST);
  const s = {
    t,
    ran(command, failed = false) { t.recordCompleted("s", "exec", { command }, failed); return s; },
    wrote(path) { t.recordCompleted("s", "write", { file_path: path, content: "x" }, false); return s; },
    owns: (command, workdir) => t.ownsFiles("s", "exec", { command, ...(workdir ? { workdir } : {}) }),
  };
  return s;
}

test("a plain delete of files the agent wrote qualifies", () => {
  const s = session().wrote("check_kv.py").ran("echo ok > out.txt");
  for (const cmd of ["rm check_kv.py", "rm -f check_kv.py", "rm -fv ./check_kv.py", "unlink out.txt",
    "rm check_kv.py out.txt", "rm check_kv.py && rm out.txt", "sudo rm check_kv.py"]) {
    assert.equal(s.owns(cmd), true, cmd);
  }
  assert.equal(s.t.label("s", "exec", { command: "rm check_kv.py" }), "own_artifact");
});

test("anything more than a plain file delete does not", () => {
  const s = session().wrote("check_kv.py").ran("mkdir scratch");
  for (const cmd of ["rm -r check_kv.py", "rm -rf check_kv.py", "rm --recursive check_kv.py", "rm -d check_kv.py",
    "rm -rf scratch", "rmdir scratch", "rm scratch",
    "rm check_kv.py kv.py",
    "rm check_kv.py && python3 x.py", "rm check_kv.py && mv a b",
    "cd sub && rm check_kv.py", "cd .. && rm check_kv.py", "cd /tmp && rm check_kv.py", "ls",
    "rm check_kv.py 2>/dev/null", "rm check_kv.py | tee log", "rm $(cat list)",
    "rm check_*.py", "rm ../check_kv.py", "rm ~/check_kv.py", "rm $F", "rm -- -x",
    "shred check_kv.py", "truncate -s 0 check_kv.py", "git rm check_kv.py"]) {
    assert.equal(s.owns(cmd), false, cmd);
  }
  assert.equal(s.t.ownsFiles("s", "write", { file_path: "check_kv.py" }), false);
  assert.equal(createAuthorizationTracker().ownsFiles("s", "exec", { command: "rm check_kv.py" }), false);
});

test("the working folder, cd and read-only company are understood", () => {
  const s = session().wrote("runs/x/solve.py").wrote("check_kv.py");
  for (const [cmd, wd] of [["rm solve.py", "runs/x"], ["del solve.py", "runs/x"], ["Remove-Item solve.py", "runs/x"],
    ["Remove-Item -Path solve.py -Force", "runs/x"], ["del /f /q solve.py", "runs/x"],
    ["cd runs/x && rm solve.py"], ["cd runs && rm x/solve.py && ls -la"],
    ["rm check_kv.py && ls"], ["rm check_kv.py; cat out.txt"], ["rm ../../check_kv.py", "runs/x"]]) {
    assert.equal(s.owns(cmd, wd), !cmd.startsWith("rm ../"), `${cmd} @ ${wd}`);
  }
  for (const [cmd, wd] of [["rm solve.py"], ["rm solve.py", "runs"], ["rm solve.py", "/abs/runs/x"],
    ["rm solve.py", "../runs/x"], ["Remove-Item -Recurse solve.py", "runs/x"], ["del /s solve.py", "runs/x"]]) {
    assert.equal(s.owns(cmd, wd), false, `${cmd} @ ${wd}`);
  }
  assert.equal(session().wrote("tmp/data.csv").owns("rm data.csv"), false);
  assert.equal(session().ran("cd out && echo x > log.txt").owns("rm out/log.txt"), true);
});

test("tool caches may go unless a move named them", () => {
  for (const cmd of ["rm -rf __pycache__", "rm -rf runs/x/__pycache__", "rm -f kv.pyc", "Remove-Item -Recurse -Force __pycache__"]) {
    assert.equal(session().owns(cmd), true, cmd);
  }
  for (const move of ["mv data.csv build/__pycache__/sub/", "mv data __pycache__", "mv -t . ../*"]) {
    assert.equal(session().ran(move).owns("rm -rf build/__pycache__"), false, move);
  }
  assert.equal(session().ran("mv data.csv kv.pyc").owns("rm -f kv.pyc"), false);
});

test("appends, touches and idempotent forms are not creations", () => {
  const s = session().ran("echo x >> notes.txt").ran("touch data.csv").ran("cat kv.py 2> err.log");
  for (const cmd of ["rm notes.txt", "rm data.csv"]) assert.equal(s.owns(cmd), false, cmd);
});

test("a folder the agent made cannot launder a user's file", () => {
  const s = session().ran("mkdir scratch").ran("mv data.csv scratch/");
  assert.equal(s.owns("rm -rf scratch"), false);
  assert.equal(s.owns("rm scratch/data.csv"), false);
});

test("a move onto an own file takes it out of the set", () => {
  const cases = [
    ["echo x > data.csv", "mv ../data.csv .", "rm data.csv"],
    ["echo x > check.py", "mv kv.py check.py", "rm check.py"],
    ["echo x > out/log.txt", "mv backup out", "rm out/log.txt"],
    ["echo x > a.txt", "mv -t . ../*", "rm a.txt"],
    ["echo x > a.txt", "ls ../in | xargs mv -t .", "rm a.txt"],
    ["echo x > a.txt", "git mv ../a.txt a.txt", "rm a.txt"],
    ["echo x > a.txt", "rsync --remove-source-files ../a.txt .", "rm a.txt"],
  ];
  for (const [create, move, del] of cases) {
    const s = session().ran(create);
    assert.equal(s.owns(del), true, create);
    s.ran(move);
    assert.equal(s.owns(del), false, move);
  }
  assert.equal(session().ran("echo x > data.csv").ran("mv ../data.csv .", true).owns("rm data.csv"), false);
  assert.equal(session().ran("echo x > out.txt").ran("mv build.log logs/").wrote("out.txt").owns("rm out.txt"), true);
});

function gated({ preset = "recommended", rules = [] } = {}) {
  const s = session();
  const logs = [];
  const gate = createToolGate({ mode: "enforce", preset, rules, log: (e) => logs.push(e),
    authorize: (e) => s.t.label("s", e.toolName, e.params),
    ownsFiles: (e) => s.t.ownsFiles("s", e.toolName, e.params) });
  const call = (command, id) => gate({ toolName: "exec", params: { command }, toolCallId: id }, { sessionKey: "s", agentId: "main" });
  return { s, call, logs };
}

test("the gate lets the agent delete its own files without a prompt, never its own folders", () => {
  const { s, call, logs } = gated();
  s.wrote("check_kv.py").ran("mkdir scratch");
  assert.equal(call("rm check_kv.py", "c1"), undefined);
  const waived = logs.filter((e) => e.type === "tool_gate_waived");
  assert.deepEqual([waived[0].authorization, waived[0].waiver], ["own_artifact", "own_files"]);
  assert.ok(call("rm -rf scratch", "c2").requireApproval);
  assert.equal(logs.at(-1).authorization, "own_artifact");
  assert.equal(logs.at(-1).waiver, undefined);
});

test("the strict preset waives it too; a rule without own_files does not; rules may list own_files", () => {
  let g = gated({ preset: "strict" });
  g.s.wrote("check_kv.py");
  assert.equal(g.call("rm check_kv.py", "c1"), undefined);
  g = gated({ preset: undefined, rules: [{ id: "hold-deletes", agentId: "*", toolName: "*", riskAtLeast: "destructive",
    action: "block", unlessAuthorization: ["requested"] }] });
  g.s.wrote("check_kv.py");
  assert.equal(g.call("rm check_kv.py", "c1").block, true);
  createToolGate({ rules: [{ id: "r", agentId: "*", toolName: "*", riskAtLeast: "destructive", action: "block",
    unlessAuthorization: ["own_files"] }] });
  assert.throws(() => createToolGate({ rules: [{ id: "r", agentId: "*", toolName: "*", riskAtLeast: "destructive",
    action: "block", unlessAuthorization: ["own_artifact"] }] }), /unlessAuthorization/);
});
