// Verify before finish: asks for one more model pass, through OpenClaw's
// before_agent_finalize hook, before a run's final answer is accepted - a
// check of the work against the request.
//
// Why: the most common real failure in the 2026-09-27 outcome grading was an
// agent reporting success that its own work didn't back up - empty folders,
// a file literally named `{1..48}.txt`, a wrong total stated confidently.
// Nothing here knows the task, so the instruction is generic: re-read the
// request, confirm the files, re-run what was reported, fix what's wrong.
//
// Opt-in per agent. Only runs that made a tool call are asked (a plain chat
// answer has nothing to verify), and each run is asked at most once: the
// retry budget below is OpenClaw's own, and this module also remembers which
// runs it already asked in case a host applies no budget.
export const DEFAULT_INSTRUCTION = [
  "Before giving your final answer, check your work against the original request:",
  "1. Re-read the request and confirm every part of it is done.",
  "2. For each file you created or changed, confirm it exists at the requested path with the expected content.",
  "3. If you reported a command's output or test results, re-run it and make sure your answer matches what it actually prints.",
  "4. Check the edge cases and exact formats the request mentions.",
  "If anything is missing or wrong, fix it now, then give your final answer.",
].join("\n");

const IDEMPOTENCY_KEY = "xybernetex-verify-before-finish";

export function createFinalizeVerifier({ agentIds, instruction = DEFAULT_INSTRUCTION, minToolCalls = 1,
  toolCallsFor, runKeyOf, log = () => {}, maxTrackedRuns = 500 }) {
  if (!Array.isArray(agentIds) || !agentIds.length || agentIds.some((a) => typeof a !== "string" || !a.trim())) {
    throw new Error("verifyBeforeFinish.agentIds must be a nonempty list of agent ids");
  }
  if (typeof instruction !== "string" || !instruction.trim() || instruction.length > 1000) {
    throw new Error("verifyBeforeFinish.instruction must be 1-1000 characters");
  }
  if (!Number.isInteger(minToolCalls) || minToolCalls < 0) {
    throw new Error("verifyBeforeFinish.minToolCalls must be a non-negative integer");
  }
  const asked = new Set(); // insertion order doubles as LRU order
  return (event, ctx) => {
    if (!agentIds.includes(ctx?.agentId)) return undefined;
    const runKey = runKeyOf(event, ctx);
    if (asked.has(runKey) || toolCallsFor(runKey) < minToolCalls) return undefined;
    asked.add(runKey);
    while (asked.size > maxTrackedRuns) asked.delete(asked.values().next().value);
    try { log({ type: "finalize_verify", runKey, sessionKey: ctx?.sessionKey, agentId: ctx?.agentId }); }
    catch { /* logging must not change the decision */ }
    return { action: "revise", reason: "Xybernetex: verify the work against the request before finishing.",
      retry: { instruction, idempotencyKey: IDEMPOTENCY_KEY, maxAttempts: 1 } };
  };
}
