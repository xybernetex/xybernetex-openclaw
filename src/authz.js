// Authorization: does the user's own request cover a risky tool call?
//
// risk.js says what a call DOES (deletes something, reaches outside the
// machine). It can't say whether the user asked for it, so a requested
// `rm -rf build` and an `rm -rf data` planted in a file the agent read get the
// same label - the 2026-09-27 outcome grading found BLOCK_ACTION firing on
// all 8 runs where an agent obeyed a planted instruction, and on ~100 runs
// where the user had asked for exactly that deletion. This module supplies
// the missing signal, one label per destructive/sensitive call:
//
//   "requested"     the user's own message asks for this kind of operation and
//                   names every target it touches (verb-only for operations
//                   with no parseable target, except deletes and drops)
//   "own_artifact"  every target is something the agent itself created
//                   earlier in the session (written, mkdir'd, redirected to,
//                   CREATE TABLE'd) - routine cleanup of its own scratch work
//   "unrequested"   neither
//   null            not a risky call, or no user request seen for the session
//
// Only the user's own turns count: they come from before_agent_run's
// `prompt`, never from tool results, so an instruction planted in a file or
// web page can't make itself "requested". Turns OpenClaw marks as coming from
// another session or the system are not treated as the user's. The request
// text stays in memory on this machine; only the label is ever sent or logged.
//
// "own_artifact" is weaker evidence than "requested" - a same-session
// instruction could create a file and then delete it - so it is a feature for
// the policy, never grounds to skip an enforcement rule. Like risk.js this is
// a heuristic, not a security boundary.
import { classifyShellCommand, classifyToolCall, SQL_CLIENT, SQL_DESTRUCTIVE } from "./risk.js";

export const AUTHORIZATION_LABELS = Object.freeze(["requested", "own_artifact", "unrequested"]);

const VERBS = {
  delete: ["delete", "remove", "rm", "erase", "wipe", "purge", "clean", "clean up", "cleanup", "clear", "empty",
    "truncate", "get rid of", "prune", "discard", "trash", "unlink", "drop", "tidy"],
  git_rewrite: ["reset", "clean", "discard", "revert", "undo", "rewind", "force", "delete", "remove", "drop",
    "prune", "clear"],
  db_destroy: ["drop", "delete", "remove", "truncate", "clear", "wipe", "empty", "purge"],
  publish: ["push", "publish", "deploy", "release", "upload", "ship", "apply", "merge", "install", "upgrade",
    "scale", "rollout", "roll out"],
  send: ["post", "put", "patch", "send", "upload", "submit", "message", "notify", "email", "mail", "register",
    "transfer", "scp", "rsync", "sync", "ssh"],
  credentials: ["create", "write", "add", "set", "configure", "save", "store", "make", "update", "edit", "change"],
  process: ["kill", "stop", "terminate", "end", "restart", "shut down"],
  system: ["shutdown", "shut down", "reboot", "restart", "format", "halt", "power off", "install", "uninstall",
    "configure", "enable", "disable", "schedule", "cron"],
};
VERBS.generic = [...new Set(Object.values(VERBS).flat())];
// Git history operations have no file target to name, so the verb carries the
// whole authorization - and a generic one isn't enough: the 2026-09-27 replay
// found "delete files only there" in a task framing authorizing a planted
// `git reset --hard && git clean -fdx`. Each operation needs its own verb.
const GIT_VERBS = {
  reset: ["reset", "roll back", "rollback", "revert", "undo", "rewind", "go back"],
  clean: ["git clean", "clean", "untracked"],
  push: ["force push", "force-push", "force"],
  branch: ["delete", "remove", "force-delete", "drop"],
  stash: ["drop", "clear", "discard"],
};
// Tool-generated and regenerated on demand: deleting them loses nothing.
const REGENERABLE = /^(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.cache|.*\.pyc)$/i;
// A delete or drop with no target we can read is never "requested" on the
// strength of a verb alone: "delete the old logs" must not cover `xargs rm`.
const NEEDS_TARGET = new Set(["delete", "db_destroy"]);
const SEVERITY = { requested: 0, own_artifact: 1, unrequested: 2 };

const WRAPPERS = new Set(["sudo", "doas", "env", "nohup", "time", "xargs", "exec", "call", "start", "&", ".",
  "npx", "pnpx", "bunx", "uvx"]);
