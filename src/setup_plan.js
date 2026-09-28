// What `xybernetex-setup` does to an OpenClaw install, as a list of openclaw
// CLI calls. Pure (state and options in, steps out) so it's tested without
// touching a real config; scripts/setup.mjs gathers the state and runs them.

export const PLUGIN_ID = "xybernetex-openclaw";
export const DEFAULT_ENDPOINT = "https://api.xybernetex.com/evaluate";
const ENTRY = `plugins.entries.${PLUGIN_ID}`;

// state: { installed: bool, allow: string[] | null }  (null = no allowlist)
// opts:  { source, mode, preset, endpoint, apiKey, reinstall, trustSource,
//          interventions, interventionAgents, shareOutcomes }
// OpenClaw refuses installs from outside ClawHub unless confirmed with
// --force; trustSource is that confirmation, which setup.mjs only sets after
// the person running it says yes (or passes --yes).
export function planSetup(state, opts) {
  const mode = opts.mode ?? "observe";
  const preset = opts.preset ?? "recommended";
  if (!["observe", "enforce"].includes(mode)) throw new Error("--mode must be observe or enforce");
  if (!["none", "recommended", "strict"].includes(preset)) throw new Error("--preset must be none, recommended or strict");
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  if (!/^https:\/\/\S+$/.test(endpoint)) throw new Error("--endpoint must be an https URL");
  const interventions = opts.interventions ?? "observe";
  if (!["off", "observe", "act"].includes(interventions)) throw new Error("--interventions must be off, observe or act");
  const agents = opts.interventionAgents ?? null;
  if (agents !== null && (!Array.isArray(agents) || !agents.length || agents.some((a) => !/^[\w.-]+$/.test(a)))) {
    throw new Error("--intervention-agents must be a comma-separated list of agent ids");
  }

  const steps = [];
  if (!state.installed || opts.reinstall) {
    if (!opts.source) throw new Error("no plugin source to install from");
    steps.push({ label: "Install the plugin", args: ["plugins", "install", opts.source, "--accept-capabilities",
      ...(state.installed || opts.trustSource ? ["--force"] : [])] });
  }
  steps.push({ label: "Enable it", args: ["plugins", "enable", PLUGIN_ID, "--accept-capabilities"] });
  // An allowlist restricts loading to its entries: add ours, keep the rest.
  // No allowlist means nothing is restricted, so there's nothing to add.
  if (Array.isArray(state.allow) && state.allow.length && !state.allow.includes(PLUGIN_ID)) {
    steps.push({ label: "Add it to plugins.allow (keeping existing entries)",
      args: ["config", "set", "plugins.allow", JSON.stringify([...state.allow, PLUGIN_ID]), "--strict-json"] });
  }
  // Authorization labels read the user's own turn (before_agent_run), which
  // OpenClaw only hands to plugins with conversation access. Without it every
  // destructive call is unlabeled, so presets can't waive the user's requests.
  steps.push({ label: "Let it read the user's own requests (authorization labels)",
    args: ["config", "set", `${ENTRY}.hooks.allowConversationAccess`, "true", "--strict-json"], optional: true });
  steps.push({ label: `Policy endpoint: ${endpoint}`, args: ["config", "set", `${ENTRY}.config.endpoint`, endpoint] });
  steps.push({ label: `Gate mode: ${mode}`, args: ["config", "set", `${ENTRY}.config.control.mode`, mode] });
  steps.push({ label: `Gate preset: ${preset}`, args: ["config", "set", `${ENTRY}.config.control.preset`, preset] });
  // Follow-up turns after a run: observe logs what it would do (and the
  // report shows it); act starts them. Outcome sharing sends labels only.
  if (interventions === "off") {
    steps.push({ label: "Interventions: off", args: ["config", "unset", `${ENTRY}.config.interventions`], optional: true });
  } else {
    const value = { mode: interventions, ...(agents ? { agentIds: agents } : {}),
      ...(opts.shareOutcomes === false ? { shareOutcomes: false } : {}) };
    steps.push({ label: `Interventions: ${interventions}${agents ? ` for ${agents.join(", ")}` : ", every agent"}` +
      `${opts.shareOutcomes === false ? ", outcomes kept local" : ""}`,
      args: ["config", "set", `${ENTRY}.config.interventions`, JSON.stringify(value), "--strict-json"] });
  }
  if (opts.apiKey) {
    steps.push({ label: "API key (stored in openclaw.json)", secret: true,
      args: ["config", "set", `${ENTRY}.config.apiKey`, opts.apiKey] });
  }
  return steps;
}

// For printing: never show a secret step's value.
export const describeStep = (step) => (step.secret
  ? `openclaw ${step.args.slice(0, -1).join(" ")} ********`
  : `openclaw ${step.args.map((a) => (/[\s"'[\]{}]/.test(a) ? `'${a}'` : a)).join(" ")}`);
