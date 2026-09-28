# Changelog

## 0.4.0

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
