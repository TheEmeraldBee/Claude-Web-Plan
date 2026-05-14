import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { spawn } from "node:child_process";

import { startHttp, config, storage } from "./http.js";
import { state, type AskedQuestion } from "./state.js";
import {
  appendBlock,
  blockIdsIn,
  replaceBlock,
  validatePlanSource,
  validateReplacementBlock,
} from "./blocks.js";
import { projectSlugFromCwd } from "./config.js";
import {
  compilePlanFile,
  compileSourceForValidation,
  invalidate,
  PlanCompileError,
} from "./compile.js";
import { startWatch } from "./layout.js";

// ---------- helpers ----------

function ok(text: unknown) {
  return { content: [{ type: "text" as const, text: typeof text === "string" ? text : JSON.stringify(text, null, 2) }] };
}
function err(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

function formatCompileError(e: unknown): string {
  if (e instanceof PlanCompileError) {
    const d = e.detail;
    if (d.line !== undefined) {
      const lt = d.lineText ? `\n  ${d.lineText.trim()}` : "";
      return `${d.file ?? "plan.tsx"}:${d.line}:${d.column ?? 0} ${d.text ?? e.message}${lt}`;
    }
    return d.text ? `${d.file ?? "plan.tsx"}: ${d.text}` : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

function nowId(slug: string): string {
  const d = new Date();
  const ts = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}-${String(d.getHours()).padStart(2,"0")}${String(d.getMinutes()).padStart(2,"0")}`;
  return `${ts}-${slug}`;
}
function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "plan";
}

// ---------- tool schemas ----------

const QuestionSchema = z.object({
  text: z.string(),
  help: z.string().optional(),
  kind: z.enum(["single", "multi", "freeform", "confirm"]),
  options: z.array(z.string()).optional(),
  placeholder: z.string().optional(),
});

const CreatePlanSchema = z.object({
  title: z.string().min(1),
  source: z.string().min(1),
  project: z.string().optional(),
});

const UpdateBlockSchema = z.object({
  project: z.string().optional(),
  plan_id: z.string(),
  block_id: z.string(),
  replacement: z.string().min(1),
});

const AppendBlockSchema = z.object({
  project: z.string().optional(),
  plan_id: z.string(),
  source: z.string().min(1),
  after_block_id: z.string().optional(),
});

const SetStatusSchema = z.object({
  project: z.string().optional(),
  plan_id: z.string(),
  status: z.enum(["proposed", "approved", "implemented", "abandoned"]),
});

const SetStateSchema = z.object({
  state: z.enum(["idle", "thinking", "asking", "waiting", "implementing", "errored"]),
});

const AskUserSchema = z.object({
  questions: z.array(QuestionSchema).min(1),
  timeout_seconds: z.number().optional(),
});

const RegisterComponentSchema = z.object({
  project: z.string().optional(),
  name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  source: z.string().min(1),
});

const GetPlanSchema = z.object({
  project: z.string().optional(),
  plan_id: z.string(),
});

const ListPlansSchema = z.object({
  project: z.string().optional(),
});

const OpenSchema = z.object({
  project: z.string().optional(),
  plan_id: z.string().optional(),
});

const SetProjectMetaSchema = z.object({
  project: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  watch_path: z.string().optional(),
});

const CreateTabSchema = z.object({
  project: z.string().optional(),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  title: z.string().min(1),
  source: z.string().min(1),
});

const UpdateTabSchema = z.object({
  project: z.string().optional(),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  title: z.string().optional(),
  source: z.string().min(1),
});

const GetProjectSchema = z.object({
  project: z.string().optional(),
});

const DeletePlanSchema = z.object({
  project: z.string().optional(),
  plan_id: z.string(),
});

const CheckSchema = z.object({
  project: z.string().optional(),
  plan_id: z.string().optional(),
  tab_id: z.string().optional(),
});

interface CheckItem {
  kind: "plan" | "tab";
  id: string;
  ok: boolean;
  error?: string;
  block_ids?: string[];
}

// ---------- defaults ----------

function defaultProject(arg?: string): string {
  return arg ?? projectSlugFromCwd();
}

// ---------- tool handlers ----------

async function callToolImpl(name: string, args: unknown): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  switch (name) {
    case "wait_for_message": {
      state.setActivity({ kind: "waiting" });
      const text = await new Promise<string>((resolve) => {
        state.registerPending({ kind: "message", resolve });
      });
      state.setActivity({ kind: "thinking" });
      return ok(text);
    }

    case "ask_user": {
      const a = AskUserSchema.parse(args);
      const questions: AskedQuestion[] = a.questions;
      state.setActivity({ kind: "asking" });
      const result = await new Promise<{ questions: AskedQuestion[]; answers: unknown[] } | { timed_out: true }>((resolve) => {
        const id = state.registerPending({ kind: "ask_user", resolve, questions });
        state.broadcast({ type: "ask_user:open", id, payload: { questions, timeout_seconds: a.timeout_seconds ?? 1800 } });
        if (a.timeout_seconds && a.timeout_seconds > 0) {
          setTimeout(() => {
            const still = state.takePending(id);
            if (still && still.kind === "ask_user") still.resolve({ timed_out: true });
          }, a.timeout_seconds * 1000);
        }
      });
      state.setActivity({ kind: "thinking" });
      if ("timed_out" in result) return ok({ timed_out: true });
      const lines: string[] = ["User answers:", ""];
      result.questions.forEach((q, i) => {
        const ans = result.answers[i];
        lines.push(`${i+1}. ${q.text}`);
        if (Array.isArray(ans)) ans.forEach((a) => lines.push(`   → ${a}`));
        else lines.push(`   → ${ans ?? "(no answer)"}`);
      });
      return ok(lines.join("\n"));
    }

    case "create_plan": {
      const a = CreatePlanSchema.parse(args);
      const project = defaultProject(a.project);
      try { validatePlanSource(a.source); }
      catch (e) { return err(e instanceof Error ? e.message : String(e)); }
      // Dry-compile before persisting so the agent never sees ok for a plan
      // that won't render.
      try { await compileSourceForValidation(a.source, slugify(a.title)); }
      catch (e) { return err(`compile_failed: ${formatCompileError(e)}`); }
      const slug = slugify(a.title);
      const id = nowId(slug);
      const now = new Date().toISOString();
      storage.writePlan({
        meta: { id, title: a.title, slug, status: "proposed", created: now, modified: now, project },
        source: a.source,
        notes: {},
      });
      const url = `http://localhost:${config.port}/plans/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;
      state.broadcast({ type: "plan.created", planId: id, project });
      maybeOpen(url, "always");
      return ok({ plan_id: id, project, url });
    }

    case "update_block": {
      const a = UpdateBlockSchema.parse(args);
      const project = defaultProject(a.project);
      const rec = storage.readPlan(project, a.plan_id);
      if (!rec) return err(`plan_not_found: ${a.plan_id}`);
      if (rec.meta.status === "implemented") return err("plan_frozen");
      try { validateReplacementBlock(a.replacement, a.block_id); }
      catch (e) { return err(e instanceof Error ? e.message : String(e)); }
      let next: string;
      try { next = replaceBlock(rec.source, a.block_id, a.replacement); }
      catch (e) { return err(e instanceof Error ? e.message : String(e)); }
      try { validatePlanSource(next); }
      catch (e) { return err(e instanceof Error ? e.message : String(e)); }
      try { await compileSourceForValidation(next, a.plan_id); }
      catch (e) { return err(`compile_failed: ${formatCompileError(e)}`); }
      storage.updateSource(project, a.plan_id, next);
      invalidate(storage.basePath(project, a.plan_id) + ".plan.tsx");
      state.broadcast({ type: "block.updated", planId: a.plan_id, project, blockId: a.block_id });
      return ok({ plan_id: a.plan_id, block_id: a.block_id });
    }

    case "append_block": {
      const a = AppendBlockSchema.parse(args);
      const project = defaultProject(a.project);
      const rec = storage.readPlan(project, a.plan_id);
      if (!rec) return err(`plan_not_found: ${a.plan_id}`);
      if (rec.meta.status === "implemented") return err("plan_frozen");
      const appendedIds = blockIdsIn(a.source);
      if (appendedIds.length === 0) return err("appended_source_missing_block: append_block source must contain at least one <Block id=\"…\">…</Block>");
      let next: string;
      try { next = appendBlock(rec.source, a.source, a.after_block_id); }
      catch (e) { return err(e instanceof Error ? e.message : String(e)); }
      try { validatePlanSource(next); }
      catch (e) { return err(e instanceof Error ? e.message : String(e)); }
      try { await compileSourceForValidation(next, a.plan_id); }
      catch (e) { return err(`compile_failed: ${formatCompileError(e)}`); }
      storage.updateSource(project, a.plan_id, next);
      invalidate(storage.basePath(project, a.plan_id) + ".plan.tsx");
      for (const blockId of appendedIds) {
        state.broadcast({ type: "block.appended", planId: a.plan_id, project, blockId });
      }
      return ok({ plan_id: a.plan_id, block_ids: appendedIds });
    }

    case "register_component": {
      const a = RegisterComponentSchema.parse(args);
      const project = defaultProject(a.project);
      try { storage.appendComponent(project, a.name, a.source); }
      catch (e) { return err(e instanceof Error ? e.message : String(e)); }
      return ok({ name: a.name, hint: "import this component in your plan/tab source. Run `check` to confirm everything still compiles." });
    }

    case "set_plan_status": {
      const a = SetStatusSchema.parse(args);
      const project = defaultProject(a.project);
      const rec = storage.readPlan(project, a.plan_id);
      if (!rec) return err(`plan_not_found: ${a.plan_id}`);
      storage.setStatus(project, a.plan_id, a.status);
      state.broadcast({ type: "plan.status", planId: a.plan_id, project, status: a.status });
      return ok({ plan_id: a.plan_id, status: a.status });
    }

    case "set_state": {
      const a = SetStateSchema.parse(args);
      state.setActivity({ kind: a.state });
      return ok({ state: a.state });
    }

    case "list_plans": {
      const a = ListPlansSchema.parse(args);
      if (a.project) return ok({ project: a.project, plans: storage.listPlans(a.project) });
      const out: Record<string, unknown[]> = {};
      for (const p of storage.listProjects()) out[p] = storage.listPlans(p);
      return ok(out);
    }

    case "get_plan": {
      const a = GetPlanSchema.parse(args);
      const project = defaultProject(a.project);
      const rec = storage.readPlan(project, a.plan_id);
      if (!rec) return err(`plan_not_found: ${a.plan_id}`);
      try {
        const sourcePath = storage.basePath(project, a.plan_id) + ".plan.tsx";
        const compiled = await compilePlanFile(sourcePath);
        return ok({ meta: rec.meta, source: rec.source, notes: rec.notes, block_ids: compiled.blockIds, has_mermaid: compiled.hasMermaid });
      } catch (e) {
        return ok({ meta: rec.meta, source: rec.source, notes: rec.notes, compile_error: formatCompileError(e) });
      }
    }

    case "set_project_meta": {
      const a = SetProjectMetaSchema.parse(args);
      const project = defaultProject(a.project);
      storage.ensureProject(project);
      const patch: { name?: string; description?: string; watchPath?: string } = {};
      if (a.name !== undefined) patch.name = a.name;
      if (a.description !== undefined) patch.description = a.description;
      if (a.watch_path !== undefined) patch.watchPath = a.watch_path;
      const next = storage.setProjectMeta(project, patch);
      if (patch.watchPath !== undefined) {
        startWatch(project, next.watchPath, (p) => state.broadcast({ type: "layout:changed", project: p }));
      }
      state.broadcast({ type: "project.updated", project });
      return ok(next);
    }

    case "create_tab":
    case "update_tab": {
      const a = (name === "create_tab" ? CreateTabSchema : UpdateTabSchema).parse(args);
      const project = defaultProject(a.project);
      try { validatePlanSource(a.source); }
      catch (e) { return err(e instanceof Error ? e.message : String(e)); }
      try { await compileSourceForValidation(a.source, `tab-${a.id}`); }
      catch (e) { return err(`compile_failed: ${formatCompileError(e)}`); }
      const title = ("title" in a && a.title) ? a.title : a.id;
      storage.writeTab(project, a.id, title, a.source);
      invalidate(storage.tabPath(project, a.id));
      state.broadcast({ type: "tab.updated", project, tabId: a.id });
      return ok({ project, tab_id: a.id, title });
    }

    case "get_project": {
      const a = GetProjectSchema.parse(args);
      const project = defaultProject(a.project);
      const meta = storage.readProject(project);
      if (!meta) return err(`project_not_found: ${project}`);
      return ok(meta);
    }

    case "open_in_browser": {
      const a = OpenSchema.parse(args);
      const path = a.plan_id ? `/plans/${encodeURIComponent(defaultProject(a.project))}/${encodeURIComponent(a.plan_id)}` : "/";
      const url = `http://localhost:${config.port}${path}`;
      maybeOpen(url, "always");
      return ok({ url });
    }

    case "delete_plan": {
      const a = DeletePlanSchema.parse(args);
      const project = defaultProject(a.project);
      const rec = storage.readPlan(project, a.plan_id);
      if (!rec) return err(`plan_not_found: ${a.plan_id}`);
      const removed = storage.deletePlan(project, a.plan_id);
      invalidate(storage.basePath(project, a.plan_id) + ".plan.tsx");
      state.broadcast({ type: "plan.deleted", planId: a.plan_id, project });
      return ok({ deleted: removed, plan_id: a.plan_id, project });
    }

    case "check": {
      const a = CheckSchema.parse(args);
      const project = defaultProject(a.project);
      const meta = storage.readProject(project);
      if (!meta) return err(`project_not_found: ${project}`);
      const items: CheckItem[] = [];

      const plans = a.plan_id
        ? (storage.readPlan(project, a.plan_id) ? [{ id: a.plan_id }] : [])
        : storage.listPlans(project).map((p) => ({ id: p.id }));
      if (a.plan_id && plans.length === 0) return err(`plan_not_found: ${a.plan_id}`);

      const tabs = a.tab_id
        ? meta.tabs.filter((t) => t.kind === "custom" && t.id === a.tab_id)
        : meta.tabs.filter((t) => t.kind === "custom");
      if (a.tab_id && tabs.length === 0) return err(`tab_not_found: ${a.tab_id}`);

      // If both plan_id and tab_id were omitted we check everything;
      // if one was given, narrow accordingly.
      const checkPlans = a.tab_id ? [] : plans;
      const checkTabs = a.plan_id && !a.tab_id ? [] : tabs;

      for (const p of checkPlans) {
        const path = storage.basePath(project, p.id) + ".plan.tsx";
        invalidate(path);
        try {
          const r = await compilePlanFile(path);
          items.push({ kind: "plan", id: p.id, ok: true, block_ids: r.blockIds });
        } catch (e) {
          items.push({ kind: "plan", id: p.id, ok: false, error: formatCompileError(e) });
        }
      }
      for (const t of checkTabs) {
        const path = storage.tabPath(project, t.id);
        invalidate(path);
        try {
          const r = await compilePlanFile(path);
          items.push({ kind: "tab", id: t.id, ok: true, block_ids: r.blockIds });
        } catch (e) {
          items.push({ kind: "tab", id: t.id, ok: false, error: formatCompileError(e) });
        }
      }
      const allOk = items.every((i) => i.ok);
      return ok({ project, ok: allOk, items });
    }

    default:
      return err(`unknown_tool: ${name}`);
  }
}

