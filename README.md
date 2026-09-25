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

```bash
git clone https://github.com/xybernetex/xybernetex-openclaw.git
cd xybernetex-openclaw
openclaw plugins install --link .
openclaw plugins enable xybernetex-openclaw --accept-capabilities
openclaw config set plugins.allow '["xybernetex-openclaw"]'
openclaw config set plugins.entries.xybernetex-openclaw.config.endpoint "https://<your-endpoint>/evaluate"
```

(`--accept-capabilities` is the plugin consent step newer OpenClaw
releases require; drop it on versions that don't recognize it.)

Set the API key as an environment variable for the gateway process (it
takes precedence over the `apiKey` config field and keeps the key out of
`openclaw.json`):

```bash
export XYBERNETEX_API_KEY=<key>
```

Optional: grant conversation access so the plugin can log each run's token
total and free per-run memory as soon as a run ends (`llm_output` /
`agent_end`). This setting doesn't exist on older OpenClaw releases such as
2026.3.22, which reject it:

```bash
openclaw config set plugins.entries.xybernetex-openclaw.hooks.allowConversationAccess true
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
| `endpoint` | (required) | Policy endpoint URL, ending in `/evaluate` |
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
