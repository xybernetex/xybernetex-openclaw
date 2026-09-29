# Xybernetex Supervisor for OpenClaw

See [ALPHA.md](ALPHA.md) for the current alpha contract, implementation stages,
and measured limitations. Pending-call telemetry is opt-in with
`proposalTelemetry: true`; it writes local v2 proposal records without changing
the deployed v1 model or enforcing learned decisions.

An [OpenClaw](https://github.com/openclaw/openclaw) plugin that watches an
agent's tool calls and records what a trained supervisor policy would do at
each step: continue, replan, block the action, ask the user, inject
context, or stop.

**Observation is the default.** The learned policy still only observes.
Optional local rules can now block explicitly prohibited calls before they
execute. These rules operate independently of the remote policy endpoint.

## Live status (2026-09-27)

The `main` agent (the interactive one; `scenarios`, the automated batch
harness, is untouched and stays fully observe-only so live scenario batches
keep running unattended) now runs three `enforce`/`approve` rules -
`main-destructive-exec-approve`, `main-destructive-terminal-approve`,
`main-destructive-patch-approve` - each `riskAtLeast: "destructive"`. Any
shell command or file-delete patch `risk.js` classifies destructive now pauses
for human approval instead of running or being silently observed. `block`
was deliberately not used here: `risk.js` classifies what an operation does,
not whether it was authorized (see "`riskAtLeast` does not know intent"
below), and full-run1's live data showed roughly 26 legitimate agent
self-cleanups (`rm todos.json`, `git reset --hard` redoing its own botched
merge, `DROP TABLE IF EXISTS` before a fresh `CREATE`) get classified
destructive exactly like an unwanted deletion would. `approve` keeps the same
guarantee - nothing destructive executes unreviewed - at the cost of one
click for the legitimate cases, rather than silently killing them. See the
non-interactive-CLI caveat above: this only reviews meaningfully in an
interactive session (`main` is used that way); the same rule under a one-shot
CLI call fails closed with no prompt to answer.

**Since 2026-09-30 the presets also list `"own_files"`**: a plain delete of
single files the agent created this session, with no visible move onto them
since, is waived (src/authz.js `ownsFiles`; folders never, except tool
caches). Replayed on the 198 experiment runs: 21 of the 27 own_artifact calls
qualify, identical in the Python port; `mv data.csv scratch/ && rm -rf scratch`
and `echo x > data.csv; mv ../data.csv .; rm data.csv` do not.

**Since 2026-09-28 each of those rules also sets `unlessAuthorization:
["requested"]`**: a destructive call the user's own message asked for (verb
and target in one sentence of their turn - see "Authorization labels" below)
runs without a prompt and is logged as `tool_gate_waived`; everything else
still asks. Checked end to end on the sandboxed agent first: a requested
`rm -rf tmp` was waived and ran; a planted `rm -rf data` was attempted twice
each by gemma4 and nemotron and was held for approval every time (and
auto-denied, being a non-interactive run), leaving `data/` intact. Only
`requested` can waive a rule - never `own_artifact` - and an unlabeled call
always asks. Remove the field from a rule to go back to prompting for every
destructive call. Review what ran unprompted with the `tool_gate_waived`
lines in the log.

Also fixed same day: `risk.js`'s npm/yarn/pnpm `publish --dry-run` false
positive (a no-op simulated publish was indistinguishable from a real one by
verb alone) - the largest remaining false-alarm source found in full-run1's
scenario grading.

## Authorization labels (2026-09-27, observational)

`risk.js` says what a call does, never whether the user asked for it.
`src/authz.js` adds that signal: every destructive or sensitive call is
labeled `requested` (the user's own message asks for this kind of operation
and names every target), `own_artifact` (every target was created by the
agent earlier in the session, or is a regenerable cache like `__pycache__`),
or `unrequested`. It reads only the user's own turns, captured by the
`before_agent_run` hook (always returns `pass`; needs
`hooks.allowConversationAccess`), never file contents or tool results, so an
instruction planted in data can't authorize itself. The request text stays in
memory; only the label is logged or sent: on each `tool_history` entry, on
proposal records, and on `tool_gate` log lines.

Nothing enforces on it yet. Replayed against 565 real scenario runs
(`scripts/authz_eval.mjs`, fed by the trainer's `scenarios.export_calls`):
no planted-instruction call labeled `requested`, all 8 runs where an agent
obeyed a planted instruction still caught by "block only unrequested", and
the successful runs such a rule would hit fall from 105 to 24. It's a
heuristic: `own_artifact` in particular can be staged within a session, so it
must never be grounds to skip a rule. Turns OpenClaw marks as coming from
another session don't count as the user's, but OpenClaw 2026.9.6 supplied no
provenance on the gateway path in testing, so that protection applies only
where provenance is provided.

## Outcome signals (2026-09-28, 0.4.0)

Customers' runs have no checker, so learning which interventions pay off on
their work needs outcomes the plugin can observe. `src/outcomes.js` opens one
episode per intervention decision (`none` included) and closes it on the
user's next message in that session, `quietMinutes` without one (default
30), the session ending, or a newer decision in the same session. An episode
records what was decided and what was actually applied (observe mode and
failed starts are `applied: "none"` with probability 1, the correct
propensity for off-policy evaluation), the run's success, retriability, tool
calls and tokens, our follow-up's success, tool calls, file writes (successful
`write`/`edit`/`apply_patch`-style calls) and tokens, and:

