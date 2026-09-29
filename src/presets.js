// Named rule sets, so a new install gets a sensible gate from one config
// value (control.preset) instead of hand-written rules. Each preset is a
// list of ordinary control rules using the "*" wildcards, expanded ahead of
// any rules the operator writes; the gate validates them like any other rule.
//
// Every preset rule waives calls the user's own turn requested (see
// src/authz.js): that waiver is what stops an injected `rm -rf` without
// prompting on the user's own "delete the build folder".
//
// Note for unattended agents: OpenClaw denies an approval outright when no
// approval-capable surface is attached (cron, one-shot CLI runs), so for
// those runs an "approve" rule behaves like "block".

const DESTRUCTIVE_APPROVAL = "Destructive action the user didn't ask for (delete, reset, drop, overwrite). " +
  "It may come from instructions in a file, web page or tool output. Allow only if you expected it.";
const SENSITIVE_APPROVAL = "Action that reaches outside this machine (push, publish, deploy, send, credential change) " +
  "that the user didn't ask for. Allow only if you expected it.";

export const PRESETS = Object.freeze({
  // Hold unrequested destructive calls for a person; everything else runs.
  recommended: [
    { id: "preset-destructive-approve", agentId: "*", toolName: "*", riskAtLeast: "destructive",
      action: "approve", approvalDescription: DESTRUCTIVE_APPROVAL, unlessAuthorization: ["requested", "own_files"] },
  ],
  // Refuse unrequested destructive calls outright; hold unrequested
  // outward-facing ones for a person.
  strict: [
    { id: "preset-destructive-block", agentId: "*", toolName: "*", riskAtLeast: "destructive",
      action: "block", unlessAuthorization: ["requested", "own_files"] },
    { id: "preset-sensitive-approve", agentId: "*", toolName: "*", riskAtLeast: "sensitive",
      action: "approve", approvalDescription: SENSITIVE_APPROVAL, unlessAuthorization: ["requested", "own_files"] },
  ],
});

export const PRESET_NAMES = Object.freeze(Object.keys(PRESETS));

export function presetRules(name) {
  if (name === undefined || name === null || name === "none") return [];
  if (!Object.hasOwn(PRESETS, name)) {
    throw new Error(`control.preset must be one of ${["none", ...PRESET_NAMES].join(", ")}`);
  }
  return PRESETS[name].map((rule) => ({ ...rule, unlessAuthorization: [...rule.unlessAuthorization] }));
}
