// Generated from index.ts by scripts/build.mjs - edit index.ts, then run npm run build.
// No openclaw/plugin-sdk import on purpose: a plugin linked from outside
// OpenClaw's own install can't always resolve that package (it failed on
// 2026.3.22), and OpenClaw's loader accepts a plain { id, register } object
// in every version from 2026.3.22 through 2026.9.6 anyway.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { createSupervisor } from "../src/supervisor.js";
import { createToolGate } from "../src/control.js";
import { createAuthorizationTracker } from "../src/authz.js";
import { createFinalizeVerifier } from "../src/verify.js";
import { createCliScheduler, createInterventions, createRemoteDecider, emptyRunError, isOurs, lastReplyError, retriable }
  from "../src/interventions.js";
import { createOutcomeSender, createOutcomeTracker } from "../src/outcomes.js";
import { createContracts } from "../src/contract_runner.js";

const DEFAULT_LOG_PATH = join(homedir(), ".openclaw", "xybernetex-supervisor.jsonl");

               
                    
                  
                              
                   
                              
                                                                                           
                                                                                                                 
                                                     
                                                                                                                           
             
                                 
                                               
                                                                            
                                                                                                        
                                                                                          
                                                                                                
    
  

export default {
  id: "xybernetex-openclaw",
  name: "Xybernetex Safety Gate",
  description: "Holds destructive actions nobody asked for. Instructions planted in files or web pages can't authorize " +
    "themselves, and your own requests run without a prompt.",
  register(api     ) {
    const config = (api.pluginConfig ?? {})          ;
    const logPath = config.logPath ?? DEFAULT_LOG_PATH;
    const writeLog = (entry                         ) => {
      try {
        mkdirSync(dirname(logPath), { recursive: true });
        appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
      } catch {
        // best-effort: logging must never break the agent
      }
    };

    const apiKey = process.env.XYBERNETEX_API_KEY ?? config.apiKey;
    const authz = createAuthorizationTracker();
    const supervisor = createSupervisor({ endpoint: config.endpoint, apiKey, authz,
      maxToolCallsPerRun: config.maxToolCallsPerRun, proposalTelemetry: config.proposalTelemetry, log: writeLog });
    const runKeyOf = (event     , ctx     )         =>
      event?.runId ?? ctx?.runId ?? ctx?.sessionKey ?? ctx?.sessionId ?? "unknown";

    // Register the local gate even if remote observation is unavailable.
    // No endpoint failure can disable configured restrictions.
    const gate = createToolGate({ ...config.control, log: writeLog,
      authorize: (event     , ctx     ) => authz.label(ctx?.sessionKey, event?.toolName, event?.params),
      requestsTarget: (ctx     , target        ) => authz.requestsTarget(ctx?.sessionKey, target),
      ownsFiles: (event     , ctx     ) => authz.ownsFiles(ctx?.sessionKey, event?.toolName, event?.params) });

    // Follow-up turns (src/interventions.js): a detached `openclaw agent`
    // turn in the same session, on the same model. Off unless configured.
    let interventions                                                = null;
    let outcomes                                                 = null;
    const runModels = new Map                (); // runKey -> provider/model, from llm_output
    if (config.interventions) {
      // "remote" (the default when the policy service is configured) asks
      // POST /intervene; "v0" uses the fixed local rule.
      const remote = (config.interventions.policy ?? "remote") === "remote" && Boolean(config.endpoint && apiKey);
      interventions = createInterventions({ config: config.interventions, log: writeLog, schedule: createCliScheduler(),
        decide: remote ? createRemoteDecider({ endpoint: config.endpoint, apiKey }) : null });
      // Outcome signals (src/outcomes.js): logged locally always; sent to the
      // policy service as labels and counts unless shareOutcomes is false.
      const quietMinutes = config.interventions.quietMinutes ?? 30;
      if (typeof quietMinutes !== "number" || !(quietMinutes >= 1 && quietMinutes <= 1440)) {
        throw new Error("interventions.quietMinutes must be 1-1440");
      }
      const share = config.interventions.shareOutcomes !== false && Boolean(config.endpoint && apiKey);
      outcomes = createOutcomeTracker({ log: writeLog, quietMs: quietMinutes * 60_000,
        send: share ? createOutcomeSender({ endpoint: config.endpoint, apiKey }) : null });
      writeLog({ type: "interventions_ready", mode: config.interventions.mode ?? "observe", policy: remote ? "remote" : "v0",
        agentIds: config.interventions.agentIds ?? null, verifyRate: config.interventions.verifyRate ?? 1,
        shareOutcomes: share });
    }

    // Contracts (src/contract_runner.js): the run's model writes acceptance
    // checks from the request; when the run ends they run in the session's
    // sandbox, and only failures get a fix turn, under the ratchet. Off unless
    // configured; needs api.runtime.llm and api.runtime.agent (OpenClaw 2026.9).
    let contracts                                            = null;
    if (config.contracts && (config.contracts.mode ?? "off") !== "off") {
      const llm = api.runtime?.llm;
      const agentRuntime = api.runtime?.agent;
      if (typeof llm?.complete !== "function" || typeof agentRuntime?.resolveAgentWorkspaceDir !== "function") {
        writeLog({ error: "contracts need api.runtime.llm and api.runtime.agent (OpenClaw 2026.9 or later): disabled" });
      } else {
        contracts = createContracts({ config: config.contracts, log: writeLog, schedule: createCliScheduler(),
          complete: (params     ) => llm.complete(params),
          workspaceDir: (agentId        ) => {
            try { return agentRuntime.resolveAgentWorkspaceDir(api.runtime?.config?.current?.(), agentId) ?? null; } catch { return null; }
          } });
        writeLog({ type: "contracts_ready", agentIds: config.contracts.agentIds ?? null, maxFixes: config.contracts.maxFixes ?? 2,
          ratchet: config.contracts.ratchet !== false });
      }
    }

    // The user's own turn, before the model reads anything - the only text
    // src/authz.js accepts as authorization, so instructions planted in files
    // or tool results can't grant it. Always passes: this hook only observes
    // here, and a gate hook's unsupported return shape fails closed. Needs
    // hooks.allowConversationAccess; logs size and provenance, never the text.
    try {
      api.on("before_agent_run", (event     , ctx     ) => {
        try {
          const oursTurn = isOurs(event?.prompt);
          try { contracts?.noteRunStart(runKeyOf(event, ctx), ctx, event?.prompt, oursTurn); } catch { /* best-effort */ }
          // Our own follow-up turn is never the user's request.
          if (interventions?.noteRunStart(runKeyOf(event, ctx), event?.prompt)) {
            outcomes?.noteFollowupStart(ctx?.sessionKey, runKeyOf(event, ctx));
            return { outcome: "pass" };
          }
          if (oursTurn) return { outcome: "pass" };  // ours, with follow-ups not configured (a contract fix turn)
          const provenance = ctx?.inputProvenance?.kind ?? null;
          const accepted = authz.setRequest(ctx?.sessionKey, event?.prompt, provenance);
          // The user's next message is how the last run's episode ended.
          if (accepted) outcomes?.noteUserTurn(ctx?.sessionKey, event?.prompt);
          writeLog({ type: "authz_request", sessionKey: ctx?.sessionKey, accepted, provenance,
            chars: typeof event?.prompt === "string" ? event.prompt.length : null });
        } catch { /* authorization context is best-effort */ }
        return { outcome: "pass" };
      });
    } catch {
      writeLog({ error: "before_agent_run unavailable on this OpenClaw version: authorization labels disabled" });
    }
    api.on("before_tool_call", (event     , ctx     ) => {
      if (config.proposalTelemetry) {
        try {
          supervisor.recordProposal(runKeyOf(event, ctx), { toolName: event.toolName, params: event.params,
            toolCallId: event.toolCallId ?? ctx?.toolCallId, sessionKey: ctx?.sessionKey });
        } catch { /* telemetry failure must not bypass the gate */ }
      }
      return gate(event, ctx);
    }, { priority: 100 });
    writeLog({ type: "tool_gate_ready", proposalTelemetry: config.proposalTelemetry === true, mode: config.control?.mode ?? "observe",
      preset: config.control?.preset ?? "none", ruleIds: gate.ruleIds });

    // The key can come from the environment so it stays out of openclaw.json.
    if (!config.endpoint || !apiKey) {
      writeLog({ error: "xybernetex-openclaw remote observation disabled: set plugin config `endpoint` and XYBERNETEX_API_KEY " +
                        "(or plugin config `apiKey`) - see README" });
    }

    // One supervised trajectory = one agent run (a single user turn and all
    // its tool calls). Falls back to the session when a run id is missing.
    // Nothing is returned, and OpenClaw runs after_tool_call fire-and-forget,
    // so the agent never waits on the supervisor.
    api.on("after_tool_call", (event     , ctx     ) => {
      // What the agent just read: a delete command in it (a README step, a web
      // page) can't authorize itself, so its target is held (src/control.js).
      try { gate.noteToolResult(event, ctx); } catch { /* the gate still judges every call */ }
      try { outcomes?.noteToolCall(runKeyOf(event, ctx), event?.toolName, Boolean(event?.error)); } catch { /* best-effort */ }
      try { contracts?.noteToolCall(runKeyOf(event, ctx), event?.toolName, event?.params); } catch { /* best-effort */ }
      void supervisor.recordToolCall(runKeyOf(event, ctx), {
        toolName: event.toolName,
        params: event.params,
        error: event.error,
        toolCallId: event.toolCallId ?? ctx?.toolCallId,
        sessionKey: ctx?.sessionKey,
      });
    });

    // The run's total token spend, which OpenClaw reports once, after the
    // run. Logged on its own line (joinable on runKey) for later analysis -
    // too late to inform any decision in the run. Needs the conversation-
    // access grant; without it the line is simply never written.
    api.on("llm_output", (event     , ctx     ) => {
      const runKey = runKeyOf(event, ctx);
      writeLog({ runKey, runUsage: event?.usage ?? null, model: event?.model });
      outcomes?.noteUsage(runKey, Number(event?.usage?.total));
      if ((interventions || contracts) && typeof event?.model === "string") {
        const model = event.model.includes("/") && !event.model.startsWith("@") ? event.model
          : event.provider ? `${event.provider}/${event.model}` : event.model;
        runModels.set(runKey, model);
        while (runModels.size > 500) runModels.delete(runModels.keys().next().value);
      }
    });

    // Also needs the conversation-access grant; runs are LRU-evicted
    // regardless, so this only frees memory sooner.
    // Opt-in: one verification pass before a run's final answer (src/verify.js).
    // Invalid settings fail registration, like invalid control rules.
    if (config.verifyBeforeFinish) {
      const verify = createFinalizeVerifier({ ...config.verifyBeforeFinish, runKeyOf, log: writeLog,
        toolCallsFor: (runKey        ) => supervisor.toolCalls(runKey) });
      api.on("before_agent_finalize", (event     , ctx     ) => verify(event, ctx));
      writeLog({ type: "verify_ready", agentIds: config.verifyBeforeFinish.agentIds });
    }

    // Authorization context is per session, not per run: a later turn can
    // confirm an earlier request, and the agent's own files outlive a run.
    // Also the run's outcome for the report (scripts/report.mjs): whether it
    // ended cleanly, how long it took, how many tool calls it made. The error
    // is OpenClaw's own failure summary, cut short; messages are never logged.
    api.on("agent_end", (event     , ctx     ) => {
      const runKey = runKeyOf(event, ctx);
      const summary = { success: event?.success === true,
        error: typeof event?.error === "string" ? event.error.slice(0, 200) : null,
        durationMs: typeof event?.durationMs === "number" ? event.durationMs : null,
        toolCalls: supervisor.toolCalls(runKey) };
      // OpenClaw's own report misses the commonest deaths: a "successful" run
      // whose model said nothing (incomplete_turn), and an aborted run with no
      // error given (the reason is on its final message). Needs the transcript,
      // i.e. hooks.allowConversationAccess; without it the report stands.
      try {
        if (summary.success) {
          const empty = emptyRunError(event?.messages);
          if (empty) Object.assign(summary, { success: false, error: empty });
        } else if (!summary.error) {
          summary.error = lastReplyError(event?.messages);
        }
      } catch { /* transcript shape changed: leave it as reported */ }
      writeLog({ type: "run_end", runKey, sessionKey: ctx?.sessionKey, agentId: ctx?.agentId, ...summary });
      supervisor.endRun(runKey);
      outcomes?.noteRunEnd(runKey, summary.success);
      // Never awaited: an intervention can't hold up the end of a run. The
      // short wait lets OpenClaw report the run's model (llm_output lands
      // just after agent_end), so a follow-up runs on the same model.
      // A contract decides its run's follow-up; without one, the interventions rule does.
      if (interventions || contracts) {
        setTimeout(() => {
          const model = runModels.get(runKey) ?? null;
          runModels.delete(runKey);
          void (async () => {
            if (contracts && await contracts.onFixEnd(runKey, ctx)) return;  // one of our fix turns
            const decided = contracts ? await contracts.onRunEnd(runKey, ctx, summary, model) : null;
            const entry = decided ?? (interventions ? await interventions.onRunEnd(runKey, ctx, { ...summary, model }) : null);
            if (entry) outcomes?.open(entry, { ...summary, retriable: retriable(summary.error) });
          })().catch(() => {});
        }, 400);
      }
    });
    api.on("session_end", (_event     , ctx     ) => {
      if (ctx?.sessionKey) authz.endSession(ctx.sessionKey);
      if (ctx?.sessionKey) outcomes?.endSession(ctx.sessionKey);
      if (ctx?.sessionKey) contracts?.endSession(ctx.sessionKey);
    });
  },
};
