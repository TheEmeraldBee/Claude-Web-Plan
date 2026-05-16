import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, projectSlugFromCwd } from "./config.js";
import { state } from "./state.js";
import { Storage } from "./storage.js";
import { compilePlanFile, invalidate } from "./compile.js";
import { buildTree } from "./layout.js";
import { resolveTheme, themeToCSS } from "./themes.js";
import { type CardBoard } from "./storage.js";

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

function uiRoot(): string {
  return resolve(__dirname, "..", "..", "ui");
}
function kitRoot(): string {
  return resolve(__dirname, "..", "..", "kit", "src");
}

function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}
function sendJson(res: ServerResponse, status: number, obj: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function serveStatic(path: string, res: ServerResponse) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    send(res, 404, "not found");
    return;
  }
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

function renderShell(title: string, body: string, hasMermaid: boolean, planMeta?: { id: string; project: string; status: string; notes: Record<string, string> }, extraScripts: string = "", projectSlug?: string): string {
  let themeStyle = "";
  if (projectSlug) {
    const theme = storage.getTheme(projectSlug);
    if (theme) themeStyle = `<style>${themeToCSS(resolveTheme(theme))}</style>\n`;
  }
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="/kit/styles.css" />
${themeStyle}${planMeta ? `<script>window.__PLAN__ = ${JSON.stringify(planMeta)};</script>` : ""}
${hasMermaid ? `<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs";
  mermaid.initialize({ startOnLoad: false, theme: "dark", themeVariables: { background: "#1e1e2e", primaryColor: "#313244", primaryTextColor: "#cdd6f4", lineColor: "#89b4fa" } });
  function renderMermaid() { mermaid.run({ querySelector: "pre[data-mermaid]:not([data-rendered])" }).then(()=>document.querySelectorAll("pre[data-mermaid]").forEach(el=>el.setAttribute("data-rendered","true"))); }
  window.addEventListener("DOMContentLoaded", renderMermaid);
  window.__renderMermaid = renderMermaid;
</script>` : ""}
</head><body><div class="page">${body}</div>
<script type="module" src="/ui/app.js"></script>
${extraScripts}
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" }[c]!));
}

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
  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { /* noop */ }
  }, 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    state.removeSubscriber(id);
  });
}

