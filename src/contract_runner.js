// Contracts for OpenClaw runs: the deterministic loop around an agent run.
//
//   user turn starts   the run's model writes a contract from the request
//                      (api.runtime.llm, no tools), while the agent works
//   run ends           the checks run where the agent's commands run - in the
//                      session's Docker sandbox, on a copy of the run's folder
//                      (or on the host, for an unsandboxed agent on Linux/macOS)
//                      all pass: done, no follow-up
//                      any fail: snapshot the run's folder, then a fix turn
//                      naming exactly what failed (a detached `openclaw agent`
//                      turn in the same session, like every follow-up)
//   fix turn ends      checks again; the ratchet keeps the change only if no
//                      passing check now fails, else restores the snapshot and
//                      says what was undone; up to maxFixes rounds
//
// A contract decides that run's follow-up in place of the interventions rule.
// The ratchet only ever snapshots and restores the run's own folder (the
// workdir its commands used) - never an agent's whole workspace, which other
// sessions may be writing to - and only below a size limit. Logs carry the
// contract's hash, counts and outcomes, never check text or file contents.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ROLLED_BACK, REGRESSED, contractPrompt, failureMessage, judge, parseGenerated, passedAll, passing,
  rollbackMessage, runChecks, verdictSummary } from "./contracts.js";

const SYSTEM = "You write acceptance checks. Reply with JSON only.";

function run(file, args, { timeoutMs, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, cwd, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (err.killed ? 124 : typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, output: String(stdout ?? "") + (String(stderr ?? "").trim() ? `\n[stderr]\n${stderr}` : "") });
      });
  });
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The session's sandbox container: OpenClaw labels each with the session key it
// serves (an agent-scoped sandbox carries an agent:<id>:... key).
export async function findSandbox(sessionKey, agentId, runImpl = run) {
  const { code, output } = await runImpl("docker", ["ps", "--filter", "label=openclaw.sandbox=1", "--format",
    "{{.Names}}\t{{.Label \"openclaw.sessionKey\"}}"], { timeoutMs: 15_000 });
  if (code !== 0) return null;
  const rows = output.split(/\r?\n/).map((l) => l.trim().split("\t")).filter((r) => r.length === 2 && r[0]);
  const exact = rows.find(([, key]) => key === sessionKey);
  if (exact) return exact[0];
  const scoped = rows.filter(([, key]) => agentId && key.startsWith(`agent:${agentId}:`));
  return scoped.length === 1 ? scoped[0][0] : null;
}

// A folder's size, giving up past `limit` bytes.
function sizeUpTo(dir, limit) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    for (const entry of fs.readdirSync(stack.pop(), { withFileTypes: true })) {
      const full = path.join(entry.parentPath ?? entry.path, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
      if (total > limit) return total;
    }
  }
  return total;
}

