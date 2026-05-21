import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { startHttp, config, storage } from "./http.js";
import { state, type AskedQuestion } from "./state.js";
import { THEMES } from "./themes.js";
import { STATUSES } from "./storage.js";
import {
  appendBlock,
  blockIdsIn,
  replaceBlock,
  validateModalSource,
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
import { nowId, slugify } from "./ids.js";

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

function mergeKitImports(source: string, newNames: string[]): string {
  // Tolerate multi-line import bodies — the previous regex anchored to a
  // single line (^...$ with /m) and silently no-op'd on any wrapped import,
  // producing a "Component is not defined" failure at compile time.
  const re = /(import\s*\{)([^}]+)(\}\s*from\s*["']@web-planner\/kit["'];?)/;
  const m = source.match(re);
  if (!m) return source;
  const existing = m[2]!.split(",").map((s) => s.trim()).filter(Boolean);
  const merged = [...new Set([...existing, ...newNames])].sort().join(", ");
  return source.replace(re, `${m[1]} ${merged} ${m[3]}`);
}

// ---------- tool schemas ----------

const QuestionSchema = z.object({
  text: z.string(),
  help: z.string().optional(),
  kind: z.enum(["single", "multi", "freeform", "confirm"]),
  options: z.array(z.string()).optional(),
  placeholder: z.string().optional(),
  allow_other: z.boolean().optional(),
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
  imports: z.array(z.string()).optional(),
});

const SetStatusSchema = z.object({
  project: z.string().optional(),
  plan_id: z.string(),
  status: z.enum(STATUSES),
});

const SetStateSchema = z.object({
  state: z.string().min(1),
  color: z.string().optional(),
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

const SetThemeSchema = z.object({
  project: z.string().optional(),
  theme: z.union([z.string(), z.record(z.string())]),
});

const InitHomepageSchema = z.object({
  project: z.string().optional(),
});

const ListCommentsSchema = z.object({
  project: z.string().optional(),
});

const OpenModalSchema = z.object({
  title: z.string().min(1),
  source: z.string().min(1),
  project: z.string().optional(),
});

const GetCommentsSchema = z.object({
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
  mermaid_errors?: import("./compile.js").MermaidError[];
}

// ---------- defaults ----------

function defaultProject(arg?: string): string {
  return arg ?? projectSlugFromCwd();
}

// ---------- tool handlers ----------

async function callToolImpl(name: string, args: unknown, signal?: AbortSignal): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  switch (name) {
    case "wait_for_message": {
      // If anything queued during the previous turn, deliver the FRESHEST
      // entry immediately and drop the older ones. The freshest is almost
      // always what the user actually wants the agent to answer; dropping
      // everything (the previous behavior) silently swallowed messages
      // racing with the call.
      const fresh = state.takeFreshest();
      if (fresh) return ok(fresh.text);
      state.setActivity({ kind: "waiting" });
      const text = await new Promise<string>((resolve, reject) => {
        const id = state.registerPending({ kind: "message", resolve });
        signal?.addEventListener("abort", () => {
          state.takePending(id);
          reject(new Error("wait_for_message cancelled"));
        }, { once: true });
      });
      return ok(text);
    }

    case "ask_user": {
      const a = AskUserSchema.parse(args);
      const questions: AskedQuestion[] = a.questions;
      state.setActivity({ kind: "asking" });
      const result = await new Promise<{ questions: AskedQuestion[]; answers: unknown[] } | { timed_out: true }>((resolve) => {
        const pending: import("./state.js").PendingAsk = { kind: "ask_user", resolve, questions };
        const id = state.registerPending(pending);
        state.broadcast({ type: "ask_user:open", id, payload: { questions, timeout_seconds: a.timeout_seconds ?? 1800 } });
        if (a.timeout_seconds && a.timeout_seconds > 0) {
          // Store the handle on the pending entry so handleAnswer can clear
          // it when the user submits; otherwise the timer kept a closure
          // pinned in memory for up to 30 minutes per ask.
          pending.timeout = setTimeout(() => {
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
        const fmt = (a: unknown) =>
          typeof a === "string" && a.startsWith("__other__:")
            ? `Other: ${a.slice(10)}`
            : String(a ?? "(no answer)");
        if (Array.isArray(ans)) ans.forEach((a) => lines.push(`   → ${fmt(a)}`));
        else lines.push(`   → ${fmt(ans)}`);
      });
      return ok(lines.join("\n"));
    }

    case "create_plan": {
      const a = CreatePlanSchema.parse(args);
      const project = defaultProject(a.project);
      try { validatePlanSource(a.source); }
      catch (e) { return err(e instanceof Error ? e.message : String(e)); }
      try { await compileSourceForValidation(a.source, slugify(a.title)); }
      catch (e) { return err(`compile_failed: ${formatCompileError(e)}`); }
      const slug = slugify(a.title);
      const id = nowId(slug);
      const now = new Date().toISOString();
      storage.writePlan({
        meta: { id, title: a.title, slug, status: "designing", created: now, modified: now, project },
        source: a.source,
      });
      const url = `http://localhost:${config.port}/plans/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;
      state.broadcast({ type: "plan.created", planId: id, project });
      return ok({ plan_id: id, project, url });
    }

    case "update_block": {
      const a = UpdateBlockSchema.parse(args);
      const project = defaultProject(a.project);
      const rec = storage.readPlan(project, a.plan_id);
      if (!rec) return err(`plan_not_found: ${a.plan_id}`);
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
      if (storage.clearComment(project, "plan", a.plan_id, a.block_id)) {
        state.broadcast({ type: "comment:cleared", project, target_kind: "plan", target_id: a.plan_id, blockId: a.block_id });
      }
      return ok({ plan_id: a.plan_id, block_id: a.block_id });
    }

    case "append_block": {
      const a = AppendBlockSchema.parse(args);
      const project = defaultProject(a.project);
      const rec = storage.readPlan(project, a.plan_id);
      if (!rec) return err(`plan_not_found: ${a.plan_id}`);
      const appendedIds = blockIdsIn(a.source);
      if (appendedIds.length === 0) return err("appended_source_missing_block: append_block source must contain at least one <Block id=\"…\">…</Block>");
      let base = rec.source;
      if (a.imports && a.imports.length > 0) base = mergeKitImports(base, a.imports);
      let next: string;
      try { next = appendBlock(base, a.source, a.after_block_id); }
      catch (e) { return err(e instanceof Error ? e.message : String(e)); }
      try { validatePlanSource(next); }
      catch (e) { return err(e instanceof Error ? e.message : String(e)); }
      try { await compileSourceForValidation(next, a.plan_id); }
      catch (e) { return err(`compile_failed: ${formatCompileError(e)}`); }
      storage.updateSource(project, a.plan_id, next);
      invalidate(storage.basePath(project, a.plan_id) + ".plan.tsx");
      for (const blockId of appendedIds) {
        state.broadcast({ type: "block.appended", planId: a.plan_id, project, blockId });
        if (storage.clearComment(project, "plan", a.plan_id, blockId)) {
          state.broadcast({ type: "comment:cleared", project, target_kind: "plan", target_id: a.plan_id, blockId });
        }
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
      state.setActivity({ kind: a.state, ...(a.color ? { color: a.color } : {}) });
      return ok({ state: a.state, ...(a.color ? { color: a.color } : {}) });
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
      const notes = storage.notesFor(project, "plan", a.plan_id);
      try {
        const sourcePath = storage.basePath(project, a.plan_id) + ".plan.tsx";
        const compiled = await compilePlanFile(sourcePath);
        return ok({ meta: rec.meta, source: rec.source, notes, block_ids: compiled.blockIds, has_mermaid: compiled.hasMermaid });
      } catch (e) {
        return ok({ meta: rec.meta, source: rec.source, notes, compile_error: formatCompileError(e) });
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
      const existingMeta = storage.readProject(project);
      const existingTitle = existingMeta?.tabs.find((t) => t.id === a.id)?.title;
      const title = ("title" in a && a.title) ? a.title : (existingTitle ?? a.id);
      const isNew = name === "create_tab" && !existingMeta?.tabs.some((t) => t.id === a.id);
      storage.writeTab(project, a.id, title, a.source);
      invalidate(storage.tabPath(project, a.id));
      if (isNew) {
        state.broadcast({ type: "project.updated", project });
      } else {
        state.broadcast({ type: "tab.updated", project, tabId: a.id });
      }
      return ok({ project, tab_id: a.id, title });
    }

    case "get_project": {
      const a = GetProjectSchema.parse(args);
      const project = defaultProject(a.project);
      const meta = storage.readProject(project);
      if (!meta) return err(`project_not_found: ${project}`);
      return ok(meta);
    }

    case "open_modal": {
      const a = OpenModalSchema.parse(args);
      const project = defaultProject(a.project);
      try { validateModalSource(a.source); }
      catch (e) { return err(e instanceof Error ? e.message : String(e)); }
      let html: string;
      try {
        const result = await compileSourceForValidation(a.source, `modal-${slugify(a.title)}`);
        html = result.html;
      } catch (e) {
        return err(`compile_failed: ${formatCompileError(e)}`);
      }
      storage.ensureProject(project);
      const id = nowId(slugify(a.title));
      const now = new Date().toISOString();
      const meta = { id, title: a.title, project, created: now };
      storage.writeModal({ meta, source: a.source, html });
      state.broadcast({ type: "modal.open", project, id, title: a.title, html });
      return ok({ id, project });
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

    case "set_theme": {
      const a = SetThemeSchema.parse(args);
      const project = defaultProject(a.project);
      if (typeof a.theme === "string" && !THEMES[a.theme]) {
        return err(`unknown_theme: ${a.theme}. Available: ${Object.keys(THEMES).join(", ")}`);
      }
      storage.setTheme(project, a.theme);
      state.broadcast({ type: "project.updated", project });
      return ok({ project, theme: a.theme });
    }

    case "init_project_homepage": {
      const a = InitHomepageSchema.parse(args);
      const project = defaultProject(a.project);
      const meta = storage.readProject(project);
      if (!meta) return err(`project_not_found: ${project}`);
      const plans = storage.listPlans(project);
      const counts = { designing: 0, ready: 0, implemented: 0, rejected: 0 } as Record<string, number>;
      for (const p of plans) counts[p.status] = (counts[p.status] ?? 0) + 1;
      const active = plans.filter((p) => p.status === "designing" || p.status === "ready");
      const done = plans.filter((p) => p.status === "implemented");
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "\\`");
      const planItems = (list: typeof plans) =>
        list.map((p) => `        { path: "${esc(p.id)}", desc: "${esc(p.title)} — ${p.status}" },`).join("\n");
      const source = `import { Plan, Block, Callout, FileList, DecisionPanel } from "@web-planner/kit";

export default () => (
  <Plan title="${esc(meta.name || meta.slug)}" status="designing">
    <Block id="b-home-header" kind="summary">
      <Callout>${esc(meta.description || "Project homepage. Ask the planner to update this description.")}</Callout>
    </Block>

    <Block id="b-home-stats" kind="detail">
      <p>
        <strong>${counts.designing}</strong> designing ·{" "}
        <strong>${counts.ready}</strong> ready ·{" "}
        <strong>${counts.implemented}</strong> implemented ·{" "}
        <strong>${counts.rejected}</strong> rejected
      </p>
    </Block>${active.length > 0 ? `

    <Block id="b-home-active" kind="files">
      <FileList items={[
${planItems(active)}
      ]} />
    </Block>` : ""}${done.length > 0 ? `

    <Block id="b-home-done" kind="files">
      <FileList items={[
${planItems(done)}
      ]} />
    </Block>` : ""}

    <Block id="b-home-quickstart" kind="detail">
      <DecisionPanel questions={[{
        text: "What do you want to do today?",
        kind: "single",
        options: [
          { value: "Draft a new plan" },
          { value: "Review open plans" },
          { value: "Change theme" },
        ],
        allow_other: true,
      }]} />
    </Block>
  </Plan>
);
`;
      try { validatePlanSource(source); } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
      try { await compileSourceForValidation(source, "tab-home"); }
      catch (e) { return err(`compile_failed: ${formatCompileError(e)}`); }
      storage.writeTab(project, "home", "Home", source);
      invalidate(storage.tabPath(project, "home"));
      state.broadcast({ type: "tab.updated", project, tabId: "home" });
      const url = `http://localhost:${config.port}/projects/${encodeURIComponent(project)}?tab=home`;
      return ok({ project, tab_id: "home", url });
    }

    case "list_comments": {
      const a = ListCommentsSchema.parse(args);
      const project = defaultProject(a.project);
      const meta = storage.readProject(project);
      if (!meta) return err(`project_not_found: ${project}`);
      const comments = storage.listComments(project);
      const planTitles = new Map(storage.listPlans(project).map((p) => [p.id, p.title]));
      const tabTitles = new Map(meta.tabs.map((t) => [t.id, t.title]));
      const enriched = comments.map((c) => ({
        ...c,
        target_title: c.target_kind === "plan" ? planTitles.get(c.target_id) ?? null : tabTitles.get(c.target_id) ?? null,
      }));
      return ok({ project, count: enriched.length, comments: enriched });
    }

    case "get_comments": {
      const a = GetCommentsSchema.parse(args);
      if (!a.plan_id && !a.tab_id) return err("missing_target: pass either plan_id or tab_id");
      if (a.plan_id && a.tab_id) return err("ambiguous_target: pass only one of plan_id or tab_id");
      const project = defaultProject(a.project);
      const target_kind = a.plan_id ? "plan" : "tab";
      const target_id = (a.plan_id ?? a.tab_id) as string;
      const comments = storage.getComments(project, target_kind, target_id);
      let target_title: string | null = null;
      if (target_kind === "plan") target_title = storage.readPlan(project, target_id)?.meta.title ?? null;
      else target_title = storage.readProject(project)?.tabs.find((t) => t.id === target_id)?.title ?? null;
      return ok({ project, target_kind, target_id, target_title, count: comments.length, comments });
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

      const checkPlans = a.tab_id ? [] : plans;
      const checkTabs = a.plan_id && !a.tab_id ? [] : tabs;

      for (const p of checkPlans) {
        const path = storage.basePath(project, p.id) + ".plan.tsx";
        invalidate(path);
        try {
          const r = await compilePlanFile(path);
          const item: CheckItem = { kind: "plan", id: p.id, ok: true, block_ids: r.blockIds };
          if (r.mermaidErrors.length > 0) { item.ok = false; item.mermaid_errors = r.mermaidErrors; }
          items.push(item);
        } catch (e) {
          items.push({ kind: "plan", id: p.id, ok: false, error: formatCompileError(e) });
        }
      }
      for (const t of checkTabs) {
        const path = storage.tabPath(project, t.id);
        invalidate(path);
        try {
          const r = await compilePlanFile(path);
          const item: CheckItem = { kind: "tab", id: t.id, ok: true, block_ids: r.blockIds };
          if (r.mermaidErrors.length > 0) { item.ok = false; item.mermaid_errors = r.mermaidErrors; }
          items.push(item);
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

// ---------- MCP wiring ----------

const TOOLS = [
  { name: "wait_for_message", description: "Block until the user sends a message (browser chat, wp send, or feedback bundle). No timeout. Outer-loop primitive — comments, chat, and feedback bundles from ANY plan or tab reach you through this single call.", inputSchema: { type: "object", properties: {} } },
  { name: "ask_user", description: "Push structured questions to the browser; block until the user submits. Times out cleanly.", inputSchema: { type: "object", properties: { questions: { type: "array" }, timeout_seconds: { type: "number" } }, required: ["questions"] } },
  { name: "create_plan", description: "Submit a full .plan.tsx source. Server validates structure + block ids and dry-compiles before persisting. New plans start in status 'designing'.", inputSchema: { type: "object", properties: { title: { type: "string" }, source: { type: "string" }, project: { type: "string" } }, required: ["title","source"] } },
  { name: "update_block", description: "Replace one <Block id='...'> in a plan. Replacement MUST be exactly one <Block> with the same id. Allowed on plans of any status — there is no frozen state.", inputSchema: { type: "object", properties: { plan_id: { type: "string" }, block_id: { type: "string" }, replacement: { type: "string" }, project: { type: "string" } }, required: ["plan_id","block_id","replacement"] } },
  { name: "append_block", description: "Insert one or more new <Block>s after an existing one. Pass imports[] to merge component names into the plan's @web-planner/kit import line. Allowed on plans of any status.", inputSchema: { type: "object", properties: { plan_id: { type: "string" }, source: { type: "string" }, after_block_id: { type: "string" }, imports: { type: "array", items: { type: "string" } }, project: { type: "string" } }, required: ["plan_id","source"] } },
  { name: "register_component", description: "Append a Preact component to the project's components.tsx for use as a new block kind. Then import it in your plan/tab source.", inputSchema: { type: "object", properties: { name: { type: "string" }, source: { type: "string" }, project: { type: "string" } }, required: ["name","source"] } },
  { name: "set_plan_status", description: "Move plan between designing / ready / implemented / rejected. All statuses remain editable and commentable.", inputSchema: { type: "object", properties: { plan_id: { type: "string" }, status: { type: "string", enum: ["designing","ready","implemented","rejected"] }, project: { type: "string" } }, required: ["plan_id","status"] } },
  { name: "set_state", description: "Override the activity state surfaced by the dashboard pill (e.g. 'implementing' while editing files).", inputSchema: { type: "object", properties: { state: { type: "string" } }, required: ["state"] } },
  { name: "list_plans", description: "List plans for a project (or all projects).", inputSchema: { type: "object", properties: { project: { type: "string" } } } },
  { name: "get_plan", description: "Read a plan: source, notes, block ids. Notes are the unified comments scoped to this plan.", inputSchema: { type: "object", properties: { plan_id: { type: "string" }, project: { type: "string" } }, required: ["plan_id"] } },
  { name: "set_project_meta", description: "Set a project's name, description, and/or watchPath (source dir for the Layout tab).", inputSchema: { type: "object", properties: { project: { type: "string" }, name: { type: "string" }, description: { type: "string" }, watch_path: { type: "string" } } } },
  { name: "create_tab", description: "Create a custom tab on a project's page from a Preact .tab.tsx source. id must be lowercase kebab. Dry-compiled before persisting.", inputSchema: { type: "object", properties: { project: { type: "string" }, id: { type: "string" }, title: { type: "string" }, source: { type: "string" } }, required: ["id","title","source"] } },
  { name: "update_tab", description: "Update an existing custom tab's source. Dry-compiled before persisting.", inputSchema: { type: "object", properties: { project: { type: "string" }, id: { type: "string" }, title: { type: "string" }, source: { type: "string" } }, required: ["id","source"] } },
  { name: "get_project", description: "Read project metadata (name, description, watchPath, tabs).", inputSchema: { type: "object", properties: { project: { type: "string" } } } },
  { name: "delete_plan", description: "Permanently delete a plan (source + meta + comments). Allowed on any status.", inputSchema: { type: "object", properties: { plan_id: { type: "string" }, project: { type: "string" } }, required: ["plan_id"] } },
  { name: "check", description: "Re-compile a plan, a custom tab, or every plan + custom tab in a project. Returns { ok, items: [...] }. Call after every create/update.", inputSchema: { type: "object", properties: { project: { type: "string" }, plan_id: { type: "string" }, tab_id: { type: "string" } } } },
  { name: "set_theme", description: "Set the colour theme for a project. Pass a preset name ('catppuccin-mocha', 'catppuccin-latte', 'nord', 'gruvbox-dark') or a Record<string,string> of CSS variable overrides.", inputSchema: { type: "object", properties: { project: { type: "string" }, theme: {} }, required: ["theme"] } },
  { name: "init_project_homepage", description: "Create or regenerate the Home tab: project header, plan counts, plan links, and a DecisionPanel quick-start.", inputSchema: { type: "object", properties: { project: { type: "string" } } } },
  { name: "list_comments", description: "Return EVERY open comment in the project, across plans and tabs. Each comment carries target_kind ('plan'|'tab'), target_id, target_title, block_id, text, and timestamps. Use this on resume to sweep for anything that arrived while you were busy.", inputSchema: { type: "object", properties: { project: { type: "string" } } } },
  { name: "get_comments", description: "Return comments for one target — pass exactly one of plan_id or tab_id. Returns the same enriched shape as list_comments, scoped.", inputSchema: { type: "object", properties: { project: { type: "string" }, plan_id: { type: "string" }, tab_id: { type: "string" } } } },
  { name: "open_modal", description: "Display a one-way modal in the browser. `source` is a full Preact .modal.tsx whose root is `<div class=\"modal-body\">` (NOT `<Plan>`) — the modal chrome supplies the title bar. Use kit blocks (Block, Callout, Mermaid, CodeBlock, …); no markdown. Source is dry-compiled before sending. Past modals are archived on the project's Modals tab.", inputSchema: { type: "object", properties: { title: { type: "string" }, source: { type: "string" }, project: { type: "string" } }, required: ["title","source"] } },
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
  const server = new Server({ name: "web-planner", version: "0.2.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    return callToolImpl(req.params.name, req.params.arguments ?? {}, extra?.signal);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[web-planner] mcp ready");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