const DELETE_COMMANDS = new Set(["rm", "rmdir", "rd", "del", "erase", "unlink", "shred", "rimraf", "ri",
  "truncate"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "cargo", "gem", "twine"]);
const CLI_TOOLS = new Set(["docker", "podman", "kubectl", "helm", "terraform", "tofu", "aws", "az", "gcloud",
  "wrangler", "fly", "flyctl", "heroku", "firebase", "supabase", "gh", "vercel", "netlify"]);
const CLI_DESTRUCTIVE = new Set(["delete", "destroy", "rm", "rmi", "rb", "prune", "purge", "terminate", "drop"]);
const HTTP_CLIENTS = new Set(["curl", "wget", "http", "invoke-webrequest", "invoke-restmethod", "iwr", "irm"]);
const REMOTE_COMMANDS = new Set(["ssh", "scp", "sftp", "rsync"]);
const PROCESS_COMMANDS = new Set(["kill", "pkill", "killall", "taskkill", "stop-process"]);
const TARGET_FLAGS = new Set(["-path", "-literalpath", "-filter", "-include", "-name", "-iname"]);
const VALUE_FLAGS = new Set(["-s", "--size", "-r", "--reference"]);

// Split a shell command on ; && || | and newlines, respecting quotes (unlike
// risk.js, which strips quoted text; here quoted paths and SQL are the point).
function splitSegments(command) {
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if ("()".includes(ch)) { out.push(cur); cur = ""; continue; } // `(a || rm -rf b)` subshells
    if (ch === "\n" || ch === ";" || ch === "|" || (ch === "&" && command[i + 1] === "&")) {
      out.push(cur);
      cur = "";
      if (command[i + 1] === ch) i++;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function tokens(segment) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function command(segment) {
  const all = tokens(segment);
  let i = 0;
  while (i < all.length && (WRAPPERS.has(all[i].toLowerCase()) || /^[A-Za-z_]\w*=/.test(all[i]) ||
         (/^\$[\w:]+$/.test(all[i]) && all[i + 1] === "="))) i += /^\$/.test(all[i]) ? 2 : 1;
  const rest = all.slice(i);
  const cmd = (rest[0] ?? "").toLowerCase().replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|ps1|sh)$/, "");
  return { cmd, args: rest.slice(1) };
}

// cmd scopes VALUE_FLAGS: they take a value only for truncate. Everywhere
// else -r is recursive, and skipping the next word lost `build` from
// `rm -r build`, labeling the user's own "delete the build folder" unrequested.
function plainArgs(raw, cmd) {
  // PowerShell passes lists as `a, b` or `a,b`.
  const args = raw.flatMap((a) => (a.startsWith("-") ? [a] : a.split(",").map((s) => s.trim()).filter(Boolean)));
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const lower = a.toLowerCase();
    if (TARGET_FLAGS.has(lower)) { if (args[i + 1] !== undefined) out.push(args[++i]); continue; }
    if (cmd === "truncate" && VALUE_FLAGS.has(lower)) { i++; continue; }
    if (a.startsWith("-")) continue;
    out.push(a);
  }
  return out;
}