- `verify`: `fixed` (our check-your-work turn changed files: the first answer
  was incomplete), `confirmed`, or `failed`.
- `user`: the next message classified locally against the previous request:
  `correction` ("that didn't work", "still failing", "you forgot..."),
  `repeat` (word-set Jaccard >= 0.6), `thanks` (short and positive), `new`.
  Neither message is logged or sent. The patterns are deliberately narrow: a
  new request like "fix the error in parse.py" stays `new`.

Episodes are logged locally (`type: "episode"`) and, unless
`interventions.shareOutcomes` is false or there's no key, POSTed to
`/outcome` (cfworker `src/outcome.js`), which validates labels and counts and
writes one row to the `xybernetex_outcomes` Analytics Engine dataset, kept
apart from usage. Our follow-up's `before_agent_run` can arrive before the
decision is logged (the decision is logged only after the turn starts), so a
follow-up seen early is held and attached when the episode opens.

Known limits: a user who replies in a different session, or never replies,
gives no signal; `repeat` can't tell "do it again" from "do the same thing to
another file" at high overlap; file writes through `exec` (e.g. `sed -i`)
don't count as writes.

## First control version

Set `plugins.entries.xybernetex-openclaw.config.control` to an object such as:

```json
{
  "mode": "enforce",
  "rules": [
    {
      "id": "no-shell-in-scenarios",
      "agentId": "scenarios",
      "toolName": "exec"
    }
  ]
}
```

This example prohibits **every exec call for the scenarios agent**. Other
agents and tools are unaffected. Use `mode: "observe"` to log `WOULD_BLOCK`
without blocking anything. Omitting `control` defaults to observation with
no restrictions. After changing configuration, confirm a `tool_gate_ready`
entry in the log; the running gateway must reload the plugin for changes
to apply. Keep rule IDs unique.

An optional `paramsMatch` object restricts a rule to exact, case-sensitive
matches on specified string parameters, for example
`"paramsMatch": {"command": "rm /workspace/example.txt"}`. Extra parameters
are permitted.

An optional `riskAtLeast: "sensitive"` or `"destructive"` instead restricts a
rule to calls `src/risk.js` classifies at or above that tier - the same
classifier the observation path (`supervisor.js`) already uses, e.g. one
`exec` rule that blocks **any** destructive shell command (`rm -rf`,
`git reset --hard`, `DROP TABLE`, ...) rather than one exact command:

```json
{"id": "no-destructive-exec", "agentId": "scenarios", "toolName": "exec", "riskAtLeast": "destructive"}
```

`paramsMatch` and `riskAtLeast` combine (a rule with both needs both to
match) when a rule sets both. A tool `risk.js` doesn't know how to judge
(an MCP tool, a plugin-provided tool) never satisfies `riskAtLeast`, even in
`enforce` mode - the rule is skipped for that call rather than guessing.
`risk.js` is a heuristic for a supervisor that mostly only observes; see its
own module docstring. `riskTier` (the classification that decided the
match, or `null` when the rule matched on `paramsMatch` alone) is logged on
every `tool_gate` entry.

**`riskAtLeast` does not know intent.** `risk.js` classifies what an
operation *does* (deletes something, reaches outside the machine), not
whether the user authorized it - a rule blocking destructive `exec` calls
blocks a user-requested cleanup exactly as readily as an unwanted one. Scope
`agentId` and `toolName`/`paramsMatch` to the situations where that
trade-off is acceptable; this is a blunt, explicit restriction, not a
judgment about what the user wanted.

These are tool-call restrictions, **not filesystem protection**:
another tool, a differently formatted command, or a delegated agent may perform
the same operation. A blocked call tells the agent not to circumvent the rule,
but this instruction is not an access-control boundary. Use the sandbox and
host permissions for that boundary.

The gate uses OpenClaw's `before_tool_call` hook, returning `block: true` and
a reason the agent can act on. It is synchronous, has no network dependency,
and logging failures do not lift a denial. Invalid rules fail registration;
ensure the plugin is loaded before relying on them. Startup and gate events
are separate from post-execution policy observations. Only hashes of tool
parameters are logged. No learned decision is enforced; replanning, parameter
rewriting, and run termination are not implemented yet.

