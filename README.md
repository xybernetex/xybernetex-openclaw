# Xybernetex for OpenClaw

An [OpenClaw](https://github.com/openclaw/openclaw) plugin that keeps a
tracked estimate calibrated to reality over time, instead of letting it
drift the way a model's own running commentary tends to.

Most agent loops that ask a model to "give me your current best estimate"
every so often will happily restate whatever it said last time, echo a
template verbatim, or anchor on the wrong number in a busy context. This
plugin runs a lightweight correction step on top of that estimate using
OpenClaw's own hook system - no fork, no change to how OpenClaw reasons or
calls tools, just a governed feedback signal layered on top.

## What's in this repo

A small, self-contained demo: a synthetic "reservoir monitor" scenario.
Every heartbeat tick, the plugin:

1. Generates a noisy sensor reading of a (synthetic) declining value.
2. Injects that reading plus the current estimate into the heartbeat's
   context via `heartbeat_prompt_contribution`.
3. Reads the model's reply via `before_agent_finalize`, parses its numeric
   estimate, and applies a smoothing correction against the running value.
4. Logs every tick (`~/.openclaw/xybernetex-openclaw.log.jsonl`) so you can
   watch the estimate track the true value over time.

The correction step here is a simple exponential smoothing average -
intentionally minimal, so the mechanism (inject context, read the reply,
correct, feed forward) is easy to follow end to end. Swapping in a more
capable correction model is the natural next step; this repo is the
reference implementation of the plugin side of that, not the model itself.

## Install

```bash
git clone https://github.com/xybernetex/xybernetex-openclaw.git
cd xybernetex-openclaw
openclaw plugins install --link .
openclaw plugins enable xybernetex-openclaw
```

Non-bundled plugins that read conversation/reply content need an explicit
capability grant:

```bash
openclaw config set plugins.entries.xybernetex-openclaw.hooks.allowConversationAccess true
```

## Run the demo

Enable a heartbeat on your agent pointed at this plugin's task:

```bash
openclaw config set agents.entries.main.heartbeat '{
  "every": "2m",
  "target": "none",
  "timeoutSeconds": 45,
  "lightContext": true,
  "isolatedSession": true,
  "prompt": "This is an automated monitoring check-in. Follow the task instructions provided in context exactly."
}'
openclaw gateway restart
tail -f ~/.openclaw/xybernetex-openclaw.log.jsonl
```

Each tick logs `{trueValue, rawEstimate, correctedBelief, relativeError}` -
watch `correctedBelief` track `trueValue` over successive ticks.

## License

MIT - see [LICENSE](LICENSE).
