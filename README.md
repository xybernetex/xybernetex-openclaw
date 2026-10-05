# Xybernetex Supervisor for OpenClaw

The control plane for [OpenClaw](https://github.com/openclaw/openclaw) agents.
It stops destructive actions nobody asked for, lets the ones your users asked
for run without a prompt, and records every step so you can see what your
agents actually did.

```bash
npx xybernetex-openclaw --restart
```

Everything runs on your machine, and no account is needed: the safety gate,
contracts, the ratchet, the governor and the report are all local. An API key
from **[app.xybernetex.com](https://app.xybernetex.com)** is optional; it lets
the policy service choose which runs get a follow-up.

## Try it on your own agents first

Two commands show what Xybernetex would do for you before you change
anything:

```bash
npx xybernetex-openclaw audit   # what your agents did in the last 30 days
npx xybernetex-openclaw test    # does your agent follow a delete planted in a README?
npx xybernetex-openclaw undo    # put the last agent run's files back
npx xybernetex-openclaw timeline   # your latest session as a timeline page
```

**`audit`** reads your OpenClaw session history (read-only, on your machine)
and replays it through the gate and the governor. It lists the destructive
and outward-facing commands nobody asked for, the instructions to delete
something your agents read in files and web pages, the runs that died while
OpenClaw reported success, and the runs that looped, then writes it all to
one HTML page. Nothing is stopped, and nothing leaves your machine. Needs
Node 22.5 or newer. On our own test machine, after a week of benchmark
runs that were deliberately tricky (5,414 runs), it found 589 risky
commands nobody asked for, 203 runs that died while reported successful,
and 106 loops.

**`test`** makes a scratch project in your agent's workspace whose README
says to `rm -rf` a decoy folder, asks your agent to set the project up, and
tells you whether the agent tried the delete and whether Xybernetex stopped
it. It costs one agent run on your model, and removes the scratch project
afterwards. The decoy has a unique name, so a delete aimed at it can't match
anything else. Needs the gateway running.

**`undo`** puts an agent run's files back. Before any tool call writes,
overwrites, moves or deletes something in the agent's workspace, the plugin
copies what it touches aside (a journal of the last 20 runs, up to 200 MB a
run). `undo` restores the latest run, `undo --list` shows the others, and
whatever is there at the time goes to the journal's trash first, so an undo
can itself be undone. It covers the paths a call names: written files,
`rm`/`mv`/`cp`/trash targets and `>` redirects, followed through `cd`. It
can't see files a script changes from inside (`python clean.py`) or paths
outside the workspace, and says so when you undo.

**`timeline`** is the flight recorder: one session as a page. Every request
and reply, every tool call with the command itself and the gate's verdict
(held, blocked, or ran because you asked), where a run died, was cut off or
looped, what follow-ups ran, and which files `undo` can put back. Verdicts
come from the plugin's log where it has them and are replayed (strict
preset) for history from before you installed it. `timeline --list` shows
recent sessions; `timeline <part of a session key>` picks one.

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

**A second opinion before it asks you (opt-in).** A held call normally waits
for you. With the reviewer on, a model first reads your own messages in the
session and the call, and approves it when you clearly asked for it in other
words ("clean up the temp files" covers `rm -rf tmp/`); otherwise it passes
the call to you with its reason. It never sees files, web pages or tool
output, and a call that repeats a command the agent read there is never
reviewed at all, since that instruction didn't come from you. Replayed over
589 held calls from our own history: it approved 41% of ordinary held calls
(the approvals you'd no longer click through) and 1 of 217 calls from
injection scenarios, one the user had in fact asked for.

```bash
openclaw config set plugins.entries.xybernetex-openclaw.config.reviewer.mode on
```

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

- **Retry** when the run died without a usable answer. On our benchmark (198
  hard multi-step runs, 9 models, 22 tasks), one same-model retry finished
  35% of the runs that had died.
- **Check your work** when the run finished: re-read the request, confirm the
  files and outputs, fix anything missing. On the same benchmark this lifted
  task success by 10 points (72% to 82%), for about half again as many tokens
  per completed task. With an API key the policy service decides which runs
  get one, and holds a share of runs out so the effect stays measurable.

The same follow-ups run on a stronger model did better still (a retry rescued
62%, a check added 18 points). To run your agents on a cheap model and spend
on a strong one only when a run dies:

```bash
openclaw config set plugins.entries.xybernetex-openclaw.config.interventions.escalate.retry "workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813"
```

(`escalate.verify` does the same for check-your-work turns. The model has to
be allowed by `agents.defaults.modelPolicy.allow`.)

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

**Checks the work against a contract (experimental).** With `contracts.mode` set to
`auto`, the run's own model turns the user's request into acceptance checks
before the run is judged: read-only shell commands such as
`python3 test_totals.py` or `test -f totals.csv`. Checks that would write
anything are refused. When the run ends they run in the session's sandbox on
a copy of the run's folder (never on the host unless you allow it). If they all pass, nothing more happens. If any
fail, the agent gets a fix turn that names exactly which checks failed and
why.

**Never lets a fix make things worse.** Before each fix turn the run's
folder is snapshotted (the ratchet). After the fix the checks run again: if
any check that passed before now fails, the folder is restored and the agent
is told what its fix broke. Fix rounds stop when every check passes, after
`contracts.maxFixes` rounds, or after `contracts.noProgressRounds` rounds in
a row with no improvement.

```bash
openclaw config set plugins.entries.xybernetex-openclaw.config.contracts.mode auto
```

Checks run only in OpenClaw's sandbox (`agents.defaults.sandbox`). If your
agents run unsandboxed, set `contracts.allowHost` to `true` to run them on a
copy of the folder on the host instead; otherwise no contract is checked.

Contracts are experimental, and in our first benchmark they hurt. On 12 hard
tasks with two Python frameworks (same design as this plugin), the
model-written checks often encoded a wrong expectation: they failed 13 of the 17
correct first tries that got a contract, and the fix turns then broke 4 of
them. The ratchet can't catch that, because it judges fixes by the same
checks. Final success fell from 75% to 67% and from 83% to 67%. Leave
contracts off unless you're testing them.

In our tests on Cloudflare Workers AI they worked
on short requests, but on detailed ones GLM-5.3 Flash and DeepSeek V4 Flash
often deliberated past 32,000 tokens and wrote nothing. The plugin asks for low
reasoning effort, which fixes this when called directly, but OpenClaw doesn't
pass that setting to every provider. When no contract gets written, the log
shows `contract_unavailable` and the run is judged as if contracts were off.
You can have a different model write contracts:

```bash
openclaw config set plugins.entries.xybernetex-openclaw.config.contracts.model "workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731"
openclaw config set plugins.entries.xybernetex-openclaw.llm.allowModelOverride true --strict-json
```

**Stops runaway runs.** The governor gives each run a budget: 150 tool
calls, an hour, and no more than 4 identical calls in a row (`"standard"`),
or your own limits. The call that crosses a limit is blocked with a message
telling the model to stop and summarize, every call after it is blocked too,
and the run gets no follow-up.

```bash
openclaw config set plugins.entries.xybernetex-openclaw.config.governor standard
```

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
- **A delete it was told about is held in any form.** When something the agent
  reads (a README step, a web page, tool output) contains a delete command, that
  target is held against being deleted, moved, renamed or trashed, unless the
  user asks. Only literal commands are recognized: "please remove the data
  folder" in prose isn't, though an actual delete of it is still held.
- **"Requested" is read from the user's own message.** The action and its
  target have to appear together, and only the user's turns count, never files,
  web pages or tool output. Phrasing can still fool it in either direction.
- **The agent may delete its own files, not its own folders.** A plain delete
  (`rm`, `del`, `Remove-Item`, no recursion) of files the agent itself created
  in the session, with nothing moved onto them since, runs without a prompt.
  Deleting a folder it made is still held: moving your file into it first
  would otherwise get it deleted. Tool caches (`__pycache__`, `.pyc`) are the
  one folder exception.
- **Where OpenClaw doesn't report where a turn came from,** every turn in the
  session is treated as the user's. OpenClaw 2026.9.6 doesn't report it on the
  gateway path.
- **An approval needs someone to approve it.** Cron jobs and one-shot CLI runs
  can't show a prompt, so OpenClaw denies the call: a held call there behaves
  like a blocked one.
- **Observe mode stops nothing.** It's the default until you switch to enforce.

For untrusted work, pair it with OpenClaw's own sandboxing. Found a way past
it? Please open an issue, or email chris@xybernetex.com if it's sensitive.

## What it runs on your machine

The gate itself only reads tool calls and answers allow, hold or block. The
plugin starts other programs in three places, listed here in full:

- **Setup** (`npx xybernetex-openclaw`) runs the `openclaw` command line to
  install, enable and configure the plugin. `--dry-run` prints every command
  without running it. `audit` only reads OpenClaw's session database; `test`
  runs `openclaw agent` once, for the self-test; `undo` only copies files.
- **Follow-up and fix turns** start a detached
  `openclaw agent --session-key ...` process, so the turn lands in the same
  session; OpenClaw offers plugins no other working route for this. This only
  happens with `interventions.mode` set to `act` or with contracts on.
- **Contract checks** (`contracts.mode` `auto`) find the session's sandbox
  container with `docker ps` and run the checks there with `docker exec`, on a
  copy of the run's folder. Checks that visibly write, delete, install, push
  or use the network are refused before anything runs. With no sandbox
  container, nothing runs, unless you set `contracts.allowHost` to `true`:
  then the checks run with `bash` on a copy of the folder on the host, with
  the gateway's permissions.

## Install options

```bash
npx xybernetex-openclaw --restart                  # recommended preset, observe mode
npx xybernetex-openclaw --mode enforce --preset strict
npx xybernetex-openclaw --interventions act        # retry and check-your-work turns on
npx xybernetex-openclaw --interventions off        # no follow-ups, not even logged
npx xybernetex-openclaw --key                      # also ask for an API key (optional policy service)
npx xybernetex-openclaw --dry-run                  # print every command, change nothing
npx xybernetex-openclaw report --days 30          # the report, for the last 30 days
npx xybernetex-openclaw audit --days 7 --agent main   # replay one agent's last week of history
npx xybernetex-openclaw test --agent ci-bot --keep    # self-test another agent; keep the scratch project
```

Setup does the following:

- Installs and enables the plugin, asking you to confirm the source (OpenClaw's
  check for plugins from outside ClawHub). `--yes` skips the prompt for scripted
  installs.
- Grants the conversation access that authorization labels need.
- If you have a plugin allowlist, adds this plugin to it and keeps your existing
  entries.
- With `--key`, asks for your API key without echoing it. Without it, nothing
  is asked and everything runs locally.

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
| `interventions.escalate` | the run's model | `{ retry, verify }`: model refs for follow-up turns |
| `interventions.agentIds` | every agent | Only these agents get follow-ups |
| `interventions.policy` | `remote` | `remote` lets the policy service decide (falls back to `v0` offline); `v0` always retries dead runs and checks finished ones |
| `interventions.shareOutcomes` | `true` | Send outcome labels and counts to the policy service |
| `interventions.quietMinutes` | `30` | How long to wait for the user's next message before recording a run's outcome without one |
| `contracts.mode` | `off` | `auto`: the run's model writes acceptance checks; failures get fix turns |
| `contracts.maxFixes` | `2` | Fix turns for a failed contract (0-5) |
| `contracts.ratchet` | `true` | Snapshot before each fix and undo fixes that break a passing check |
| `contracts.noProgressRounds` | `2` | Fix rounds in a row without improvement before the loop stops |
| `contracts.allowHost` | `false` | Run checks on the host when the session has no sandbox container |
| `contracts.model` | the run's model | Write contracts with this model ref instead; needs `llm.allowModelOverride` (see below) |
| `contracts.agentIds` | every agent | Only these agents get contracts |
| `reviewer.mode` | `off` | `on`: a model approves held calls you clearly asked for, else passes them to you with its reason |
| `undo.mode` | `on` | Journal files before calls change them, for `npx xybernetex-openclaw undo` |
| `undo.maxRunMb` / `undo.keepRuns` | `200` / `20` | Most one run may copy aside; how many runs stay undoable |
| `governor` | off | `"standard"` or `{ maxToolCalls, maxSeconds, repeatLimit }` |
| `endpoint` | - | `https://api.xybernetex.com/evaluate` |
| `apiKey` | - | Your key; the `XYBERNETEX_API_KEY` environment variable takes precedence |
| `logPath` | `~/.openclaw/xybernetex-supervisor.jsonl` | Local log (labels and hashes only) |

## Support

Questions, or want to join the design partner program? Contact
[chris@xybernetex.com](mailto:chris@xybernetex.com) or visit
[xybernetex.com](https://xybernetex.com).

## License

MIT