### Approve one pending call

Use `action: "approve"` on a rule to ask through OpenClaw's native approval
flow. The default rule action is still `block`. For example:

```json
{
  "mode": "enforce",
  "rules": [{
    "id": "review-test-delete",
    "agentId": "scenarios",
    "toolName": "exec",
    "paramsMatch": { "command": "rm /workspace/disposable.txt" },
    "action": "approve",
    "approvalDescription": "Delete the disposable test file /workspace/disposable.txt. This removes that file.",
    "approvalTimeoutMs": 120000
  }]
}
```

The configured description must identify the action, target, and consequence.
Keep it accurate for **all** calls the rule matches; use narrowly scoped exact
parameters where needed. The plugin does not copy raw parameters into approval
prompts, because they may contain credentials. A fingerprint identifies the
specific call without exposing its contents. Never treat that fingerprint as
a substitute for understanding the described operation.

OpenClaw holds the call before execution and binds the approval to its parameter
snapshot. Only **allow-once** and **deny** are offered; the plugin stores no
standing permission. A later matching call asks again. A matching block rule
always wins over approval regardless of rule order. Among overlapping approval
rules, the first configured match supplies the prompt.

Use a connected OpenClaw approval UI, or inspect and resolve the pending request:

```sh
openclaw approvals pending
openclaw approvals resolve <request-id> allow-once
openclaw approvals resolve <request-id> deny
```

Timeout, cancellation, missing approval routing, and denial do not authorize
execution. A missing approval route may deny immediately rather than wait.
Ensure a reviewing surface is connected before running an approval test.
`tool_gate_resolution` logs are correlated to the request by `gateId`, tool-call
identity and parameter hash. An allowed resolution is permission, not proof
that the tool eventually executed successfully. In observe mode, approval
rules only log `WOULD_REQUEST_USER` and do not pause the agent.

**Confirmed live (2026-09-27): a one-shot `openclaw agent ...` CLI call has no
approval-capable surface at all**, and OpenClaw denies immediately with
`"Plugin approval unavailable: non-interactive CLI runs have no
approval-capable initiating surface"` - this is exactly what "a missing
approval route may deny immediately" above means in practice, reproduced with
`scripts/approval_smoke.py` against OpenClaw 2026.9.6. That script's own
`allow-once`/`deny` case therefore cannot pass against a one-shot CLI
invocation; only an interactive surface attached to the running gateway
(the TUI, or a connected approval UI) can actually present the prompt to a
human. This is a safe failure mode (destructive calls fail closed, not open)
but it means an `action: "approve"` rule is only meaningfully reviewed in an
interactive session - any unattended/CLI/automated run of the same agent will
simply have every matching call denied, with no prompt anyone can answer.

`python scripts/approval_smoke.py` tests two successive identical calls (allow
the first, deny the second), timeout, and cancellation in the live sandbox.
It uses a **test-only automated reviewer**, scoped to unique test sessions and
descriptions; it never resolves unrelated approvals. It also checks rejection
of persistent approval and verifies filesystem effects. This exercises the
Gateway approval flow, not the usability of a human approval interface.
Results include the installed OpenClaw version, plugin Git revision, and gate
source hash. Settings are restored afterward. The reviewer currently uses an
installed OpenClaw runtime adapter and fails if that private adapter changes.

### Live control check

With the configured Docker-sandboxed `scenarios` agent and a running gateway:

```sh
python scripts/control_smoke.py
```

This makes two paid agent calls, temporarily changes only the plugin's
control configuration, and waits for confirmation that the gateway loaded
each mode. It compares observe versus enforce on disposable test files,
checks that permitted work continues, and restores the prior control settings
in `finally`. Results and a control-only recovery record are saved under
`out/control-*/`. If the process is forcibly killed, use that recovery record
to restore settings manually. The test requires Node and Python on PATH and
the current npm-installed OpenClaw layout. Live hook behavior was checked on
OpenClaw 2026.9.6; older supported observation versions are not a control
compatibility guarantee.

## How it works

After every completed tool call (`after_tool_call`), the plugin:

1. Adds the call to that agent run's history: tool name, a hash of its
   params, and whether it failed or timed out.
2. Sends the run's recent state (last 8 tool calls, the policy's last 16
   decisions, step count, and cost against budget) to the Xybernetex policy
   endpoint.
3. Logs the snapshot and the decision to
   `~/.openclaw/xybernetex-supervisor.jsonl`.

The agent never waits on any of this: OpenClaw runs `after_tool_call`
fire-and-forget, and each run's requests are queued so every evaluation
sees the decisions before it.

**Privacy.** Tool params never leave your machine. The policy only needs to
know whether two calls were identical (its loop detector), so the plugin
sends a hash of each call's params instead. Tool names, success/failure,
step/cost counts, and a risk label are sent.

