#!/usr/bin/env node
// One-command install of Xybernetex into an existing OpenClaw.
//
//   npx xybernetex-openclaw                  (once published)
//   npx --package ./xybernetex-openclaw-0.3.0.tgz xybernetex-setup
//   node scripts/setup.mjs --mode enforce --preset strict
//
// Installs and enables the plugin, sets the gate preset and mode, the policy
// endpoint and, with --key, the API key (asked for, hidden), keeps any existing plugin
// allowlist intact, and can restart the gateway and confirm the plugin loaded.
// --dry-run prints every command without running any.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { DEFAULT_ENDPOINT, PLUGIN_ID, describeStep, planSetup } from "../src/setup_plan.js";
import { ask, askHidden } from "./prompt.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG = join(homedir(), ".openclaw", "xybernetex-supervisor.jsonl");

const { values: args } = parseArgs({ options: {
  mode: { type: "string", default: "observe" },
  preset: { type: "string", default: "recommended" },
  interventions: { type: "string", default: "observe" },
  "intervention-agents": { type: "string" },
  "no-share-outcomes": { type: "boolean", default: false },
  endpoint: { type: "string", default: DEFAULT_ENDPOINT },
  source: { type: "string", default: PACKAGE_ROOT },
  reinstall: { type: "boolean", default: false },
  key: { type: "boolean", default: false },
  "no-key": { type: "boolean", default: false },   // the default since 0.4.6; still accepted
  restart: { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  yes: { type: "boolean", short: "y", default: false },
  help: { type: "boolean", short: "h", default: false },
} });

if (args.help) {
  console.log(`usage: npx xybernetex-openclaw [options]        (install)
       npx xybernetex-openclaw report [--days 7]   (weekly report)
  --mode observe|enforce          gate mode (default observe: log what it would stop, stop nothing)
  --preset recommended|strict|none  rule set (default recommended)
  --interventions off|observe|act follow-up turns after a run: a retry when it died, a check-your-work
                                  turn when it finished (default observe: decide and report, start nothing)
  --intervention-agents a,b       only these agents get follow-ups (default: every agent)
  --no-share-outcomes             keep outcome signals on this machine (default: send labels and counts)
  --endpoint URL                  policy endpoint (default ${DEFAULT_ENDPOINT})
  --source PATH|SPEC              where to install the plugin from (default: this package)
  --reinstall                     reinstall even if already installed
  --key                           ask for an API key for the optional policy service (default: no key;
                                  everything runs locally)
  --restart                       restart the gateway and confirm the plugin loaded
  --yes, -y                       confirm installing from outside ClawHub without asking
  --dry-run                       print the commands, run nothing`);
  process.exit(0);
}

// The openclaw CLI: its entry script run with this node when it's an npm
// install (avoids Windows .cmd shims), otherwise the binary on PATH.
function findOpenClaw() {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of ["openclaw.cmd", "openclaw"]) {
      const shim = join(dir, name);
      if (!existsSync(shim) || !statSync(shim).isFile()) continue;
      const entry = join(dir, "node_modules", "openclaw", "openclaw.mjs");
      if (existsSync(entry)) return [process.execPath, entry];
      if (name === "openclaw") return [shim];
    }
  }
  return null;
}

