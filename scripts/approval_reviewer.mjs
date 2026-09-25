// Test-only reviewer for disposable sandbox calls. Never loaded by the plugin.
// Resolves only requests matching a supplied session AND unique test description.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const settings = JSON.parse(readFileSync(process.argv[2], "utf8"));
const dist = join(settings.openclawRoot, "dist");
// Installed runtime adapter: fail explicitly if its private export changes.
const file = readdirSync(dist).filter((f) => /^client-.*\.mjs$/.test(f)).find((f) =>
  readFileSync(join(dist, f), "utf8").includes("GatewayClient as t"));
if (!file) throw new Error("Installed OpenClaw GatewayClient adapter not found");
const { t: GatewayClient } = await import(pathToFileURL(join(dist, file)).href);
const config = JSON.parse(readFileSync(join(homedir(), ".openclaw", "openclaw.json"), "utf8"));
const records = [];
const seen = new Set();
function save() { writeFileSync(settings.results, JSON.stringify(records, null, 2)); }
let count = 0;
const client = new GatewayClient({
  url: `ws://127.0.0.1:${config.gateway?.port ?? 18789}`,
  token: config.gateway?.auth?.token,
  clientName: "cli", mode: "cli", role: "operator",
  scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
  caps: ["approvals", "plugin-approvals"],
  onHelloOk: () => writeFileSync(settings.ready, "ready"),
  onConnectError: () => { writeFileSync(settings.error, "Gateway reviewer connection failed"); },
  onEvent: (event) => {
    if (event.event !== "plugin.approval.requested") return;
    const { id, request } = event.payload ?? {};
    if (!id || seen.has(id) || request?.pluginId !== "xybernetex-openclaw" ||
        request.sessionKey !== settings.sessionKey ||
        !request.description?.startsWith(settings.description + "\nCall fingerprint:")) return;
    seen.add(id);
    const decision = settings.decisions[count++];
    const record = { id, decision: decision ?? "unexpected", allowedDecisions: request.allowedDecisions };
    records.push(record); save();
    void (async () => {
      if (settings.effectPath) {
        let contents = "";
        try { contents = readFileSync(settings.effectPath, "utf8"); } catch { /* not executed yet */ }
        record.contentsBeforeDecision = contents;
      }
      if (decision === "timeout") { save(); return; }
      if (decision === "cancel") {
        await client.request("chat.abort", { sessionKey: settings.sessionKey });
        record.cancelRequested = true; save(); return;
      }
      if (decision === "allow-once") {
        // A persistent approval must be rejected, not merely hidden in the UI.
        try {
          await client.request("plugin.approval.resolve", { id, decision: "allow-always" });
          throw new Error("Gateway unexpectedly accepted allow-always");
        } catch (error) {
          if (String(error).includes("unexpectedly accepted")) throw error;
          record.persistentDecisionRejected = true;
        }
      }
      await client.request("plugin.approval.resolve", { id, decision: decision === "allow-once" ? decision : "deny" });
      record.resolved = true; save();
    })().catch((error) => { record.error = String(error.message); save(); });
  },
});
client.start();
const lifetime = setTimeout(() => { client.stop(); process.exit(0); }, 300_000);
process.on("SIGTERM", () => { clearTimeout(lifetime); client.stop(); process.exit(0); });
