// Classifies a tool call's risk on the user's machine, from what it actually
// does: "destructive", "sensitive", "none", or null when this module doesn't
// know the tool (the policy server then judges it by name alone).
//
// Why here: the policy used to judge risk from tool names only, and OpenClaw
// runs every shell command through one tool, `exec` - so running a test
// suite and `Remove-Item -Recurse` looked identical, and every exec call was
// judged destructive. The command text says which is which, but tool params
// never leave the machine (see hashParams in supervisor.js), so the label is
// computed here and only the label is sent.
//
// Deliberately conservative and simple: a first-word command match per
// shell segment plus a few argument patterns. It will miss obfuscated
// commands; it's a feature for a supervisor that only observes, not a
// security boundary.

const SHELL_TOOLS = new Set(["exec", "terminal"]);

// Tools whose calls never have an external or irreversible effect of their own.
const NO_RISK_TOOLS = new Set([
  "read", "ls", "web_fetch", "web_search", "pdf", "view_image", "image_generate", "music_generate",
  "video_generate", "tts", "sessions_list", "sessions_history", "sessions_search", "session_status",
  "sessions_spawn", "sessions_yield", "sessions_send", "agents_list", "agents_wait", "subagents",
  "conversations_list", "conversations_turn", "create_goal", "get_goal", "update_goal", "progress_card",
  "show_widget", "structured_output", "suggest_task", "dismiss_task", "heartbeat_respond", "ask_user",
  "dashboard", "theme", "transcripts", "github_identity_status", "process", "skill_workshop",
]);

// Tools that act outside the machine (send, publish, reconfigure) unless the
// call is plainly a read.
const OUTWARD_TOOLS = new Set(["message", "conversations_send", "github_publish", "gateway", "cron", "plugins", "secrets"]);
const READ_ACTION = /^(get|list|read|search|status|history|fetch|show|describe|runs|schema|view|inspect)\b/i;
const DELETE_ACTION = /\b(delete|remove|unsend|purge|destroy)\b/i;

// Files whose contents are credentials or config: editing them is sensitive.
const SENSITIVE_PATH = /(^|[\\/])(\.ssh|\.aws|\.gnupg|\.kube|\.docker)([\\/]|$)|(^|[\\/])(\.env(\.[\w-]+)?|id_rsa|id_ed25519|credentials(\.json)?|openclaw\.json|\.npmrc|\.pypirc|\.netrc)$/i;

// First word of a shell segment -> destructive.
const DESTRUCTIVE_COMMANDS = new Set([
  "rm", "rmdir", "rd", "del", "erase", "unlink", "shred", "rimraf", "dd", "mkfs", "fdisk", "diskpart",
  "format", "wipefs", "truncate", "shutdown", "reboot", "halt", "poweroff", "ri", "restart-computer",
  "stop-computer", "clear-content", "clear-recyclebin", "format-volume", "clear-disk", "initialize-disk",
]);
// PowerShell Remove-*/Clear-* verbs are destructive except these session-only ones.
const HARMLESS_REMOVE_CLEAR = new Set([
  "clear-host", "clear-variable", "clear-history", "remove-variable", "remove-module", "remove-psdrive",
  "remove-job", "remove-event", "remove-typedata",
]);

// First word -> sensitive (effects outside the machine, or on other processes).
const SENSITIVE_COMMANDS = new Set([
  "ssh", "scp", "sftp", "rsync", "sendmail", "mail", "mailx", "send-mailmessage", "crontab", "schtasks",
  "set-executionpolicy", "vercel", "netlify", "enter-pssession", "invoke-command",
  "kill", "pkill", "killall", "taskkill", "stop-process",
]);

// Infra/packaging CLIs: judged by the verbs in their arguments.
const CLI_TOOLS = new Set([
  "git", "gh", "docker", "podman", "kubectl", "helm", "terraform", "tofu", "aws", "az", "gcloud", "wrangler",
  "fly", "flyctl", "heroku", "npm", "pnpm", "yarn", "bun", "cargo", "twine", "gem", "firebase", "supabase",
]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "cargo", "gem"]);
const DESTRUCTIVE_VERBS = new Set(["delete", "destroy", "rm", "rmi", "rb", "prune", "purge", "terminate", "unpublish", "drop"]);
const SENSITIVE_VERBS = new Set(["deploy", "publish", "push", "apply", "release", "upload", "merge", "send", "put", "install", "upgrade", "scale", "rollout", "create", "secret"]);

