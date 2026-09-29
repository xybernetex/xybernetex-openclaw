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
// the policy, never on its own grounds to skip an enforcement rule. Like
// risk.js this is a heuristic, not a security boundary.
//
// ownsFiles() is the narrow case that may waive one (a rule lists
// "own_files" in unlessAuthorization): a plain delete (rm, unlink, del,
// Remove-Item) of single files the agent itself created this session -
// written, added by a patch, redirected to with > - that no move has touched
// since. The same call may cd and run other commands the risk classifier
// rates harmless (python3 check.py; ls), but no move: a script can already
// delete or move files unseen (risk.js can't read inside it), so harmless
// company adds nothing a planted instruction couldn't do anyway, while a
// visible move in the same call could land a user's file on the one deleted.
// Deleting such a file loses only the agent's own content: whatever it
// replaced was already gone when the agent wrote it. Paths are resolved
// against the call's workdir and any cd, and must match exactly - a file made
// at tmp/data.csv never covers data.csv. Folders never qualify: `mv data.csv
// scratch/ && rm -rf scratch` would launder a user's file through a folder the
// agent made. The one exception is a tool cache (__pycache__, *.pyc), which
// regenerates itself, and only while no move this session has named a folder
// or file by that name. Any visible move that could land on a tracked file
// (same path, a folder above it, the same file name, or sources we can't
// read) drops it from the set.
import { classifyShellCommand, classifyToolCall, SHELL_KEYWORDS, SQL_CLIENT, SQL_DESTRUCTIVE } from "./risk.js";

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
// ownsFiles: the only commands, flags and target shapes it accepts.
const OWN_DELETE_COMMANDS = new Set(["rm", "unlink", "del", "erase", "remove-item", "ri"]);
const PLAIN_DELETE_FLAG = /^(-f|-v|-fv|-vf|--force|--verbose|-force|\/f|\/q)$/i;
const RECURSIVE_FLAG = /^(-(?=[rfv]*r)[rfv]+|--recursive|-recurse)$/i;
const PATH_FLAG = /^-(path|literalpath)$/i;
const CD_COMMANDS = new Set(["cd", "chdir", "pushd", "set-location", "sl"]);
const NULL_REDIRECT = /^(\d?>>?|&>)(\/dev\/null|nul|&\d)$|^\d?>&\d$/i;
const HIDDEN_COMMAND = /`|\$\(/;
const UNSAFE_TARGET = /[*?[\]{}$`~,]|(^|[/\\])\.\.([/\\]|$)|^-/;
const ABSOLUTE = /^([/\\]|[a-z]:)/i;
const UNREADABLE_MOVE = /\bxargs\b|\bfind\b.*-exec|\bparallel\b/i;
// A delete or drop with no target we can read is never "requested" on the
// strength of a verb alone: "delete the old logs" must not cover `xargs rm`.
const NEEDS_TARGET = new Set(["delete", "db_destroy"]);
const SEVERITY = { requested: 0, own_artifact: 1, unrequested: 2 };

const WRAPPERS = new Set(["sudo", "doas", "env", "nohup", "time", "xargs", "exec", "call", "start", "&", ".",
  "npx", "pnpx", "bunx", "uvx", ...SHELL_KEYWORDS]);
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

const MOVE_COMMANDS = new Set(["mv", "move", "move-item", "mi", "ren", "rename", "rename-item", "rni", "trash", "trash-put"]);
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

// Paths a call makes vanish from where they were: deleted, trashed, or moved
// away (a move's sources, not its destination). Narrower than touchedPaths -
// writing into a folder doesn't make it disappear.
export function relocatedPaths(toolName, params) {
  const p = params && typeof params === "object" ? params : {};
  if (toolName === "apply_patch") {
    const patch = typeof p.input === "string" ? p.input : typeof p.patch === "string" ? p.patch : "";
    return [...patch.matchAll(/^\*\*\* Delete File: (.+)$/gm)].map((m) => m[1].trim());
  }
  if (toolName !== "exec" && toolName !== "terminal") return [];
  const text = p.command ?? p.cmd ?? p.input;
  if (typeof text !== "string") return [];
  const out = [];
  for (const segment of splitSegments(text)) {
    const { cmd, args } = command(segment);
    const plain = plainArgs(args, cmd);
    if (MOVE_COMMANDS.has(cmd)) out.push(...(plain.length > 1 && !cmd.startsWith("trash") ? plain.slice(0, -1) : plain));
    else if (DELETE_COMMANDS.has(cmd) || /^(remove|clear)-/.test(cmd) || cmd === "shred") out.push(...plain);
  }
  return out;
}