async function handleMessage(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { text?: string; source?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const text = (parsed.text ?? "").trim();
  if (!text) return sendJson(res, 400, { error: "empty_text" });
  const source = parsed.source ?? "chat";
  const payload = `[from ${source}]\n${text}`;
  const r = state.enqueueOrDeliver({ text: payload, kind: "chat", meta: { source } });
  if (r.delivered) state.broadcast({ type: "message:delivered", source });
  else state.broadcast({ type: "message:queued", source, position: r.position });
  sendJson(res, 200, { ok: true, queued: r.queued, position: r.position });
}

async function handleAnswer(req: IncomingMessage, res: ServerResponse, askId: string) {
  const body = await readBody(req);
  let parsed: { answers?: unknown[] };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const p = state.pending.get(askId);
  if (!p || p.kind !== "ask_user") return sendJson(res, 404, { error: "unknown_ask_id" });
  state.pending.delete(askId);
  p.resolve({ questions: p.questions, answers: parsed.answers ?? [] });
  sendJson(res, 200, { ok: true });
}

async function handleComment(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { project?: string; planId?: string; blockId?: string; text?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { project, planId, blockId, text } = parsed;
  if (!project || !planId || !blockId || typeof text !== "string") return sendJson(res, 400, { error: "missing_fields" });
  try {
    if (text === "") {
      storage.clearComment(project, planId, blockId);
      state.broadcast({ type: "comment:cleared", project, planId, blockId });
    } else {
      storage.setComment(project, planId, blockId, text);
      state.broadcast({ type: "comment:set", project, planId, blockId });
    }
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
}

async function handlePlanStatus(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { project?: string; planId?: string; status?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { project, planId, status } = parsed;
  if (!project || !planId || !status) return sendJson(res, 400, { error: "missing_fields" });
  if (status !== "proposed" && status !== "approved" && status !== "implemented" && status !== "abandoned") {
    return sendJson(res, 400, { error: "invalid_status" });
  }
  const rec = storage.readPlan(project, planId);
  if (!rec) return sendJson(res, 404, { error: "plan_not_found" });
  const next = storage.setStatus(project, planId, status as "proposed" | "approved" | "implemented" | "abandoned");
  state.broadcast({ type: "plan.status", planId, project, status: next.meta.status });
  sendJson(res, 200, { ok: true, status: next.meta.status });
}

async function handleDeletePlan(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { project?: string; planId?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { project, planId } = parsed;
  if (!project || !planId) return sendJson(res, 400, { error: "missing_fields" });
  const rec = storage.readPlan(project, planId);
  if (!rec) return sendJson(res, 404, { error: "plan_not_found" });
  storage.deletePlan(project, planId);
  invalidate(storage.basePath(project, planId) + ".plan.tsx");
  state.broadcast({ type: "plan.deleted", planId, project });
  sendJson(res, 200, { ok: true });
}

async function handleFeedback(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { project?: string; planId?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  if (!parsed.project || !parsed.planId) return sendJson(res, 400, { error: "missing_fields" });
  const rec = storage.readPlan(parsed.project, parsed.planId);
  if (!rec) return sendJson(res, 404, { error: "plan_not_found" });
  const lines: string[] = [
    `Feedback on plan "${rec.meta.title}":`,
    "",
  ];
  const entries = Object.entries(rec.notes);
  if (entries.length === 0) return sendJson(res, 400, { error: "no_comments" });
  for (const [blockId, comment] of entries) {
    lines.push(`[${blockId}] ${comment}`);
  }
  lines.push("", "Please revise.");
  const text = lines.join("\n");
  const r = state.enqueueOrDeliver({ text, kind: "feedback", meta: { planId: parsed.planId, project: parsed.project } });
  state.broadcast({ type: "feedback:sent", planId: parsed.planId, queued: r.queued, position: r.position });
  sendJson(res, 200, { ok: true, queued: r.queued, position: r.position });
}

async function handleStartImplementation(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { project?: string; planId?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  if (!parsed.project || !parsed.planId) return sendJson(res, 400, { error: "missing_fields" });
  const rec = storage.readPlan(parsed.project, parsed.planId);
  if (!rec) return sendJson(res, 404, { error: "plan_not_found" });
  if (rec.meta.status === "implemented") return sendJson(res, 409, { error: "plan_already_implemented" });
  const next = storage.setStatus(parsed.project, parsed.planId, "approved");
  state.broadcast({ type: "plan.status", planId: parsed.planId, project: parsed.project, status: next.meta.status });
  const text = [
    `Start implementation of plan "${rec.meta.title}" (id: ${parsed.planId}).`,
    `No comments — proceed.`,
  ].join("\n");
  const r = state.enqueueOrDeliver({ text, kind: "implementation", meta: { planId: parsed.planId, project: parsed.project } });
  state.broadcast({ type: "implementation:started", planId: parsed.planId, queued: r.queued, position: r.position });
  sendJson(res, 200, { ok: true, queued: r.queued, position: r.position });
}

async function handlePlansList(_req: IncomingMessage, res: ServerResponse) {
  const out: Record<string, ReturnType<Storage["listPlans"]>> = {};
  for (const p of storage.listProjects()) out[p] = storage.listPlans(p);
  sendJson(res, 200, out);
}

async function handlePlanPage(_req: IncomingMessage, res: ServerResponse, project: string, planId: string) {
  const rec = storage.readPlan(project, planId);
  if (!rec) return send(res, 404, "plan not found");
  const sourcePath = join(storage.basePath(project, planId) + ".plan.tsx");
  try {
    const { html, hasMermaid } = await compilePlanFile(sourcePath);
    const decorated = decorateWithNotes(html, rec.notes);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderShell(rec.meta.title, decorated, hasMermaid, {
      id: rec.meta.id,
      project: rec.meta.project,
      status: rec.meta.status,
      notes: rec.notes,
    }, "", rec.meta.project));
  } catch (e) {
    res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
    res.end(`<pre>${escapeHtml(e instanceof Error ? e.message : String(e))}</pre>`);
  }
}

function decorateWithNotes(html: string, notes: Record<string, string>): string {
  // Tag <section class="block" data-block-id="X"> with data-has-comment="true" when notes[X] exists.
  return html.replace(/<section\s+class="block"\s+data-block-id="([^"]+)"/g, (m, id: string) => {
    return notes[id] ? `${m} data-has-comment="true"` : m;
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
          const inProgress = plans.filter((pl) => pl.status === "proposed" || pl.status === "approved").length;
          const done = plans.filter((pl) => pl.status === "implemented").length;
          const latest = plans[0];
          return `<a class="project-card" href="/projects/${encodeURIComponent(p)}">
            <h3>${escapeHtml(meta?.name || p)}</h3>
            ${meta?.description ? `<p class="project-desc">${escapeHtml(meta.description)}</p>` : ""}
            <div class="project-stats">
              <span><strong>${plans.length}</strong> plan${plans.length === 1 ? "" : "s"}</span>
              <span class="dot">·</span>
              <span class="status-proposed">${inProgress} active</span>
              <span class="dot">·</span>
              <span class="status-implemented">${done} done</span>
            </div>
            ${latest ? `<p class="project-latest">latest: <span>${escapeHtml(latest.title)}</span></p>` : ""}
          </a>`;
        }).join("")}
      </div>
    </main>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(renderShell("web-planner", body, false));
}

function renderTabBar(active: string, tabs: { id: string; title: string; kind: string }[]): string {
  return `<nav class="tab-bar">
    ${tabs.map((t) => `<a class="tab ${t.id === active ? "active" : ""}" href="?tab=${encodeURIComponent(t.id)}" data-tab-id="${escapeHtml(t.id)}" data-tab-kind="${escapeHtml(t.kind)}">${escapeHtml(t.title)}</a>`).join("")}
  </nav>`;
}

async function renderBuiltinTab(project: string, tabId: string): Promise<string> {
  if (tabId === "plans") {
    const plans = storage.listPlans(project);
    const COLUMNS: { status: "proposed" | "approved" | "implemented" | "abandoned"; label: string }[] = [
      { status: "proposed", label: "Proposed" },
      { status: "approved", label: "Approved" },
      { status: "implemented", label: "Implemented" },
      { status: "abandoned", label: "Abandoned" },
    ];
    const empty = plans.length === 0 ? `<p class="muted">No plans yet. Drag here once the planner creates one.</p>` : "";
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
            <button type="button" class="plan-row-delete" data-plan-id="${escapeHtml(p.id)}" data-plan-title="${escapeHtml(p.title)}" data-plan-status="${escapeHtml(p.status)}" title="delete plan">×</button>
          </div>`).join("")}
        </div>
      </section>`;
    };
    return `${empty}<div class="kanban">${COLUMNS.map((c) => column(c.label, c.status)).join("")}</div>`;
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
  const notes = storage.readTabNotes(project, tabId);
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
    else if (tab.kind === "board") tabBody = renderBoardTab(project, tab.id);
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
  const tabMeta = tab.kind === "custom" ? `<script>window.__TAB__ = ${JSON.stringify({ project, tabId: tab.id })};</script>` : "";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(renderShell(`${meta.name || project} — web-planner`, body, hasMermaid, undefined, `${tabMeta}<script type="module" src="/ui/project.js"></script>`, project));
}

function renderBoardTab(project: string, boardId: string): string {
  const board = storage.readCardBoard(project, boardId);
  if (!board) return `<p class="muted">Board not found: ${escapeHtml(boardId)}</p>`;
  const cols = board.statuses.map((status) => {
    const cards = board.cards.filter((c) => c.status === status);
    const cardHtml = cards.map((c) => `
      <div class="card-item" data-card-id="${escapeHtml(c.id)}" data-board-id="${escapeHtml(boardId)}" data-project="${escapeHtml(project)}">
        <div class="card-item-title">${escapeHtml(c.title)}</div>
        ${c.body ? `<div class="card-item-body">${escapeHtml(c.body)}</div>` : ""}
        <span class="card-item-status">${escapeHtml(status)}</span>
      </div>`).join("");
    return `<div class="card-col" data-status="${escapeHtml(status)}">
      <header class="card-col-head">
        <h4>${escapeHtml(status)}</h4>
        <span class="muted small">${cards.length}</span>
      </header>
      <div class="card-col-body">${cardHtml}</div>
      <button type="button" class="card-col-add" data-board-id="${escapeHtml(boardId)}" data-status="${escapeHtml(status)}" data-project="${escapeHtml(project)}">+ Add card</button>
    </div>`;
  }).join("");
  return `<div class="card-board" data-board-id="${escapeHtml(boardId)}" data-project="${escapeHtml(project)}">
    <header class="card-board-header">
      <span class="card-board-title">${escapeHtml(board.title)}</span>
      <button type="button" class="card-board-edit-btn" data-board-id="${escapeHtml(boardId)}" data-project="${escapeHtml(project)}" title="Edit columns">⚙ Edit columns</button>
    </header>
    ${cols}
  </div>`;
}

async function handleProjectTabFragment(req: IncomingMessage, res: ServerResponse, project: string, tabId: string) {
  const meta = storage.readProject(project);
  if (!meta) return send(res, 404, "project not found");
  const tab = meta.tabs.find((t) => t.id === tabId);
  if (!tab) return send(res, 404, "tab not found");
  try {
    let body: string;
    if (tab.kind === "builtin") body = await renderBuiltinTab(project, tab.id);
    else if (tab.kind === "board") body = renderBoardTab(project, tab.id);
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

async function handleGenerateBlock(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { planId?: string; prompt?: string; project?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { planId, prompt, project } = parsed;
  if (!planId || !prompt) return sendJson(res, 400, { error: "missing_fields" });
  const text = `[generate-block planId=${planId}${project ? ` project=${project}` : ""}]\n${prompt}`;
  const r = state.enqueueOrDeliver({ text, kind: "chat", meta: { planId, project } });
  sendJson(res, 200, { ok: true, queued: r.queued });
}

async function handleCreatePlanStub(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { title?: string; brief?: string; project?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { title, brief, project: proj } = parsed;
  if (!title || !brief) return sendJson(res, 400, { error: "missing_fields" });
  const project = proj || "default";
  const slug = slugify(title);
  const id = nowId(slug);
  const now = new Date().toISOString();
  const escapedTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedBrief = brief.replace(/[<>&]/g, (c: string) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
  const source = `import { Plan, Block, Callout } from "@web-planner/kit";\n\nexport default () => (\n  <Plan title="${escapedTitle}" status="proposed">\n    <Block id="b-brief" kind="summary">\n      <Callout>${escapedBrief}</Callout>\n    </Block>\n  </Plan>\n);\n`;
  storage.writePlan({ meta: { id, title, slug, status: "proposed", created: now, modified: now, project }, source, notes: {} });
  state.broadcast({ type: "plan.created", planId: id, project });
  const text = `[expand-plan planId=${id}]\n${brief}`;
  const r = state.enqueueOrDeliver({ text, kind: "chat", meta: { planId: id, project } });
  const url = `http://localhost:${config.port}/plans/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;
  sendJson(res, 200, { ok: true, planId: id, url, queued: r.queued });
}

async function handleBoardCreateCard(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { project?: string; boardId?: string; title?: string; body?: string; status?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { project, boardId, title, body: cardBody, status } = parsed;
  if (!project || !boardId || !title || !status) return sendJson(res, 400, { error: "missing_fields" });
  try {
    const card = storage.addCard(project, boardId, title, cardBody ?? "", status);
    state.broadcast({ type: "board:changed", project, boardId });
    sendJson(res, 200, { ok: true, card_id: card.id });
  } catch (e) { sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
}

async function handleBoardUpdateCard(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { project?: string; boardId?: string; cardId?: string; title?: string; body?: string; status?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { project, boardId, cardId, ...patch } = parsed;
  if (!project || !boardId || !cardId) return sendJson(res, 400, { error: "missing_fields" });
  try {
    const card = storage.updateCard(project, boardId, cardId, patch as { title?: string; body?: string; status?: string });
    state.broadcast({ type: "board:changed", project, boardId });
    sendJson(res, 200, { ok: true, card_id: card.id });
  } catch (e) { sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
}

async function handleBoardDeleteCard(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { project?: string; boardId?: string; cardId?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { project, boardId, cardId } = parsed;
  if (!project || !boardId || !cardId) return sendJson(res, 400, { error: "missing_fields" });
  try {
    const removed = storage.deleteCard(project, boardId, cardId);
    state.broadcast({ type: "board:changed", project, boardId });
    sendJson(res, 200, { ok: true, deleted: removed });
  } catch (e) { sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
}

async function handleTabComment(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { project?: string; tabId?: string; blockId?: string; text?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { project, tabId, blockId, text } = parsed;
  if (!project || !tabId || !blockId || typeof text !== "string") return sendJson(res, 400, { error: "missing_fields" });
  try {
    storage.setTabComment(project, tabId, blockId, text);
    const type = text === "" ? "tab:comment:cleared" : "tab:comment:set";
    state.broadcast({ type, project, tabId, blockId });
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
}

async function handleBoardCreate(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { project?: string; title?: string; id?: string; statuses?: string[] };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { title, statuses, id: rawId } = parsed;
  if (!title || !statuses || !Array.isArray(statuses) || statuses.length === 0) {
    return sendJson(res, 400, { error: "missing_fields" });
  }
  const project = parsed.project || projectSlugFromCwd();
  const id = rawId || slugify(title);
  try {
    const board = storage.createCardBoard(project, id, title, statuses);
    state.broadcast({ type: "project.updated", project });
    sendJson(res, 200, { ok: true, board_id: board.id, title: board.title, statuses: board.statuses });
  } catch (e) {
    sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
}

async function handleBoardUpdateStatuses(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { project?: string; boardId?: string; statuses?: string[] };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { boardId, statuses } = parsed;
  if (!boardId || !statuses || !Array.isArray(statuses) || statuses.length === 0) {
    return sendJson(res, 400, { error: "missing_fields" });
  }
  const project = parsed.project || projectSlugFromCwd();
  try {
    const board = storage.updateBoardStatuses(project, boardId, statuses);
    state.broadcast({ type: "board:changed", project, boardId });
    sendJson(res, 200, { ok: true, statuses: board.statuses });
  } catch (e) {
    sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
}

async function handleCreateTab(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let parsed: { project?: string; title?: string; purpose?: string };
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "bad_json" }); }
  const { title, purpose } = parsed;
  if (!title || !purpose) return sendJson(res, 400, { error: "missing_fields" });
  const project = parsed.project || projectSlugFromCwd();
  const text = `Create a new tab titled "${title}": ${purpose}`;
  const r = state.enqueueOrDeliver({ text, kind: "chat", meta: { source: "new-tab-modal", project } });
  sendJson(res, 200, { ok: true, queued: r.queued, position: r.position });
}

async function router(req: IncomingMessage, res: ServerResponse) {
  // Localhost-only.
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
    if (m === "GET" && url.pathname === "/api/plans") return handlePlansList(req, res);

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
    if (m === "POST" && url.pathname === "/api/board/create") return handleBoardCreate(req, res);
    if (m === "POST" && url.pathname === "/api/board/update-statuses") return handleBoardUpdateStatuses(req, res);
    if (m === "POST" && url.pathname === "/api/board/create-card") return handleBoardCreateCard(req, res);
    if (m === "POST" && url.pathname === "/api/board/update-card") return handleBoardUpdateCard(req, res);
    if (m === "POST" && url.pathname === "/api/board/delete-card") return handleBoardDeleteCard(req, res);
    if (m === "POST" && url.pathname === "/api/tab-comment") return handleTabComment(req, res);
    if (m === "POST" && url.pathname === "/api/create-tab") return handleCreateTab(req, res);
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
