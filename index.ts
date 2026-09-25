import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { createSupervisor } from "./src/supervisor.js";

const DEFAULT_LOG_PATH = join(homedir(), ".openclaw", "xybernetex-supervisor.jsonl");

type Config = {
  endpoint?: string;
  apiKey?: string;
  maxToolCallsPerRun?: number;
  tokenBudgetPerRun?: number;
  logPath?: string;
};

export default definePluginEntry({
  id: "xybernetex-openclaw",
  name: "Xybernetex Supervisor for OpenClaw",
  description: "Observe-only agent supervisor: logs what the Xybernetex policy would do after every tool call.",
  register(api) {
    const config = (api.pluginConfig ?? {}) as Config;
    const logPath = config.logPath ?? DEFAULT_LOG_PATH;
    const writeLog = (entry: Record<string, unknown>) => {
      try {
        mkdirSync(dirname(logPath), { recursive: true });
        appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
      } catch {
        // best-effort: logging must never break the agent
      }
    };

    // The key can come from the environment so it stays out of openclaw.json.
    const apiKey = process.env.XYBERNETEX_API_KEY ?? config.apiKey;
    if (!config.endpoint || !apiKey) {
      writeLog({ error: "xybernetex-openclaw disabled: set plugin config `endpoint` and XYBERNETEX_API_KEY " +
                        "(or plugin config `apiKey`) - see README" });
      return;
    }

    const supervisor = createSupervisor({
      endpoint: config.endpoint,
      apiKey,
      maxToolCallsPerRun: config.maxToolCallsPerRun,
      tokenBudgetPerRun: config.tokenBudgetPerRun,
      log: writeLog,
    });

    // One supervised trajectory = one agent run (a single user turn and all
    // its tool calls). Falls back to the session when a run id is missing.
    const runKeyOf = (event: any, ctx: any): string =>
      event?.runId ?? ctx?.runId ?? ctx?.sessionKey ?? ctx?.sessionId ?? "unknown";

    // Nothing is returned, and OpenClaw runs after_tool_call fire-and-forget,
    // so the agent never waits on the supervisor.
    api.on("after_tool_call", (event: any, ctx: any) => {
      void supervisor.recordToolCall(runKeyOf(event, ctx), {
        toolName: event.toolName,
        params: event.params,
        error: event.error,
        sessionKey: ctx?.sessionKey,
      });
    });

    // Token spend. llm_output needs OpenClaw's conversation-access grant; if
    // it never fires, cost is measured in tool calls instead (logged as
    // costBasis on every entry).
    api.on("llm_output", (event: any, ctx: any) => {
      supervisor.recordTokens(runKeyOf(event, ctx), event.usage);
    });

    // Also needs the conversation-access grant; runs are LRU-evicted
    // regardless, so this only frees memory sooner.
    api.on("agent_end", (event: any, ctx: any) => {
      supervisor.endRun(runKeyOf(event, ctx));
    });
  },
});
