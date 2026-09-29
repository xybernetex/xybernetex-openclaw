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
that ran, runs that died or looped, follow-ups and what happened after them,
tokens by model, and plain-language next steps.

**Rescues and checks runs.** When a run ends, Xybernetex decides whether it
needs one more turn in the same session, on the same model:

- **Retry** when the run died without a usable answer. In our testing one
  retry finished 54% of runs that had died.
- **Check your work** when the run finished: re-read the request, confirm the
  files and outputs, fix anything missing. In our testing this lifted task
  success by 11 points on hard multi-step tasks, but the gain depends heavily
  on the model, so with an API key the policy service picks which runs get it.

Setup starts this in observe mode: every decision is logged and shown in the
report, and no turn is started. To let it act:

```bash
npx xybernetex-openclaw --interventions act
npx xybernetex-openclaw --interventions act --intervention-agents ci-bot,nightly
```

In act mode the follow-up turn appears in the session like any other message,
marked `[xybernetex]`. A session gets at most 3 follow-ups, and the gateway at
most 10 a minute. Follow-up turns never count as the user's request, so they
can't authorize a destructive action.

**Measures outcomes.** Your real work has no answer key, so Xybernetex watches
for the signals it can see: whether a retry finished the run, whether a
check-your-work turn changed files (the first answer was incomplete) or only
confirmed it, and how the user followed up. The user's next message is
classified on your machine as a correction ("that didn't work"), the same
request again, thanks, or something new. The report shows these by what was
applied, so you can see what the follow-ups are worth on your own workload.

**Learns (with an API key).** Every step also gets a decision from the
Xybernetex policy service at `api.xybernetex.com`, and it picks which runs get
a follow-up. Outcome signals go back to it, so it learns which follow-ups pay
off for which models and work.

## Privacy

Your prompts, files and command text never leave your machine. The policy
service receives tool names, a hash of each call's parameters (enough to spot
an identical repeat, not to reconstruct it), risk and authorization labels,
success or failure, and step counts. If the service is unreachable, agents keep
working and your local rules still apply.

When a run ends it also receives the run's shape (finished or not, whether the
failure looks retriable, tool-call count, model id) and, later, its outcome
signals: labels such as `fixed`, `confirmed`, `correction` or `thanks`, and
counts of tool calls, file writes and tokens. Never the user's message, the
agent's answer or any file. To keep outcome signals on your machine, set
`interventions.shareOutcomes` to `false` (or install with
`--no-share-outcomes`); they still appear in your report.

## What it doesn't do

The gate is a strong layer against agents doing destructive things nobody
asked for. It is a heuristic, not a sandbox, and you should know its edges:

- **It judges what a call visibly does.** It reads shell commands, file paths,
  patch contents and action verbs. A command hidden inside a script the agent
  runs (`python cleanup.py`) is judged as running a script, not as the deletes
  inside it. Tools it doesn't know how to judge are never matched by its rules.
- **"Requested" is read from the user's own message.** The action and its
  target have to appear together, and only the user's turns count, never files,
  web pages or tool output. Phrasing can still fool it in either direction, and
  `own_artifact` (cleaning up the agent's own files) never waives a rule.
- **Where OpenClaw doesn't report where a turn came from,** every turn in the
  session is treated as the user's. OpenClaw 2026.9.6 doesn't report it on the
  gateway path.
- **An approval needs someone to approve it.** Cron jobs and one-shot CLI runs
  can't show a prompt, so OpenClaw denies the call: a held call there behaves
  like a blocked one.
- **Observe mode stops nothing.** It's the default until you switch to enforce.

For untrusted work, pair it with OpenClaw's own sandboxing. Found a way past
it? Please open an issue, or email chris@xybernetex.com if it's sensitive.

## Install options

```bash
npx xybernetex-openclaw --restart                  # recommended preset, observe mode
npx xybernetex-openclaw --mode enforce --preset strict
npx xybernetex-openclaw --interventions act        # retry and check-your-work turns on
npx xybernetex-openclaw --interventions off        # no follow-ups, not even logged
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
| `interventions.mode` | off (setup sets `observe`) | `observe` decides and logs; `act` starts the follow-up turn |
| `interventions.agentIds` | every agent | Only these agents get follow-ups |
| `interventions.policy` | `remote` | `remote` lets the policy service decide (falls back to `v0` offline); `v0` always retries dead runs and checks finished ones |
| `interventions.shareOutcomes` | `true` | Send outcome labels and counts to the policy service |
| `interventions.quietMinutes` | `30` | How long to wait for the user's next message before recording a run's outcome without one |
| `endpoint` | - | `https://api.xybernetex.com/evaluate` |
| `apiKey` | - | Your key; the `XYBERNETEX_API_KEY` environment variable takes precedence |
| `logPath` | `~/.openclaw/xybernetex-supervisor.jsonl` | Local log (labels and hashes only) |

## Support

Questions, or want to join the design partner program? Contact
[chris@xybernetex.com](mailto:chris@xybernetex.com) or visit
[xybernetex.com](https://xybernetex.com).

## License

MIT