export function folderSnapshots(dir, tmpRoot = os.tmpdir()) {
  let n = 0;
  const root = fs.mkdtempSync(path.join(tmpRoot, "xyb-snap-"));
  return {
    snapshot() {
      n += 1;
      const dest = path.join(root, String(n));
      fs.cpSync(dir, dest, { recursive: true, verbatimSymlinks: true });
      return dest;
    },
    restore(token) {
      for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
      fs.cpSync(token, dir, { recursive: true, verbatimSymlinks: true });
    },
    discard(token) { fs.rmSync(token, { recursive: true, force: true }); },
    close() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

// The workdir the run's commands used most, as a folder relative to the workspace ("" = the root).
function runFolder(workdirs) {
  const best = [...workdirs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!best) return "";
  const rel = best.replace(/\\/g, "/").replace(/^\/workspace\/?/, "").replace(/^\.\/?/, "").replace(/\/+$/, "");
  return rel.startsWith("/") || rel.split("/").includes("..") ? null : rel;  // null: outside the workspace
}

export function createContracts({ config = {}, complete, workspaceDir, schedule, log = () => {},
  sandboxFor = findSandbox, runImpl = run, platform = process.platform, tmpRoot = os.tmpdir() }) {
  const mode = config.mode ?? "off";
  if (!["off", "auto"].includes(mode)) throw new Error("contracts.mode must be off or auto");
  const agentIds = config.agentIds ?? null;
  const maxFixes = config.maxFixes ?? 2;
  if (!Number.isInteger(maxFixes) || maxFixes < 0 || maxFixes > 5) throw new Error("contracts.maxFixes must be 0-5");
  const ratchet = config.ratchet !== false;
  // Fix rounds in a row without improvement before the loop gives up (the governor's no-progress stop).
  const noProgressRounds = config.noProgressRounds ?? 2;
  if (!Number.isInteger(noProgressRounds) || noProgressRounds < 1) throw new Error("contracts.noProgressRounds must be 1 or more");
  const maxSnapshotBytes = (config.maxSnapshotMb ?? 200) * 1024 * 1024;
  const pending = new Map();   // runKey -> { sessionKey, agentId, writing, workdirs }
  const loops = new Map();     // sessionKey -> a contract's fix loop in progress
  const ours = new Set();      // runKeys of our fix turns
  const bound = (m) => { while (m.size > 500) m.delete(m.keys().next().value); };
  const safeLog = (e) => { try { log(e); } catch { /* best-effort */ } };

  // A reasoning model can spend the whole budget thinking and return nothing (GLM-5.3 Flash did at 8000
  // tokens, live): a reply cut off at the limit gets one more try with more room.
  const WRITER_BUDGETS = [8000, 32000];

  async function write(prompt, agentId) {
    let writer = agentId ? "agent" : "default";
    let last = null;
    for (const maxTokens of WRITER_BUDGETS) {
      const params = { messages: [{ role: "user", content: contractPrompt(prompt) }], systemPrompt: SYSTEM,
        purpose: "xybernetex.contract", maxTokens, temperature: 0 };
      let result;
      try {
        result = await complete({ ...params, ...(writer === "agent" ? { agentId } : {}) });
      } catch (err) {
        if (writer !== "agent") return { contract: null, error: `${err?.code ?? "error"}: ${String(err?.message ?? err).slice(0, 120)}` };
        // Writing with another agent's model needs plugins.entries.<id>.llm.allowAgentIdOverride; the default
        // agent's model will do.
        writer = "default";
        try { result = await complete(params); } catch (err2) {
          return { contract: null, error: `${err2?.code ?? "error"}: ${String(err2?.message ?? err2).slice(0, 120)}` };
        }
      }
      const tokens = (last?.tokens ?? 0) + (result?.usage?.totalTokens ?? 0) || null;
      try {
        return { contract: parseGenerated(result?.text), writer, tokens };
      } catch (err) {
        // Why it couldn't be read - the reply's size and stop reason, never its text.
        const why = `${String(err?.message ?? err).slice(0, 120)} (reply ${String(result?.text ?? "").length} chars, ` +
          `stop ${result?.stopReason ?? "unknown"}, budget ${maxTokens})`;
        last = { contract: null, writer, error: why, tokens };
        const cutOff = /length|max_tokens/i.test(String(result?.stopReason ?? ""));
        if (!cutOff) return last;
      }
    }
    return last;
  }

  // Where the checks run, and where the ratchet snapshots: the sandbox (or the host) and the run's folder.
  async function locate(sessionKey, agentId, workdirs) {
    const rel = runFolder(workdirs);
    if (rel === null) return { error: "the run worked outside its workspace" };
    const hostRoot = workspaceDir(agentId);
    const hostDir = hostRoot && rel ? path.join(hostRoot, rel) : null;   // never the workspace root
    const container = await sandboxFor(sessionKey, agentId, runImpl);
    let execForRound;
    if (container) {
      const wd = rel ? `/workspace/${rel}` : "/workspace";
      execForRound = () => {
        let copied = null;
        return async (command, timeout) => {
          copied ??= runImpl("docker", ["exec", "-w", "/", container, "bash", "-c",
            `rm -rf /tmp/xyb-check && cp -a ${q(wd)} /tmp/xyb-check`], { timeoutMs: 300_000 });
          const setup = await copied;
          if (setup.code !== 0) throw new Error(`couldn't copy the folder for checking: ${setup.output.slice(-200)}`);
          return runImpl("docker", ["exec", "-w", "/tmp/xyb-check", container, "timeout", String(timeout), "bash", "-c", command],
            { timeoutMs: (timeout + 30) * 1000 });
        };
      };
    } else if (platform !== "win32" && hostRoot) {
      const wd = rel ? path.join(hostRoot, rel) : hostRoot;
      execForRound = () => {
        let copy = null;
        return async (command, timeout) => {
          if (!copy) {
            copy = fs.mkdtempSync(path.join(tmpRoot, "xyb-check-"));
            fs.cpSync(wd, copy, { recursive: true, verbatimSymlinks: true });
          }
          return runImpl("bash", ["-c", command], { cwd: copy, timeoutMs: (timeout + 30) * 1000 });
        };
      };
    } else {
      return { error: "no sandbox to run checks in (an unsandboxed agent on Windows)" };
    }
    let snapshots = null;
    let noRatchet = null;
    if (!ratchet) noRatchet = "off";
    else if (!hostDir) noRatchet = "no run folder";
    else if (!fs.existsSync(hostDir)) noRatchet = "run folder not found";
    else if (sizeUpTo(hostDir, maxSnapshotBytes) > maxSnapshotBytes) noRatchet = "run folder over the size limit";
    else snapshots = folderSnapshots(hostDir, tmpRoot);
    return { execForRound, snapshots, noRatchet, where: container ? "sandbox" : "host" };
  }

  async function check(sessionKey, contract, place, round) {
    const verdict = await runChecks(contract, place.execForRound());
    safeLog({ type: "contract_check", sessionKey, round, ...verdictSummary(verdict) });
    return verdict;
  }

  async function fix(loop, message) {
    if (loop.place.snapshots) {
      try { loop.token = loop.place.snapshots.snapshot(); } catch (err) {
        loop.token = null;
        safeLog({ type: "snapshot_failed", sessionKey: loop.sessionKey, round: loop.round, error: err?.name ?? "Error" });
      }
    }
    await schedule({ sessionKey: loop.sessionKey, agentId: loop.agentId, message, model: loop.model });
  }

  function end(loop, met) {
    loops.delete(loop.sessionKey);
    try { loop.place.snapshots?.close(); } catch { /* best-effort */ }
    safeLog({ type: "contract_end", sessionKey: loop.sessionKey, contract: loop.contract.hash, met, rounds: loop.outcomes.length,
      ratchet: loop.outcomes });
  }

  return {
    enabled: mode === "auto",

    // before_agent_run: our fix turns are remembered; a user's turn starts a contract
    // (and ends any fix loop still open in that session).
    noteRunStart(runKey, ctx, prompt, isOursTurn) {
      if (mode !== "auto" || !ctx?.sessionKey) return;
      if (isOursTurn) { ours.add(runKey); bound(ours); return; }
      const loop = loops.get(ctx.sessionKey);
      if (loop) end(loop, null);
      if (agentIds && !agentIds.includes(ctx.agentId)) return;
      if (typeof prompt !== "string" || !prompt.trim()) return;
      pending.set(runKey, { sessionKey: ctx.sessionKey, agentId: ctx.agentId, writing: write(prompt, ctx.agentId),
        workdirs: new Map() });
      bound(pending);
    },

    // after_tool_call: which folder the run works in.
    noteToolCall(runKey, toolName, params) {
      const p = pending.get(runKey);
      const wd = params?.workdir ?? params?.cwd;
      if (p && (toolName === "exec" || toolName === "terminal") && typeof wd === "string" && wd.trim()) {
        p.workdirs.set(wd.trim(), (p.workdirs.get(wd.trim()) ?? 0) + 1);
      }
    },

    // agent_end for a user's run: the contract's decision (an interventions-shaped entry), or
    // null when there is no contract - then the usual follow-up rule decides.
    async onRunEnd(runKey, ctx, summary, model) {
      const p = pending.get(runKey);
      if (!p) return null;
      pending.delete(runKey);
      const { contract, error, writer, tokens } = await p.writing;
      if (!contract) {
        safeLog({ type: "contract_unavailable", sessionKey: p.sessionKey, reason: (error ?? "none").slice(0, 200) });
        return null;
      }
      safeLog({ type: "contract", sessionKey: p.sessionKey, source: contract.source, writer, contract: contract.hash,
        checks: contract.checks.length, refused: contract.refused.length, tokens });
      const place = await locate(p.sessionKey, p.agentId, p.workdirs);
      if (place.error) {
        safeLog({ type: "contract_unavailable", sessionKey: p.sessionKey, reason: place.error });
        return null;
      }
      if (place.noRatchet) safeLog({ type: "ratchet_off", sessionKey: p.sessionKey, reason: place.noRatchet });
      const verdict = await check(p.sessionKey, contract, place, 0);
      const met = passedAll(verdict);
      const entry = { type: "intervention", runKey, sessionKey: p.sessionKey, agentId: p.agentId, mode: "act",
        wasOurs: false, success: summary.success, toolCalls: summary.toolCalls, model: model ?? null,
        action: met ? "none" : "verify", probability: 1, rule: met ? "contract-met" : "contract-failed", policy: "contract",
        scheduled: false };
      if (!met && maxFixes > 0) {
        const loop = { sessionKey: p.sessionKey, agentId: p.agentId, model: model ?? null, contract, place, best: verdict,
          round: 1, token: null, outcomes: [], stalls: 0 };
        loops.set(p.sessionKey, loop);
        bound(loops);
        try {
          await fix(loop, failureMessage(verdict));
          entry.scheduled = true;
        } catch (err) {
          entry.error = String(err?.message ?? err).slice(0, 200);
          end(loop, false);
        }
      } else {
        place.snapshots?.close();
      }
      safeLog(entry);
      return entry;
    },

    // agent_end for one of our fix turns: re-check, keep or undo, then another round or done.
    async onFixEnd(runKey, ctx) {
      if (!ours.delete(runKey)) return false;
      const loop = ctx?.sessionKey ? loops.get(ctx.sessionKey) : null;
      if (!loop) return false;
      const next = await check(loop.sessionKey, loop.contract, loop.place, loop.round);
      let outcome = judge(loop.best, next);
      let message;
      if (outcome === REGRESSED && loop.token) {
        try {
          loop.place.snapshots.restore(loop.token);
          outcome = ROLLED_BACK;
          message = rollbackMessage(loop.best, next);
        } catch (err) {
          safeLog({ type: "restore_failed", sessionKey: loop.sessionKey, round: loop.round, error: err?.name ?? "Error" });
        }
      }
      if (outcome !== ROLLED_BACK) {
        loop.best = next;
        message = failureMessage(next);
      }
      if (loop.token) {
        try { loop.place.snapshots.discard(loop.token); } catch { /* a leftover snapshot is harmless */ }
        loop.token = null;
      }
      loop.outcomes.push(outcome);
      loop.stalls = outcome === "improved" ? 0 : loop.stalls + 1;
      safeLog({ type: "ratchet", sessionKey: loop.sessionKey, round: loop.round, outcome, passed: passing(next).size,
        kept: passing(loop.best).size, checks: next.results.length });
      if (passedAll(loop.best) || loop.round >= maxFixes || loop.stalls >= noProgressRounds) {
        if (!passedAll(loop.best) && loop.stalls >= noProgressRounds && loop.round < maxFixes) {
          safeLog({ type: "governor_stop", sessionKey: loop.sessionKey, reason: "no-progress", rounds: loop.round });
        }
        end(loop, passedAll(loop.best));
        return true;
      }
      loop.round += 1;
      try {
        await fix(loop, message);
      } catch (err) {
        safeLog({ type: "contract_fix_failed", sessionKey: loop.sessionKey, error: String(err?.message ?? err).slice(0, 200) });
        end(loop, false);
      }
      return true;
    },

    endSession(sessionKey) {
      const loop = loops.get(sessionKey);
      if (loop) end(loop, null);
    },
  };
}