const HTTP_CLIENTS = new Set(["curl", "wget", "http", "invoke-webrequest", "invoke-restmethod", "iwr", "irm"]);
const HTTP_WRITE = /(^|\s)(-X|--request|-Method)\s*['"]?(POST|PUT|PATCH|DELETE)\b|(^|\s)(-d|--data(-\w+)?|--json|-F|--form|-Body|-InFile|-T|--upload-file|--post-(data|file))(\s|=|$)/i;

// SQL lives inside quoted arguments, so it's matched against the raw text -
// but only when a SQL client is invoked, or a commit message saying "drop
// table support" would read as destructive.
const SQL_CLIENT = /(^|[\s;&|(])(psql|pgcli|mysql|mariadb|sqlite3?|litecli|sqlcmd|invoke-sqlcmd|duckdb|clickhouse(-client)?|bq|snowsql|cockroach)(\.exe)?(\s|$)/i;
const SQL_DESTRUCTIVE = /\b(drop\s+(table|database|schema|index|view|user)|truncate\s+(table\s+)?\w|delete\s+from)\b/i;

// Prefixes that run the next word as the real command.
const WRAPPERS = new Set([
  "sudo", "doas", "env", "nohup", "time", "xargs", "exec", "call", "start", "start-process", "&", ".",
  "npx", "pnpx", "bunx", "uvx",
]);

function stripQuoted(command) {
  return command.replace(/"(?:[^"\\`]|[\\`].)*"|'[^']*'/g, '""');
}

function segments(command) {
  return stripQuoted(command).split(/\r?\n|;|&&|\|\||\||[{}()]/).map((s) => s.trim()).filter(Boolean);
}

function words(segment) {
  const all = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  // Skip `$x = ...` assignments, env-style VAR=value prefixes, and wrappers.
  while (i < all.length) {
    const w = all[i].toLowerCase();
    if (/^\$[\w:]+$/.test(all[i]) && all[i + 1] === "=") { i += 2; continue; }
    if (/^[A-Za-z_]\w*=/.test(all[i]) || WRAPPERS.has(w) || /^-/.test(all[i]) && WRAPPERS.has((all[i - 1] ?? "").toLowerCase())) { i += 1; continue; }
    break;
  }
  const rest = all.slice(i);
  if (rest.length === 0) return { cmd: "", args: [] };
  // `./tool`, `C:\bin\tool.exe`, `tool.cmd` -> `tool`
  const cmd = rest[0].toLowerCase().replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|ps1|sh)$/, "");
  return { cmd, args: rest.slice(1).map((a) => a.toLowerCase()) };
}

function classifySegment(segment, rawCommand) {
  const { cmd, args } = words(segment);
  if (!cmd) return "none";
  if (HARMLESS_REMOVE_CLEAR.has(cmd)) return "none";
  if (DESTRUCTIVE_COMMANDS.has(cmd) || cmd.startsWith("mkfs") || /^(remove|clear)-/.test(cmd)) return "destructive";
  if (cmd === "find" && (args.includes("-delete") || (args.includes("-exec") && args.includes("rm")))) {
    return "destructive";
  }

  if (cmd === "git") {
    const sub = args.find((a) => !a.startsWith("-"));
    if (sub === "reset" && args.includes("--hard")) return "destructive";
    if (sub === "clean" && args.some((a) => /^-\w*f/.test(a) || a === "--force")) return "destructive";
    if (sub === "push" && args.some((a) => a === "-f" || a.startsWith("--force") || a === "--delete" || a === "-d")) return "destructive";
    if (sub === "branch" && args.some((a) => a === "-D" || a === "-d" || a === "--delete")) return "destructive";
    if (sub === "stash" && args.some((a) => a === "drop" || a === "clear")) return "destructive";
    if (sub === "push") return "sensitive";
    return "none";
  }
  if (CLI_TOOLS.has(cmd)) {
    const verbs = args.filter((a) => !a.startsWith("-"));
    // Package managers only reach outside the machine when publishing;
    // installs and removals are local dependency changes.
    if (PACKAGE_MANAGERS.has(cmd)) {
      if (verbs.includes("unpublish")) return "destructive";
      return verbs.some((v) => v === "publish" || v === "deploy") ? "sensitive" : "none";
    }
    if (verbs.some((v) => DESTRUCTIVE_VERBS.has(v))) return "destructive";
    if (verbs.some((v) => SENSITIVE_VERBS.has(v))) return "sensitive";
    return "none";
  }
  // Checked against the raw text: quoting is stripped from segments, and
  // `-Method "POST"` keeps its method inside quotes.
  if (HTTP_CLIENTS.has(cmd)) return HTTP_WRITE.test(rawCommand) ? "sensitive" : "none";
  if (SENSITIVE_COMMANDS.has(cmd)) return "sensitive";
  return "none";
}

const SEVERITY = { none: 0, sensitive: 1, destructive: 2 };
const worst = (a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a);

export function classifyShellCommand(command) {
  if (typeof command !== "string" || !command.trim()) return "none";
  let tier = SQL_CLIENT.test(command) && SQL_DESTRUCTIVE.test(command) ? "destructive" : "none";
  for (const segment of segments(command)) tier = worst(tier, classifySegment(segment, command));
  return tier;
}

export function classifyToolCall(toolName, params) {
  const p = params && typeof params === "object" ? params : {};
  if (SHELL_TOOLS.has(toolName)) return classifyShellCommand(p.command ?? p.cmd ?? p.input);
  if (NO_RISK_TOOLS.has(toolName)) return "none";
  if (toolName === "write" || toolName === "edit") {
    const path = p.file_path ?? p.path ?? "";
    return typeof path === "string" && SENSITIVE_PATH.test(path) ? "sensitive" : "none";
  }
  if (toolName === "apply_patch") {
    const patch = typeof p.input === "string" ? p.input : typeof p.patch === "string" ? p.patch : "";
    if (/^\*\*\* Delete File:/m.test(patch)) return "destructive";
    const touched = [...patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)].map((m) => m[1].trim());
    return touched.some((path) => SENSITIVE_PATH.test(path)) ? "sensitive" : "none";
  }
  if (OUTWARD_TOOLS.has(toolName)) {
    const action = typeof p.action === "string" ? p.action : "";
    if (DELETE_ACTION.test(action)) return toolName === "cron" ? "sensitive" : "destructive";
    if (READ_ACTION.test(action)) return "none";
    return "sensitive";
  }
  return null; // unknown tool (plugins, MCP servers): let the server judge the name
}
