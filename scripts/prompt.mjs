// Terminal prompts that work on Windows consoles. Hidden input reads raw
// keystrokes itself (no echo, pastes arrive once) instead of muting
// readline's output, which on Windows echoed secrets and doubled pastes.
// Keep in sync with the copy in the other repo (xybernetex-app / xybernetex-openclaw).
import { createInterface } from "node:readline";

// Piped input (tests, scripts): one reader for all of it - separate readline
// interfaces on a pipe each buffer ahead and lose lines.
let piped = null;
async function nextPipedLine() {
  piped ??= createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const { value } = await piped.next();
  return (value ?? "").trim();
}

export async function ask(question) {
  if (!process.stdin.isTTY) {
    process.stdout.write(question);
    const value = await nextPipedLine();
    process.stdout.write("\n");
    return value;
  }
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); done(answer.trim()); });
  });
}

export function askHidden(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(question); // piped input: nothing to echo anyway
  return new Promise((done) => {
    process.stdout.write(question);
    let value = "";
    const finish = (result) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write(result ? ` (${result.length} characters)\n` : "\n");
      done(result);
    };
    function onData(chunk) {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish(value.trim());
        if (ch === "\u0003") { // Ctrl+C
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u0008" || ch === "\u007f") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    }
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}
