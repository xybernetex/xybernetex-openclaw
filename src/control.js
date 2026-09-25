// Local, explicit restrictions on pending calls. This is independent of the
// learned, post-execution policy and never waits for a remote service.
import { hashParams } from "./supervisor.js";
import { randomUUID } from "node:crypto";

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
    const action = rule.action ?? "block";
    if (!["block", "approve"].includes(action)) throw new Error("control rule action must be block or approve");
    if (action === "approve" && (typeof rule.approvalDescription !== "string" ||
        !rule.approvalDescription.trim() || rule.approvalDescription.length > 350)) {
      throw new Error("approval rules need an approvalDescription of 1-350 characters");
    }
    const approvalTimeoutMs = rule.approvalTimeoutMs ?? 120_000;
    if (!Number.isInteger(approvalTimeoutMs) || approvalTimeoutMs < 1_000 || approvalTimeoutMs > 600_000) {
      throw new Error("approvalTimeoutMs must be an integer from 1000 to 600000");
    }
    const match = rule.paramsMatch ?? {};
    if (typeof match !== "object" || Array.isArray(match) ||
        Object.values(match).some((v) => typeof v !== "string")) {
      throw new Error("control rule paramsMatch must contain string values");
    }
    return { ...rule, action, approvalTimeoutMs, paramsMatch: { ...match } };
  });

  return (event, ctx) => {
    const matches = compiled.filter((r) => r.agentId === ctx?.agentId && r.toolName === event?.toolName &&
      Object.entries(r.paramsMatch).every(([key, value]) =>
        Object.hasOwn(event.params ?? {}, key) && event.params[key] === value));
    // A broad approval must never override an overlapping explicit prohibition.
    const rule = matches.find((r) => r.action === "block") ?? matches[0];
    if (!rule) return;
    const enforced = mode === "enforce";
    const metadata = { gateId: randomUUID(), mode, ruleId: rule.id, enforced,
      runKey: event.runId ?? ctx?.runId ?? ctx?.sessionKey ?? "unknown",
      sessionKey: ctx?.sessionKey, agentId: ctx?.agentId,
      toolCallId: event.toolCallId, toolName: event.toolName, paramsHash: hashParams(event.params) };
    const safeLog = (entry) => { try { log({ ...metadata, ...entry }); } catch { /* keep the gate */ } };
    // Log metadata and hashes, never raw command text or tool parameters.
    // Logging failure must not turn an explicit denial into an allowed call.
    const action = rule.action === "approve" ? "REQUEST_USER" : "BLOCK_ACTION";
    safeLog({ type: "tool_gate", action: enforced ? action :
      rule.action === "approve" ? "WOULD_REQUEST_USER" : "WOULD_BLOCK" });
    if (enforced && rule.action === "approve") return {
      requireApproval: {
        title: "Xybernetex: approve one tool call",
        description: `${rule.approvalDescription}\nCall fingerprint: ${metadata.paramsHash}. This call only.`,
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
        timeoutMs: rule.approvalTimeoutMs,
        onResolution(decision) {
          safeLog({ type: "tool_gate_resolution", decision,
            allowed: decision === "allow-once" });
        },
      },
    };
    if (enforced) return {
      block: true,
      blockReason: `Xybernetex rule '${rule.id}' prohibits this tool call. It was not executed. ` +
        "Do not retry or perform the prohibited operation through another tool. " +
        "Continue any permitted work and explain the restriction to the user.",
    };
  };
}
