import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { state } from "./state.js";
import { Storage } from "./storage.js";
import { compilePlanFile, invalidate } from "./compile.js";
import { buildTree } from "./layout.js";

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

function renderShell(title: string, body: string, hasMermaid: boolean, planMeta?: { id: string; project: string; status: string; notes: Record<string, string> }, extraScripts: string = ""): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="/kit/styles.css" />
${planMeta ? `<script>window.__PLAN__ = ${JSON.stringify(planMeta)};</script>` : ""}
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

  // resolve any pending wait_for_message
  for (const [id, p] of state.pending) {
    if (p.kind === "message") {
      state.pending.delete(id);
      const source = parsed.source ?? "chat";
      p.resolve(`[from ${source}]\n${text}`);
      state.broadcast({ type: "message:delivered", source });
      return sendJson(res, 200, { ok: true });
    }
  }
  // no waiting agent — store as backlog? For v1 just reject.
  sendJson(res, 409, { error: "agent_not_waiting", hint: "the planner is not currently blocked on wait_for_message" });
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
    storage.setComment(project, planId, blockId, text);
    state.broadcast({ type: "comment:set", project, planId, blockId });
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
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
  // resolve a pending wait_for_message
  for (const [id, p] of state.pending) {
    if (p.kind === "message") {
      state.pending.delete(id);
      p.resolve(text);
      state.broadcast({ type: "feedback:sent", planId: parsed.planId });
      return sendJson(res, 200, { ok: true });
    }
  }
  sendJson(res, 409, { error: "agent_not_waiting" });
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
    }));
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
    ${tabs.map((t) => `<a class="tab ${t.id === active ? "active" : ""}" href="?tab=${encodeURIComponent(t.id)}" data-tab-id="${escapeHtml(t.id)}">${escapeHtml(t.title)}</a>`).join("")}
  </nav>`;
}

async function renderBuiltinTab(project: string, tabId: string): Promise<string> {
  if (tabId === "plans") {
    const plans = storage.listPlans(project);
    if (plans.length === 0) return `<p class="muted">No plans yet.</p>`;
    const group = (status: string) => plans.filter((p) => p.status === status);
    const section = (label: string, status: string) => {
      const items = group(status);
      if (items.length === 0) return "";
      return `<section class="plan-section">
        <h3>${escapeHtml(label)} <span class="muted">(${items.length})</span></h3>
        <div class="plan-list">
          ${items.map((p) => `<div class="plan-row-wrap">
            <a class="plan-row" href="/plans/${encodeURIComponent(project)}/${encodeURIComponent(p.id)}">
              <span class="plan-title">${escapeHtml(p.title)}</span>
              <span class="badge status-${escapeHtml(p.status)}">${escapeHtml(p.status)}</span>
              <span class="when">${escapeHtml(p.modified.slice(0,16))}</span>
            </a>
            <button type="button" class="plan-row-delete" data-plan-id="${escapeHtml(p.id)}" data-plan-title="${escapeHtml(p.title)}" data-plan-status="${escapeHtml(p.status)}" title="delete plan">×</button>
          </div>`).join("")}
        </div>
      </section>`;
    };
    return [section("Proposed", "proposed"), section("Approved", "approved"), section("Implemented", "implemented"), section("Abandoned", "abandoned")].join("");
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
  return compiled.html;
}

async function handleProjectPage(req: IncomingMessage, res: ServerResponse, project: string) {
  const meta = storage.readProject(project);
  if (!meta) return send(res, 404, "project not found");
  const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
  const requested = url.searchParams.get("tab") || meta.tabs[0]?.id || "plans";
  const tab = meta.tabs.find((t) => t.id === requested) ?? meta.tabs[0]!;
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
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(renderShell(`${meta.name || project} — web-planner`, body, hasMermaid, undefined, `<script type="module" src="/ui/project.js"></script>`));
}

async function handleProjectTabFragment(req: IncomingMessage, res: ServerResponse, project: string, tabId: string) {
  const meta = storage.readProject(project);
  if (!meta) return send(res, 404, "project not found");
  const tab = meta.tabs.find((t) => t.id === tabId);
  if (!tab) return send(res, 404, "tab not found");
  try {
    const body = tab.kind === "builtin" ? await renderBuiltinTab(project, tab.id) : await renderCustomTab(project, tab.id);
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
    if (m === "POST" && url.pathname === "/api/comment") return handleComment(req, res);
    if (m === "POST" && url.pathname === "/api/plan/delete") return handleDeletePlan(req, res);
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
