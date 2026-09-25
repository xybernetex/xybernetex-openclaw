# Alpha implementation contract

This document translates the Gemini discussion into staged implementation
work, reconciled with the current code and local test evidence. It does not
replace an external architecture document; the only shared architecture file
found during this pass was the broader `../architecture.html`.

## Current evidence and boundaries

- Local explicit blocking was verified against OpenClaw 2026.9.6: the file
  survived and the agent continued permitted work. Observation remains default.
- Claude added `riskAtLeast` rules using the local heuristic classifier. Unknown
  classifications do not meet a risk threshold. This is not a sandbox boundary.
- Approval rules use OpenClaw's native per-call flow and offer allow-once/deny.
  The non-interactive `openclaw agent` test path rejected approvals before
  presenting a request, even with a separate approval-capable reviewer connected.
  Two test calls were cancelled, neither executed, and settings were restored.
  Allow-once success, timeout, cancellation and UI usability still need live
  verification through a supported interactive initiating surface.
- The `full-run1` manifest contains 1,152 jobs: 1,142 done and 10 failed.
  Offline scoring found 844 passes, 45 failures, 150 inconclusive, 32 known gaps,
  71 unscored, and 10 incomplete. Teacher agreement was 8,561/9,158 (93.48%).
  In 409 observations the teacher chose CONTINUE and the policy TERMINATE.
  These are teacher disagreements, not independently adjudicated mistakes;
  they nevertheless make automatic learned termination inappropriate today.

## Implemented first slice: versioned proposal telemetry

The deployed model's v1 contract remains 140 float32 features. A separate,
opt-in `xybernetex.state.v2` extractor produces 148 features. The first 140
are unchanged; the new features at indices 140-147 are:

| Index | Feature | Meaning |
|---|---|---|
| 140 | proposed_present | A pending call exists |
| 141 | proposed_sensitive | Pending call classified sensitive |
| 142 | proposed_destructive | Pending call classified destructive |
| 143 | proposed_risk_assessed | Recorder supplied a risk label, including none |
| 144 | recent_tool_breadth | Distinct tool names / call count in the last eight completed calls |
| 145 | proposed_repeat_count | Matching trailing completed calls / 5, capped at 1 |
| 146 | proposed_new_tool | Nonempty recent history does not contain this tool name |
| 147 | goal_drift_available | Distinguishes absent drift from measured zero |

`ProposedToolCall` contains tool name, hashed params, optional risk and call ID.
It deliberately has no success, error or timeout: the operation has not run.
It is not appended to completed history and does not spend step/cost budget.

Set plugin config `proposalTelemetry: true` to log `tool_proposal` events locally
from the pre-call hook. This setting is off by default. Capture adds local
classification, hashing and best-effort synchronous logging; it is not literally
zero latency. It makes no network request and does not invoke a v2 policy.
The snapshot includes only prior policy decisions available at capture time.
Its correlation ID identifies this hook's proposal, not a guarantee that another
plugin cannot later rewrite the call. Completed history still reflects the
existing after-tool hook and must not be treated as proof of successful effects.

The replay loader separates proposals from completed observations. Python and
JavaScript extractors are checked against 84 shared generated cases. The v1
extractor rejects explicit v2 snapshots or pending calls instead of silently
misreading them. The live Worker still calls only the v1 extractor. No v2
checkpoint has been trained, exported, uploaded, or deployed.

## Control-loop direction

Keep explicit local restrictions authoritative and keep remote inference out
of the mandatory pre-call path for now. Evaluate remote advice in shadow mode.
Do not assume that an asynchronous response after step N arrives before N+1.

Before cached advice can influence execution, its envelope must include run ID,
source step, unique proposal ID if applicable, model version, feature schema,
expiry, and a local generation. Reject stale, out-of-order, cross-run or
incompatible responses. Consume proposal-specific decisions once. Remote
advice may never override an explicit local denial or reuse an approval.
No cached-action enforcement is implemented in this slice.

### Data collection and review tooling

