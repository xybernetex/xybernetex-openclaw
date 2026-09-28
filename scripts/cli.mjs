#!/usr/bin/env node
// `npx xybernetex-openclaw [setup options]` installs; `... report [options]`
// builds the report. One entry point because npx resolves a *package* by
// name: a separate `npx xybernetex-report` would look for (and run) whatever
// package someone published under that name.
if (process.argv[2] === "report") {
  process.argv.splice(2, 1);
  await import("./report.mjs");
} else {
  if (process.argv[2] === "setup") process.argv.splice(2, 1);
  await import("./setup.mjs");
}
