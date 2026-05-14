import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { state } from "./state.js";
import { Storage } from "./storage.js";
import { compilePlanFile } from "./compile.js";

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

function renderShell(title: string, body: string, hasMermaid: boolean, planMeta?: { id: string; project: string; status: string; notes: Record<string, string> }): string {
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
  window.addEventListener("DOMContentLoaded", () => mermaid.run({ querySelector: "pre[data-mermaid]" }));
</script>` : ""}
</head><body><div class="page">${body}</div>
<script type="module" src="/ui/app.js"></script>
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
      ${projects.length === 0 ? `<p>No plans yet. The planner agent creates them.</p>` : ""}
      <div class="project-grid">
        ${projects.map((p) => {
          const plans = storage.listPlans(p);
          return `<div class="project-card">
            <h3>${escapeHtml(p)}</h3>
            <p>${plans.length} plan${plans.length === 1 ? "" : "s"}</p>
            ${plans.slice(0, 5).map((pl) => `
              <div class="plan-row">
                <a href="/plans/${escapeHtml(p)}/${escapeHtml(pl.id)}">${escapeHtml(pl.title)}</a>
                <span class="badge status-${escapeHtml(pl.status)}">${escapeHtml(pl.status)}</span>
                <span class="when">${escapeHtml(pl.modified.slice(0,16))}</span>
              </div>`).join("")}
          </div>`;
        }).join("")}
      </div>
    </main>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(renderShell("web-planner", body, false));
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

    if (m === "POST" && url.pathname === "/api/message") return handleMessage(req, res);
    if (m === "POST" && url.pathname === "/api/feedback") return handleFeedback(req, res);
    if (m === "POST" && url.pathname === "/api/comment") return handleComment(req, res);
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
