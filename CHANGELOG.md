# Changelog

## 0.4.2

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