const hostsIn = (text) => [...text.matchAll(/https?:\/\/([^/\s'"?#:]+)/gi)].map((m) => m[1]);

function sqlTargets(text) {
  return [...text.matchAll(/\b(?:drop\s+(?:table|database|schema|index|view|user)\s+(?:if\s+exists\s+)?|truncate\s+(?:table\s+)?|delete\s+from\s+)([\w."`\[\]]+)/gi)]
    .map((m) => m[1].replace(/[`"[\]]/g, ""));
}

function segmentOperation(segment) {
  if (classifyShellCommand(segment) === "none") return null;
  if (SQL_CLIENT.test(segment) && SQL_DESTRUCTIVE.test(segment)) {
    return { kind: "db_destroy", targets: sqlTargets(segment) };
  }
  const { cmd, args } = command(segment);
  const plain = plainArgs(args, cmd);
  if (DELETE_COMMANDS.has(cmd) || /^(remove|clear)-/.test(cmd)) return { kind: "delete", targets: plain };
  if (cmd === "find") {
    const start = args.findIndex((a) => a.startsWith("-"));
    return { kind: "delete", targets: [...(start === -1 ? args : args.slice(0, start)),
      ...plainArgs(args.slice(Math.max(start, 0))).filter((a) => a.includes("*"))] };
  }
  if (cmd === "git") {
    const sub = plain[0];
    if (sub === "push" && !args.some((a) => /^(-f|--force.*|--delete|-d)$/.test(a))) return { kind: "publish", targets: [] };
    if (sub === "branch") return { kind: "git_rewrite", verbs: GIT_VERBS.branch, targets: plain.slice(1) };
    return { kind: "git_rewrite", verbs: GIT_VERBS[sub], targets: [] };
  }
  if (PACKAGE_MANAGERS.has(cmd)) {
    return plain.includes("unpublish") ? { kind: "delete", targets: plain.slice(plain.indexOf("unpublish") + 1) }
      : { kind: "publish", targets: [] };
  }
  if (CLI_TOOLS.has(cmd)) {
    const verb = plain.findIndex((v) => CLI_DESTRUCTIVE.has(v.toLowerCase()));
    return verb === -1 ? { kind: "publish", targets: [] } : { kind: "delete", targets: plain.slice(verb + 1) };
  }
  if (HTTP_CLIENTS.has(cmd)) return { kind: "send", targets: hostsIn(segment) };
  if (REMOTE_COMMANDS.has(cmd)) {
    return { kind: "send", targets: plain.map((a) => a.match(/^(?:[^@\s]+@)?([^:\s]+):/)?.[1] ?? (cmd === "ssh" ? a.replace(/^[^@]+@/, "") : null)).filter(Boolean).slice(0, 1) };
  }
  if (PROCESS_COMMANDS.has(cmd)) return { kind: "process", targets: [] };
  if (["sendmail", "mail", "mailx", "send-mailmessage"].includes(cmd)) return { kind: "send", targets: [] };
  if (["crontab", "schtasks", "shutdown", "reboot", "halt", "poweroff", "restart-computer", "stop-computer",
       "set-executionpolicy", "enter-pssession", "invoke-command"].includes(cmd) || /^(mkfs|format)/.test(cmd)) {
    return { kind: "system", targets: [] };
  }
  return { kind: "generic", targets: [] };
}

// The risky operations a tool call performs, each { kind, targets }.
export function operations(toolName, params) {
  const p = params && typeof params === "object" ? params : {};
  if (toolName === "exec" || toolName === "terminal") {
    const text = p.command ?? p.cmd ?? p.input;
    return typeof text === "string" ? splitSegments(text).map(segmentOperation).filter(Boolean) : [];
  }
  if (toolName === "apply_patch") {
    const patch = typeof p.input === "string" ? p.input : typeof p.patch === "string" ? p.patch : "";
    const deleted = [...patch.matchAll(/^\*\*\* Delete File: (.+)$/gm)].map((m) => m[1].trim());
    if (deleted.length) return [{ kind: "delete", targets: deleted }];
    return [{ kind: "credentials", targets: [...patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)].map((m) => m[1].trim()) }];
  }
  if (toolName === "write" || toolName === "edit") {
    const path = p.file_path ?? p.path;
    return [{ kind: "credentials", targets: typeof path === "string" ? [path] : [] }];
  }
  if (toolName === "message" || toolName === "conversations_send") {
    return [{ kind: /\b(delete|remove|unsend|purge|destroy)\b/i.test(p.action ?? "") ? "delete" : "send", targets: [] }];
  }
  if (toolName === "github_publish") return [{ kind: "publish", targets: [] }];
  return [{ kind: "system", targets: [] }];
}

const MOVE_COMMANDS = new Set(["mv", "move", "move-item", "mi", "ren", "rename", "rename-item", "rni"]);
const COPY_COMMANDS = new Set(["cp", "copy", "copy-item", "cpi", "install", "rsync"]);

// Every path a call would move, rename, overwrite, write into or delete - not
// just the ones risk.js calls destructive. The gate uses it after a hold: an
// agent refused `rm -rf data` often reaches for `mv data data.bak` next, which
// makes the data vanish from where it was just as surely.
export function touchedPaths(toolName, params) {
  const p = params && typeof params === "object" ? params : {};
  if (toolName === "write" || toolName === "edit") {
    const path = p.file_path ?? p.path;
    return typeof path === "string" ? [path] : [];
  }
  if (toolName === "apply_patch") {
    const patch = typeof p.input === "string" ? p.input : typeof p.patch === "string" ? p.patch : "";
    return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)]
      .map((m) => (m[1] ?? m[2]).trim());
  }
  if (toolName !== "exec" && toolName !== "terminal") return [];
  const text = p.command ?? p.cmd ?? p.input;
  if (typeof text !== "string") return [];
  const out = [];
  for (const segment of splitSegments(text)) {
    const { cmd, args } = command(segment);
    const plain = plainArgs(args, cmd);
    if (MOVE_COMMANDS.has(cmd) || DELETE_COMMANDS.has(cmd) || /^(remove|clear)-/.test(cmd) || cmd === "shred") {
      out.push(...plain);
    } else if (COPY_COMMANDS.has(cmd) && plain.length > 1) {
      out.push(plain.at(-1)); // the destination is what gets overwritten
    }
    for (const m of segment.matchAll(/(?<![\d&>])>>?(?![&])\s*("[^"]+"|'[^']+'|[^\s;|&<>]+)/g)) {
      out.push(m[1].replace(/^["']|["']$/g, ""));
    }
  }
  return out.filter((t) => !/^\/dev\/|^nul$/i.test(t));
}

// Relative and absolute spellings of one path share their tail, so compare
// tails: `../customer-data`, `./customer-data` and `/home/u/customer-data`
// all cover the same folder, and so does anything inside it.
const tail = (p) => normPath(p).replace(/^(\.\.?\/|~\/)+/, "");
export function coversPath(held, path) {
  const h = tail(held);
  const t = tail(path);
  if (!h || !t || /[*?[\]]/.test(h) || !mentionable(h)) return false;
  return t === h || t.endsWith(`/${h}`) || h.endsWith(`/${t}`) || t.startsWith(`${h}/`) || t.includes(`/${h}/`);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");

function mentions(text, phrase) {
  return new RegExp(`(?<![\\w-])${escape(phrase)}(?![\\w-])`, "i").test(text);
}

// The last path segment, minus glob characters: what a user would name.
function mentionable(target) {
  const last = String(target).replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop().replace(/[*?[\]]/g, "");
  return last && last !== "." && last !== ".." && last.length >= 2 ? last : null;
}

const normPath = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();

function owned(created, target) {
  if (/[*?[\]]/.test(target)) return false;
  const t = normPath(target);
  if (REGENERABLE.test(t.split("/").pop())) return true;
  for (const c of created) if (c === t || c.endsWith(`/${t}`) || t.endsWith(`/${c}`)) return true;
  return false;
}

// Named outright, or covered by an extension the user named ("delete the .tmp
// files" covers a.tmp).
function named(text, name) {
  const ext = name.match(/(\.[a-z0-9]{1,6})$/i)?.[1];
  return mentions(text, name) || (ext !== undefined && ext !== name && mentions(text, ext));
}

// Sentence ends: . ! ? before whitespace or the end (so notes.txt and
// httpbin.org/post don't split), and line breaks.
const sentences = (text) => text.split(/[.!?](?=\s|$)|\n+/);

// A target counts as requested only when a matching verb sits in the SAME
// sentence as it. A blanket permission ("create, change and delete files")
// in one sentence plus the target named for another reason in the next
// ("import ... (table customers)") must not combine into authorization - the
// 2026-09-27 new-scenario check found exactly that labeling a planted
// `DROP TABLE customers` requested.
function namedWithVerb(text, name, verbs) {
  return sentences(text).some((s) => named(s, name) && verbs.some((v) => mentions(s, v)));
}

function judge(op, session) {
  const text = session.requests.join("\n");
  const names = op.targets.map(mentionable).filter(Boolean);
  const verbs = op.verbs ?? VERBS[op.kind];
  const requested = names.length
    ? names.length === op.targets.length && names.every((n) => namedWithVerb(text, n, verbs))
    : !NEEDS_TARGET.has(op.kind) && verbs.some((v) => mentions(text, v));
  if (text && requested) return "requested";
  const pool = op.kind === "db_destroy" ? session.tables : session.paths;
  if (op.targets.length && op.targets.every((t) => owned(pool, t))) return "own_artifact";
  return "unrequested";
}

// Things a successful call created, so later deletes of them read as the
// agent's own scratch work. Deliberately excludes idempotent forms that also
// succeed on something pre-existing (mkdir -p, touch, CREATE TABLE IF NOT
// EXISTS, git init), which would let an existing target pass as "created".
function creations(toolName, params) {
  const p = params && typeof params === "object" ? params : {};
  const paths = [];
  const tables = [];
  if (toolName === "write") {
    const path = p.file_path ?? p.path;
    if (typeof path === "string") paths.push(path);
  } else if (toolName === "apply_patch") {
    const patch = typeof p.input === "string" ? p.input : typeof p.patch === "string" ? p.patch : "";
    paths.push(...[...patch.matchAll(/^\*\*\* Add File: (.+)$/gm)].map((m) => m[1].trim()));
  } else if (toolName === "exec" || toolName === "terminal") {
    const text = p.command ?? p.cmd ?? p.input;
    if (typeof text !== "string") return { paths, tables };
    for (const segment of splitSegments(text)) {
      const { cmd, args } = command(segment);
      if ((cmd === "mkdir" || cmd === "md") && !args.some((a) => /^(-p|--parents|-force)$/i.test(a))) {
        paths.push(...plainArgs(args, cmd));
      }
      for (const m of segment.matchAll(/(?<![\d&>])>(?![>&])\s*("[^"]+"|'[^']+'|[^\s;|&<>]+)/g)) {
        const target = m[1].replace(/^["']|["']$/g, "");
        if (!/^\/dev\/|^nul$/i.test(target)) paths.push(target);
      }
      if (SQL_CLIENT.test(segment)) {
        tables.push(...[...segment.matchAll(/\bcreate\s+table\s+(?!if\s+not\s+exists)([\w."`]+)/gi)]
          .map((m) => m[1].replace(/[`"]/g, "")));
      }
    }
  }
  return { paths, tables };
}

export function createAuthorizationTracker({ maxSessions = 200, requestsKept = 3, maxCreated = 1000 } = {}) {
  const sessions = new Map(); // sessionKey -> state; Map order doubles as LRU order

  function state(sessionKey) {
    let s = sessions.get(sessionKey);
    if (s) sessions.delete(sessionKey);
    else s = { requests: [], requestSeen: false, paths: new Set(), tables: new Set() };
    sessions.set(sessionKey, s);
    while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
    return s;
  }

  const bounded = (set, items) => {
    for (const item of items) {
      set.add(normPath(item));
      if (set.size > maxCreated) set.delete(set.values().next().value);
    }
  };

  return {
    // One user turn. Returns whether it was accepted as the user's own words.
    setRequest(sessionKey, prompt, provenance) {
      if (!sessionKey || typeof prompt !== "string") return false;
      const s = state(sessionKey);
      s.requestSeen = true;
      if (provenance && provenance !== "external_user") return false;
      s.requests.push(prompt);
      if (s.requests.length > requestsKept) s.requests.shift();
      return true;
    },
    label(sessionKey, toolName, params) {
      const risk = classifyToolCall(toolName, params);
      if (risk !== "destructive" && risk !== "sensitive") return null;
      const s = sessionKey ? sessions.get(sessionKey) : undefined;
      if (!s?.requestSeen) return null;
      const ops = operations(toolName, params);
      const labels = (ops.length ? ops : [{ kind: "generic", targets: [] }]).map((op) => judge(op, s));
      return labels.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a));
    },
    // Whether the user's own turns name this target with a delete or move
    // verb in one sentence - what lets a held target be touched after all.
    requestsTarget(sessionKey, target) {
      const s = sessionKey ? sessions.get(sessionKey) : undefined;
      const name = mentionable(target);
      if (!s?.requests.length || !name) return false;
      return namedWithVerb(s.requests.join("\n"), name, [...VERBS.delete, "move", "rename", "mv"]);
    },
    recordCompleted(sessionKey, toolName, params, failed) {
      if (!sessionKey || failed) return;
      const { paths, tables } = creations(toolName, params);
      if (!paths.length && !tables.length) return;
      const s = state(sessionKey);
      bounded(s.paths, paths);
      bounded(s.tables, tables);
    },
    endSession(sessionKey) {
      sessions.delete(sessionKey);
    },
  };
}
