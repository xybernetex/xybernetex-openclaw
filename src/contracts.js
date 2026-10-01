// Contracts: what "done" means for a run, checked by code instead of guessed
// by a model - the original Xybernetex's deliverable manifest, as a layer over
// OpenClaw. A port of xybernetex-python's core/contracts.py and
// core/ratchet.py: same check format, same refusals, same messages, so a
// contract behaves the same in every framework (test/contracts.test.js and
// the Python tests hold the same cases).
//
// A contract is up to 12 acceptance checks: shell commands that pass when
// they exit 0 (and, optionally, their output matches a pattern). The run's
// own model writes it from the request (contractPrompt / parseGenerated),
// through OpenClaw's api.runtime.llm - neither the request nor the checks
// leave the host. Checks are read-only as far as a command line shows:
// anything the risk classifier doesn't rate "none", and any visible write
// (a redirect into a file, tee, cp, mv, mkdir, sed -i, installs, network,
// git beyond reading), is refused. Logs identify a contract by its hash and
// carry counts only, never check text (it echoes the request).
import { createHash } from "node:crypto";

import { classifyShellCommand, segments, stripQuoted, words } from "./risk.js";
import { MARKER } from "./interventions.js";

export const MAX_CHECKS = 12;
const MAX_COMMAND = 2000;
const MAX_NAME = 120;
const MAX_TIMEOUT = 600;
const OUTPUT_TAIL = 1500;
const MESSAGE_LIMIT = 6000;

const WRITERS = new Set(["tee", "touch", "mkdir", "cp", "mv", "ln", "chmod", "chown", "install", "truncate", "dd",
  "patch", "rsync", "pip", "pip3", "npm", "npx", "yarn", "pnpm", "apt", "apt-get", "unzip", "tar", "curl", "wget"]);
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "ls-files", "rev-parse", "branch", "cat-file", "grep"]);
const REDIRECT = /(?<![<>&\d])\d?>{1,2}\s*([^\s;&|]+)/g;
const NULL_TARGET = /^(\/dev\/null|&\d|nul)$/i;

export class ContractError extends Error {}

// What visible write a command makes, or null.
export function writes(command) {
  for (const m of stripQuoted(command).matchAll(REDIRECT)) {
    if (!NULL_TARGET.test(m[1])) return "redirects output into a file";
  }
  for (const segment of segments(command)) {
    const { cmd, args } = words(segment);
    if (WRITERS.has(cmd)) return `runs ${cmd}`;
    if ((cmd === "sed" || cmd === "perl") && args.some((a) => a === "-i" || a.startsWith("-i"))) {
      return `edits files in place (${cmd} -i)`;
    }
    if (cmd === "git" && !READ_ONLY_GIT.has(args.find((a) => !a.startsWith("-")) ?? null)) return "runs git beyond reading";
  }
  return null;
}

function validRegex(source) {
  try { new RegExp(source); return true; } catch { return false; }
}

// Python's re.search and JS RegExp agree on the patterns contracts use
// (anchors, classes, alternation); multiline anchors are Python's default-off too.
const matches = (pattern, text) => new RegExp(pattern).test(text);

// {checks: [{name, command, expect?, timeout?}]} (or the bare list) -> contract.
// Malformed or unsafe checks are dropped and counted in refused; none left throws.
export function parseContract(raw, source = "developer") {
  const items = raw && !Array.isArray(raw) && typeof raw === "object" ? raw.checks : raw;
  if (!Array.isArray(items)) throw new ContractError('a contract is {"checks": [...]}');
  const checks = [];
  const refused = [];
  items.forEach((item, i) => {
    if (checks.length >= MAX_CHECKS) { refused.push(`check ${i}: over ${MAX_CHECKS} checks`); return; }
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.command !== "string" || !item.command.trim()) {
      refused.push(`check ${i}: needs a command`); return;
    }
    const command = item.command.trim();
    if (command.length > MAX_COMMAND) { refused.push(`check ${i}: command over ${MAX_COMMAND} characters`); return; }
    const tier = classifyShellCommand(command);
    if (tier !== "none") { refused.push(`check ${i}: ${tier} - checks must be read-only`); return; }
    const write = writes(command);
    if (write) { refused.push(`check ${i}: ${write} - checks must be read-only`); return; }
    let expect = item.expect ?? null;
    if (expect !== null) {
      if (typeof expect !== "string") { refused.push(`check ${i}: expect must be a regex string`); return; }
      if (!validRegex(expect)) { refused.push(`check ${i}: expect is not a valid regex`); return; }
    }
    let timeout = item.timeout ?? 60;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT) timeout = 60;
    const name = String(item.name || command).slice(0, MAX_NAME);
    checks.push(Object.freeze({ name, command, expect: expect || null, timeout }));
  });
  if (!checks.length) throw new ContractError("no usable checks" + (refused.length ? ` (${refused.join("; ")})` : ""));
  return contractOf(checks, source, refused);
}

function contractOf(checks, source, refused = []) {
  // Same canonical form as the Python port's Contract.hash.
  const canon = JSON.stringify(checks.map((c) => [c.name, c.command, c.expect, c.timeout]));
  const hash = createHash("sha256").update(canon, "utf8").digest("hex").slice(0, 16);
  return Object.freeze({ checks: Object.freeze([...checks]), source, refused: Object.freeze([...refused]), hash });
}

