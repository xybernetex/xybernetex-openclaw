#!/usr/bin/env node
// `npx xybernetex-openclaw [setup options]` installs; `... report`, `... audit`
// and `... test` run the tools. One entry point because npx resolves a
// *package* by name: a separate `npx xybernetex-report` would look for (and
// run) whatever package someone published under that name.
const TOOLS = { report: "./report.mjs", audit: "./audit.mjs", test: "./selftest.mjs" };
const tool = TOOLS[process.argv[2]];
if (tool) {
  process.argv.splice(2, 1);
  await import(tool);
} else {
  if (process.argv[2] === "setup") process.argv.splice(2, 1);
  await import("./setup.mjs");
}
