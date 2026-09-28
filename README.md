# Xybernetex for OpenClaw

The control plane for [OpenClaw](https://github.com/openclaw/openclaw) agents.
It stops destructive actions nobody asked for, lets the ones your users asked
for run without a prompt, and records every step so you can see what your
agents actually did.

```bash
npx xybernetex-openclaw --restart
```

Get a free API key at **[app.xybernetex.com](https://app.xybernetex.com)**
(design partner beta). You can also install without a key: the safety gate and
the report run entirely on your machine.

## What it does

**Knows who asked.** Every tool call is labeled with its risk (destructive,
sensitive or none) and with who asked for it:

- `requested`: the user's own message asked for this.
- `own_artifact`: the agent is cleaning up something it created.
- `unrequested`: nobody asked, for example an instruction planted in a
  README, a web page or a tool result.

"Delete the build folder" from your user runs. The same command from a
prompt-injected file gets held.

**Gates what matters.** Presets turn that into policy across every agent:

| Preset | Destructive, not requested | Outward-facing (push, publish, send), not requested |
|---|---|---|
| `recommended` (default) | Held for approval | Runs |
| `strict` | Blocked | Held for approval |

Requested actions always run without a prompt. Your own rules layer on top.

**Starts in observe mode.** It logs what it *would* hold or block and stops
nothing. When the report looks right, switch to enforce:

```bash
openclaw config set plugins.entries.xybernetex-openclaw.config.control.mode enforce
```

**Reports.** `npx xybernetex-openclaw report` turns the last 7 days into one HTML page.
It covers what the gate held, blocked or waived, who asked for the risky calls
that ran, runs that died or looped, tokens by model, and plain-language next
steps.

**Learns (with an API key).** Every step also gets a decision from the
Xybernetex policy service at `api.xybernetex.com`. It's recorded alongside
your runs and feeds the scorecard in your dashboard.

## Privacy

Your prompts, files and command text never leave your machine. The policy
service receives tool names, a hash of each call's parameters (enough to spot
an identical repeat, not to reconstruct it), risk and authorization labels,
success or failure, and step counts. If the service is unreachable, agents keep
working and your local rules still apply.

## Install options

```bash
npx xybernetex-openclaw --restart                  # recommended preset, observe mode
npx xybernetex-openclaw --mode enforce --preset strict
npx xybernetex-openclaw --no-key                   # local gate and report only
npx xybernetex-openclaw --dry-run                  # print every command, change nothing
npx xybernetex-openclaw report --days 30          # the report, for the last 30 days
```

Setup does the following:

- Installs and enables the plugin, asking you to confirm the source (OpenClaw's
  check for plugins from outside ClawHub). `--yes` skips the prompt for scripted
  installs.
- Grants the conversation access that authorization labels need.
- If you have a plugin allowlist, adds this plugin to it and keeps your existing
  entries.
- Asks for your API key without echoing it.

Requires OpenClaw 2026.3.22 or later (verified on 2026.9.6) and Node 20+.

**Unattended agents:** OpenClaw can't show an approval prompt for cron jobs or
one-shot CLI runs, so there a held action is denied. That's safe, but pick the
preset with those agents in mind.

## Config

All under `plugins.entries.xybernetex-openclaw.config`:

| Key | Default | Meaning |
|---|---|---|
| `control.mode` | `observe` | `observe` logs; `enforce` holds and blocks |
| `control.preset` | `none` (setup sets `recommended`) | `recommended`, `strict` or `none` |
| `control.rules` | `[]` | Extra rules; `agentId`/`toolName` accept `"*"` (a tool wildcard needs `riskAtLeast`) |
| `endpoint` | - | `https://api.xybernetex.com/evaluate` |
| `apiKey` | - | Your key; the `XYBERNETEX_API_KEY` environment variable takes precedence |
| `logPath` | `~/.openclaw/xybernetex-supervisor.jsonl` | Local log (labels and hashes only) |

## Support

Questions, or want to join the design partner program? Contact
[chris@xybernetex.com](mailto:chris@xybernetex.com) or visit
[xybernetex.com](https://xybernetex.com).

## License

MIT
