import { build } from "esbuild";
import { statSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import renderToString from "preact-render-to-string";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface CacheEntry {
  mtimeMs: number;
  html: string;
  hasMermaid: boolean;
  blockIds: string[];
}

const cache = new Map<string, CacheEntry>();

function kitDir(): string {
  // server/src/compile.ts -> server/src -> server -> root -> kit/src
  return resolve(__dirname, "..", "..", "kit", "src");
}

export interface CompileResult {
  html: string;
  hasMermaid: boolean;
  blockIds: string[];
}

export async function compilePlanFile(planSourcePath: string): Promise<CompileResult> {
  const stat = statSync(planSourcePath);
  const cached = cache.get(planSourcePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return { html: cached.html, hasMermaid: cached.hasMermaid, blockIds: cached.blockIds };
  }

  const tmp = mkdtempSync(join(tmpdir(), "web-planner-compile-"));
  try {
    const outFile = join(tmp, "plan.mjs");
    await build({
      entryPoints: [planSourcePath],
      bundle: true,
      format: "esm",
      platform: "node",
      jsx: "automatic",
      jsxImportSource: "preact",
      outfile: outFile,
      external: [],
      alias: {
        "@web-planner/kit": kitDir(),
      },
      // Resolve preact/jsx-runtime upward from the kit source dir. esbuild's
      // alias values resolve from cwd (the client's project), which may not
      // have preact installed — but the web-planner install always does.
      nodePaths: [resolve(__dirname, "..", "..", "node_modules")],
      logLevel: "silent",
    });

    const mod = (await import(pathToFileURL(outFile).href + "?t=" + stat.mtimeMs)) as {
      default?: () => unknown;
    };
    if (typeof mod.default !== "function") {
      throw new Error("plan_missing_default_export");
    }
    const vnode = mod.default();
    // preact-render-to-string is callable as a function
    const html = (renderToString as unknown as (v: unknown) => string)(vnode);
    const hasMermaid = /data-mermaid/.test(html);
    const blockIds = Array.from(html.matchAll(/data-block-id="([^"]+)"/g)).map((m) => m[1] as string);

    const entry: CacheEntry = { mtimeMs: stat.mtimeMs, html, hasMermaid, blockIds };
    cache.set(planSourcePath, entry);
    return { html, hasMermaid, blockIds };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function invalidate(planSourcePath: string) {
  cache.delete(planSourcePath);
  // bust import cache via fresh tmp dir on next call (already do that)
}

export function clearCache() {
  cache.clear();
}

export function writeJunkForTest(path: string, source: string) {
  writeFileSync(path, source, "utf8");
}
