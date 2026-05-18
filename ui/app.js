// Vanilla JS viewer chrome — popover comments, chat box, state pill, send-feedback.
// No build step. Loaded on every page from /ui/app.js.

(function () {
  const PLAN = /** @type {{id:string, project:string, status:string, notes:Record<string,string>}|undefined} */ (window.__PLAN__);
  const CARD = /** @type {{id:string, boardId:string, project:string, title:string, status:string, statuses:string[], notes:Record<string,string>}|undefined} */ (window.__CARD__);

  // ---------- State pill ----------
  function mountStatePill() {
    const chrome = document.createElement("div");
    chrome.className = "chrome";
    chrome.innerHTML = `
      <button type="button" class="state-pill" aria-expanded="true" title="toggle message box">
        <span class="state-dot state-dot-idle"></span><span class="state-name">connecting…</span>
        <span class="state-pill-caret" aria-hidden="true">▾</span>
      </button>
      <div class="chat-box">
        <textarea placeholder="Message the planner…"></textarea>
        <div class="row">
          <span class="state-name" style="font-size:.78rem;color:var(--subtext0);">↵ send &nbsp; Shift+↵ newline &nbsp; / focus</span>
          <button type="button">Send</button>
        </div>
        <div class="chat-hint" hidden></div>
      </div>
    `;
    document.body.appendChild(chrome);
    return chrome;
  }
  const chrome = mountStatePill();
  const pillBtn = chrome.querySelector(".state-pill");
  const pillDot = chrome.querySelector(".state-pill .state-dot");
  const pillName = chrome.querySelector(".state-pill .state-name");
  const chatArea = chrome.querySelector(".chat-box textarea");
  const chatBtn = chrome.querySelector(".chat-box button");
  const chatHint = chrome.querySelector(".chat-box .chat-hint");

  function showChatHint(text) {
    if (!chatHint) return;
    chatHint.textContent = text;
    chatHint.hidden = false;
    setTimeout(() => { chatHint.hidden = true; }, 4000);
  }

  function setCollapsed(collapsed) {
    chrome.classList.toggle("collapsed", collapsed);
    pillBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }
  setCollapsed(true);
  pillBtn.addEventListener("click", () => { setCollapsed(false); chatArea.focus(); });
  chatArea.addEventListener("blur", () => { setTimeout(() => setCollapsed(true), 120); });

  let _activeTimer = null;
  let _activeStart = 0;

  function setStateUi(value) {
    const kind = (value && value.kind) || "idle";
    pillDot.className = "state-dot state-dot-" + kind;
    pillDot.style.background = (value && value.color) ? value.color : "";
    if (_activeTimer) { clearInterval(_activeTimer); _activeTimer = null; }
    const IDLE_STATES = ["idle", "waiting"];
    if (IDLE_STATES.includes(kind)) {
      pillName.textContent = kind;
      document.querySelector(".planner-active-banner")?.remove();
    } else {
      _activeStart = Date.now();
      const update = () => {
        const s = Math.round((Date.now() - _activeStart) / 1000);
        pillName.textContent = s > 0 ? kind + " " + s + "s…" : kind;
      };
      update();
      _activeTimer = setInterval(update, 1000);
      if (PLAN && !document.querySelector(".planner-active-banner")) {
        const banner = document.createElement("div");
        banner.className = "planner-active-banner";
        banner.textContent = "Planner is working on this plan…";
        const planEl = document.querySelector(".plan");
        if (planEl) planEl.insertBefore(banner, planEl.firstChild);
      }
    }
  }

  // ---------- SSE ----------
  const es = new EventSource("/api/stream");
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    window.dispatchEvent(new CustomEvent("wp:sse", { detail: msg }));
    if (msg.type === "state") setStateUi(msg.value);
    if (msg.type === "ask_user:open") openAskModal(msg.id, msg.payload);
    if (msg.type === "comment:set" && PLAN && msg.planId === PLAN.id) reflectComment(msg.blockId);
    if (msg.type === "comment:cleared" && PLAN && msg.planId === PLAN.id) clearCommentUi(msg.blockId);
    if (msg.type === "plan.status" && PLAN && msg.planId === PLAN.id) reflectStatus(msg.status);
    if (msg.type === "block.updated") {
      if (PLAN && msg.planId === PLAN.id) {
        if (msg.blockId) livePatchBlock(msg.blockId);
        else setTimeout(() => location.reload(), 200);
      }
    }
    if (msg.type === "block.appended" || msg.type === "plan.created" || msg.type === "plan.updated") {
      if (PLAN && msg.planId === PLAN.id) setTimeout(() => location.reload(), 200);
    }
    if (msg.type === "plan.deleted") {
      if (PLAN && msg.planId === PLAN.id) {
        location.href = "/projects/" + encodeURIComponent(PLAN.project);
      } else if (!PLAN && location.pathname === "/") {
        // dashboard — refresh counts
        setTimeout(() => location.reload(), 150);
      }
    }
  };
  es.onerror = () => { pillName.textContent = "disconnected"; };

  // ---------- Chat ----------
  async function sendChat() {
    const text = chatArea.value.trim();
    if (!text) return;
    chatBtn.disabled = true;
    try {
      const r = await fetch("/api/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, source: "browser" }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        chatArea.value = "";
        if (data.queued) showChatHint("Queued — position " + (data.position || "?"));
      } else {
        alert("send failed: " + (data.error || r.status));
      }
    } finally {
      chatBtn.disabled = false;
    }
  }
  chatBtn.addEventListener("click", sendChat);
  chatArea.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      sendChat();
    }
  });

  // ---------- Live block patching ----------
  async function livePatchBlock(blockId) {
    try {
      const r = await fetch(location.href, { cache: "no-store" });
      if (!r.ok) { location.reload(); return; }
      const html = await r.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const newBlock = doc.querySelector('[data-block-id="' + cssEscape(blockId) + '"]');
      const oldBlock = document.querySelector('[data-block-id="' + cssEscape(blockId) + '"]');
      if (!newBlock || !oldBlock) { location.reload(); return; }
      oldBlock.replaceWith(newBlock);
      if (window.Prism) window.Prism.highlightAllUnder(newBlock);
      if (PLAN && PLAN.notes && PLAN.notes[blockId]) reflectComment(blockId);
      // Re-apply tab panel comment indicators for any of this block's tab panels
      if (PLAN && PLAN.notes) {
        const prefix = blockId + "~";
        Object.keys(PLAN.notes).forEach((k) => { if (k.startsWith(prefix)) reflectComment(k); });
      }
      if (window.__renderMermaid) window.__renderMermaid();
      if (PLAN) wireTabPanelCommentBtns();
    } catch {
      location.reload();
    }
  }

  // ---------- Tab panel comments ----------
  // Tab-panel comment keys use the format: "{blockId}~{tabId}" e.g. "b-phases~tab-1"
  function wireTabPanelCommentBtns() {
    if (!PLAN || PLAN.status === "implemented") return;
    document.querySelectorAll(".plan-tabs").forEach((tabs) => {
      const block = tabs.closest("[data-block-id]");
      if (!block) return;
      const blockId = block.getAttribute("data-block-id");
      tabs.querySelectorAll(".plan-tab-panel").forEach((panel) => {
        const tabId = panel.getAttribute("data-tab-id");
        if (!tabId) return;
        if (panel.querySelector(".tab-panel-toolbar")) return; // already wired
        const toolbar = document.createElement("div");
        toolbar.className = "tab-panel-toolbar";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "comment-btn";
        btn.setAttribute("data-comment-for", blockId + "~" + tabId);
        btn.textContent = "+ comment";
        toolbar.appendChild(btn);
        panel.appendChild(toolbar);
      });
      // Block contains tabs: hide the redundant block-level comment button
      const parentToolbar = block.querySelector(":scope > .block-toolbar");
      if (parentToolbar) parentToolbar.style.display = "none";
    });
  }

  function updateTabCommentBadge(commentId) {
    // Works for both plain block IDs (find their panel) and tab-panel IDs ("blockId~tabId")
    let panel, tabId;
    if (commentId.includes("~")) {
      const [parentId, tid] = commentId.split("~", 2);
      const parentBlock = document.querySelector('[data-block-id="' + cssEscape(parentId) + '"]');
      if (!parentBlock) return;
      panel = parentBlock.querySelector('[data-tab-id="' + cssEscape(tid) + '"]');
      tabId = tid;
      if (!panel) return;
    } else {
      const block = document.querySelector('[data-block-id="' + cssEscape(commentId) + '"]');
      if (!block) return;
      panel = block.closest(".plan-tab-panel");
      if (!panel) return;
      tabId = panel.getAttribute("data-tab-id");
    }
    if (!tabId) return;
    const tabs = panel.closest("[data-plan-tabs]");
    if (!tabs) return;
    const tabBtn = tabs.querySelector('[data-for-tab="' + cssEscape(tabId) + '"]');
    if (!tabBtn) return;
    const selfHas = panel.getAttribute("data-has-comment") === "true" ? 1 : 0;
    const innerCount = panel.querySelectorAll(".block[data-has-comment='true']").length;
    const total = selfHas + innerCount;
    let badge = tabBtn.querySelector(".tab-comment-badge");
    if (total > 0) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "tab-comment-badge";
        tabBtn.appendChild(badge);
      }
      badge.textContent = String(total);
    } else if (badge) {
      badge.remove();
    }
  }

  // ---------- Block comments ----------
  function reflectComment(blockId) {
    if (blockId.includes("~")) {
      // Tab-panel comment: "parentBlockId~tabId"
      const [parentId, tabId] = blockId.split("~", 2);
      const parentBlock = document.querySelector('[data-block-id="' + cssEscape(parentId) + '"]');
      if (!parentBlock) return;
      const panel = parentBlock.querySelector('[data-tab-id="' + cssEscape(tabId) + '"]');
      if (!panel) return;
      panel.setAttribute("data-has-comment", "true");
      const btn = panel.querySelector('.comment-btn[data-comment-for="' + cssEscape(blockId) + '"]');
      if (btn) btn.textContent = "edit comment";
      updateTabCommentBadge(blockId);
      return;
    }
    const block = document.querySelector('[data-block-id="' + cssEscape(blockId) + '"]');
    if (!block) return;
    block.setAttribute("data-has-comment", "true");
    const btn = block.querySelector(":scope > .block-toolbar .comment-btn");
    if (btn) btn.textContent = "edit comment";
    updateTabCommentBadge(blockId);
  }

  function clearCommentUi(blockId) {
    if (PLAN && PLAN.notes) delete PLAN.notes[blockId];
    if (blockId.includes("~")) {
      const [parentId, tabId] = blockId.split("~", 2);
      const parentBlock = document.querySelector('[data-block-id="' + cssEscape(parentId) + '"]');
      if (!parentBlock) return;
      const panel = parentBlock.querySelector('[data-tab-id="' + cssEscape(tabId) + '"]');
      if (!panel) return;
      panel.removeAttribute("data-has-comment");
      const btn = panel.querySelector('.comment-btn[data-comment-for="' + cssEscape(blockId) + '"]');
      if (btn) btn.textContent = "+ comment";
      const pop = document.querySelector('.popover[data-comment-block="' + cssEscape(blockId) + '"]');
      if (pop) pop.remove();
      updateTabCommentBadge(blockId);
      return;
    }
    const block = document.querySelector('[data-block-id="' + cssEscape(blockId) + '"]');
    if (!block) return;
    block.removeAttribute("data-has-comment");
    const btn = block.querySelector(":scope > .block-toolbar .comment-btn");
    if (btn) btn.textContent = "+ comment";
    const pop = document.querySelector('.popover[data-comment-block="' + cssEscape(blockId) + '"]');
    if (pop) pop.remove();
    updateTabCommentBadge(blockId);
  }

  function reflectStatus(status) {
    if (!PLAN) return;
    PLAN.status = status;
    const badge = document.querySelector(".plan .plan-header .badge.status-proposed, .plan .plan-header .badge.status-approved, .plan .plan-header .badge.status-implemented, .plan .plan-header .badge.status-abandoned");
    if (badge) {
      badge.className = "badge status-" + status;
      badge.textContent = status;
    }
    if (status === "implemented") {
      document.querySelectorAll(".send-feedback-bar, .start-impl-bar").forEach((b) => b.remove());
    }
  }

  function cssEscape(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
  }

  // ---------- Plan-internal tabs ----------
  document.addEventListener("click", (ev) => {
    const btn = ev.target instanceof HTMLElement ? ev.target.closest(".plan-tab-btn") : null;
    if (!btn) return;
    const tabs = btn.closest("[data-plan-tabs]");
    if (!tabs) return;
    const targetId = btn.getAttribute("data-for-tab");
    tabs.querySelectorAll(".plan-tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    tabs.querySelectorAll(".plan-tab-panel").forEach((p) => {
      const isTarget = p.getAttribute("data-tab-id") === targetId;
      p.hidden = !isTarget;
      p.querySelectorAll(".block-toolbar").forEach((t) => { t.style.display = isTarget ? "" : "none"; });
    });
  });

  // ---------- Slideshow ----------
  function initSlideshow(sw) {
    const slides = /** @type {HTMLElement[]} */ ([...sw.querySelectorAll(".slide")]);
    if (slides.length === 0) return;
    const prevBtn = sw.querySelector(".slide-prev");
    const nextBtn = sw.querySelector(".slide-next");
    const fsBtn = sw.querySelector(".slide-fullscreen");
    const curEl = sw.querySelector(".slide-cur");
    const labelEl = sw.querySelector(".slide-label");
    const fillEl = sw.querySelector(".slide-progress-fill");
    let current = 0;
    function goTo(n) {
      slides[current].setAttribute("aria-hidden", "true");
      current = Math.max(0, Math.min(n, slides.length - 1));
      const slide = slides[current];
      slide.setAttribute("aria-hidden", "false");
      slide.classList.remove("slide-entering");
      void slide.offsetWidth;
      slide.classList.add("slide-entering");
      if (curEl) curEl.textContent = String(current + 1);
      if (labelEl) {
        const t = slide.getAttribute("data-slide-title") || "";
        labelEl.textContent = t.length > 28 ? t.slice(0, 28) + "…" : t;
      }
      if (fillEl) fillEl.style.width = ((current + 1) / slides.length * 100) + "%";
      if (prevBtn) prevBtn.disabled = current === 0;
      if (nextBtn) nextBtn.disabled = current === slides.length - 1;
    }
    slides.forEach((s, i) => { s.setAttribute("aria-hidden", i !== 0 ? "true" : "false"); });
    if (fillEl) fillEl.style.width = (1 / slides.length * 100) + "%";
    if (labelEl && slides[0]) {
      const t = slides[0].getAttribute("data-slide-title") || "";
      labelEl.textContent = t.length > 28 ? t.slice(0, 28) + "…" : t;
    }
    if (prevBtn) { prevBtn.disabled = true; prevBtn.addEventListener("click", () => goTo(current - 1)); }
    if (nextBtn) { nextBtn.disabled = slides.length <= 1; nextBtn.addEventListener("click", () => goTo(current + 1)); }
    if (fsBtn) fsBtn.addEventListener("click", () => sw.classList.toggle("fullscreen"));
    try {
      if (!sessionStorage.getItem("wp:slide-hint-seen")) {
        const hint = document.createElement("div");
        hint.className = "slide-hint";
        hint.textContent = "← → to navigate · F for fullscreen";
        sw.querySelector(".slideshow-viewport")?.appendChild(hint);
        setTimeout(() => { hint.classList.add("fade-out"); setTimeout(() => hint.remove(), 500); }, 2800);
        sessionStorage.setItem("wp:slide-hint-seen", "1");
      }
    } catch {}
  }
  document.querySelectorAll("[data-slideshow]").forEach(initSlideshow);
  document.addEventListener("keydown", (ev) => {
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
    if (ev.key === "Escape") {
      const fs = document.querySelector(".slideshow.fullscreen");
      if (fs) { fs.classList.remove("fullscreen"); return; }
      document.querySelectorAll(".popover").forEach((p) => p.remove());
      return;
    }
    const sw = document.querySelector("[data-slideshow]");
    if (!sw) return;
    if (ev.key === "ArrowRight") { ev.preventDefault(); sw.querySelector(".slide-next")?.click(); }
    if (ev.key === "ArrowLeft")  { ev.preventDefault(); sw.querySelector(".slide-prev")?.click(); }
    if (ev.key.toLowerCase() === "f") sw.classList.toggle("fullscreen");
  });

  if (PLAN) {
    // wire tab panel comment buttons before marking existing comments
    wireTabPanelCommentBtns();
    // mark existing comments
    Object.keys(PLAN.notes || {}).forEach(reflectComment);

    document.addEventListener("click", (ev) => {
      const target = ev.target;
      if (!(target instanceof HTMLElement)) return;
      const btn = target.closest(".comment-btn");
      if (btn) {
        const blockId = btn.getAttribute("data-comment-for");
        if (blockId) openCommentPopover(blockId);
      }
    });

    mountFeedbackBar();
    mountDeleteButton();
    mountBackButton();
    if (PLAN.status !== "implemented") mountAiBlockBtn();
  }

  if (CARD) {
    const cardNotes = Object.assign({}, CARD.notes || {});
    Object.keys(cardNotes).forEach(reflectCardComment);

    document.addEventListener("click", (ev) => {
      const target = ev.target;
      if (!(target instanceof HTMLElement)) return;
      const btn = target.closest(".comment-btn");
      if (btn) {
        const blockId = btn.getAttribute("data-comment-for");
        if (blockId) openCardCommentPopover(blockId);
      }
    });

    mountCardAiBlockBtn();
    mountCardDeleteButton();
    mountCardInlineTitleEdit();
    mountCardStatusPill();
    mountCardFeedbackBar();

    window.addEventListener("wp:sse", (ev) => {
      const msg = ev.detail;
      if (msg.type === "card:updated" && msg.project === CARD.project && msg.boardId === CARD.boardId && msg.cardId === CARD.id) {
        location.reload();
      }
    });
  }

  // ---------- Copy buttons ----------
  document.addEventListener("click", (ev) => {
    const btn = ev.target instanceof HTMLElement ? ev.target.closest(".copy-btn") : null;
    if (!btn) return;
    const wrap = btn.closest(".code-block-wrap");
    const code = wrap && wrap.querySelector("code");
    if (!code) return;
    navigator.clipboard.writeText(code.textContent || "").then(() => {
      btn.textContent = "✓";
      btn.classList.add("copied");
      setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1500);
    }).catch(() => {});
  });

  // ---------- Keyboard shortcuts ----------
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "/" && !(ev.target instanceof HTMLInputElement) && !(ev.target instanceof HTMLTextAreaElement)) {
      ev.preventDefault();
      setCollapsed(false);
      chatArea.focus();
    }
  });

  function mountAiBlockBtn() {
    const bar = document.querySelector(".send-feedback-bar");
    if (!bar) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ai-block-btn";
    btn.textContent = "+ AI block";
    btn.addEventListener("click", openAiBlockPopover);
    bar.before(btn);
  }

  function openAiBlockPopover() {
    closePopover();
    const pop = document.createElement("div");
    pop.className = "popover";
    pop.style.position = "fixed";
    pop.style.bottom = "80px";
    pop.style.right = "16px";
    pop.style.width = "380px";
    pop.innerHTML = `
      <h6>Add AI-generated block</h6>
      <textarea rows="3" placeholder="Describe the block you want…"></textarea>
      <div class="row">
        <button type="button" class="cancel">Cancel</button>
        <button type="button" class="save">Generate</button>
      </div>`;
    document.body.appendChild(pop);
    const ta = pop.querySelector("textarea");
    ta && ta.focus();
    pop.querySelector(".cancel").addEventListener("click", closePopover);
    pop.querySelector(".save").addEventListener("click", async () => {
      const prompt = ta ? ta.value.trim() : "";
      if (!prompt) return;
      const saveBtn = pop.querySelector(".save");
      saveBtn.disabled = true;
      saveBtn.textContent = "sending…";
      try {
        await fetch("/api/generate-block", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ planId: PLAN.id, project: PLAN.project, prompt }),
        });
        closePopover();
      } catch (e) {
        alert("send failed: " + e);
      } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Generate"; }
      }
    });
    setTimeout(() => document.addEventListener("click", outsideClick, true), 0);
  }

  function mountBackButton() {
    const header = document.querySelector(".plan .plan-header .plan-meta");
    if (!header) return;
    const back = document.createElement("a");
    back.className = "plan-back-btn";
    back.href = "/projects/" + encodeURIComponent(PLAN.project);
    back.textContent = "← back to project";
    header.insertBefore(back, header.firstChild);
  }

  function mountDeleteButton() {
    const header = document.querySelector(".plan .plan-header .plan-meta");
    if (!header) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "plan-delete-btn";
    btn.textContent = "Delete";
    btn.addEventListener("click", async () => {
      const frozen = PLAN.status === "implemented";
      const msg = frozen
        ? "Plan is implemented — delete anyway? This is permanent."
        : "Delete this plan? This is permanent.";
      if (!confirm(msg)) return;
      btn.disabled = true;
      try {
        const r = await fetch("/api/plan/delete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project: PLAN.project, planId: PLAN.id }),
        });
        if (r.ok) {
          location.href = "/projects/" + encodeURIComponent(PLAN.project);
        } else {
          const e = await r.json().catch(() => ({}));
          alert("delete failed: " + (e.error || r.status));
          btn.disabled = false;
        }
      } catch (e) {
        alert("delete failed: " + e);
        btn.disabled = false;
      }
    });
    header.appendChild(btn);
  }

  function openCommentPopover(blockId) {
    closePopover();
    let anchor;
    if (blockId.includes("~")) {
      const [parentId, tabId] = blockId.split("~", 2);
      const parentBlock = document.querySelector('[data-block-id="' + cssEscape(parentId) + '"]');
      anchor = parentBlock && parentBlock.querySelector('[data-tab-id="' + cssEscape(tabId) + '"]');
    } else {
      anchor = document.querySelector('[data-block-id="' + cssEscape(blockId) + '"]');
    }
    const block = anchor;
    if (!block) return;
    const existing = (PLAN.notes || {})[blockId] || "";
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
      </div>
    `;
    document.body.appendChild(pop);
    const rect = block.getBoundingClientRect();
    pop.style.position = "fixed";
    pop.style.maxWidth = "calc(100vw - 32px)";
    pop.style.top = Math.min(rect.top + 24, window.innerHeight - 200) + "px";
    pop.style.left = Math.min(rect.right + 16, window.innerWidth - 296) + "px";
    const ta = pop.querySelector("textarea");
    ta && ta.focus();
    pop.querySelector(".cancel").addEventListener("click", closePopover);
    const delBtn = pop.querySelector(".delete");
    if (delBtn) {
      delBtn.addEventListener("click", async () => {
        if (PLAN.status === "implemented") { alert("plan is frozen — comments are read-only"); return; }
        delBtn.disabled = true;
        const r = await fetch("/api/comment", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project: PLAN.project, planId: PLAN.id, blockId, text: "" }),
        });
        if (r.ok) {
          clearCommentUi(blockId);
          closePopover();
        } else {
          const e = await r.json().catch(() => ({}));
          alert("delete failed: " + (e.error || r.status));
          delBtn.disabled = false;
        }
      });
    }
    pop.querySelector(".save").addEventListener("click", async () => {
      const text = ta.value.trim();
      if (!text) { closePopover(); return; }
      if (PLAN.status === "implemented") { alert("plan is frozen — comments are read-only"); return; }
      const r = await fetch("/api/comment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: PLAN.project, planId: PLAN.id, blockId, text }),
      });
      if (r.ok) {
        PLAN.notes = PLAN.notes || {};
        PLAN.notes[blockId] = text;
        reflectComment(blockId);
        closePopover();
      } else {
        const e = await r.json().catch(() => ({}));
        alert("save failed: " + (e.error || r.status));
      }
    });
    setTimeout(() => document.addEventListener("click", outsideClick, true), 0);
  }
  function outsideClick(ev) {
    const pop = document.querySelector(".popover");
    if (!pop) return;
    if (!pop.contains(ev.target) && !ev.target.closest(".comment-btn")) closePopover();
  }
  function closePopover() {
    document.removeEventListener("click", outsideClick, true);
    document.querySelectorAll(".modal-overlay").forEach((o) => o.remove());
    document.querySelectorAll(".popover").forEach((p) => p.remove());
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" }[c]));
  }

  function mountFeedbackBar() {
    if (PLAN.status === "implemented") return;
    const bar = document.createElement("div");
    bar.className = "send-feedback-bar";
    bar.innerHTML = `
      <button type="button" class="send-feedback">Send feedback to planner</button>
      <button type="button" class="start-impl">Start Implementation</button>
      <span class="bar-hint" hidden></span>
    `;
    document.querySelector(".plan").appendChild(bar);
    const fbBtn = bar.querySelector(".send-feedback");
    const implBtn = bar.querySelector(".start-impl");
    const hint = bar.querySelector(".bar-hint");
    function showHint(text) {
      hint.textContent = text;
      hint.hidden = false;
      setTimeout(() => { hint.hidden = true; }, 4000);
    }
    fbBtn.addEventListener("click", async () => {
      fbBtn.disabled = true;
      try {
        const r = await fetch("/api/feedback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project: PLAN.project, planId: PLAN.id }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          alert(body.error === "no_comments" ? "add a comment first" :
                "send failed: " + (body.error || r.status));
        } else if (body.queued) {
          showHint("queued — planner is busy; will deliver next");
        } else {
          showHint("sent");
        }
      } finally {
        fbBtn.disabled = false;
      }
    });
    implBtn.addEventListener("click", async () => {
      if (!confirm("Start implementation now? The planner will begin editing files.")) return;
      implBtn.disabled = true;
      try {
        const r = await fetch("/api/start-implementation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project: PLAN.project, planId: PLAN.id }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          alert("start failed: " + (body.error || r.status));
        } else if (body.queued) {
          showHint("approved + queued — planner will start when free");
        } else {
          showHint("approved + sent");
        }
      } finally {
        implBtn.disabled = false;
      }
    });
  }

  // ---------- Ask modal ----------
  function openAskModal(id, payload) {
    closePopover();
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.cssText = "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:59;";
    const wrap = document.createElement("div");
    wrap.className = "popover";
    wrap.style.cssText = "width:520px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow-y:auto;";
    wrap.innerHTML = `<h6>planner is asking</h6>` + renderQuestions(payload.questions) +
      `<div class="row"><button type="button" class="cancel">later</button><button type="button" class="save">submit</button></div>`;
    overlay.appendChild(wrap);
    document.body.appendChild(overlay);
    wrap.querySelector(".cancel").addEventListener("click", () => overlay.remove());
    wrap.querySelector(".save").addEventListener("click", async () => {
      const answers = collectAnswers(wrap, payload.questions);
      await fetch("/api/answer/" + encodeURIComponent(id), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      overlay.remove();
    });
  }
  function renderQuestions(qs) {
    return (qs || []).map((q, i) => {
      const help = q.help ? `<div class="q-help">${escapeHtml(q.help)}</div>` : "";
      const text = `<div class="q-text">${escapeHtml(q.text)}</div>`;
      if (q.kind === "freeform") {
        return `<div class="question" data-q="${i}" data-q-kind="freeform">${text}${help}
          <textarea class="q-freeform" rows="3" placeholder="${escapeHtml(q.placeholder||"")}"></textarea></div>`;
      }
      const t = q.kind === "single" ? "radio" : "checkbox";
      const opts = (q.options || []).map((o) => `
        <label class="q-option"><input type="${t}" name="ask-${i}" value="${escapeHtml(o)}" />
          <div class="q-option-text">${escapeHtml(o)}</div></label>`).join("");
      const otherOpt = q.allow_other ? `
        <label class="q-option q-option-other"><input type="${t}" name="ask-${i}" value="__other__" />
          <div class="q-option-text">Other…</div></label>
        <input type="text" class="q-other-input" placeholder="Please specify…" />` : "";
      return `<div class="question" data-q="${i}" data-q-kind="${q.kind}">${text}${help}
        <div class="q-options">${opts}${otherOpt}</div></div>`;
    }).join("");
  }
  // ---------- DecisionPanel submit ----------
  document.addEventListener("click", async (ev) => {
    const btn = ev.target instanceof HTMLElement ? ev.target.closest(".btn-submit-answers") : null;
    if (!btn) return;
    const qpanel = btn.closest(".qpanel");
    if (!qpanel) return;
    const blockEl = qpanel.closest("[data-block-id]");
    const blockId = blockEl ? blockEl.getAttribute("data-block-id") : "decisions";
    const planTitle = PLAN ? PLAN.id : "current plan";
    const lines = [];
    qpanel.querySelectorAll(".question[data-q]").forEach((q) => {
      const kind = q.getAttribute("data-q-kind");
      const text = (q.querySelector(".q-text") || {}).textContent?.trim() || "";
      let answer = "";
      if (kind === "freeform") {
        const ta = q.querySelector(".q-freeform");
        answer = (ta && ta.value.trim()) || "(empty)";
      } else if (kind === "single") {
        const sel = q.querySelector("input[type=radio]:checked");
        if (sel) {
          answer = sel.value === "__other__"
            ? "Other: " + ((q.querySelector(".q-other-input") || {}).value || "")
            : sel.value;
        } else {
          answer = "(no selection)";
        }
      } else {
        const sels = [...q.querySelectorAll("input[type=checkbox]:checked")];
        answer = sels.map((s) => s.value === "__other__"
          ? "Other: " + ((q.querySelector(".q-other-input") || {}).value || "")
          : s.value).join(", ") || "(none)";
      }
      if (text) lines.push(`- ${text}: ${answer}`);
    });
    if (lines.length === 0) return;
    const text = `Answers for [${blockId}] in ${planTitle}:\n${lines.join("\n")}`;
    btn.disabled = true;
    try {
      const r = await fetch("/api/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, source: "decisions" }),
      });
      if (r.ok) showChatHint("answers sent to planner");
      else alert("send failed: " + r.status);
    } catch (e) {
      alert("send failed: " + e);
    } finally {
      btn.disabled = false;
    }
  });

  function collectAnswers(root, qs) {
    const ans = [];
    (qs || []).forEach((q, i) => {
      const block = root.querySelector('[data-q="'+i+'"]');
      if (!block) { ans.push(null); return; }
      if (q.kind === "freeform") {
        const ta = block.querySelector(".q-freeform");
        ans.push(ta ? ta.value : "");
      } else if (q.kind === "single") {
        const sel = block.querySelector("input[type=radio]:checked");
        if (sel && sel.value === "__other__") {
          const txt = block.querySelector(".q-other-input");
          ans.push("__other__:" + (txt ? txt.value : ""));
        } else {
          ans.push(sel ? sel.value : null);
        }
      } else {
        const sels = [...block.querySelectorAll("input[type=checkbox]:checked")];
        ans.push(sels.map((s) => {
          if (s.value === "__other__") {
            const txt = block.querySelector(".q-other-input");
            return "__other__:" + (txt ? txt.value : "");
          }
          return s.value;
        }));
      }
    });
    return ans;
  }

  // ---------- Toast notifications (replaces alert()) ----------
  function showToast(text, kind) {
    let container = document.querySelector(".toast-container");
    if (!container) {
      container = document.createElement("div");
      container.className = "toast-container";
      document.body.appendChild(container);
    }
    const toast = document.createElement("div");
    toast.className = "toast" + (kind === "error" ? " toast-error" : "");
    toast.textContent = text;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add("toast-visible"), 10);
    setTimeout(() => {
      toast.classList.remove("toast-visible");
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }
  window.__showToast = showToast;

  // ---------- Card page functions ----------
  function reflectCardComment(blockId) {
    const block = document.querySelector('[data-block-id="' + cssEscape(blockId) + '"]');
    if (!block) return;
    const btn = block.querySelector('.comment-btn[data-comment-for="' + cssEscape(blockId) + '"]');
    if (btn) btn.textContent = "edit comment";
    block.setAttribute("data-has-comment", "true");
  }

  function openCardCommentPopover(blockId) {
    closePopover();
    const block = document.querySelector('[data-block-id="' + cssEscape(blockId) + '"]');
    if (!block) return;
    const cardNotes = CARD.notes || {};
    const existing = cardNotes[blockId] || "";
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
    pop.querySelector(".cancel").addEventListener("click", closePopover);
    const delBtn = pop.querySelector(".delete");
    if (delBtn) {
      delBtn.addEventListener("click", async () => {
        delBtn.disabled = true;
        const r = await fetch("/api/card-comment", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ project: CARD.project, boardId: CARD.boardId, cardId: CARD.id, blockId, text: "" }),
        });
        if (r.ok) { delete (CARD.notes || {})[blockId]; block.removeAttribute("data-has-comment"); const btn = block.querySelector(".comment-btn"); if (btn) btn.textContent = "+ comment"; closePopover(); }
        else { const e = await r.json().catch(() => ({})); alert("delete failed: " + (e.error || r.status)); delBtn.disabled = false; }
      });
    }
    pop.querySelector(".save").addEventListener("click", async () => {
      const text = ta ? ta.value.trim() : "";
      if (!text) { closePopover(); return; }
      const saveBtn = pop.querySelector(".save");
      saveBtn.disabled = true;
      const r = await fetch("/api/card-comment", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: CARD.project, boardId: CARD.boardId, cardId: CARD.id, blockId, text }),
      });
      if (r.ok) { CARD.notes = CARD.notes || {}; CARD.notes[blockId] = text; reflectCardComment(blockId); closePopover(); }
      else { const e = await r.json().catch(() => ({})); alert("save failed: " + (e.error || r.status)); saveBtn.disabled = false; }
    });
    setTimeout(() => document.addEventListener("click", outsideClick, true), 0);
  }

  function mountCardAiBlockBtn() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ai-block-btn";
    btn.textContent = "+ AI block";
    btn.style.cssText = "position:fixed;bottom:80px;right:56px;";
    btn.addEventListener("click", () => {
      closePopover();
      const pop = document.createElement("div");
      pop.className = "popover";
      pop.style.cssText = "position:fixed;bottom:130px;right:16px;width:360px;max-width:calc(100vw - 32px);";
      pop.innerHTML = `<h6>Add AI-generated block</h6>
        <textarea rows="3" placeholder="Describe what you want…"></textarea>
        <div class="row"><button type="button" class="cancel">Cancel</button><button type="button" class="save">Generate</button></div>`;
      document.body.appendChild(pop);
      const ta = pop.querySelector("textarea");
      ta && ta.focus();
      pop.querySelector(".cancel").addEventListener("click", closePopover);
      pop.querySelector(".save").addEventListener("click", async () => {
        const prompt = ta ? ta.value.trim() : "";
        if (!prompt) return;
        const saveBtn = pop.querySelector(".save");
        saveBtn.disabled = true; saveBtn.textContent = "sending…";
        await fetch("/api/card-generate-block", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ project: CARD.project, boardId: CARD.boardId, cardId: CARD.id, prompt }),
        });
        closePopover();
      });
      setTimeout(() => document.addEventListener("click", outsideClick, true), 0);
    });
    document.body.appendChild(btn);
  }

  function mountCardDeleteButton() {
    const header = document.querySelector(".card-page-header .plan-meta");
    if (!header) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "plan-delete-btn";
    btn.textContent = "Delete card";
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this card? This is permanent.")) return;
      btn.disabled = true;
      const r = await fetch("/api/card-delete", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: CARD.project, boardId: CARD.boardId, cardId: CARD.id }),
      });
      if (r.ok) location.href = "/projects/" + encodeURIComponent(CARD.project) + "?tab=" + encodeURIComponent(CARD.boardId);
      else { const e = await r.json().catch(() => ({})); alert("delete failed: " + (e.error || r.status)); btn.disabled = false; }
    });
    header.appendChild(btn);
  }

  function mountCardInlineTitleEdit() {
    const h1 = document.querySelector(".card-page-title");
    if (!h1) return;
    let lastTitle = h1.getAttribute("data-card-title") || h1.textContent || "";
    const save = async () => {
      const newTitle = (h1.textContent || "").trim();
      if (!newTitle || newTitle === lastTitle) { h1.textContent = lastTitle; return; }
      const r = await fetch("/api/board/update-card", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: CARD.project, boardId: CARD.boardId, cardId: CARD.id, title: newTitle }),
      });
      if (r.ok) { lastTitle = newTitle; CARD.title = newTitle; document.title = newTitle + " — " + document.title.split(" — ").slice(1).join(" — "); }
      else { h1.textContent = lastTitle; const e = await r.json().catch(() => ({})); alert("rename failed: " + (e.error || r.status)); }
    };
    h1.addEventListener("blur", save);
    h1.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); h1.blur(); } if (ev.key === "Escape") { h1.textContent = lastTitle; h1.blur(); } });
  }

  function mountCardStatusPill() {
    const pill = document.querySelector(".card-status-pill");
    if (!pill) return;
    pill.style.cursor = "pointer";
    pill.title = "Click to move to another column";
    pill.addEventListener("click", () => {
      closePopover();
      const otherStatuses = (CARD.statuses || []).filter((s) => s !== CARD.status);
      if (otherStatuses.length === 0) return;
      const pop = document.createElement("div");
      pop.className = "popover";
      const rect = pill.getBoundingClientRect();
      pop.style.cssText = `position:fixed;top:${Math.min(rect.bottom + 6, window.innerHeight - 150)}px;left:${Math.min(rect.left, window.innerWidth - 176)}px;min-width:160px;max-width:calc(100vw - 32px);`;
      pop.innerHTML = `<h6>Move to</h6>` + otherStatuses.map((s) =>
        `<button type="button" class="status-move-btn" data-status="${escapeHtml(s)}" style="display:block;width:100%;text-align:left;margin-bottom:4px;">${escapeHtml(s)}</button>`
      ).join("");
      document.body.appendChild(pop);
      pop.querySelectorAll(".status-move-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const newStatus = btn.getAttribute("data-status");
          closePopover();
          const r = await fetch("/api/board/update-card", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ project: CARD.project, boardId: CARD.boardId, cardId: CARD.id, status: newStatus }),
          });
          if (r.ok) { pill.textContent = newStatus; CARD.status = newStatus; }
          else { const e = await r.json().catch(() => ({})); alert("move failed: " + (e.error || r.status)); }
        });
      });
      setTimeout(() => document.addEventListener("click", outsideClick, true), 0);
    });
  }

  function mountCardFeedbackBar() {
    const bar = document.createElement("div");
    bar.className = "send-feedback-bar";
    bar.innerHTML = `<button type="button" class="send-feedback">Send feedback to planner</button><span class="bar-hint" hidden></span>`;
    const target = document.querySelector(".plan-blocks") || document.querySelector(".plan");
    if (target) target.appendChild(bar);
    const fbBtn = bar.querySelector(".send-feedback");
    const hint = bar.querySelector(".bar-hint");
    function showHint(text) { hint.textContent = text; hint.hidden = false; setTimeout(() => { hint.hidden = true; }, 4000); }
    fbBtn.addEventListener("click", async () => {
      fbBtn.disabled = true;
      try {
        const r = await fetch("/api/card-feedback", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ project: CARD.project, boardId: CARD.boardId, cardId: CARD.id }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          alert(body.error === "no_comments" ? "add a comment first" : "send failed: " + (body.error || r.status));
        } else if (body.queued) {
          showHint("queued — planner is busy; will deliver next");
        } else {
          showHint("sent");
        }
      } finally {
        fbBtn.disabled = false;
      }
    });
  }

  // ---------- Help button ----------
  function mountHelpBtn() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "help-btn";
    btn.textContent = "?";
    btn.title = "Help";
    btn.addEventListener("click", toggleHelpPanel);
    document.body.appendChild(btn);
  }
  function toggleHelpPanel() {
    const existing = document.querySelector(".help-panel");
    if (existing) { existing.remove(); return; }
    const panel = document.createElement("div");
    panel.className = "help-panel";
    panel.innerHTML = `
      <h6>How to use web-planner</h6>
      <dl>
        <dt>Create a plan</dt>
        <dd>Type <code>/web-plan your brief</code> in Claude Code to start a new plan.</dd>
        <dt>Comment on a block</dt>
        <dd>Click <strong>+ comment</strong> on any block to leave a note for the planner.</dd>
        <dt>Send feedback</dt>
        <dd>After commenting, click <strong>Send feedback to planner</strong> to wake the agent.</dd>
        <dt>Chat with planner</dt>
        <dd>Type in the chat box (lower right) and press <strong>&#x23CE;</strong> to send.</dd>
        <dt>Keyboard shortcuts</dt>
        <dd><code>/</code> &mdash; focus chat &nbsp; <code>&#x23CE;</code> &mdash; send &nbsp; <code>Shift+&#x23CE;</code> &mdash; new line</dd>
        <dd><code>&#x2190;</code> / <code>&#x2192;</code> &mdash; prev/next slide &nbsp; <code>F</code> &mdash; fullscreen</dd>
      </dl>
      <button type="button" class="help-close">Close</button>
    `;
    document.body.appendChild(panel);
    panel.querySelector(".help-close").addEventListener("click", () => panel.remove());
  }
  mountHelpBtn();
})();
