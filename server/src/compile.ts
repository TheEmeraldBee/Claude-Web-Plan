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

export interface CompileErrorDetail {
  file?: string;
  line?: number;
  column?: number;
  text?: string;
  lineText?: string;
}

export class PlanCompileError extends Error {
  readonly detail: CompileErrorDetail;
  constructor(message: string, detail: CompileErrorDetail = {}) {
    super(message);
    this.name = "PlanCompileError";
    this.detail = detail;
  }
}

interface EsbuildMessageShape {
  text?: string;
  location?: { file?: string; line?: number; column?: number; lineText?: string };
}
interface EsbuildBuildFailureShape {
  errors?: EsbuildMessageShape[];
  message?: string;
}

function isBuildFailure(e: unknown): e is EsbuildBuildFailureShape {
  return !!e && typeof e === "object" && Array.isArray((e as { errors?: unknown }).errors);
}

function fromEsbuildFailure(e: EsbuildBuildFailureShape, fallbackFile: string): PlanCompileError {
  const first = e.errors?.[0];
  const loc = first?.location;
  const text = first?.text ?? e.message ?? "compile_failed";
  const file = loc?.file ?? fallbackFile;
  const detail: CompileErrorDetail = {
    file,
    line: loc?.line,
    column: loc?.column,
    text,
    lineText: loc?.lineText,
  };
  const pretty = loc
    ? `${file}:${loc.line ?? "?"}:${loc.column ?? "?"}: ${text}`
    : `${file}: ${text}`;
  return new PlanCompileError(pretty, detail);
}

export async function compilePlanFile(planSourcePath: string): Promise<CompileResult> {
  const stat = statSync(planSourcePath);
  const cached = cache.get(planSourcePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return { html: cached.html, hasMermaid: cached.hasMermaid, blockIds: cached.blockIds };
  }

  const tmp = mkdtempSync(join(tmpdir(), "web-planner-compile-"));
  const outFile = join(tmp, "plan.mjs");
  try {
    try {
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
    } catch (e) {
      if (isBuildFailure(e)) throw fromEsbuildFailure(e, planSourcePath);
      throw e;
    }

    let mod: { default?: () => unknown };
    try {
      mod = (await import(pathToFileURL(outFile).href + "?t=" + stat.mtimeMs)) as { default?: () => unknown };
    } catch (e) {
      throw new PlanCompileError(
        `${planSourcePath}: module import failed: ${e instanceof Error ? e.message : String(e)}`,
        { file: planSourcePath, text: e instanceof Error ? e.message : String(e) },
      );
    }
    if (typeof mod.default !== "function") {
      throw new PlanCompileError(`${planSourcePath}: plan_missing_default_export`, {
        file: planSourcePath,
        text: "plan must `export default () => <Plan ...>…</Plan>`",
      });
    }
    let vnode: unknown;
    try {
      vnode = mod.default();
    } catch (e) {
      throw new PlanCompileError(
        `${planSourcePath}: default export threw: ${e instanceof Error ? e.message : String(e)}`,
        { file: planSourcePath, text: e instanceof Error ? e.message : String(e) },
      );
    }
    let html: string;
    try {
      html = (renderToString as unknown as (v: unknown) => string)(vnode);
    } catch (e) {
      throw new PlanCompileError(
        `${planSourcePath}: render failed: ${e instanceof Error ? e.message : String(e)}`,
        { file: planSourcePath, text: e instanceof Error ? e.message : String(e) },
      );
    }
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
}

/**
 * Dry-compile a plan/tab source string without touching the persistent store.
 * Used by the MCP layer to validate before commit, so we never persist a plan
 * that won't render. Throws PlanCompileError on failure.
 */
export async function compileSourceForValidation(source: string, label: string = "plan"): Promise<CompileResult> {
  const tmp = mkdtempSync(join(tmpdir(), "web-planner-validate-"));
  const file = join(tmp, `${label}.plan.tsx`);
  writeFileSync(file, source, "utf8");
  try {
    return await compilePlanFile(file);
  } finally {
    cache.delete(file);
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function clearCache() {
  cache.clear();
}

export function writeJunkForTest(path: string, source: string) {
  writeFileSync(path, source, "utf8");
}