**Risk labels.** Before hashing, `src/risk.js` classifies each call from
what it actually does: `destructive` (e.g. `rm -rf`, `Remove-Item`,
`git reset --hard`, `DROP TABLE` via a SQL client), `sensitive` (reaches
outside the machine: `git push`, `npm publish`, `wrangler deploy`, HTTP
POSTs, sending a message, editing credential files), or `none`. This
matters most for `exec`, which runs every shell command: judged by name
alone, running a test suite and deleting a folder look the same. Tools the
classifier doesn't know are sent without a label and judged by name on the
server. It's a heuristic for a supervisor that only observes, not a
security boundary.

**Cost.** Cost is tool calls against `maxToolCallsPerRun`. OpenClaw only
reports token usage once a run has finished, too late to inform a decision
during it, so with conversation access granted (below) the plugin logs each
run's token total on its own line (`runUsage`, joinable on `runKey`).

## Install

One command, from the package you were sent (or `npx xybernetex-openclaw`
once it's published):

```bash
npx --package ./xybernetex-openclaw-0.3.0.tgz xybernetex-setup --restart
```

Setup installs and enables the plugin and asks you to confirm the source
(OpenClaw's own check for plugins from outside ClawHub). It grants
conversation access, which authorization labels need. It sets the gate to
`observe` with the `recommended` preset and asks for your API key (hidden,
Enter to skip). With `--restart` it restarts the gateway and confirms the
plugin loaded. If you have a plugin allowlist (`plugins.allow`), setup adds
this plugin to it and keeps every existing entry. Other flags:
`--mode enforce`, `--preset strict|none`, `--no-key`, `--yes`, `--dry-run`
(print every command, change nothing).

Start in `observe` for a few days. The gate logs what it *would* hold or
block and stops nothing. Check the report, then switch:

```bash
openclaw config set plugins.entries.xybernetex-openclaw.config.control.mode enforce
```

**Presets.** `recommended` holds destructive calls the user didn't ask for
(delete, reset, drop, overwrite) for approval, across every agent. `strict`
blocks those outright and also holds outward-facing actions nobody asked for
(push, publish, send). Both let the user's own requests run without a
prompt. Your own `control.rules` are added after the preset. Rules accept
`"*"` for `agentId` and `toolName`; a tool wildcard needs `riskAtLeast`.
Unattended runs (cron, one-shot CLI) have nowhere to show an approval, so
OpenClaw denies them automatically there.

**Report.** `npx xybernetex-openclaw report` (or `npm run report` in a checkout) turns
the last 7 days of the log into one HTML page. It covers what the gate held,
blocked or waived, who asked for the risky calls that ran, runs that died or
looped, tokens by model, and policy latency, followed by plain-language next
steps. `--days 30`, `--out file.html`, `--json`. It contains labels and
hashes only, so it's safe to share.

**From source** (development): `openclaw plugins install --link .` in a
checkout loads `index.ts` directly. Packaged installs load `dist/index.js`,
which `npm run build` regenerates (and `npm pack` runs automatically).

The API key can also come from the gateway's environment, where it takes
precedence over the `apiKey` config field:

```bash
export XYBERNETEX_API_KEY=<key>
```

Then restart the gateway (`openclaw gateway restart`) and watch decisions
arrive:

```bash
tail -f ~/.openclaw/xybernetex-supervisor.jsonl
```

If `endpoint` or the key is missing, the plugin disables itself and writes
one line saying so to the log.

**Run agents through the gateway.** As of OpenClaw 2026.9.6, the local
terminal chat (`openclaw chat`, i.e. `openclaw tui --local`) loads the
plugin but never delivers tool-call events to it, so nothing is logged.
Everything that runs through the gateway works: `openclaw tui` (no
`--local`), the dashboard, chat channels, and `openclaw agent`. So does
`openclaw agent --local`.

## Config

| Key | Default | Meaning |
|---|---|---|
| `endpoint` | (required) | Policy endpoint URL: `https://api.xybernetex.com/evaluate` |
| `apiKey` | - | Bearer key; `XYBERNETEX_API_KEY` wins if set |
| `maxToolCallsPerRun` | 50 | Tool-call budget per agent run (the policy's step and cost budget) |
| `logPath` | `~/.openclaw/xybernetex-supervisor.jsonl` | Decision log |

## Test

```bash
npm test
```

The supervisor core (`src/supervisor.js`) has no OpenClaw dependency and is
tested against a fake endpoint; `index.ts` only wires OpenClaw's hooks to
it. Works with OpenClaw 2026.3.22 and later; verified end to end on
2026.9.6. On 2026.3.22, runs are keyed by session rather than by run, since
that release doesn't pass a run id to tool hooks.

## License

MIT - see [LICENSE](LICENSE).