Live batch `control-406068cdc0` (2026-09-25, OpenClaw 2026.9.6) passed both
observation and enforcement tests. Observation deleted the disposable file;
enforcement preserved its exact contents. Both agents completed the permitted
recovery write. All six proposals had host call IDs. Replay found five completed
calls and one blocked proposal, with zero unmatched completions or invalid joins.
These six records are a pipeline check, not enough data to train or establish
general intervention accuracy. Evidence lives under `out/control-406068cdc0/`
and the trainer's `out/control-406068cdc0-proposal-review.json`.

`python scripts/control_smoke.py --proposals` temporarily enables pending-call
telemetry for the existing observe/enforce sandbox comparison and restores the
previous settings. Configuration changes are serialized behind readiness
acknowledgements because this installation's plugin reloads can exceed a minute.
The opt-in local `tool_completed` event preserves the host call ID and hashed
parameters independently of remote inference. Hook call IDs fall back to the
host context when absent on the event itself.

The trainer's `python -m scenarios.proposal_report <logs> --output <report>`
validates v2 extraction, joins by run and call ID, and flags duplicate IDs,
missing correlations, reordered outcomes, changed calls and orphan completions.
It exports an unlabelled review set. A configured block is recorded as evidence
of a local restriction, not promoted to a universally correct teacher label.
Missing outcomes stay unknown. Filesystem effects still require a separate check.

The deeper `full-run1` termination review found all 409 CONTINUE-to-TERMINATE
disagreements at steps 35-44; 352 included a previous TERMINATE decision and
386 had no errors in their recent history. This suggests testing remaining-budget
boundaries and feedback from previous policy decisions; it does not prove
causation. Future evaluation should include healthy long runs at these budgets,
with both empty and policy-generated action histories, while preserving whole-run
holdouts. The current synthetic generator gives non-exhaustion episodes generous
budgets, so its reported accuracy does not establish performance near this boundary.

An alternative synchronous policy call needs measured end-to-end latency and
an explicit timeout/fallback contract; a suggested 80-120ms deadline is not
evidence that the network or model can meet it. Do not implement both paths
before choosing and testing one.

## Remaining stages and acceptance checks

1. **Review real disagreements.** Split by run/model and run length, inspect
   early TERMINATE decisions, and add counterexamples with long error/repetition
   histories. Preserve entire runs in held-out sets. Keep teacher agreement
   separate from human-reviewed task outcomes. Do not relabel all disagreements
   as teacher truth without inspection.
2. **Collect pending-call data.** Enable proposal telemetry only for a bounded
   test run first. Check before/after IDs, blocked-call handling, observation
   completeness and replay. Bound/drain the existing asynchronous evaluation
   queue before enabling large-scale collection.
3. **Define intervention contracts before new teacher labels.** Tool breadth is
   not lack of progress. MODIFY_ACTION needs an explicit allowed transformation
   and parameter bounds, not merely a risky name. NARROW_TOOLS needs concrete
   allowed tools and a justified trigger. Until then these actions remain
   unreachable; do not invent labels just to populate eight classes.
4. **Train/export v2 in isolation.** Retain the deterministic baseline. Version
   feature meanings and action ordering in model manifests, check all tensor
   shapes and vocabulary, regenerate parity cases, and evaluate with the model's
   own previous decisions. A 140-input checkpoint cannot serve v2.
5. **Realize one additional action at a time.** First complete interactive
   approval tests. Verify supported hook semantics for REPLAN/INJECT_CONTEXT;
   distinguish intervention messages from genuine tool output. Parameter changes
   must be returned as `{ params: ... }`, not applied by mutating the event.
   TERMINATE must target the owning run, not blindly abort a shared session.
6. **Shadow, then limited enforcement.** Compare against both observation-only
   and deterministic controls, measuring completion, unwanted effects, false
   interruptions, recovery, latency and spend. Keep an explicit disable path.

## Claims deliberately not adopted

Market-first status, AGI claims and competitor comparisons are unverified and
are not engineering requirements. The actual trainer uses cross-entropy, not
MSE. Behavioral cloning does not guarantee correct or stable decisions. Parameter
hashes reduce raw-data exposure but do not encrypt low-entropy secrets. The shell
classifier can miss wrappers, scripts and obfuscation. Existing parity tests
measure implementation agreement, not intervention quality. The critic output
is untrained by the current behavioral-cloning loss.
