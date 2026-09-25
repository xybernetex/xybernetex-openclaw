# Xybernetex Supervisor for OpenClaw

An [OpenClaw](https://github.com/openclaw/openclaw) plugin that watches an
agent's tool calls and records what a trained supervisor policy would do at
each step: continue, replan, block the action, ask the user, inject
context, or stop.

**This release only observes.** It never blocks, modifies, or delays
anything the agent does. Its job is to log real trajectories and the
policy's decisions on them, so the policy can be checked against real use
before any decision is enforced.

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
and step/cost counts are sent.

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