function maybeOpen(url: string, policy: "always" | "on-ask" | "never") {
  const effective = policy === "always" ? "always" : config.autoLaunch;
  if (effective === "never") return;
  if (!config.openCommand) return;
  const cmd = config.openCommand.replace(/\{url\}/g, url);
  try {
    const parts = cmd.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return;
    spawn(parts[0]!, parts.slice(1), { stdio: "ignore", detached: true }).unref();
  } catch (e) {
    console.error(`[web-planner] open command failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------- MCP wiring ----------

const TOOLS = [
  { name: "wait_for_message", description: "Block until the user sends a message (browser chat, wp send, or feedback bundle). No timeout. The planner's outer-loop primitive.", inputSchema: { type: "object", properties: {} } },
  { name: "ask_user", description: "Push structured questions to the browser; block until the user submits. Times out cleanly.", inputSchema: { type: "object", properties: { questions: { type: "array" }, timeout_seconds: { type: "number" } }, required: ["questions"] } },
  { name: "create_plan", description: "Submit a full .plan.tsx source. Server validates structure + block ids and dry-compiles before persisting; on compile_failed the plan is NOT saved.", inputSchema: { type: "object", properties: { title: { type: "string" }, source: { type: "string" }, project: { type: "string" } }, required: ["title","source"] } },
  { name: "update_block", description: "Replace one <Block id='...'> in a plan. Replacement MUST be exactly one <Block> with the same id. Server dry-compiles the resulting plan; rejected on implemented plans.", inputSchema: { type: "object", properties: { plan_id: { type: "string" }, block_id: { type: "string" }, replacement: { type: "string" }, project: { type: "string" } }, required: ["plan_id","block_id","replacement"] } },
  { name: "append_block", description: "Insert one or more new <Block>s after an existing one (or before </Plan>). Server dry-compiles before persisting.", inputSchema: { type: "object", properties: { plan_id: { type: "string" }, source: { type: "string" }, after_block_id: { type: "string" }, project: { type: "string" } }, required: ["plan_id","source"] } },
  { name: "register_component", description: "Append a Preact component to the project's components.tsx for use as a new block kind. You must then import it in your plan/tab source.", inputSchema: { type: "object", properties: { name: { type: "string" }, source: { type: "string" }, project: { type: "string" } }, required: ["name","source"] } },
  { name: "set_plan_status", description: "Move plan between proposed/approved/implemented/abandoned. Implemented plans become read-only (but can still be delete_plan'd).", inputSchema: { type: "object", properties: { plan_id: { type: "string" }, status: { type: "string" }, project: { type: "string" } }, required: ["plan_id","status"] } },
  { name: "set_state", description: "Override the implicit activity state (e.g. 'implementing' while running edits).", inputSchema: { type: "object", properties: { state: { type: "string" } }, required: ["state"] } },
  { name: "list_plans", description: "List plans for a project (or all projects).", inputSchema: { type: "object", properties: { project: { type: "string" } } } },
  { name: "get_plan", description: "Read a plan: source, notes, block ids. Includes compile_error if the persisted plan currently fails to render.", inputSchema: { type: "object", properties: { plan_id: { type: "string" }, project: { type: "string" } }, required: ["plan_id"] } },
  { name: "open_in_browser", description: "Spawn the configured open-command against a plan or the dashboard.", inputSchema: { type: "object", properties: { plan_id: { type: "string" }, project: { type: "string" } } } },
  { name: "set_project_meta", description: "Set a project's name, description, and/or watchPath (the source directory shown in the Layout tab).", inputSchema: { type: "object", properties: { project: { type: "string" }, name: { type: "string" }, description: { type: "string" }, watch_path: { type: "string" } } } },
  { name: "create_tab", description: "Create a custom tab on a project's page from a Preact .tab.tsx source. id must be lowercase kebab. Dry-compiled before persisting.", inputSchema: { type: "object", properties: { project: { type: "string" }, id: { type: "string" }, title: { type: "string" }, source: { type: "string" } }, required: ["id","title","source"] } },
  { name: "update_tab", description: "Update an existing custom tab's source. Dry-compiled before persisting.", inputSchema: { type: "object", properties: { project: { type: "string" }, id: { type: "string" }, title: { type: "string" }, source: { type: "string" } }, required: ["id","source"] } },
  { name: "get_project", description: "Read project metadata (name, description, watchPath, tabs).", inputSchema: { type: "object", properties: { project: { type: "string" } } } },
  { name: "delete_plan", description: "Permanently delete a plan (source + meta + notes). Allowed on any status, including implemented. Broadcasts plan.deleted on SSE.", inputSchema: { type: "object", properties: { plan_id: { type: "string" }, project: { type: "string" } }, required: ["plan_id"] } },
  { name: "check", description: "Re-compile a plan, a custom tab, or every plan + custom tab in a project. Returns { ok, items: [{ kind, id, ok, error?, block_ids? }] }. Call after every create/update to confirm the persisted state renders.", inputSchema: { type: "object", properties: { project: { type: "string" }, plan_id: { type: "string" }, tab_id: { type: "string" } } } },
];

function spawnExistingWatchers() {
  for (const project of storage.listProjects()) {
    const meta = storage.readProject(project);
    if (meta?.watchPath) {
      startWatch(project, meta.watchPath, (p) => state.broadcast({ type: "layout:changed", project: p }));
    }
  }
}

async function main() {
  await startHttp();
  spawnExistingWatchers();
  const server = new Server({ name: "web-planner", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return callToolImpl(req.params.name, req.params.arguments ?? {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[web-planner] mcp ready");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
