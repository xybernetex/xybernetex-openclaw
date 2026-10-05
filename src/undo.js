// The undo journal: before a tool call visibly writes, overwrites, moves or
// deletes something in the agent's workspace, the paths it touches are copied
// aside, once per run. `npx xybernetex-openclaw undo` then puts a run's files
// back the way they were (scripts/undo.mjs).
//
// What it covers: paths a call names - write/edit/apply_patch targets, and in a
// shell command the targets of rm/mv/cp/trash/Remove-Item and > redirects,
// followed through `cd` and the call's workdir, with simple globs expanded.
// What it can't see: files a script changes from inside (`python clean.py`),
// paths outside the agent's workspace, and anything over the size budget. Each
// of those is recorded as not undoable, so `undo` can say so.
//
// Layout: <root>/<run id>/journal.json plus <root>/<run id>/files/<n>, kept for
// the last `keepRuns` runs. Local only; nothing here is logged or sent.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { shellSteps, touchedPaths } from "./authz.js";

export const DEFAULT_UNDO_DIR = join(homedir(), ".openclaw", "xybernetex-undo");
const SANDBOX_ROOT = "/workspace";
const GLOB = /[*?]/;

// Bytes in `path`, stopping once past `limit`.
export function sizeUpTo(path, limit) {
  let total = 0;
  const walk = (p) => {
    if (total > limit) return;
    let st;
    try { st = lstatSync(p); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let names = [];
      try { names = readdirSync(p); } catch { return; }
      for (const n of names) walk(join(p, n));
    } else {
      total += st.size;
    }
  };
  walk(path);
  return total;
}

const globRegex = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

// The workspace-relative paths a call touches ("" = the workspace itself), or a reason it can't be followed.
export function plannedPaths(toolName, params) {
  const p = params && typeof params === "object" ? params : {};
  if (toolName === "exec" || toolName === "terminal") {
    const steps = shellSteps(p) ?? [];
    const out = [];
    for (const step of steps) {
      const paths = touchedPaths("exec", { command: step.segment });
      for (const path of paths) {
        out.push(step.cwd === null ? { path, unresolved: "a cd we can't follow" }
          : /[$`%]/.test(path) ? { path, unresolved: "a path built from a variable" } : { path, cwd: step.cwd });
      }
    }
    return out;
  }
  return touchedPaths(toolName, p).map((path) => ({ path, cwd: "" }));
}

// A planned path -> a host path inside the workspace, or why not.
export function hostPath(workspace, { path, cwd }) {
  let p = String(path).replace(/^["']|["']$/g, "");
  if (p.startsWith("~")) return { reason: "outside the workspace" };
  if (p === SANDBOX_ROOT || p.startsWith(`${SANDBOX_ROOT}/`)) p = p.slice(SANDBOX_ROOT.length).replace(/^\/+/, "");
  const full = isAbsolute(p) || /^[a-z]:[\\/]/i.test(p) ? resolve(p) : resolve(workspace, cwd ?? "", p);
  const rel = relative(resolve(workspace), full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return { reason: rel === "" ? "the whole workspace" : "outside the workspace" };
  return { full, rel };
}

function expand(full) {
  const name = basename(full);
  if (!GLOB.test(name)) return [full];
  const dir = dirname(full);
  if (GLOB.test(dir)) return [];
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const re = globRegex(name);
  return names.filter((n) => re.test(n)).map((n) => join(dir, n));
}

export function createUndoJournal({ root = DEFAULT_UNDO_DIR, workspaceFor, maxRunMb = 200, keepRuns = 20,
  log = () => {}, now = Date.now } = {}) {
  const runs = new Map();   // runKey -> { id, dir, journal, seen, bytes }
  const safeLog = (e) => { try { log(e); } catch { /* best-effort */ } };
  const budget = maxRunMb * 1024 * 1024;

  const save = (run) => {
    mkdirSync(run.dir, { recursive: true });
    writeFileSync(join(run.dir, "journal.json"), JSON.stringify(run.journal, null, 1));
  };

  function prune() {
    let dirs = [];
    try {
      dirs = readdirSync(root).filter((d) => !d.startsWith(".")).map((d) => ({ d, t: statSync(join(root, d)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
    } catch { return; }
    for (const { d } of dirs.slice(keepRuns)) {
      try { rmSync(join(root, d), { recursive: true, force: true }); } catch { /* next time */ }
    }
  }

  return {
    root,
    noteRunStart(runKey, ctx, prompt) {
      const workspace = workspaceFor?.(ctx?.agentId) ?? null;
      if (!workspace) return;
      const started = now();
      const id = `${new Date(started).toISOString().replace(/[:.]/g, "-")}-${String(runKey).replace(/[^\w-]/g, "").slice(0, 12)}`;
      runs.set(runKey, { id, dir: join(root, id), seen: new Set(), bytes: 0,
        journal: { id, runKey, sessionKey: ctx?.sessionKey ?? null, agentId: ctx?.agentId ?? null, workspace,
          startedAt: new Date(started).toISOString(), prompt: typeof prompt === "string" ? prompt.slice(0, 160) : null,
          entries: [], skipped: [] } });
      while (runs.size > 200) runs.delete(runs.keys().next().value);
    },

    // before_tool_call, for a call the gate lets through.
    beforeCall(runKey, toolName, params) {
      const run = runs.get(runKey);
      if (!run) return;
      let changed = false;
      for (const planned of plannedPaths(toolName, params)) {
        if (planned.unresolved) {
          run.journal.skipped.push({ tool: toolName, why: planned.unresolved });
          changed = true;
          continue;
        }
        const target = hostPath(run.journal.workspace, planned);
        if (!target.full) {
          run.journal.skipped.push({ tool: toolName, why: target.reason });
          changed = true;
          continue;
        }
        for (const full of expand(target.full)) {
          const rel = relative(resolve(run.journal.workspace), full);
          if (run.seen.has(rel)) continue;
          run.seen.add(rel);
          changed = true;
          const existed = existsSync(full);
          const entry = { rel, existed, tool: toolName, at: new Date(now()).toISOString() };
          if (existed) {
            const size = sizeUpTo(full, budget - run.bytes);
            if (run.bytes + size > budget) {
              run.journal.skipped.push({ tool: toolName, rel, why: `over the ${Math.round(budget / 1048576)} MB undo budget` });
              continue;
            }
            const backup = `files/${run.journal.entries.length}`;
            try {
              mkdirSync(join(run.dir, "files"), { recursive: true });
              cpSync(full, join(run.dir, backup), { recursive: true, verbatimSymlinks: true });
              run.bytes += size;
              Object.assign(entry, { backup, dir: lstatSync(full).isDirectory() });
            } catch (err) {
              run.journal.skipped.push({ tool: toolName, rel, why: `couldn't copy it (${err?.code ?? "error"})` });
              continue;
            }
          }
          run.journal.entries.push(entry);
        }
      }
      if (!changed) return;
      try { save(run); } catch (err) { safeLog({ type: "undo_failed", runKey, error: err?.code ?? "error" }); }
    },

    endRun(runKey) {
      const run = runs.get(runKey);
      runs.delete(runKey);
      if (!run || !existsSync(run.dir)) return;
      run.journal.endedAt = new Date(now()).toISOString();
      try { save(run); } catch { /* the entries are already on disk */ }
      safeLog({ type: "undo_saved", runKey, entries: run.journal.entries.length, skipped: run.journal.skipped.length });
      prune();
    },
  };
}