const oc = findOpenClaw();
if (!oc) {
  console.error("openclaw isn't on PATH. Install OpenClaw first: https://openclaw.ai");
  process.exit(1);
}
const run = (argv, { quiet = false } = {}) => {
  const p = spawnSync(oc[0], [...oc.slice(1), ...argv], { encoding: "utf8", windowsHide: true });
  if (!quiet && p.status !== 0) process.stderr.write((p.stderr || p.stdout || "").slice(-1500));
  return p;
};
const json = (text) => {
  const start = text.search(/[[{]/);
  try { return start < 0 ? null : JSON.parse(text.slice(start)); } catch { return null; }
};

const version = run(["--version"], { quiet: true }).stdout.trim().split("\n").pop();
console.log(`Xybernetex setup for ${version || "OpenClaw"}\n`);

const listed = json(run(["plugins", "list", "--json"], { quiet: true }).stdout ?? "");
const installed = Array.isArray(listed?.plugins) && listed.plugins.some((p) => p.id === PLUGIN_ID);
const allowed = json(run(["config", "get", "plugins.allow", "--json"], { quiet: true }).stdout ?? "");
const state = { installed, allow: Array.isArray(allowed) ? allowed : null };

let apiKey = null;
if (process.env.XYBERNETEX_API_KEY && !args["dry-run"]) {
  console.log("Using the API key in XYBERNETEX_API_KEY (it takes precedence at runtime; not written to config).\n");
} else if (!args.key || args["no-key"]) {
  if (!args["dry-run"]) console.log("No API key needed: the gate, governor, follow-ups and report run locally. " +
    "(--key adds one for the optional policy service.)\n");
} else if (!args["dry-run"]) {
  // Checked here so a mangled paste never gets written into the config.
  for (;;) {
    apiKey = await askHidden("Xybernetex API key (from app.xybernetex.com; Enter to skip): ");
    if (!apiKey || /^xyb_[0-9A-Za-z]{32}$/.test(apiKey)) break;
    console.log(`  That isn't a Xybernetex key ("xyb_" + 32 letters and digits; got ${apiKey.length} characters). Paste it again.`);
  }
  if (!apiKey) console.log("No key: everything still runs locally; the policy service stays off.\n");
}

// OpenClaw's own consent step for plugins that don't come from ClawHub.
let trustSource = args.yes;
if ((!installed || args.reinstall) && !trustSource && !args["dry-run"]) {
  console.log(`OpenClaw asks you to confirm plugins installed from outside ClawHub.\nSource: ${args.source}`);
  trustSource = /^y(es)?$/i.test(await ask("Install Xybernetex from this source? [y/N] "));
  if (!trustSource) {
    console.log("Cancelled. Nothing was changed.");
    process.exit(1);
  }
  console.log("");
}

let steps;
try {
  steps = planSetup(state, { source: args.source, mode: args.mode, preset: args.preset, endpoint: args.endpoint,
    apiKey: apiKey || null, reinstall: args.reinstall, trustSource, interventions: args.interventions,
    interventionAgents: args["intervention-agents"] ? args["intervention-agents"].split(",").map((a) => a.trim()).filter(Boolean) : null,
    shareOutcomes: !args["no-share-outcomes"] });
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
if (installed && !args.reinstall) console.log("The plugin is already installed; updating its settings.\n");

for (const step of steps) {
  process.stdout.write(`- ${step.label}\n    ${describeStep(step)}\n`);
  if (args["dry-run"]) continue;
  const p = run(step.args);
  if (p.status !== 0) {
    if (step.optional) {
      console.log(step.args[1] === "unset" ? "    (nothing to turn off)"
        : "    (skipped: this OpenClaw version doesn't support it; authorization labels will be off)");
      continue;
    }
    console.error(`\nSetup stopped at "${step.label}". Nothing after it was changed.`);
    process.exit(1);
  }
}
if (args["dry-run"]) {
  console.log("\nDry run: nothing was changed.");
  process.exit(0);
}

if (!args.restart) {
  console.log(`\nDone. Restart the gateway to load it:\n    openclaw gateway restart\n` +
    `Then run an agent and check the log: ${LOG}`);
  process.exit(0);
}

console.log("\nRestarting the gateway...");
const before = existsSync(LOG) ? readFileSync(LOG, "utf8").length : 0;
if (run(["gateway", "restart"]).status !== 0) {
  console.error("Couldn't restart the gateway. Run `openclaw gateway restart` yourself.");
  process.exit(1);
}
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const tail = existsSync(LOG) ? readFileSync(LOG, "utf8").slice(before) : "";
  const ready = tail.split("\n").filter(Boolean).map(json).find((e) => e?.type === "tool_gate_ready");
  if (ready) {
    console.log(`Loaded: gate ${ready.mode}, preset ${ready.preset ?? "none"}, rules ${(ready.ruleIds ?? []).join(", ") || "none"}.`);
    const iv = tail.split("\n").filter(Boolean).map(json).find((e) => e?.type === "interventions_ready");
    if (iv) console.log(`Interventions: ${iv.mode}, policy ${iv.policy}, outcomes ${iv.shareOutcomes ? "shared (labels only)" : "kept local"}.`);
    console.log("Generate a report any time with: npx xybernetex-openclaw report");
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.error("The gateway restarted but the plugin hasn't reported in yet. Check `openclaw plugins list`.");
process.exit(1);
