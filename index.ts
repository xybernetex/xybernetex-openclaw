import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_PATH = join(homedir(), ".openclaw", "xybernetex-openclaw.log.jsonl");

const DECLINE_RATE = 0.03;
const REPORT_NOISE_STD = 0.05;
// Smoothing correction against the running estimate. Swap this for a call
// to a real inference backend once you have one - see README.md.
const SMOOTHING_ALPHA = 0.5;

let trueValue = 1000;
let institutionalBelief = 1000;
let tick = 0;

function gaussianNoise(std: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return z * std;
}

function extractEstimate(text: string): number | null {
  const match = text.match(/Estimate:\s*(-?\d+(?:\.\d+)?)/i);
  return match ? parseFloat(match[1]) : null;
}

function log(entry: Record<string, unknown>) {
  try {
    appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // best-effort logging only
  }
}

function contentToText(content: unknown): string | null {
  if (typeof content === "string" && content.length > 0) return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part: any) => (typeof part === "string" ? part : part?.text ?? ""))
      .join("");
    return text.length > 0 ? text : null;
  }
  return null;
}

function getReplyText(event: any): string | null {
  const msg = event?.lastAssistantMessage;
  if (typeof msg === "string" && msg.length > 0) return msg;
  if (msg && typeof msg === "object") {
    const fromContent = contentToText(msg.content);
    if (fromContent) return fromContent;
    if (typeof msg.text === "string" && msg.text.length > 0) return msg.text;
  }
  const messages = event?.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    const last = messages[messages.length - 1];
    const fromLast = contentToText(last?.content);
    if (fromLast) return fromLast;
  }
  return null;
}

export default definePluginEntry({
  id: "xybernetex-openclaw",
  name: "Xybernetex for OpenClaw",
  description: "Keeps a tracked estimate calibrated to reality over time instead of drifting.",
  register(api) {
    api.on("heartbeat_prompt_contribution", async () => {
      tick += 1;
      trueValue = trueValue * (1 - DECLINE_RATE);
      const noisyReport = trueValue * (1 + gaussianNoise(REPORT_NOISE_STD));

      const contribution =
        `[Reservoir Monitor - tick ${tick}]\n` +
        `You are monitoring the water volume of a reservoir, measured in cubic meters.\n` +
        `Latest sensor reading: approximately ${noisyReport.toFixed(1)} cubic meters.\n` +
        `Your previous official estimate was: ${institutionalBelief.toFixed(1)} cubic meters.\n\n` +
        `Task: based on the sensor reading and your previous estimate, give your best current ` +
        `numeric estimate of the true reservoir volume.\n` +
        `Reply with exactly one line in this exact format, replacing 000 with your actual ` +
        `numeric estimate (a plain number, no units, no extra words):\n` +
        `Estimate: 000`;

      log({ tick, trueValue, noisyReport, institutionalBelief, hookStage: "contribution", contribution });

      return { appendContext: contribution };
    });

    api.on("before_agent_finalize", async (event: any) => {
      const text = getReplyText(event);
      if (text === null) {
        const msg = event?.lastAssistantMessage;
        log({ tick, trueValue, institutionalBelief, rawEstimate: null,
              note: "could not find reply text field",
              lastAssistantMessageType: typeof msg,
              lastAssistantMessageKeys: msg && typeof msg === "object" ? Object.keys(msg) : null });
        return;
      }

      const rawEstimate = extractEstimate(text);
      if (rawEstimate === null) {
        log({ tick, trueValue, institutionalBelief, rawEstimate: null,
              note: "reply text found but no Estimate: line parsed", replyPreview: text.slice(0, 200) });
        return;
      }

      const correctedBelief = SMOOTHING_ALPHA * rawEstimate + (1 - SMOOTHING_ALPHA) * institutionalBelief;
      const relativeError = Math.abs(correctedBelief - trueValue) / trueValue;

      log({ tick, trueValue, institutionalBelief, rawEstimate, correctedBelief, relativeError });
      institutionalBelief = correctedBelief;
    });
  },
});
