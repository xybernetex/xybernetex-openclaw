import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyShellCommand, classifyToolCall } from "../src/risk.js";

function expectAll(cases) {
  for (const [command, expected] of cases) {
    assert.equal(classifyShellCommand(command), expected, command);
  }
}

test("the exec commands from real OpenClaw runs get the right tier", () => {
  // Verbatim from the 2026-09-25 test sessions, where every one of these
  // was judged destructive because the tool is named exec.
  expectAll([
    ["python scratch/fib.py", "none"],
    ["python scratch\\primes.py", "none"],
    ['python -m unittest discover -s scratch -p "test_*.py" -v', "none"],
    ["Get-ChildItem -Force | Select-Object Mode, Length, Name | Format-Table -AutoSize", "none"],
    ["Get-ChildItem -Path . -Filter *.md -Recurse -File | Select-Object -ExpandProperty FullName", "none"],
    ['if (Test-Path .\\supervisor-test.txt) { Write-Output "FOUND: supervisor-test.txt" } else { Write-Output "MISSING" }; $pyc = Get-ChildItem -Path .\\scratch -Recurse -Directory -Filter __pycache__', "none"],
    ['Remove-Item -Path .\\supervisor-test.txt -Force; if (Test-Path .\\supervisor-test.txt) { Write-Output "ERROR: still exists" } else { Write-Output "DELETED: supervisor-test.txt" }', "destructive"],
  ]);
});

test("destructive shell commands, bash and PowerShell", () => {
  expectAll([
    ["rm -rf build", "destructive"],
    ["sudo rm /etc/hosts", "destructive"],
    ["ls *.log | xargs rm", "destructive"],
    ["find . -name '*.tmp' -delete", "destructive"],
    ["find . -name '*.tmp' -exec rm {} \\;", "destructive"],
    ["del /q C:\\temp\\*", "destructive"],
    ["Get-ChildItem .\\logs | Remove-Item -Recurse", "destructive"],
    ["Clear-Content .\\notes.txt", "destructive"],
    ["git reset --hard HEAD~3", "destructive"],
    ["git clean -fdx", "destructive"],
    ["git push --force origin main", "destructive"],
    ["git branch -D old-feature", "destructive"],
    ["docker system prune -af", "destructive"],
    ["kubectl delete pod web-1", "destructive"],
    ["terraform destroy -auto-approve", "destructive"],
    ["npx wrangler kv key delete version --binding WEIGHTS", "destructive"],
    ['psql -c "DROP TABLE users"', "destructive"],
    ['sqlite3 app.db "DELETE FROM sessions"', "destructive"],
    ["npm unpublish my-pkg@1.0.0", "destructive"],
  ]);
});

test("sensitive shell commands reach outside the machine", () => {
  expectAll([
    ["git push origin main", "sensitive"],
    ["npm publish", "sensitive"],
    ["npx wrangler deploy", "sensitive"],
    ["gh pr create --fill", "sensitive"],
    ["docker push registry.example.com/app:1", "sensitive"],
    ["terraform apply", "sensitive"],
    ["scp build.zip user@host:/srv", "sensitive"],
    ["curl -X POST https://api.example.com/items -d '{}'", "sensitive"],
    ['Invoke-RestMethod -Uri https://api.example.com -Method "POST" -Body $json', "sensitive"],
    ["Send-MailMessage -To a@b.c -Subject hi", "sensitive"],
    ["taskkill /IM node.exe /F", "sensitive"],
  ]);
});

test("ordinary work stays none, including lookalikes", () => {
  expectAll([
    ["git status", "none"],
    ['git commit -m "drop table support, delete from cache"', "none"],
    ["git log --oneline -5", "none"],
    ["npm install lodash", "none"],
    ["npm rm lodash", "none"],
    ["npm run build", "none"],
    ["pip install requests", "none"],
    ["curl https://example.com", "none"],
    ["kubectl get pods", "none"],
    ["Clear-Host", "none"],
    ['echo "rm -rf is dangerous"', "none"],
    ["Format-Table -AutoSize", "none"],
    ["", "none"],
  ]);
});

test("a chain is as risky as its worst part", () => {
  assert.equal(classifyShellCommand("npm test && git push"), "sensitive");
  assert.equal(classifyShellCommand("git push; rm -rf dist"), "destructive");
});

test("non-shell tools", () => {
  assert.equal(classifyToolCall("exec", { command: "python x.py" }), "none");
  assert.equal(classifyToolCall("exec", { command: "rm -rf /" }), "destructive");
  assert.equal(classifyToolCall("read", { file_path: "a.txt" }), "none");
  assert.equal(classifyToolCall("write", { file_path: "notes.md", content: "x" }), "none");
  assert.equal(classifyToolCall("write", { file_path: "C:\\Users\\me\\.ssh\\config", content: "x" }), "sensitive");
  assert.equal(classifyToolCall("edit", { path: "app/.env.production" }), "sensitive");
  assert.equal(classifyToolCall("apply_patch", { input: "*** Begin Patch\n*** Delete File: old.py\n*** End Patch" }), "destructive");
  assert.equal(classifyToolCall("apply_patch", { input: "*** Begin Patch\n*** Update File: src/a.js\n*** End Patch" }), "none");
  assert.equal(classifyToolCall("message", { action: "send", to: "x", text: "hi" }), "sensitive");
  assert.equal(classifyToolCall("message", { action: "read" }), "none");
  assert.equal(classifyToolCall("message", { action: "delete", id: "1" }), "destructive");
  assert.equal(classifyToolCall("cron", { action: "list" }), "none");
  assert.equal(classifyToolCall("cron", { action: "add" }), "sensitive");
  assert.equal(classifyToolCall("github_publish", {}), "sensitive");
  assert.equal(classifyToolCall("web_fetch", { url: "https://x" }), "none");
  assert.equal(classifyToolCall("some_mcp_tool", { x: 1 }), null);
  assert.equal(classifyToolCall("tool_call", { id: "web_fetch" }), null);
});
