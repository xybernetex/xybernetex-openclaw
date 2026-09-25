// Local, explicit restrictions on pending calls. This is independent of the
// learned, post-execution policy and never waits for a remote service.
import { hashParams } from "./supervisor.js";

export function createToolGate({ mode = "observe", rules = [], log = () => {} } = {}) {
  if (!["observe", "enforce"].includes(mode)) throw new Error("control.mode must be observe or enforce");
  if (!Array.isArray(rules)) throw new Error("control.rules must be an array");
  const ids = new Set();
  const compiled = rules.map((rule) => {
    if (!rule || ["id", "agentId", "toolName"].some((k) => typeof rule[k] !== "string" || !rule[k].trim())) {
      throw new Error("each control rule needs a nonempty id, agentId and toolName");
    }
    if (ids.has(rule.id)) throw new Error(`duplicate control rule id: ${rule.id}`);
    ids.add(rule.id);
    const match = rule.paramsMatch ?? {};
    if (typeof match !== "object" || Array.isArray(match) ||
        Object.values(match).some((v) => typeof v !== "string")) {
      throw new Error("control rule paramsMatch must contain string values");
    }
    return { ...rule, paramsMatch: { ...match } };
  });

  return (event, ctx) => {
    const rule = compiled.find((r) => r.agentId === ctx?.agentId && r.toolName === event?.toolName &&
      Object.entries(r.paramsMatch).every(([key, value]) =>
        Object.hasOwn(event.params ?? {}, key) && event.params[key] === value));
    if (!rule) return;
    const enforced = mode === "enforce";
    // Log metadata and hashes, never raw command text or tool parameters.
    // Logging failure must not turn an explicit denial into an allowed call.
    try {
      log({ type: "tool_gate", mode, ruleId: rule.id, enforced,
        action: enforced ? "BLOCK_ACTION" : "WOULD_BLOCK",
        runKey: event.runId ?? ctx?.runId ?? ctx?.sessionKey ?? "unknown",
        sessionKey: ctx?.sessionKey, agentId: ctx?.agentId,
        toolCallId: event.toolCallId, toolName: event.toolName,
        paramsHash: hashParams(event.params) });
    } catch { /* the restriction still applies */ }
    if (enforced) return {
      block: true,
      blockReason: `Xybernetex rule '${rule.id}' prohibits this tool call. It was not executed. ` +
        "Do not retry or perform the prohibited operation through another tool. " +
        "Continue any permitted work and explain the restriction to the user.",
    };
  };
}
