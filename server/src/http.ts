import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, projectSlugFromCwd } from "./config.js";
import { state } from "./state.js";
import { Storage, STATUSES, type CommentTargetKind, type PlanStatus } from "./storage.js";
import { compilePlanFile, invalidate } from "./compile.js";
import { buildTree } from "./layout.js";
import { resolveTheme, themeToCSS } from "./themes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const config = loadConfig();
const storage = new Storage(config.storageRoot);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
};

function uiRoot(): string { return resolve(__dirname, "..", "..", "ui"); }
function kitRoot(): string { return resolve(__dirname, "..", "..", "kit", "src"); }

function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}
function sendJson(res: ServerResponse, status: number, obj: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
function jsonOk(res: ServerResponse, request_id: string | undefined, extra: Record<string, unknown> = {}) {
  sendJson(res, 200, { ok: true, ...(request_id ? { request_id } : {}), ...extra });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function serveStatic(path: string, res: ServerResponse) {
  if (!existsSync(path) || !statSync(path).isFile()) { send(res, 404, "not found"); return; }
  const ext = extname(path);
  res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
  res.end(readFileSync(path));
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "plan";
}
function nowId(slug: string): string {
  const d = new Date();
  const ts = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}-${String(d.getHours()).padStart(2,"0")}${String(d.getMinutes()).padStart(2,"0")}`;
  return `${ts}-${slug}`;
}

interface ShellExtras {
  hasMermaid?: boolean;
  planMeta?: { id: string; project: string; status: string; notes: Record<string, string> };
  tabMeta?: { project: string; tabId: string };
  pageMeta?: { kind: "plan" | "tab" | "layout" | "home" | "dashboard"; project?: string };
  extraScripts?: string;
  projectSlug?: string;
}

function renderShell(title: string, body: string, extras: ShellExtras = {}): string {
  const { hasMermaid, planMeta, tabMeta, pageMeta, extraScripts, projectSlug } = extras;
  let themeStyle = "";
  if (projectSlug) {
    const theme = storage.getTheme(projectSlug);
    if (theme) themeStyle = `<style>${themeToCSS(resolveTheme(theme))}</style>\n`;
  }
  const metaScripts = [
    planMeta ? `<script>window.__PLAN__ = ${JSON.stringify(planMeta)};</script>` : "",
    tabMeta  ? `<script>window.__TAB__  = ${JSON.stringify(tabMeta)};</script>`  : "",
    pageMeta ? `<script>window.__PAGE__ = ${JSON.stringify(pageMeta)};</script>` : "",
  ].filter(Boolean).join("\n");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="/kit/styles.css" />
${themeStyle}${metaScripts}
${hasMermaid ? `<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs";
  mermaid.initialize({ startOnLoad: false, theme: "dark", themeVariables: { background: "#1e1e2e", primaryColor: "#313244", primaryTextColor: "#cdd6f4", lineColor: "#89b4fa" } });
  function renderMermaid() { mermaid.run({ querySelector: "pre[data-mermaid]:not([data-rendered])" }).then(()=>document.querySelectorAll("pre[data-mermaid]").forEach(el=>el.setAttribute("data-rendered","true"))); }
  window.addEventListener("DOMContentLoaded", renderMermaid);
  window.__renderMermaid = renderMermaid;
</script>` : ""}
</head><body><div class="page">${body}</div>
<script src="https://cdn.jsdelivr.net/npm/prismjs@1/prism.js"></script>
<script src="https://cdn.jsdelivr.net/npm/prismjs@1/plugins/autoloader/prism-autoloader.min.js"></script>
<script>Prism.plugins.autoloader.languages_path = "https://cdn.jsdelivr.net/npm/prismjs@1/components/";</script>
<script type="module" src="/ui/submit.js"></script>
<script type="module" src="/ui/chrome.js"></script>
<script type="module" src="/ui/app.js"></script>
${extraScripts ?? ""}
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" }[c]!));
}

// ---------- SSE ----------
async function handleSse(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  const id = state.addSubscriber((data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  });
  const heartbeat = setInterval(() => { try { res.write(": heartbeat\n\n"); } catch { /* noop */ } }, 15000);
  req.on("close", () => { clearInterval(heartbeat); state.removeSubscriber(id); });
}

// ---------- chat / answer ----------
async function handleMessage(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { text?: string; source?: string; request_id?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const text = (parsed.text ?? "").trim();
  if (!text) return sendJson(res, 400, { error: "empty_text" });
  const source = parsed.source ?? "chat";
  const payload = `[from ${source}]\n${text}`;
  const r = state.enqueueOrDeliver({ text: payload, kind: "chat", meta: { source } });
  if (r.delivered) state.broadcast({ type: "message:delivered", source });
  else state.broadcast({ type: "message:queued", source, position: r.position });
  state.ack(parsed.request_id, { route: "message", queued: r.queued });
  jsonOk(res, parsed.request_id, { queued: r.queued, position: r.position });
}

async function handleAnswer(req: IncomingMessage, res: ServerResponse, askId: string) {
  const body = await readBody(req);
  let parsed: { answers?: unknown[]; request_id?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const p = state.pending.get(askId);
  if (!p || p.kind !== "ask_user") return sendJson(res, 404, { error: "unknown_ask_id" });
  state.pending.delete(askId);
  p.resolve({ questions: p.questions, answers: parsed.answers ?? [] });
  state.ack(parsed.request_id, { route: "answer" });
  jsonOk(res, parsed.request_id);
}

// ---------- unified comments ----------
async function handleComment(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { project?: string; target_kind?: string; target_id?: string; block_id?: string; text?: string; request_id?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { project, target_kind, target_id, block_id, text, request_id } = parsed;
  if (!project || (target_kind !== "plan" && target_kind !== "tab") || !target_id || !block_id || typeof text !== "string") {
    return sendJson(res, 400, { error: "missing_fields", expects: { project: "string", target_kind: "'plan'|'tab'", target_id: "string", block_id: "string", text: "string" } });
  }
  try {
    storage.setComment(project, target_kind as CommentTargetKind, target_id, block_id, text);
    const type = text === "" ? "comment:cleared" : "comment:set";
    state.broadcast({ type, project, target_kind, target_id, blockId: block_id, text });
    state.ack(request_id, { route: "comment", target_kind, target_id, blockId: block_id });
    jsonOk(res, request_id);
  } catch (e) {
    sendJson(res, 400, { error: e instanceof Error ? e.message : String(e), request_id });
  }
}

async function handleListComments(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
  const project = url.searchParams.get("project");
  if (!project) return sendJson(res, 400, { error: "missing_project" });
  const meta = storage.readProject(project);
  if (!meta) return sendJson(res, 404, { error: "project_not_found" });
  const comments = storage.listComments(project);
  const planTitles = new Map(storage.listPlans(project).map((p) => [p.id, p.title]));
  const tabTitles = new Map(meta.tabs.map((t) => [t.id, t.title]));
  const enriched = comments.map((c) => ({
    ...c,
    target_title: c.target_kind === "plan" ? planTitles.get(c.target_id) ?? null : tabTitles.get(c.target_id) ?? null,
  }));
  sendJson(res, 200, { project, count: enriched.length, comments: enriched });
}

// ---------- plan status / delete / feedback / start ----------
async function handlePlanStatus(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { project?: string; planId?: string; status?: string; request_id?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { project, planId, status, request_id } = parsed;
  if (!project || !planId || !status) return sendJson(res, 400, { error: "missing_fields" });
  if (!(STATUSES as readonly string[]).includes(status)) return sendJson(res, 400, { error: "invalid_status", valid: STATUSES });
  const rec = storage.readPlan(project, planId);
  if (!rec) return sendJson(res, 404, { error: "plan_not_found" });
  const next = storage.setStatus(project, planId, status as PlanStatus);
  state.broadcast({ type: "plan.status", planId, project, status: next.meta.status });
  state.ack(request_id, { route: "plan/status", status: next.meta.status });
  jsonOk(res, request_id, { status: next.meta.status });
}

async function handleDeletePlan(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { project?: string; planId?: string; request_id?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { project, planId, request_id } = parsed;
  if (!project || !planId) return sendJson(res, 400, { error: "missing_fields" });
  const rec = storage.readPlan(project, planId);
  if (!rec) return sendJson(res, 404, { error: "plan_not_found" });
  storage.deletePlan(project, planId);
  invalidate(storage.basePath(project, planId) + ".plan.tsx");
  state.broadcast({ type: "plan.deleted", planId, project });
  state.ack(request_id, { route: "plan/delete" });
  jsonOk(res, request_id);
}

function buildFeedbackText(project: string, target_kind?: CommentTargetKind, target_id?: string): { ok: true; text: string; n: number } | { ok: false; error: string } {
  const all = storage.listComments(project);
  const filtered = !target_kind ? all : all.filter((c) => c.target_kind === target_kind && (target_id ? c.target_id === target_id : true));
  if (filtered.length === 0) return { ok: false, error: "no_comments" };
  const meta = storage.readProject(project);
  const planTitles = new Map(storage.listPlans(project).map((p) => [p.id, p.title]));
  const tabTitles  = new Map((meta?.tabs ?? []).map((t) => [t.id, t.title]));
  const targets = new Set(filtered.map((c) => `${c.target_kind}:${c.target_id}`));
  const header = `Feedback bundle (${filtered.length} comment${filtered.length === 1 ? "" : "s"} across ${targets.size} target${targets.size === 1 ? "" : "s"}):`;
  const lines: string[] = [header, ""];
  for (const c of filtered) {
    const title = c.target_kind === "plan" ? planTitles.get(c.target_id) ?? c.target_id : tabTitles.get(c.target_id) ?? c.target_id;
    lines.push(`[${c.target_kind}: ${title}] [${c.block_id}] ${c.text}`);
  }
  lines.push("", "Please revise.");
  return { ok: true, text: lines.join("\n"), n: filtered.length };
}

async function handleFeedback(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { project?: string; target_kind?: CommentTargetKind; target_id?: string; request_id?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { project, target_kind, target_id, request_id } = parsed;
  if (!project) return sendJson(res, 400, { error: "missing_fields" });
  const built = buildFeedbackText(project, target_kind, target_id);
  if (!built.ok) return sendJson(res, 400, { error: built.error });
  const r = state.enqueueOrDeliver({ text: built.text, kind: "feedback", meta: { project, target_kind, target_id } });
  state.broadcast({ type: "feedback:sent", project, target_kind, target_id, queued: r.queued, position: r.position, count: built.n });
  state.ack(request_id, { route: "feedback", queued: r.queued });
  jsonOk(res, request_id, { queued: r.queued, position: r.position, count: built.n });
}

async function handleStartImplementation(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { project?: string; planId?: string; request_id?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { project, planId, request_id } = parsed;
  if (!project || !planId) return sendJson(res, 400, { error: "missing_fields" });
  const rec = storage.readPlan(project, planId);
  if (!rec) return sendJson(res, 404, { error: "plan_not_found" });
  const next = storage.setStatus(project, planId, "ready");
  state.broadcast({ type: "plan.status", planId, project, status: next.meta.status });
  const planComments = storage.getComments(project, "plan", planId);
  const text = planComments.length > 0
    ? buildFeedbackText(project, "plan", planId).ok ? (buildFeedbackText(project, "plan", planId) as { ok: true; text: string }).text : `Start implementation of plan "${rec.meta.title}" (id: ${planId}).`
    : [`Start implementation of plan "${rec.meta.title}" (id: ${planId}).`, `No comments — proceed.`].join("\n");
  const r = state.enqueueOrDeliver({ text, kind: "implementation", meta: { planId, project } });
  state.broadcast({ type: "implementation:started", planId, project, queued: r.queued, position: r.position });
  state.ack(request_id, { route: "start-implementation", queued: r.queued });
  jsonOk(res, request_id, { queued: r.queued, position: r.position });
}

async function handlePlansList(_req: IncomingMessage, res: ServerResponse) {
  const out: Record<string, ReturnType<Storage["listPlans"]>> = {};
  for (const p of storage.listProjects()) out[p] = storage.listPlans(p);
  sendJson(res, 200, out);
}

// ---------- pages ----------
async function handlePlanPage(_req: IncomingMessage, res: ServerResponse, project: string, planId: string) {
  const rec = storage.readPlan(project, planId);
  if (!rec) return send(res, 404, "plan not found");
  const sourcePath = join(storage.basePath(project, planId) + ".plan.tsx");
  const notes = storage.notesFor(project, "plan", planId);
  try {
    const { html, hasMermaid } = await compilePlanFile(sourcePath);
    const decorated = decorateWithNotes(html, notes);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderShell(rec.meta.title, decorated, {
      hasMermaid,
      planMeta: { id: rec.meta.id, project: rec.meta.project, status: rec.meta.status, notes },
      pageMeta: { kind: "plan", project: rec.meta.project },
      projectSlug: rec.meta.project,
    }));
  } catch (e) {
    res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
    res.end(`<pre>${escapeHtml(e instanceof Error ? e.message : String(e))}</pre>`);
  }
}

function decorateWithNotes(html: string, notes: Record<string, string>): string {
  return html.replace(/<section\s+class="block"\s+data-block-id="([^"]+)"/g, (m, id: string) => {
    if (!notes[id]) return m;
    return `${m} data-has-comment="true" data-comment-text="${escapeHtml(notes[id]!)}"`;
  });
}

async function handleDashboard(_req: IncomingMessage, res: ServerResponse) {
  const projects = storage.listProjects();
  const body = `
    <main class="dashboard">
      <header class="plan-header"><h1>web-planner</h1>
        <div class="plan-meta"><span class="badge">localhost:${config.port}</span></div>
      </header>
      ${projects.length === 0 ? `<p class="muted">No projects yet. The planner agent creates them when it makes its first plan.</p>` : ""}
      <div class="project-grid">
        ${projects.map((p) => {
          const meta = storage.readProject(p);
          const plans = storage.listPlans(p);
          const active = plans.filter((pl) => pl.status === "designing" || pl.status === "ready").length;
          const done = plans.filter((pl) => pl.status === "implemented").length;
          const latest = plans[0];
          return `<a class="project-card" href="/projects/${encodeURIComponent(p)}">
            <h3>${escapeHtml(meta?.name || p)}</h3>
            ${meta?.description ? `<p class="project-desc">${escapeHtml(meta.description)}</p>` : ""}
            <div class="project-stats">
              <span><strong>${plans.length}</strong> plan${plans.length === 1 ? "" : "s"}</span>
              <span class="dot">·</span>
              <span class="status-designing">${active} active</span>
              <span class="dot">·</span>
              <span class="status-implemented">${done} done</span>
            </div>
            ${latest ? `<p class="project-latest">latest: <span>${escapeHtml(latest.title)}</span></p>` : ""}
          </a>`;
        }).join("")}
      </div>
    </main>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(renderShell("web-planner", body, { pageMeta: { kind: "dashboard" } }));
}

function renderTabBar(active: string, tabs: { id: string; title: string; kind: string }[]): string {
  return `<nav class="tab-bar">
    ${tabs.map((t) => `<a class="tab ${t.id === active ? "active" : ""}" href="?tab=${encodeURIComponent(t.id)}" data-tab-id="${escapeHtml(t.id)}" data-tab-kind="${escapeHtml(t.kind)}">${escapeHtml(t.title)}</a>`).join("")}
  </nav>`;
}

async function renderBuiltinTab(project: string, tabId: string): Promise<string> {
  if (tabId === "plans") {
    const plans = storage.listPlans(project);
    const COLUMNS: { status: PlanStatus; label: string }[] = [
      { status: "designing", label: "Designing" },
      { status: "ready", label: "Ready" },
      { status: "implemented", label: "Implemented" },
      { status: "rejected", label: "Rejected" },
    ];
    const empty = plans.length === 0 ? `
      <div class="plans-empty-state">
        <p class="plans-empty-title">No plans yet</p>
        <p class="muted">Start by typing this in your Claude Code terminal:</p>
        <pre class="plans-empty-cmd">/web-plan describe what you want to plan</pre>
        <p class="muted">The planner will ask you questions and build the first plan.</p>
      </div>` : "";
    const column = (label: string, status: string) => {
      const items = plans.filter((p) => p.status === status);
      return `<section class="kanban-col" data-status="${escapeHtml(status)}">
        <header class="kanban-col-head">
          <span class="badge status-${escapeHtml(status)}">${escapeHtml(label)}</span>
          <span class="muted">${items.length}</span>
        </header>
        <div class="kanban-col-body" data-drop-zone="${escapeHtml(status)}">
          ${items.map((p) => `<div class="plan-card" draggable="true" data-plan-id="${escapeHtml(p.id)}" data-plan-status="${escapeHtml(p.status)}">
            <a class="plan-card-link" href="/plans/${encodeURIComponent(project)}/${encodeURIComponent(p.id)}">
              <span class="plan-title">${escapeHtml(p.title)}</span>
              <span class="when">${escapeHtml(p.modified.slice(0,16))}</span>
            </a>
            <button type="button" class="plan-row-delete" data-plan-id="${escapeHtml(p.id)}" data-plan-title="${escapeHtml(p.title)}" title="delete plan">×</button>
          </div>`).join("")}
        </div>
      </section>`;
    };
    return `${empty}<div class="kanban">${COLUMNS.map((c) => column(c.label, c.status)).join("")}</div>`;
  }
  if (tabId === "modals") {
    const modals = storage.listModals(project);
    if (modals.length === 0) {
      return `<div class="modals-empty">No modals yet. The planner uses <code>open_modal</code> to surface research and other findings.</div>`;
    }
    const rows = modals.map((m) => `<div class="modals-row" data-modal-id="${escapeHtml(m.id)}">
      <span class="modals-when">${escapeHtml(m.created.slice(0, 16).replace("T", " "))}</span>
      <span class="modals-title">${escapeHtml(m.title)}</span>
      <button type="button" class="modals-reopen" data-modal-id="${escapeHtml(m.id)}">Reopen</button>
      <button type="button" class="modals-delete" data-modal-id="${escapeHtml(m.id)}" title="delete">×</button>
    </div>`).join("");
    return `<div class="modals-pane">
      <div class="modals-toolbar">
        <button type="button" class="modals-clear-all">Clear all</button>
      </div>
      <div class="modals-timeline">${rows}</div>
    </div>`;
  }
  if (tabId === "layout") {
    const meta = storage.readProject(project);
    const path = meta?.watchPath || "";
    if (!path) {
      return `<div class="callout callout-warn">
        <p>No <code>watchPath</code> set for this project. The planner can set one via <code>set_project_meta</code>.</p>
      </div>`;
    }
    return `<div class="layout-pane" data-project="${escapeHtml(project)}">
      <p class="muted layout-path"><code>${escapeHtml(path)}</code></p>
      <div class="layout-tree" data-layout-mount>loading…</div>
    </div>`;
  }
  return `<p>unknown builtin tab: ${escapeHtml(tabId)}</p>`;
}

async function renderCustomTab(project: string, tabId: string): Promise<string> {
  const path = storage.tabPath(project, tabId);
  if (!existsSync(path)) return `<p class="muted">tab source missing</p>`;
  const compiled = await compilePlanFile(path);
  const notes = storage.notesFor(project, "tab", tabId);
  return decorateWithNotes(compiled.html, notes);
}

async function handleProjectPage(req: IncomingMessage, res: ServerResponse, project: string) {
  const meta = storage.readProject(project);
  if (!meta) return send(res, 404, "project not found");
  const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
  const homeTab = meta.tabs.find((t) => t.id === "home");
  const defaultTab = homeTab ?? meta.tabs[0];
  const requested = url.searchParams.get("tab") || defaultTab?.id || "plans";
  const tab = meta.tabs.find((t) => t.id === requested) ?? defaultTab!;
  let tabBody = "";
  let hasMermaid = false;
  try {
    if (tab.kind === "builtin") tabBody = await renderBuiltinTab(project, tab.id);
    else {
      tabBody = await renderCustomTab(project, tab.id);
      hasMermaid = /data-mermaid/.test(tabBody);
    }
  } catch (e) {
    tabBody = `<pre>${escapeHtml(e instanceof Error ? e.message : String(e))}</pre>`;
  }
  const body = `<main class="project-page" data-project="${escapeHtml(project)}" data-active-tab="${escapeHtml(tab.id)}">
    <header class="plan-header">
      <div>
        <h1>${escapeHtml(meta.name || project)}</h1>
        ${meta.description ? `<p class="project-desc">${escapeHtml(meta.description)}</p>` : ""}
        ${meta.watchPath ? `<p class="muted small"><code>${escapeHtml(meta.watchPath)}</code></p>` : ""}
      </div>
      <div class="plan-meta"><a class="badge" href="/">← all projects</a></div>
    </header>
    ${renderTabBar(tab.id, meta.tabs)}
    <div class="tab-panel" data-tab-panel>${tabBody}</div>
  </main>`;
  const tabMeta = tab.kind === "custom" ? { project, tabId: tab.id } : undefined;
  const pageKind: "home" | "layout" | "tab" = tab.id === "home" ? "home" : tab.id === "layout" ? "layout" : "tab";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(renderShell(`${meta.name || project} — web-planner`, body, {
    hasMermaid,
    tabMeta,
    pageMeta: { kind: pageKind, project },
    extraScripts: `<script type="module" src="/ui/project.js"></script>`,
    projectSlug: project,
  }));
}

async function handleProjectTabFragment(_req: IncomingMessage, res: ServerResponse, project: string, tabId: string) {
  const meta = storage.readProject(project);
  if (!meta) return send(res, 404, "project not found");
  const tab = meta.tabs.find((t) => t.id === tabId);
  if (!tab) return send(res, 404, "tab not found");
  try {
    let body: string;
    if (tab.kind === "builtin") body = await renderBuiltinTab(project, tab.id);
    else body = await renderCustomTab(project, tab.id);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

async function handleLayoutApi(_req: IncomingMessage, res: ServerResponse, project: string) {
  const meta = storage.readProject(project);
  if (!meta) return sendJson(res, 404, { error: "project_not_found" });
  if (!meta.watchPath) return sendJson(res, 200, { tree: null });
  const tree = buildTree(meta.watchPath);
  sendJson(res, 200, { tree, watchPath: meta.watchPath });
}

async function handleState(_req: IncomingMessage, res: ServerResponse) {
  sendJson(res, 200, state.activity);
}

async function handleBacklog(_req: IncomingMessage, res: ServerResponse) {
  sendJson(res, 200, { backlog: state.peekBacklog().map((b) => ({ kind: b.kind, meta: b.meta ?? null })) });
}

async function handleGenerateBlock(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { planId?: string; prompt?: string; project?: string; request_id?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { planId, prompt, project, request_id } = parsed;
  if (!planId || !prompt) return sendJson(res, 400, { error: "missing_fields" });
  const text = `[generate-block planId=${planId}${project ? ` project=${project}` : ""}]\n${prompt}`;
  const r = state.enqueueOrDeliver({ text, kind: "chat", meta: { planId, project } });
  state.ack(request_id, { route: "generate-block", queued: r.queued });
  jsonOk(res, request_id, { queued: r.queued });
}

async function handleCreatePlanStub(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { title?: string; brief?: string; project?: string; request_id?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { title, brief, project: proj, request_id } = parsed;
  if (!title || !brief) return sendJson(res, 400, { error: "missing_fields" });
  const project = proj || "default";
  const slug = slugify(title);
  const id = nowId(slug);
  const now = new Date().toISOString();
  const escapedTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedBrief = brief.replace(/[<>&]/g, (c: string) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
  const source = `import { Plan, Block, Callout } from "@web-planner/kit";\n\nexport default () => (\n  <Plan title="${escapedTitle}" status="designing">\n    <Block id="b-brief" kind="summary">\n      <Callout>${escapedBrief}</Callout>\n    </Block>\n  </Plan>\n);\n`;
  storage.writePlan({ meta: { id, title, slug, status: "designing", created: now, modified: now, project }, source });
  state.broadcast({ type: "plan.created", planId: id, project });
  const text = `[expand-plan planId=${id}]\n${brief}`;
  const r = state.enqueueOrDeliver({ text, kind: "chat", meta: { planId: id, project } });
  const url = `http://localhost:${config.port}/plans/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;
  state.ack(request_id, { route: "create-plan-stub", planId: id });
  jsonOk(res, request_id, { planId: id, url, queued: r.queued });
}

async function handleModalReopen(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { project?: string; id?: string; request_id?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { project, id, request_id } = parsed;
  if (!project || !id) return sendJson(res, 400, { error: "missing_fields" });
  const rec = storage.readModal(project, id);
  if (!rec) return sendJson(res, 404, { error: "modal_not_found" });
  state.broadcast({ type: "modal.open", project, id, title: rec.meta.title, html: rec.html });
  state.ack(request_id, { route: "modal/reopen" });
  jsonOk(res, request_id);
}

async function handleModalDelete(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { project?: string; id?: string; request_id?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { project, id, request_id } = parsed;
  if (!project || !id) return sendJson(res, 400, { error: "missing_fields" });
  const removed = storage.deleteModal(project, id);
  if (!removed) return sendJson(res, 404, { error: "modal_not_found" });
  state.broadcast({ type: "modal.deleted", project, id });
  state.ack(request_id, { route: "modal/delete" });
  jsonOk(res, request_id);
}

async function handleModalsClear(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { project?: string; request_id?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { project, request_id } = parsed;
  if (!project) return sendJson(res, 400, { error: "missing_fields" });
  const n = storage.clearModals(project);
  state.broadcast({ type: "modals.cleared", project, count: n });
  state.ack(request_id, { route: "modals/clear" });
  jsonOk(res, request_id, { count: n });
}

async function handleCreateTab(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { project?: string; title?: string; purpose?: string; request_id?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { title, purpose, request_id } = parsed;
  if (!title || !purpose) return sendJson(res, 400, { error: "missing_fields" });
  const project = parsed.project || projectSlugFromCwd();
  const text = `Create a new tab titled "${title}": ${purpose}`;
  const r = state.enqueueOrDeliver({ text, kind: "chat", meta: { source: "new-tab-modal", project } });
  state.ack(request_id, { route: "create-tab", queued: r.queued });
  jsonOk(res, request_id, { queued: r.queued, position: r.position });
}

// ---------- router ----------
async function router(req: IncomingMessage, res: ServerResponse) {
  const remote = req.socket.remoteAddress ?? "";
  if (!remote.includes("127.0.0.1") && !remote.includes("::1") && remote !== "::ffff:127.0.0.1") {
    return send(res, 403, "localhost only");
  }
  const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
  const m = req.method ?? "GET";

  try {
    if (m === "GET" && url.pathname === "/") return handleDashboard(req, res);
    if (m === "GET" && url.pathname === "/api/stream") return handleSse(req, res);
    if (m === "GET" && url.pathname === "/api/state") return handleState(req, res);
    if (m === "GET" && url.pathname === "/api/backlog") return handleBacklog(req, res);
    if (m === "GET" && url.pathname === "/api/plans") return handlePlansList(req, res);
    if (m === "GET" && url.pathname === "/api/comments") return handleListComments(req, res);

    const layoutMatch = url.pathname.match(/^\/api\/layout\/([^/]+)$/);
    if (m === "GET" && layoutMatch) return handleLayoutApi(req, res, layoutMatch[1] as string);

    const projTabMatch = url.pathname.match(/^\/projects\/([^/]+)\/tab\/([^/]+)$/);
    if (m === "GET" && projTabMatch) return handleProjectTabFragment(req, res, projTabMatch[1] as string, projTabMatch[2] as string);

    const projMatch = url.pathname.match(/^\/projects\/([^/]+)\/?$/);
    if (m === "GET" && projMatch) return handleProjectPage(req, res, projMatch[1] as string);

    if (m === "POST" && url.pathname === "/api/message") return handleMessage(req, res);
    if (m === "POST" && url.pathname === "/api/feedback") return handleFeedback(req, res);
    if (m === "POST" && url.pathname === "/api/start-implementation") return handleStartImplementation(req, res);
    if (m === "POST" && url.pathname === "/api/comment") return handleComment(req, res);
    if (m === "POST" && url.pathname === "/api/plan/status") return handlePlanStatus(req, res);
    if (m === "POST" && url.pathname === "/api/plan/delete") return handleDeletePlan(req, res);
    if (m === "POST" && url.pathname === "/api/generate-block") return handleGenerateBlock(req, res);
    if (m === "POST" && url.pathname === "/api/create-plan-stub") return handleCreatePlanStub(req, res);
    if (m === "POST" && url.pathname === "/api/create-tab") return handleCreateTab(req, res);
    if (m === "POST" && url.pathname === "/api/modal/reopen") return handleModalReopen(req, res);
    if (m === "POST" && url.pathname === "/api/modal/delete") return handleModalDelete(req, res);
    if (m === "POST" && url.pathname === "/api/modals/clear") return handleModalsClear(req, res);
    const ansMatch = url.pathname.match(/^\/api\/answer\/([\w-]+)$/);
    if (m === "POST" && ansMatch) return handleAnswer(req, res, ansMatch[1] as string);

    const planMatch = url.pathname.match(/^\/plans\/([^/]+)\/(.+)$/);
    if (m === "GET" && planMatch) return handlePlanPage(req, res, planMatch[1] as string, planMatch[2] as string);

    if (m === "GET" && url.pathname.startsWith("/ui/")) {
      return serveStatic(join(uiRoot(), url.pathname.slice("/ui/".length)), res);
    }
    if (m === "GET" && url.pathname.startsWith("/kit/")) {
      return serveStatic(join(kitRoot(), url.pathname.slice("/kit/".length)), res);
    }

    send(res, 404, "not found");
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

let serverStarted = false;
export function startHttp(): Promise<void> {
  return new Promise((resolveFn, rejectFn) => {
    if (serverStarted) return resolveFn();
    const server = createServer(router);
    server.on("error", rejectFn);
    server.listen(config.port, "127.0.0.1", () => {
      serverStarted = true;
      console.error(`[web-planner] http on http://localhost:${config.port}`);
      resolveFn();
    });
  });
}

export { storage, config };