// --- the undo itself (scripts/undo.mjs) ---

export function listRuns(root = DEFAULT_UNDO_DIR) {
  let dirs = [];
  try { dirs = readdirSync(root).filter((d) => !d.startsWith(".")); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    try { out.push({ ...JSON.parse(readFileSync(join(root, d, "journal.json"), "utf8")), dir: join(root, d) }); } catch { /* not a journal */ }
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

// When a run last changed anything (its newest entry), for picking which run to undo first.
export function lastChange(run) {
  return run.entries.reduce((m, e) => (String(e.at ?? "") > m ? String(e.at) : m), String(run.startedAt ?? ""));
}

// Paths another run changed AFTER this run did: undoing this one would overwrite that run's work.
// Ordered by when each path was touched, not by when the runs started: an interactive run that
// starts first can touch a file after an overlapping cron job already deleted it (found live,
// 2026-10-05: ordering by start time undid the two in the wrong order and lost the file).
export function laterConflicts(run, all) {
  const mine = new Map(run.entries.map((e) => [e.rel, String(e.at ?? run.startedAt)]));
  return all.filter((r) => r.id !== run.id && r.workspace === run.workspace && !r.undoneAt)
    .flatMap((r) => r.entries.filter((e) => mine.has(e.rel) && String(e.at ?? r.startedAt) > mine.get(e.rel))
      .map((e) => ({ run: r.id, rel: e.rel })));
}

// Puts a run's files back. What's there now goes to <root>/.trash/<stamp>/ first, so the undo can be undone.
export function undoRun(run, { now = Date.now } = {}) {
  const trash = join(dirname(run.dir), ".trash", new Date(now()).toISOString().replace(/[:.]/g, "-"));
  const done = { restored: [], removed: [], failed: [] };
  for (const e of [...run.entries].reverse()) {
    const full = join(run.workspace, e.rel);
    try {
      const there = existsSync(full);
      if (there) {
        const aside = join(trash, e.rel);
        mkdirSync(dirname(aside), { recursive: true });
        cpSync(full, aside, { recursive: true, verbatimSymlinks: true });
        rmSync(full, { recursive: true, force: true });
      }
      if (e.existed && e.backup) {
        mkdirSync(dirname(full), { recursive: true });
        cpSync(join(run.dir, e.backup), full, { recursive: true, verbatimSymlinks: true });
        done.restored.push(e.rel);
      } else if (!e.existed && there) {
        done.removed.push(e.rel);
      }
    } catch (err) {
      done.failed.push({ rel: e.rel, error: err?.code ?? String(err?.message ?? err) });
    }
  }
  const journal = JSON.parse(readFileSync(join(run.dir, "journal.json"), "utf8"));
  journal.undoneAt = new Date(now()).toISOString();
  journal.trash = trash;
  writeFileSync(join(run.dir, "journal.json"), JSON.stringify(journal, null, 1));
  return { ...done, trash };
}
