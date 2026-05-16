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
        postRenderInit(id);
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
      postRenderInit(active);
    } catch (e) {
      panel.innerHTML = `<pre>${String(e)}</pre>`;
    }
  }

  // ---------- Kanban drag-and-drop ----------
  let dragId = null;
  let dragFromStatus = null;
  let dragTitle = null;
  document.addEventListener("dragstart", (ev) => {
    const card = ev.target instanceof HTMLElement ? ev.target.closest(".plan-card") : null;
    if (!card) return;
    dragId = card.getAttribute("data-plan-id");
    dragFromStatus = card.getAttribute("data-plan-status");
    dragTitle = card.querySelector(".plan-title")?.textContent || dragId;
    card.classList.add("dragging");
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", dragId || "");
    }
  });
  document.addEventListener("dragend", (ev) => {
    const card = ev.target instanceof HTMLElement ? ev.target.closest(".plan-card") : null;
    if (card) card.classList.remove("dragging");
    document.querySelectorAll(".kanban-col.drop-target").forEach((c) => c.classList.remove("drop-target"));
    dragId = null;
    dragFromStatus = null;
    dragTitle = null;
  });
  document.addEventListener("dragover", (ev) => {
    const zone = ev.target instanceof HTMLElement ? ev.target.closest("[data-drop-zone]") : null;
    if (!zone || !dragId) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
    const col = zone.closest(".kanban-col");
    document.querySelectorAll(".kanban-col.drop-target").forEach((c) => { if (c !== col) c.classList.remove("drop-target"); });
    if (col) col.classList.add("drop-target");
  });
  document.addEventListener("drop", async (ev) => {
    const zone = ev.target instanceof HTMLElement ? ev.target.closest("[data-drop-zone]") : null;
    if (!zone || !dragId) return;
    ev.preventDefault();
    const status = zone.getAttribute("data-drop-zone");
    const planId = dragId;
    const fromStatus = dragFromStatus;
    document.querySelectorAll(".kanban-col.drop-target").forEach((c) => c.classList.remove("drop-target"));
    if (!status || status === fromStatus) return;
    // Confirm before freezing a plan as implemented (irreversible).
    if (status === "implemented") {
      if (!confirm(`Mark "${dragTitle || planId}" as implemented? This will freeze the plan — further edits will not be possible.`)) return;
    }
    // Optimistic move so the user sees the change immediately.
    const card = document.querySelector(`.plan-card[data-plan-id="${cssEscape(planId)}"]`);
    if (card) {
      card.setAttribute("data-plan-status", status);
      zone.appendChild(card);
      const delBtn = card.querySelector(".plan-row-delete");
      if (delBtn) delBtn.setAttribute("data-plan-status", status);
      updateColumnCounts();
    }
    try {
      const r = await fetch("/api/plan/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, planId, status }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        alert("status change failed: " + (e.error || r.status));
        // Roll back by refetching from server.
        refetchActiveTab();
        return;
      }
      // Refetch to sync any other modifications and authoritative order.
      refetchActiveTab();
    } catch (e) {
      alert("status change failed: " + e);
      refetchActiveTab();
    }
  });

  function cssEscape(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
  }

  function updateColumnCounts() {
    document.querySelectorAll(".kanban-col").forEach((col) => {
      const body = col.querySelector(".kanban-col-body");
      const head = col.querySelector(".kanban-col-head .muted");
      if (body && head) head.textContent = String(body.querySelectorAll(".plan-card").length);
    });
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

  // ---------- New Plan button (Plans tab) ----------
  function mountNewPlanBtn() {
    const kanban = document.querySelector(".kanban");
    if (!kanban || document.querySelector(".new-plan-btn")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "new-plan-btn";
    btn.textContent = "+ New plan";
    btn.addEventListener("click", openNewPlanModal);
    kanban.before(btn);
  }

  function openNewPlanModal() {
    const modal = document.createElement("div");
    modal.className = "popover";
    modal.style.cssText = "position:fixed;top:30%;left:50%;transform:translateX(-50%);width:480px;z-index:60;";
    modal.innerHTML = `
      <h6>New plan</h6>
      <input type="text" class="new-plan-title" placeholder="Plan title…"
        style="width:100%;margin-bottom:8px;padding:7px 10px;background:var(--mantle);border:1px solid var(--surface0);border-radius:6px;color:var(--text);font-size:0.9rem;font-family:inherit;box-sizing:border-box;" />
      <textarea class="new-plan-brief" rows="4" placeholder="Describe the plan briefly — the planner will expand it…"
        style="width:100%;background:var(--mantle);border:1px solid var(--surface0);border-radius:6px;color:var(--text);font-size:0.9rem;font-family:inherit;padding:7px 10px;resize:vertical;box-sizing:border-box;"></textarea>
      <div class="row" style="margin-top:8px;">
        <button type="button" class="cancel">Cancel</button>
        <button type="button" class="save">Create</button>
      </div>`;
    document.body.appendChild(modal);
    const titleInput = modal.querySelector(".new-plan-title");
    titleInput && titleInput.focus();
    modal.querySelector(".cancel").addEventListener("click", () => modal.remove());
    modal.querySelector(".save").addEventListener("click", async () => {
      const title = titleInput ? titleInput.value.trim() : "";
      const brief = modal.querySelector(".new-plan-brief")?.value.trim() || "";
      if (!title || !brief) { alert("Title and brief are required."); return; }
      const saveBtn = modal.querySelector(".save");
      saveBtn.disabled = true; saveBtn.textContent = "Creating…";
      try {
        const r = await fetch("/api/create-plan-stub", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, brief, project }),
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok) { modal.remove(); if (data.url) location.href = data.url; }
        else { alert("create failed: " + (data.error || r.status)); saveBtn.disabled = false; saveBtn.textContent = "Create"; }
      } catch (e) { alert("create failed: " + e); saveBtn.disabled = false; saveBtn.textContent = "Create"; }
    });
  }

  // ---------- Card board UI ----------
  function mountCardBoard() {
    const board = document.querySelector("[data-board-id]");
    if (!board) return;
    const boardId = board.getAttribute("data-board-id");
    const proj = board.getAttribute("data-project") || project;

    board.addEventListener("click", async (ev) => {
      const target = ev.target instanceof HTMLElement ? ev.target : null;
      if (!target) return;

      const addBtn = target.closest(".card-col-add");
      if (addBtn) {
        const status = addBtn.getAttribute("data-status");
        const title = prompt("Card title:");
        if (!title || !title.trim()) return;
        const body = prompt("Body (optional):") || "";
        try {
          const r = await fetch("/api/board/create-card", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ project: proj, boardId, title: title.trim(), body, status }),
          });
          if (!r.ok) { const e = await r.json().catch(() => ({})); alert("create failed: " + (e.error || r.status)); }
        } catch (e) { alert("create failed: " + e); }
        return;
      }

      const card = target.closest(".card-item");
      if (card) {
        const cardId = card.getAttribute("data-card-id");
        const curTitle = card.querySelector(".card-item-title")?.textContent || "";
        const curBody = card.querySelector(".card-item-body")?.textContent || "";
        const curStatus = card.querySelector(".card-item-status")?.textContent || "";
        const newStatus = prompt(`Move to status (current: ${curStatus}):`, curStatus);
        if (newStatus === null) return;
        try {
          const r = await fetch("/api/board/update-card", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ project: proj, boardId, cardId, status: newStatus.trim() || curStatus }),
          });
          if (!r.ok) { const e = await r.json().catch(() => ({})); alert("update failed: " + (e.error || r.status)); }
        } catch (e) { alert("update failed: " + e); }
      }
    });
  }

  // ---------- Plan search ----------
  function mountPlanSearch() {
    const kanban = document.querySelector(".kanban");
    if (!kanban || document.querySelector(".plan-search")) return;
    const input = document.createElement("input");
    input.type = "search";
    input.className = "plan-search";
    input.placeholder = "Filter plans…";
    input.setAttribute("aria-label", "Filter plans by title");
    kanban.before(input);
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      document.querySelectorAll(".plan-card").forEach((card) => {
        const title = (card.querySelector(".plan-title")?.textContent || "").toLowerCase();
        card.style.display = !q || title.includes(q) ? "" : "none";
      });
      updateColumnCounts();
    });
  }

  // ---------- Post-render init (called after any panel HTML swap) ----------
  function postRenderInit(activeTab) {
    if (activeTab === "plans") { mountNewPlanBtn(); mountPlanSearch(); }
    if (document.querySelector("[data-board-id]")) mountCardBoard();
    if (window.__renderMermaid) window.__renderMermaid();
  }

  // Initial mount for active tab on first paint.
  postRenderInit(page.getAttribute("data-active-tab") || "");

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
    if (msg.type === "board:changed" && msg.project === project) {
      const active = page.getAttribute("data-active-tab");
      if (active === msg.boardId) refetchActiveTab();
    }
  };
})();