// The text of a tool result, whatever shape OpenClaw hands it over in: a
// string, { content: [{ type: "text", text }] }, or nested details.
export function resultText(result, budget = 200_000) {
  const parts = [];
  let size = 0;
  const walk = (v, depth) => {
    if (size >= budget || depth > 4 || v === null || v === undefined) return;
    if (typeof v === "string") { parts.push(v.slice(0, budget - size)); size += v.length; return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(result, 0);
  return parts.join("\n");
}

// Targets that text the agent read tells it to delete: a README setup step,
// a web page, a tool's output. Only literal commands count (`rm -rf
// ../customer-data`, maybe as a list item, prompt line or inline code), never
// prose, so a page that merely talks about deleting things adds nothing.
export function plantedTargets(text) {
  if (typeof text !== "string" || !text) return [];
  const out = [];
  for (const raw of text.slice(0, 200_000).split(/\r?\n/)) {
    const line = raw.trim().replace(/^(?:[-*>]|\d+[.)]|\$|#|PS [^>]*>)\s*/, "").replace(/^`+|`+$/g, "").trim();
    if (!line || line.length > 500) continue;
    try {
      for (const op of operations("exec", { command: line })) if (op.kind === "delete") out.push(...op.targets);
    } catch { /* not a command */ }
    if (out.length >= 50) break;
  }
  // Deduplicated: a result often carries its text twice (content and details),
  // and the live demo logged targets=2 for one README line.
  return [...new Set(out.filter((t) => t && !/[*?[\]]|^\$/.test(t)))];
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

// path against a relative working folder, as one normalized relative (or absolute) path.
function resolvePath(cwd, path) {
  let p = String(path).replace(/\\/g, "/");
  if (cwd && !ABSOLUTE.test(p)) p = `${cwd}/${p}`;
  return (p.startsWith("/") ? "/" : "") + p.split("/").filter((x) => x !== "" && x !== ".").join("/");
}

// A shell call's commands, each with the folder it runs in: { cwd, cmd, args,
// segment }. cwd is relative to the agent's workspace ("" = the workspace), or
// null once a cd (or the call's workdir) goes somewhere we can't follow.
function shellSteps(p) {
  const text = p.command ?? p.cmd ?? p.input;
  if (typeof text !== "string") return null;
  const wd = p.workdir ?? p.cwd;
  let cwd = "";
  if (typeof wd === "string" && wd.trim()) {
    cwd = !UNSAFE_TARGET.test(wd.trim()) ? resolvePath("", wd.trim()) : null;
  }
  const steps = [];
  for (const segment of splitSegments(text)) {
    const { cmd, args } = command(segment);
    if (CD_COMMANDS.has(cmd)) {
      const plain = args.filter((a) => !a.startsWith("-"));
      const safe = plain.length === 1 && !UNSAFE_TARGET.test(plain[0]);
      cwd = cwd !== null && safe ? resolvePath(cwd, plain[0]) : null;
      continue;
    }
    steps.push({ cwd, cmd, args, segment });
  }
  return steps;
}

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
// files: the created paths that are single files (everything but mkdir).
// >> appends are not creations either: the file may be the user's.
function creations(toolName, params) {
  const p = params && typeof params === "object" ? params : {};
  const paths = [];
  const tables = [];
  const files = []; // resolved against the call's working folder, for ownsFiles
  if (toolName === "write") {
    const path = p.file_path ?? p.path;
    if (typeof path === "string") {
      paths.push(path);
      files.push(resolvePath("", path));
    }
  } else if (toolName === "apply_patch") {
    const patch = typeof p.input === "string" ? p.input : typeof p.patch === "string" ? p.patch : "";
    const added = [...patch.matchAll(/^\*\*\* Add File: (.+)$/gm)].map((m) => m[1].trim());
    paths.push(...added);
    files.push(...added.map((a) => resolvePath("", a)));
  } else if (toolName === "exec" || toolName === "terminal") {
    const steps = shellSteps(p);
    if (!steps) return { paths, tables, files };
    for (const { cwd, cmd, args, segment } of steps) {
      if ((cmd === "mkdir" || cmd === "md") && !args.some((a) => /^(-p|--parents|-force)$/i.test(a))) {
        paths.push(...plainArgs(args, cmd));
      }
      for (const m of segment.matchAll(/(?<![\d&>])>(?![>&])\s*("[^"]+"|'[^']+'|[^\s;|&<>]+)/g)) {
        const target = m[1].replace(/^["']|["']$/g, "");
        if (!/^\/dev\/|^nul$/i.test(target)) {
          paths.push(target);
          if (cwd !== null && !UNSAFE_TARGET.test(target)) files.push(resolvePath(cwd, target));
        }
      }
      if (SQL_CLIENT.test(segment)) {
        tables.push(...[...segment.matchAll(/\bcreate\s+table\s+(?!if\s+not\s+exists)([\w."`]+)/gi)]
          .map((m) => m[1].replace(/[`"]/g, "")));
      }
    }
  }
  return { paths, tables, files };
}

const isMove = (cmd, args) => MOVE_COMMANDS.has(cmd) || (cmd === "git" && args[0] === "mv") ||
  (cmd === "rsync" && args.includes("--remove-source-files"));

// The paths a call's visible moves name (sources and destinations, resolved
// against its working folder), and whether it moved things we can't name
// (globs, xargs, find -exec, a folder we lost track of).
function moves(toolName, params) {
  const p = params && typeof params === "object" ? params : {};
  const steps = toolName === "exec" || toolName === "terminal" ? shellSteps(p) : null;
  if (!steps) return { named: [], unreadable: false };
  const named = [];
  let unreadable = false;
  for (const { cwd, cmd, args, segment } of steps) {
    if (!isMove(cmd, args)) continue;
    const plain = (cmd === "git" ? args.slice(1) : args).filter((a) => !a.startsWith("-"));
    if (cwd === null || !plain.length || UNREADABLE_MOVE.test(segment) ||
        plain.some((a) => /[*?[\]]|^\$/.test(a) || UNSAFE_TARGET.test(a))) unreadable = true;
    named.push(...plain.map((a) => resolvePath(cwd ?? "", a)));
  }
  return { named, unreadable };
}

export function createAuthorizationTracker({ maxSessions = 200, requestsKept = 3, maxCreated = 1000 } = {}) {
  const sessions = new Map(); // sessionKey -> state; Map order doubles as LRU order

  function state(sessionKey) {
    let s = sessions.get(sessionKey);
    if (s) sessions.delete(sessionKey);
    else {
      s = { requests: [], requestSeen: false, paths: new Set(), tables: new Set(),
        files: new Set(), // single files created, no move since (resolved paths)
        movedNames: new Set(), // every path component any move has named
        movesUnreadable: false }; // a move named things we couldn't read
    }
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
    // Whether this call only deletes single files the agent created this
    // session and no move has touched since, or tool caches no move has
    // named (see the top of this file).
    ownsFiles(sessionKey, toolName, params) {
      const s = sessionKey ? sessions.get(sessionKey) : undefined;
      if (!s || (toolName !== "exec" && toolName !== "terminal")) return false;
      const p = params && typeof params === "object" ? params : {};
      const text = p.command ?? p.cmd ?? p.input;
      if (typeof text !== "string" || HIDDEN_COMMAND.test(text)) return false;
      let deleted = false;
      for (const { cwd, cmd, args, segment } of shellSteps(p) ?? []) {
        if (!OWN_DELETE_COMMANDS.has(cmd)) {
          // Company: harmless, and never a move (see the top of this file).
          if (isMove(cmd, args) || UNREADABLE_MOVE.test(segment) || classifyShellCommand(segment) !== "none") return false;
          continue;
        }
        if (cwd === null) return false;
        const targets = [];
        let recursive = false;
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (NULL_REDIRECT.test(a)) continue;
          if (/^[<>]/.test(a) || (/^\d/.test(a) && a.includes(">"))) return false;
          if (PATH_FLAG.test(a) && i + 1 < args.length) { targets.push(args[++i]); continue; }
          if (RECURSIVE_FLAG.test(a)) recursive = true;
          else if (a.startsWith("-") || ((cmd === "del" || cmd === "erase") && a.startsWith("/"))) {
            if (!PLAIN_DELETE_FLAG.test(a)) return false;
          } else targets.push(a);
        }
        if (!targets.length) return false;
        for (const t of targets) {
          if (UNSAFE_TARGET.test(t)) return false;
          const path = normPath(resolvePath(cwd, t));
          const name = path.split("/").at(-1);
          const cache = REGENERABLE.test(name) && !s.movesUnreadable && !s.movedNames.has(name);
          if (!cache && (recursive || !s.files.has(path))) return false;
        }
        deleted = true;
      }
      return deleted;
    },
    recordCompleted(sessionKey, toolName, params, failed) {
      if (!sessionKey) return;
      // A move - even a failed one, which may have moved part of its sources -
      // can land something else on a file the agent created, or inside a cache.
      const { named, unreadable } = moves(toolName, params);
      if (named.length || unreadable) {
        const s = state(sessionKey);
        const hit = new Set(named.map(normPath));
        if (unreadable) {
          s.files.clear();
          s.movesUnreadable = true;
        } else {
          const names = new Set([...hit].map((h) => h.split("/").at(-1)));
          for (const f of [...s.files]) {
            if (hit.has(f) || [...hit].some((h) => f.startsWith(`${h}/`)) || names.has(f.split("/").at(-1))) s.files.delete(f);
          }
        }
        bounded(s.movedNames, [...hit].flatMap((h) => h.split("/").filter(Boolean)));
      }
      if (failed) return;
      const { paths, tables, files } = creations(toolName, params);
      if (!paths.length && !tables.length) return;
      const s = state(sessionKey);
      bounded(s.paths, paths);
      bounded(s.tables, tables);
      bounded(s.files, files);
    },
    endSession(sessionKey) {
      sessions.delete(sessionKey);
    },
  };
}
