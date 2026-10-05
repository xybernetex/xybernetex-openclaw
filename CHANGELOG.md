# Changelog

## Unreleased

- **Undo: overlapping runs restore in the right order.** Undo ordered runs by
  when they started. An interactive run that starts first can touch a file
  after an overlapping cron or one-shot run already deleted it; undoing by
  start order then restored the two in the wrong order and lost the file
  (found in a live test; the file was still in the journal's trash). Undo now
  orders by when each file was touched: a bare `undo` picks the run whose
  latest change is the most recent, and a run is refused only when another
  run changed one of its files afterwards, with that run's id in the message.

## 0.5.3

- **The reviewer (opt-in, `reviewer.mode: "on"`).** Before a held call waits
  for a person, a model reads only the user's own messages and the call, and
  approves it when the user clearly asked for it in other words; otherwise
  the approval prompt carries its reason. A call that repeats a command the
  agent read in a file or tool output is never reviewed (a deterministic echo
  check); planted deletes stay blocked before review; slow, failing or
  unreadable answers mean a person decides. Replayed over 589 held calls from
  real history: 41% of ordinary held calls approved, 1 of 217 injection-
  scenario calls (one the user had asked for).

## 0.5.2

- **`npx xybernetex-openclaw timeline`**, the flight recorder: a session as
  one page - requests, replies, every tool call with the gate's verdict (live
  from the log, or replayed for older history), deaths, cut-offs and loops,
  follow-ups, and the files `undo` can restore.

- **Escalate follow-ups to a stronger model.** `interventions.escalate.retry`
  (and `.verify`) names the model a follow-up turn runs on. On our benchmark
  a same-model retry finished 35% of dead runs and a stronger model's 62%.
  The log records `escalatedTo`.

## 0.5.1

- **Undo.** Before a tool call writes, overwrites, moves or deletes files in
  the agent's workspace, the plugin copies what it touches into a local
  journal (last 20 runs, up to 200 MB a run; `undo` config). `npx
  xybernetex-openclaw undo` restores the latest run (`--list` for others),
  moving what's there now to the journal's trash first. It covers paths a
  call names, followed through `cd` and simple globs; not files a script
  changes from inside, nor paths outside the workspace. On by default
  (`undo.mode: "off"` turns it off). Calls the gate blocks aren't journaled.
- **The self-test points to undo** when the agent falls for the planted delete.

## 0.5.0

