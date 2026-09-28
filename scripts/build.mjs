// Compiles index.ts to dist/index.js. OpenClaw loads TypeScript straight
// from a source checkout, but a packaged install (npm, .tgz) must ship
// JavaScript. index.ts only uses erasable type syntax, so Node's own type
// stripping is the whole build - no compiler dependency. Runs on `npm pack`;
// test/build.test.js fails if the committed dist/ is stale.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function build() {
  const source = readFileSync(join(ROOT, "index.ts"), "utf8");
  const js = stripTypeScriptTypes(source, { mode: "strip" })
    // dist/ is one level down from the modules index.ts imports.
    .replace(/from "\.\/src\//g, 'from "../src/');
  return `// Generated from index.ts by scripts/build.mjs - edit index.ts, then run npm run build.\n${js}`;
}

if (process.argv[1]?.endsWith("build.mjs")) {
  mkdirSync(join(ROOT, "dist"), { recursive: true });
  writeFileSync(join(ROOT, "dist", "index.js"), build());
  console.log("wrote dist/index.js");
}
