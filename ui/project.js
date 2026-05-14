// Project page chrome: tab switching + live layout tree.
// Mounted only on /projects/<slug> pages (renderShell adds it as extraScripts).

(function () {
  const page = document.querySelector(".project-page");
  if (!page) return;
  const project = page.getAttribute("data-project");

  // ---------- Tab switching (client-side) ----------
  const tabs = document.querySelectorAll(".tab-bar .tab");
  const panel = document.querySelector("[data-tab-panel]");
  tabs.forEach((t) => {
    t.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const id = t.getAttribute("data-tab-id");
      if (!id) return;
      tabs.forEach((x) => x.classList.toggle("active", x === t));
      page.setAttribute("data-active-tab", id);
      history.replaceState(null, "", "?tab=" + encodeURIComponent(id));
      try {
        const r = await fetch(`/projects/${encodeURIComponent(project)}/tab/${encodeURIComponent(id)}`);
        panel.innerHTML = await r.text();
        if (id === "layout") loadLayout();
        if (window.__renderMermaid) window.__renderMermaid();
      } catch (e) {
        panel.innerHTML = `<pre>${String(e)}</pre>`;
      }
    });
  });

  // ---------- Layout tab ----------
  async function loadLayout() {
    const mount = document.querySelector("[data-layout-mount]");
    if (!mount) return;
    mount.textContent = "loading…";
    try {
      const r = await fetch(`/api/layout/${encodeURIComponent(project)}`);
      const data = await r.json();
      if (!data.tree) {
        mount.innerHTML = `<p class="muted">no watchPath set</p>`;
        return;
      }
      mount.innerHTML = renderTree(data.tree, 0);
      wireTreeToggle(mount);
    } catch (e) {
      mount.innerHTML = `<pre>${String(e)}</pre>`;
    }
  }

  function renderTree(node, depth) {
    if (!node) return "";
    if (node.kind === "file") {
      const size = typeof node.size === "number" ? `<span class="tree-size">${formatBytes(node.size)}</span>` : "";
      return `<div class="tree-row file" style="padding-left:${depth*16}px"><span class="tree-icon">·</span><code>${escapeHtml(node.name)}</code>${size}</div>`;
    }
    const head = `<div class="tree-row dir" style="padding-left:${depth*16}px" data-toggle><span class="tree-icon">▾</span><code>${escapeHtml(node.name)}/</code></div>`;
    const kids = (node.children || []).map((c) => renderTree(c, depth+1)).join("");
    return `<div class="tree-dir">${head}<div class="tree-children">${kids}</div></div>`;
  }
  function wireTreeToggle(root) {
    root.querySelectorAll("[data-toggle]").forEach((el) => {
      el.addEventListener("click", () => {
        const parent = el.parentElement;
        if (!parent) return;
        parent.classList.toggle("collapsed");
        el.querySelector(".tree-icon").textContent = parent.classList.contains("collapsed") ? "▸" : "▾";
      });
    });
  }
  function formatBytes(n) {
    if (n < 1024) return n + "B";
    if (n < 1024*1024) return Math.round(n/1024) + "K";
    return (n/1024/1024).toFixed(1) + "M";
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" }[c]));
  }

  // initial mount if layout is the active tab on first paint
  if (page.getAttribute("data-active-tab") === "layout") loadLayout();

  // ---------- Plans-tab row delete ----------
  async function refetchActiveTab() {
    const active = page.getAttribute("data-active-tab") || "plans";
    try {
      const r = await fetch(`/projects/${encodeURIComponent(project)}/tab/${encodeURIComponent(active)}`);
      panel.innerHTML = await r.text();
      if (active === "layout") loadLayout();
      if (window.__renderMermaid) window.__renderMermaid();
    } catch (e) {
      panel.innerHTML = `<pre>${String(e)}</pre>`;
    }
  }

  document.addEventListener("click", async (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const btn = target.closest(".plan-row-delete");
    if (!btn) return;
    ev.preventDefault();
    const planId = btn.getAttribute("data-plan-id");
    const planTitle = btn.getAttribute("data-plan-title") || planId;
    const status = btn.getAttribute("data-plan-status");
    if (!planId) return;
    const frozen = status === "implemented";
    const msg = frozen
      ? `"${planTitle}" is implemented — delete anyway? This is permanent.`
      : `Delete "${planTitle}"? This is permanent.`;
    if (!confirm(msg)) return;
    btn.disabled = true;
    try {
      const r = await fetch("/api/plan/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, planId }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        alert("delete failed: " + (e.error || r.status));
        btn.disabled = false;
      }
      // Refresh handled by SSE plan.deleted.
    } catch (e) {
      alert("delete failed: " + e);
      btn.disabled = false;
    }
  });

  // ---------- SSE: layout:changed + tab.updated ----------
  // Reuse the existing app.js EventSource? app.js owns one. To avoid two
  // connections we listen to a custom event app.js dispatches, OR open
  // a second EventSource. Simpler: second EventSource scoped to project.
  const es = new EventSource("/api/stream");
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "layout:changed" && msg.project === project) {
      if (page.getAttribute("data-active-tab") === "layout") loadLayout();
    }
    if (msg.type === "tab.updated" && msg.project === project) {
      const active = page.getAttribute("data-active-tab");
      if (active === msg.tabId) {
        const tabEl = document.querySelector(`.tab[data-tab-id="${msg.tabId}"]`);
        if (tabEl) tabEl.click();
      }
    }
    if (msg.type === "project.updated" && msg.project === project) {
      // reload to pick up new tabs / description / watchPath
      setTimeout(() => location.reload(), 200);
    }
    if ((msg.type === "plan.deleted" || msg.type === "plan.created" || msg.type === "plan.status") && msg.project === project) {
      const active = page.getAttribute("data-active-tab");
      if (active === "plans") refetchActiveTab();
    }
  };
})();