export const CONTRACT_PROMPT = `You write acceptance checks for an automated coding task. Do not do the task.

Task, exactly as the user gave it:
<<<
{request}
>>>

Write between 2 and {max_checks} checks that will all pass if and only if the task is fully and correctly done.
Each check is a shell command run from the task's working folder after the agent finishes. It passes when it
exits 0 and, if you give "expect", its output also matches that regular expression.

Rules:
- Read-only: never create, change, move or delete files, and never use the network.
- Check what the user asked for: files exist where requested, outputs have the requested format and values,
  programs run and behave as described. Use python3 for anything beyond test/grep.
- Prefer exact facts stated in the task (names, columns, values, formats) over guesses.
- If the folder may contain tests the user mentioned, include running them.
- Keep each command short and self-contained.

Reply with JSON only, no prose:
{"checks": [{"name": "short description", "command": "shell command", "expect": "optional regex"}]}`;

export function contractPrompt(request) {
  return CONTRACT_PROMPT.replace("{request}", String(request).trim().slice(0, 8000)).replace("{max_checks}", String(MAX_CHECKS));
}

// A model's reply to contractPrompt -> contract (tolerates code fences and stray prose).
export function parseGenerated(text) {
  if (typeof text !== "string") throw new ContractError("no reply");
  const body = text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new ContractError("the reply holds no JSON object");
  let raw;
  try { raw = JSON.parse(body.slice(start, end + 1)); } catch (e) { throw new ContractError(`the reply isn't valid JSON: ${e.message}`); }
  return parseContract(raw, "generated");
}

// Every check, in order, through exec(command, timeout) -> {code, output}. An exec error fails that check.
export async function runChecks(contract, exec) {
  const results = [];
  for (const check of contract.checks) {
    const t0 = Date.now();
    try {
      const { code, output = "" } = await exec(check.command, check.timeout);
      const passed = code === 0 && (check.expect === null || matches(check.expect, output));
      results.push({ check, passed, exitCode: code, output: output.slice(-OUTPUT_TAIL), seconds: (Date.now() - t0) / 1000, error: null });
    } catch (err) {
      results.push({ check, passed: false, exitCode: null, output: "", seconds: (Date.now() - t0) / 1000,
        error: `${err?.name ?? "Error"}: ${err?.message ?? err}`.slice(0, 300) });
    }
  }
  return { contract, results };
}

export const passedAll = (verdict) => verdict.results.length > 0 && verdict.results.every((r) => r.passed);

// For the log: counts and failing positions, no text.
export function verdictSummary(verdict) {
  return { contract: verdict.contract.hash, checks: verdict.results.length,
    passed: verdict.results.filter((r) => r.passed).length,
    failedAt: verdict.results.flatMap((r, i) => (r.passed ? [] : [i])) };
}

// The follow-up for a run whose contract failed: exactly what failed, nothing generic.
export function failureMessage(verdict) {
  const lines = [`${MARKER} The task isn't finished yet. These acceptance checks fail when run in your working folder:`];
  for (const r of verdict.results.filter((x) => !x.passed)) {
    const why = r.error ?? (r.exitCode !== 0 ? `exited ${r.exitCode}` : `output doesn't match /${r.check.expect}/`);
    const tail = r.output.trim().slice(-600);
    lines.push(`\n- ${r.check.name}\n  command: ${r.check.command}\n  result: ${why}` + (tail ? `\n  output (end):\n${tail}` : ""));
  }
  lines.push("\nFix the work so these pass - change your deliverables, not the checks - then give your final answer again in full.");
  const message = lines.join("\n");
  return message.length <= MESSAGE_LIMIT ? message : message.slice(0, MESSAGE_LIMIT - 40) + "\n...[more failures omitted]";
}

// ---- the ratchet: a fix turn may only move a run forward ---------------------

export const IMPROVED = "improved";
export const SAME = "same";
export const REGRESSED = "regressed";
export const ROLLED_BACK = "rolled-back";

export const passing = (verdict) => new Set((verdict?.results ?? []).flatMap((r, i) => (r.passed ? [i] : [])));

// improved | same | regressed, by which checks pass: a trade counts as a regression.
export function judge(best, next) {
  const before = passing(best);
  const after = passing(next);
  if (best && [...before].some((i) => !after.has(i))) return REGRESSED;
  return after.size > before.size || !best ? IMPROVED : SAME;
}

// The follow-up after a rolled-back fix: what broke, that it was undone, what still fails.
export function rollbackMessage(best, next) {
  const after = passing(next);
  const broke = [...passing(best)].filter((i) => !after.has(i)).sort((a, b) => a - b).map((i) => best.results[i].check.name);
  const head = `${MARKER} Your last change was undone: it made checks fail that passed before - ${broke.join("; ")}. ` +
    "The working folder is back exactly as it was before that change.";
  if (passedAll(best)) return head;
  const full = failureMessage(best);
  const rest = full.includes("\n") ? full.slice(full.indexOf("\n") + 1) : "";
  return `${head}\nThese checks still fail, and need fixing without breaking the ones above:${rest}`;
}
