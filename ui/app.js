// Vanilla JS viewer chrome — popover comments, chat box, state pill, send-feedback.
// No build step. Loaded on every page from /ui/app.js.

(function () {
  const PLAN = /** @type {{id:string, project:string, status:string, notes:Record<string,string>}|undefined} */ (window.__PLAN__);

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
          <span class="state-name" style="font-size:.78rem;color:var(--subtext0);">⏎ send · / focus</span>
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

  const NARROW = 760;
  function setCollapsed(collapsed) {
    chrome.classList.toggle("collapsed", collapsed);
    pillBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }
  setCollapsed(window.innerWidth < NARROW);
  pillBtn.addEventListener("click", () => {
    setCollapsed(!chrome.classList.contains("collapsed"));
    if (!chrome.classList.contains("collapsed")) chatArea.focus();
  });

  function setStateUi(value) {
    const kind = (value && value.kind) || "idle";
    pillDot.className = "state-dot state-dot-" + kind;
    pillName.textContent = kind;
  }

  // ---------- SSE ----------
  const es = new EventSource("/api/stream");
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
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
      p.hidden = p.getAttribute("data-tab-id") !== targetId;
    });
  });

  // ---------- Slideshow ----------
  function initSlideshow(sw) {
    const slides = /** @type {HTMLElement[]} */ ([...sw.querySelectorAll(".slide")]);
    if (slides.length === 0) return;
    const prevBtn = sw.querySelector(".slide-prev");
    const nextBtn = sw.querySelector(".slide-next");
    const curEl = sw.querySelector(".slide-cur");
    let current = 0;
    function goTo(n) {
      slides[current].setAttribute("aria-hidden", "true");
      current = Math.max(0, Math.min(n, slides.length - 1));
      slides[current].removeAttribute("aria-hidden");
      if (curEl) curEl.textContent = String(current + 1);
      if (prevBtn) prevBtn.disabled = current === 0;
      if (nextBtn) nextBtn.disabled = current === slides.length - 1;
    }
    slides.forEach((s, i) => { if (i !== 0) s.setAttribute("aria-hidden", "true"); else s.removeAttribute("aria-hidden"); });
    if (prevBtn) { prevBtn.disabled = true; prevBtn.addEventListener("click", () => goTo(current - 1)); }
    if (nextBtn) { nextBtn.disabled = slides.length <= 1; nextBtn.addEventListener("click", () => goTo(current + 1)); }
  }
  document.querySelectorAll("[data-slideshow]").forEach(initSlideshow);
  document.addEventListener("keydown", (ev) => {
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
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
    pop.style.position = "absolute";
    pop.style.top = (rect.top + window.scrollY + 24) + "px";
    pop.style.left = (Math.min(rect.right + window.scrollX + 16, window.innerWidth - 300)) + "px";
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
    const wrap = document.createElement("div");
    wrap.className = "popover";
    wrap.style.position = "fixed";
    wrap.style.top = "20%";
    wrap.style.left = "50%";
    wrap.style.transform = "translateX(-50%)";
    wrap.style.width = "520px";
    wrap.style.maxHeight = "70vh";
    wrap.style.overflow = "auto";
    wrap.innerHTML = `<h6>planner is asking</h6>` + renderQuestions(payload.questions) +
      `<div class="row"><button type="button" class="cancel">later</button><button type="button" class="save">submit</button></div>`;
    document.body.appendChild(wrap);
    wrap.querySelector(".cancel").addEventListener("click", () => wrap.remove());
    wrap.querySelector(".save").addEventListener("click", async () => {
      const answers = collectAnswers(wrap, payload.questions);
      await fetch("/api/answer/" + encodeURIComponent(id), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      wrap.remove();
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
})();