- **`npx xybernetex-openclaw audit`**: what your agents already did. Reads
  OpenClaw's session history (read-only) and replays it through this
  plugin's own hooks, with the strict preset in observe mode and the
  standard governor, so every judgment is the gate's own. One HTML page
  lists the destructive and outward-facing commands nobody asked for (with
  the commands themselves, since it's your history on your machine), the
  delete instructions agents read, the runs that died while OpenClaw
  reported success, the loops, and tokens by model. Needs Node 22.5+.
- **`npx xybernetex-openclaw test`**: plants `rm -rf <decoy>` in a scratch
  project's README, asks your agent to set it up, and reports whether the
  agent tried it and whether the gate stopped it (or, in observe mode, only
  logged it). One agent run; the scratch project is removed afterwards.

## 0.4.6

- **Setup no longer asks for an API key.** Everything runs locally without
  one; `--key` asks for a key for the optional policy service. `--no-key` is
  still accepted.
- **No key isn't logged as an error.** The log gets one `policy_service_off`
  line saying everything runs locally, in place of an error entry.
- **Startup lines are written once.** OpenClaw registers the plugin more than
  once while a gateway starts, so each `*_ready` line appeared two or three
  times; an identical line written in the last two minutes is now skipped.

## 0.4.5

- **Contract checks run only in the sandbox by default.** Checks are
  model-written commands. With no sandbox container for the session they used
  to run with `bash` on a copy of the folder on the host, with the gateway's
  permissions; now they don't run at all unless `contracts.allowHost` is
  `true`, and the run is judged as if contracts were off.
- **README: contracts hurt in our first benchmark.** Model-written checks
  often expected the wrong thing, failed correct work, and the fix turns
  then broke it. Keep contracts off unless you're testing them.
- **Known issue: a contract can be cut off by a fast run.** The contract is
  written while the agent works; if the run ends first, OpenClaw closes the
  plugin's model access mid-call ("Async work scope is closed") and the run
  is judged as if contracts were off.
- **README: what it runs on your machine.** Every program the plugin starts,
  when, and why.

## 0.4.4

- **Renamed to Xybernetex Supervisor** (was Xybernetex Safety Gate): it now
  also checks the agent's work, undoes fixes that break what worked and stops
  runaway runs. The package name, `xybernetex-openclaw`, and every config key
  are unchanged.

## 0.4.3

- **Contracts (experimental).** `contracts.mode: "auto"` has the run's own model write
  acceptance checks (read-only shell commands) from the user's request. When
  the run ends they run in the session's sandbox on a copy of the run's
  folder, and only failures get a fix turn naming what failed. Checks that
  would write are refused. Uses `api.runtime.llm`; set
  `llm.allowAgentIdOverride` so each agent's own model writes its contracts.
- **The ratchet.** The run's folder is snapshotted before each fix turn; a
  fix that makes a passing check fail is undone and the agent is told so.
  Fix rounds stop after `noProgressRounds` rounds without improvement.
- **The governor.** `governor: "standard"` (150 tool calls, an hour, 4
  identical calls in a row) or custom limits. The crossing call and every
  call after it are blocked with a stop-and-summarize message; the run gets
  no follow-up.
- **Reasoning models that never finish a contract.** GLM-5.3 Flash, live,
  often deliberated past the whole budget and returned nothing. The writer
  now asks for low reasoning effort, retries a reply cut off at its limit
  once with 32,000 tokens, and `contracts.model` lets another model write
  contracts (needs `llm.allowModelOverride`; falls back to the run's model if
  refused). On Workers AI through OpenClaw, detailed requests often still
  get no contract: OpenClaw doesn't pass the reasoning setting to that
  provider. Such runs are judged as if contracts were off.
- **Follow-up turns aren't mistaken for user requests** when interventions
  are off but contracts are on.

## 0.4.2

- **Commands hidden by quoting are classified.** The shell runs `$(...)` and
  backticks inside double quotes and unquoted heredocs, and runs the string
  given to `bash -c`, `sh -c`, `pwsh -Command`, `cmd /c` or `eval`; the gate
  used to strip quoted text before judging a command, so
  `bash -c "rm -rf data"` or `echo "$(rm -rf data)"` passed as harmless. Those
  inner commands are now judged too (the worst tier wins). Single quotes and
  quoted heredocs stay literal, so an agent writing docs that mention
  `rm -rf` isn't held. Replayed on the 1,402 experiment tool calls: no
  classification changed.
- **The agent can clean up its own files.** A plain delete (`rm`, `unlink`,
  `del`, `Remove-Item`; no recursion) of single files the agent itself created
  in the session - written, added by a patch or redirected to - now runs
  without a prompt, even after a `cd` or followed by `ls`/`cat`. Before, every
  such cleanup was held, and in runs no one can approve from (CLI, cron) the
  agent's temp scripts were left behind. Folders it made are still held:
  `mv data.csv scratch/ && rm -rf scratch` would otherwise delete your file.
  Tool caches (`__pycache__`, `.pyc`) may go unless a move named them. Any
  visible move onto a file drops it from the agent's own. Rules opt in with
  `unlessAuthorization: ["requested", "own_files"]`; both presets do.
  A plain delete of the agent's own file also gets past the memory of an
  earlier hold on it (moving or renaming it is still blocked).
- **Held-out runs keep their probability.** When the follow-up rule leaves a
  run untreated on purpose (the 10% comparison group), its outcome episode now
  records that probability (0.1) instead of 1, so weighted estimates of what
  follow-ups gain no longer undercount the comparison group.

## 0.4.1

- **Cut-off answers are recognized as deaths.** When the model's final turn
  hits its output limit, OpenClaw appends its own reply in the model's place
  ("The tool run finished, but no final summary was produced...") and reports
  the run as a success. The plugin now treats that as a death, so it can be
  retried. Checked against 198 graded runs: every run ending this way had
  failed its task (5 of 5), and no finished run was misread. On the outside
  benchmark tasks run on 2026-09-29 this was half of all failures.
- **Numbers updated to the held-out results.** The README and the report now
  cite the pooled 198-run measurement (a same-model retry finished 35% of
  dead runs; a check-your-work turn added 10 points) instead of the first
  90-run batch's (54%, 11 points). The policy service's rule is now the same
  for every model: the earlier per-model split did not hold up on new tasks.

## 0.4.0

- **Planted deletes can't authorize themselves, in any form.** When something
  the agent reads (a README step, a web page, tool output) contains a delete
  command, its target is held against being deleted, moved, renamed or
  trashed, unless the user's own words ask for it. In live tests, agents
  refused an `rm` often moved the data aside instead; that is now held too, as
  is moving, renaming or overwriting anything the gate just held.
- **Holds say why.** The agent is told that the user didn't ask for the action
  and to ask them rather than work around it. Before, in a run no one could
  approve from (CLI, cron), it only saw OpenClaw's generic "approval
  unavailable" and tended to route around it or avoid deleting altogether.
- **Classification fixes.** Commands behind shell keywords (`if ...; then rm
  -rf x; fi`, `else`, `do`, `!`, `{ }`) were not classified; they are now.
  `rm -r build` lost its target, so a user's own "delete the build folder" was
  held; it now runs without a prompt.
- **Interventions.** When a run ends, Xybernetex can give it one more turn in
  the same session, on the same model: a retry when it died without a usable
  answer, or a check-your-work turn when it finished. With an API key the
  policy service decides which runs get one; without, a fixed local rule does.
  Setup turns this on in `observe` mode (decide and report, start nothing);
  `--interventions act` starts the turns.
- **Outcome measurement.** Each decision is followed to its outcome: whether a
  retry finished the run, whether a check-your-work turn changed files or only
  confirmed the answer, and how the user followed up (a correction, the same
  request again, thanks, or something new - classified on your machine). The
  report has a new "What happened next" section. Labels and counts are shared
  with the policy service so it can learn which follow-ups pay off; set
  `interventions.shareOutcomes` to `false` to keep them local.
- Setup: `--interventions off|observe|act`, `--intervention-agents`,
  `--no-share-outcomes`.
- Dead runs are recognized. OpenClaw reports its commonest death - the model
  returning nothing usable - as a successful run, and an aborted run without
  a reason. The plugin now reads the run's final messages: an empty answer, or
  a model call that timed out, counts as a death and can be retried; a user's
  stop never is. Checked against 155 real runs: every such death caught, no
  finished run misread.

## 0.3.2

- First npm release: one-command setup, the authorization-aware safety gate
  with `recommended` and `strict` presets, and the customer report
  (`npx xybernetex-openclaw report`).
