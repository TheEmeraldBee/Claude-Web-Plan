// Project page chrome: tab switching + live layout tree.
// Mounted only on /projects/<slug> pages (renderShell adds it as extraScripts).

(function () {
  const page = document.querySelector(".project-page");
  if (!page) return;
  const project = page.getAttribute("data-project");

  // Surface errors as toasts when app.js's showToast is mounted; fall back to
  // alert() only as a last resort (e.g. SSR-blocked or app.js failed to load).
  function showError(text) { (window.__showToast || alert)(text, "error"); }

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
        const tabKind = t.getAttribute("data-tab-kind") || "";
        if (tabKind === "custom") window.__TAB__ = { project, tabId: id };
        else delete window.__TAB__;
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
      const tabEl = document.querySelector(`.tab[data-tab-id="${CSS.escape(active)}"]`);
      const tabKind = tabEl ? tabEl.getAttribute("data-tab-kind") || "" : "";
      if (tabKind === "custom") window.__TAB__ = { project, tabId: active };
      else delete window.__TAB__;
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
        showError("status change failed: " + (e.error || r.status));
        // Roll back by refetching from server.
        refetchActiveTab();
        return;
      }
      // Refetch to sync any other modifications and authoritative order.
      refetchActiveTab();
    } catch (e) {
      showError("status change failed: " + e);
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
        showError("delete failed: " + (e.error || r.status));
        btn.disabled = false;
      }
      // Refresh handled by SSE plan.deleted.
    } catch (e) {
      showError("delete failed: " + e);
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
    if (window.__wpBar && window.__wpBar.isBusy && window.__wpBar.isBusy()) {
      window.__wpBar.showHint("planner is not waiting for input");
      return;
    }
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.setAttribute("aria-label", "New plan");
    const modal = document.createElement("div");
    modal.className = "popover";
    modal.style.cssText = "width:480px;max-width:calc(100vw - 32px);max-height:calc(100vh - 64px);overflow-y:auto;";
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
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const controller = (window.__wpBar?.wireModal || ((el) => ({ close: () => el.remove() })))(overlay);
    const titleInput = modal.querySelector(".new-plan-title");
    titleInput && titleInput.focus();
    modal.querySelector(".cancel").addEventListener("click", () => controller.close());
    overlay.addEventListener("click", (ev) => { if (!modal.contains(ev.target)) controller.close(); });
    modal.querySelector(".save").addEventListener("click", async () => {
      const title = titleInput ? titleInput.value.trim() : "";
      const brief = modal.querySelector(".new-plan-brief")?.value.trim() || "";
      if (!title || !brief) { showError("Title and brief are required."); return; }
      const saveBtn = modal.querySelector(".save");
      saveBtn.disabled = true; saveBtn.textContent = "Creating…";
      try {
        const r = await fetch("/api/create-plan-stub", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, brief, project }),
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok) { controller.close(); if (data.url) location.href = data.url; }
        else { showError("create failed: " + (data.error || r.status)); saveBtn.disabled = false; saveBtn.textContent = "Create"; }
      } catch (e) { showError("create failed: " + e); saveBtn.disabled = false; saveBtn.textContent = "Create"; }
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
      try { if (q) sessionStorage.setItem("wp:plan-search", q); else sessionStorage.removeItem("wp:plan-search"); } catch {}
      document.querySelectorAll(".plan-card").forEach((card) => {
        const title = (card.querySelector(".plan-title")?.textContent || "").toLowerCase();
        card.style.display = !q || title.includes(q) ? "" : "none";
      });
      updateColumnCounts();
    });
    // Restore session filter
    try {
      const saved = sessionStorage.getItem("wp:plan-search");
      if (saved) { input.value = saved; input.dispatchEvent(new Event("input")); }
    } catch {}
  }

  // ---------- Custom tab block comments ----------
  function wireCustomTabComments(tabId) {
    const panel = document.querySelector("[data-tab-panel]");
    if (!panel) return;
    panel.querySelectorAll("[data-block-id]").forEach((block) => {
      // Skip blocks inside plan sub-tabs — those are covered by the tab-panel comment system
      if (block.closest(".plan-tab-panel")) return;
      // Remove any stale toolbars before re-wiring
      block.querySelectorAll(".block-toolbar").forEach((t) => t.remove());
      const toolbar = document.createElement("div");
      toolbar.className = "block-toolbar";
      toolbar.style.cssText = "display:flex;gap:6px;margin-top:10px;";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "comment-btn";
      btn.setAttribute("data-comment-for", block.getAttribute("data-block-id") || "");
      btn.textContent = block.getAttribute("data-has-comment") === "true" ? "edit comment" : "+ comment";
      const _existingText = block.getAttribute("data-comment-text") || "";
      if (_existingText) btn.setAttribute("data-comment-text", _existingText);
      toolbar.appendChild(btn);
      block.appendChild(toolbar);
    });
    if (panel._tabCommentListener) panel.removeEventListener("click", panel._tabCommentListener);
    panel._tabCommentListener = (ev) => {
      const btn = ev.target instanceof HTMLElement ? ev.target.closest(".comment-btn") : null;
      if (!btn) return;
      const blockId = btn.getAttribute("data-comment-for");
      if (blockId) openTabCommentPopover(tabId, blockId, btn);
    };
    panel.addEventListener("click", panel._tabCommentListener);
    if (window.__wpBar) window.__wpBar.setFeedback({ project, target_kind: "tab", target_id: tabId });
  }

  function openTabCommentPopover(tabId, blockId, triggerBtn) {
    document.querySelectorAll(".modal-overlay").forEach((o) => o.remove());
    document.querySelectorAll(".popover").forEach((p) => p.remove());
    const block = document.querySelector(`[data-block-id="${blockId}"]`);
    if (!block) return;
    const existing = block.getAttribute("data-has-comment") === "true" ? triggerBtn.getAttribute("data-comment-text") || "" : "";
    const pop = document.createElement("div");
    pop.className = "popover";
    pop.setAttribute("data-comment-block", blockId);
    pop.innerHTML = `
      <h6>comment on ${escapeHtml(blockId)}</h6>
      ${existing ? `<div class="existing">${escapeHtml(existing)}</div>` : ""}
      <textarea rows="2" placeholder="${existing ? "overwrite the comment…" : "add a comment…"}"></textarea>
      <div class="row">
        <button type="button" class="cancel">cancel</button>
        ${existing ? `<button type="button" class="delete">delete</button>` : ""}
        <button type="button" class="save">save</button>
      </div>`;
    document.body.appendChild(pop);
    const rect = block.getBoundingClientRect();
    pop.style.cssText = `position:fixed;top:${Math.min(rect.bottom + 8, window.innerHeight - 200)}px;left:${Math.min(rect.left, window.innerWidth - 296)}px;max-width:calc(100vw - 32px);`;
    const ta = pop.querySelector("textarea");
    ta && ta.focus();
    pop.querySelector(".cancel").addEventListener("click", () => pop.remove());
    const delBtn = pop.querySelector(".delete");
    if (delBtn) {
      delBtn.addEventListener("click", async () => {
        delBtn.disabled = true;
        try {
          const r = await fetch("/api/comment", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ project, target_kind: "tab", target_id: tabId, block_id: blockId, text: "" }),
          });
          if (r.ok) {
            block.removeAttribute("data-has-comment");
            triggerBtn.textContent = "+ comment";
            triggerBtn.removeAttribute("data-comment-text");
            pop.remove();
          } else { const e = await r.json().catch(() => ({})); showError("delete failed: " + (e.error || r.status)); delBtn.disabled = false; }
        } catch (e) { showError("delete failed: " + e); delBtn.disabled = false; }
      });
    }
    pop.querySelector(".save").addEventListener("click", async () => {
      const text = ta.value.trim();
      if (!text) { pop.remove(); return; }
      const saveBtn = pop.querySelector(".save");
      saveBtn.disabled = true;
      try {
        const r = await fetch("/api/comment", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ project, target_kind: "tab", target_id: tabId, block_id: blockId, text }),
        });
        if (r.ok) {
          block.setAttribute("data-has-comment", "true");
          triggerBtn.textContent = "edit comment";
          triggerBtn.setAttribute("data-comment-text", text);
          pop.remove();
        } else { const e = await r.json().catch(() => ({})); showError("save failed: " + (e.error || r.status)); saveBtn.disabled = false; }
      } catch (e) { showError("save failed: " + e); saveBtn.disabled = false; }
    });
    function _outerClickTabPop(ev) {
      if (!pop.contains(ev.target) && !ev.target?.closest?.(".comment-btn")) {
        pop.remove();
        document.removeEventListener("click", _outerClickTabPop, true);
      }
    }
    setTimeout(() => document.addEventListener("click", _outerClickTabPop, true), 0);
  }

  // ---------- New Tab ("+") button ----------
  function mountNewTabBtn() {
    const tabBar = document.querySelector(".tab-bar");
    if (!tabBar || tabBar.querySelector(".new-tab-btn")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "new-tab-btn tab";
    btn.textContent = "+";
    btn.title = "Create a new tab with AI";
    btn.addEventListener("click", openNewTabModal);
    tabBar.appendChild(btn);
  }

  const INPUT_STYLE = "width:100%;padding:7px 10px;background:var(--mantle);border:1px solid var(--surface0);border-radius:6px;color:var(--text);font-size:0.9rem;font-family:inherit;box-sizing:border-box;";

  function openNewTabModal() {
    if (window.__wpBar && window.__wpBar.isBusy && window.__wpBar.isBusy()) {
      window.__wpBar.showHint("planner is not waiting for input");
      return;
    }
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const modal = document.createElement("div");
    modal.className = "popover";
    modal.style.cssText = "width:480px;max-width:calc(100vw - 32px);max-height:calc(100vh - 64px);overflow-y:auto;";
    modal.innerHTML = `
      <h6>New tab</h6>
      <input type="text" class="new-tab-title" placeholder="Tab title…"
        style="${INPUT_STYLE}margin-bottom:8px;" />
      <textarea class="new-tab-purpose" rows="4" placeholder="Describe what this tab should contain…"
        style="${INPUT_STYLE}resize:vertical;"></textarea>
      <div class="modal-error" style="display:none;color:var(--red);font-size:0.85rem;margin-top:6px;"></div>
      <div class="row" style="margin-top:8px;">
        <button type="button" class="cancel">Cancel</button>
        <button type="button" class="save">Create with AI</button>
      </div>
      <div class="new-tab-status" hidden style="margin-top:8px;font-size:0.85rem;color:var(--subtext1);"></div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const controller = (window.__wpBar?.wireModal || ((el) => ({ close: () => el.remove() })))(overlay);

    const titleInput = modal.querySelector(".new-tab-title");
    const saveBtn = modal.querySelector(".save");
    const errorEl = modal.querySelector(".modal-error");

    function showInlineError(msg) { errorEl.style.display = ""; errorEl.textContent = msg; }
    function clearError() { errorEl.style.display = "none"; }

    titleInput && titleInput.focus();
    modal.querySelector(".cancel").addEventListener("click", () => controller.close());
    overlay.addEventListener("click", (ev) => { if (!modal.contains(ev.target)) controller.close(); });

    saveBtn.addEventListener("click", async () => {
      clearError();
      const title = titleInput ? titleInput.value.trim() : "";
      if (!title) { showInlineError("Title is required."); return; }

      const purpose = modal.querySelector(".new-tab-purpose")?.value.trim() || "";
      if (!purpose) { showInlineError("Purpose is required."); return; }
      const statusEl = modal.querySelector(".new-tab-status");
      saveBtn.disabled = true; saveBtn.textContent = "Sending to planner…";
      statusEl.hidden = false; statusEl.textContent = "Planner is generating the tab…";
      try {
        const r = await fetch("/api/create-tab", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, purpose, project }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) { showInlineError("Create failed: " + (data.error || r.status)); saveBtn.disabled = false; saveBtn.textContent = "Create with AI"; statusEl.hidden = true; return; }
        statusEl.textContent = data.queued ? "Queued — planner is busy. Tab will appear when ready." : "Planner is working… (page will reload when done)";
        const _modalTid = setTimeout(() => {
          controller.close();
          showError("The planner didn't respond in 60 s — check the chat panel.");
        }, 60000);
        modal.setAttribute("data-waiting", "1");
        modal.setAttribute("data-timeout-id", String(_modalTid));
      } catch (e) { showInlineError("Create failed: " + e); saveBtn.disabled = false; saveBtn.textContent = "Create with AI"; statusEl.hidden = true; }
    });
  }

  // ---------- Post-render init (called after any panel HTML swap) ----------
  function postRenderInit(activeTab) {
    if (activeTab === "plans") { mountNewPlanBtn(); mountPlanSearch(); }
    if (activeTab === "modals") wireModalsTab();
    if (window.__renderMermaid) window.__renderMermaid();
    const tabMeta = window.__TAB__;
    if (tabMeta && tabMeta.tabId === activeTab) {
      wireCustomTabComments(activeTab);
    } else if (window.__wpBar) {
      window.__wpBar.setFeedback(null);
    }
  }

  function wireModalsTab() {
    panel.querySelectorAll(".modals-reopen").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-modal-id");
        if (!id) return;
        btn.disabled = true;
        try {
          await fetch("/api/modal/reopen", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ project, id }),
          });
        } finally { btn.disabled = false; }
      });
    });
    panel.querySelectorAll(".modals-delete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-modal-id");
        if (!id) return;
        if (!confirm("Delete this modal? This is permanent.")) return;
        btn.disabled = true;
        try {
          const r = await fetch("/api/modal/delete", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ project, id }),
          });
          if (r.ok) refetchActiveTab();
        } finally { btn.disabled = false; }
      });
    });
    const clearAll = panel.querySelector(".modals-clear-all");
    if (clearAll) {
      clearAll.addEventListener("click", async () => {
        if (!confirm("Clear all modal history? This is permanent.")) return;
        clearAll.disabled = true;
        try {
          const r = await fetch("/api/modals/clear", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ project }),
          });
          if (r.ok) refetchActiveTab();
        } finally { clearAll.disabled = false; }
      });
    }
  }

  // Initial mount for active tab on first paint.
  postRenderInit(page.getAttribute("data-active-tab") || "");
  mountNewTabBtn();

  // ---------- SSE: layout:changed + tab.updated ----------
  // app.js owns the EventSource and dispatches 'wp:sse' CustomEvents.
  // We listen here instead of opening a second connection.
  window.addEventListener("wp:sse", (ev) => {
    const msg = ev.detail;
    if (msg.type === "layout:changed" && msg.project === project) {
      if (page.getAttribute("data-active-tab") === "layout") loadLayout();
    }
    if (msg.type === "tab.updated" && msg.project === project) {
      const active = page.getAttribute("data-active-tab");
      if (active === msg.tabId) {
        const tabEl = document.querySelector(`.tab[data-tab-id="${CSS.escape(msg.tabId)}"]`);
        if (tabEl) tabEl.click();
      }
    }
    if (msg.type === "project.updated" && msg.project === project) {
      const waiting = document.querySelector(".popover[data-waiting]");
      if (waiting) {
        const tid = waiting.getAttribute("data-timeout-id");
        if (tid) clearTimeout(Number(tid));
        waiting.remove();
      }
      setTimeout(() => location.reload(), 200);
    }
    if ((msg.type === "plan.deleted" || msg.type === "plan.created" || msg.type === "plan.status") && msg.project === project) {
      const active = page.getAttribute("data-active-tab");
      if (active === "plans") refetchActiveTab();
    }
    if ((msg.type === "modal.open" || msg.type === "modal.deleted" || msg.type === "modals.cleared") && msg.project === project) {
      if (page.getAttribute("data-active-tab") === "modals") refetchActiveTab();
    }
    if ((msg.type === "comment:set" || msg.type === "comment:cleared") && msg.project === project && msg.target_kind === "tab") {
      const active = page.getAttribute("data-active-tab");
      if (active === msg.target_id) {
        const block = panel.querySelector(`[data-block-id="${CSS.escape(msg.blockId)}"]`);
        if (block) {
          const btn = panel.querySelector(`.comment-btn[data-comment-for="${CSS.escape(msg.blockId)}"]`);
          if (msg.type === "comment:set") {
            block.setAttribute("data-has-comment", "true");
            block.setAttribute("data-comment-text", msg.text || "");
            if (btn) { btn.textContent = "edit comment"; btn.setAttribute("data-comment-text", msg.text || ""); }
          } else {
            block.removeAttribute("data-has-comment");
            block.removeAttribute("data-comment-text");
            if (btn) { btn.textContent = "+ comment"; btn.removeAttribute("data-comment-text"); }
          }
        }
      }
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { document.querySelectorAll(".modal-overlay").forEach((o) => o.remove()); document.querySelectorAll(".popover").forEach((p) => p.remove()); }
  });
})();
