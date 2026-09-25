// No openclaw/plugin-sdk import on purpose: a plugin linked from outside
// OpenClaw's own install can't always resolve that package (it failed on
// 2026.3.22), and OpenClaw's loader accepts a plain { id, register } object
// in every version from 2026.3.22 through 2026.9.6 anyway.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { createSupervisor } from "./src/supervisor.js";
import { createToolGate } from "./src/control.js";

const DEFAULT_LOG_PATH = join(homedir(), ".openclaw", "xybernetex-supervisor.jsonl");

type Config = {
  endpoint?: string;
  apiKey?: string;
  maxToolCallsPerRun?: number;
  logPath?: string;
  control?: {
    mode?: "observe" | "enforce";
    rules?: Array<{ id: string; agentId: string; toolName: string; paramsMatch?: Record<string, string>;
      riskAtLeast?: "sensitive" | "destructive";
      action?: "block" | "approve"; approvalDescription?: string; approvalTimeoutMs?: number }>;
  };
};

export default {
  id: "xybernetex-openclaw",
  name: "Xybernetex Supervisor for OpenClaw",
  description: "Agent supervisor with observation and opt-in local tool restrictions.",
  register(api: any) {
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

    // Register the local gate even if remote observation is unavailable.
    // No endpoint failure can disable configured restrictions.
    const gate = createToolGate({ ...config.control, log: writeLog });
    api.on("before_tool_call", gate, { priority: 100 });
    writeLog({ type: "tool_gate_ready", mode: config.control?.mode ?? "observe",
      ruleIds: (config.control?.rules ?? []).map((rule) => rule.id) });

    // The key can come from the environment so it stays out of openclaw.json.
    const apiKey = process.env.XYBERNETEX_API_KEY ?? config.apiKey;
    if (!config.endpoint || !apiKey) {
      writeLog({ error: "xybernetex-openclaw remote observation disabled: set plugin config `endpoint` and XYBERNETEX_API_KEY " +
                        "(or plugin config `apiKey`) - see README" });
      return;
    }

    const supervisor = createSupervisor({
      endpoint: config.endpoint,
      apiKey,
      maxToolCallsPerRun: config.maxToolCallsPerRun,
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

    // The run's total token spend, which OpenClaw reports once, after the
    // run. Logged on its own line (joinable on runKey) for later analysis -
    // too late to inform any decision in the run. Needs the conversation-
    // access grant; without it the line is simply never written.
    api.on("llm_output", (event: any, ctx: any) => {
      writeLog({ runKey: runKeyOf(event, ctx), runUsage: event?.usage ?? null, model: event?.model });
    });

    // Also needs the conversation-access grant; runs are LRU-evicted
    // regardless, so this only frees memory sooner.
    api.on("agent_end", (event: any, ctx: any) => {
      supervisor.endRun(runKeyOf(event, ctx));
    });
  },
};
