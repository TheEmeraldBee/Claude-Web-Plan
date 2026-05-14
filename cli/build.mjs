import { build } from "esbuild";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";

mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/wp.ts"],
  outfile: "dist/wp.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});
chmodSync("dist/wp.mjs", 0o755);
console.log("built dist/wp.mjs");
