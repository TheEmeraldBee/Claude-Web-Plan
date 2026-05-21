// Vanilla JS viewer chrome — popover comments, unified bottom bar (help/status/chat/feedback/accept).
// No build step. Loaded on every page from /ui/app.js.

(function () {
  const PLAN = /** @type {{id:string, project:string, status:string, notes:Record<string,string>}|undefined} */ (window.__PLAN__);

  // ---------- Bottom bar (help · status · chat · feedback · accept) ----------
  function mountBottomBar() {
    const bar = document.createElement("div");
    bar.className = "bottom-bar";
    bar.innerHTML = `
      <button type="button" class="bb-help" title="Help" aria-label="Help">?</button>
      <div class="bb-status" title="Planner state">
        <span class="state-dot state-dot-idle"></span><span class="state-name" aria-live="polite">connecting…</span>
      </div>
      <textarea class="bb-chat" rows="1" aria-label="Message the planner" placeholder="Message the planner…  ( / to focus, ↵ to send, Shift+↵ newline)"></textarea>
      <button type="button" class="bb-send" title="Send message (↵)">Send</button>
      <button type="button" class="bb-feedback" hidden>Send feedback</button>
      <button type="button" class="bb-accept" hidden>Accept</button>
      <span class="bb-hint" role="status" aria-live="polite" hidden></span>
    `;
    document.body.appendChild(bar);
    return bar;
  }
  const bar = mountBottomBar();
  const pillDot = bar.querySelector(".state-dot");
  const pillName = bar.querySelector(".state-name");
  const chatArea = bar.querySelector(".bb-chat");
  const chatBtn = bar.querySelector(".bb-send");
  const helpBtn = bar.querySelector(".bb-help");
  const fbBtn = bar.querySelector(".bb-feedback");
  const acceptBtn = bar.querySelector(".bb-accept");
  const hintEl = bar.querySelector(".bb-hint");

  function showHint(text) {
    if (!hintEl) return;
    hintEl.textContent = text;
    hintEl.hidden = false;
    clearTimeout(showHint._t);
    showHint._t = setTimeout(() => { hintEl.hidden = true; }, 4000);
  }
  function showChatHint(text) { showHint(text); }

  // Bottom bar feedback/accept slots. Pages call __wpBar.setFeedback / setAccept
  // to configure the slot for the current view. Pass null to hide.
  // Declared up here so callers in the PLAN/CARD blocks below don't hit TDZ.
  let _fbPayload = null;
  let _acceptPayload = null;
  function setFeedback(payload) {
    _fbPayload = payload;
    fbBtn.hidden = !payload;
  }
  function setAccept(payload) {
    _acceptPayload = payload;
    acceptBtn.hidden = !payload;
  }
  fbBtn.addEventListener("click", async () => {
    if (!_fbPayload) return;
    if (_busy) { showHint("planner is not waiting for input"); return; }
    fbBtn.disabled = true;
    try {
      const r = await fetch("/api/feedback", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(_fbPayload),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) showHint(body.error === "no_comments" ? "add a comment first" : "send failed: " + (body.error || r.status));
      else if (body.queued) showHint("queued — planner is busy; will deliver next");
      else showHint("sent");
    } finally { fbBtn.disabled = false; }
  });
  acceptBtn.addEventListener("click", async () => {
    if (!_acceptPayload) return;
    if (_busy) { showHint("planner is not waiting for input"); return; }
    if (!confirm("Start implementation now? The planner will begin editing files.")) return;
    acceptBtn.disabled = true;
    try {
      const r = await fetch("/api/start-implementation", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(_acceptPayload),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) showHint("start failed: " + (body.error || r.status));
      else if (body.queued) showHint("approved + queued — planner will start when free");
      else showHint("approved + sent");
    } finally { acceptBtn.disabled = false; }
  });
  window.__wpBar = { setFeedback, setAccept, showHint, isBusy: () => _busy, wireModal: wireWpModal };

  /**
   * Shared modal behavior: focus trap, Escape-to-close, last-focus
   * restoration. Caller still owns DOM creation and submit/cancel logic.
   * Returns a `close()` that fires onClose then removes the overlay.
   *
   * Pre-existing modals (ask, new-plan, new-tab) all open and close in
   * slightly different ways; wireWpModal lets them share the keyboard
   * + a11y contract without rewriting the create/teardown path.
   */
  function wireWpModal(overlay, onClose) {
    const lastFocus = document.activeElement;
    const inner = overlay.querySelector(".popover, .wp-modal") || overlay;
    if (inner && !inner.hasAttribute("tabindex")) inner.setAttribute("tabindex", "-1");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    setTimeout(() => { try { inner.focus(); } catch {} }, 0);

    function focusables() {
      return Array.from(overlay.querySelectorAll(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ));
    }
    function onKey(ev) {
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(); return; }
      if (ev.key !== "Tab") return;
      const f = focusables();
      if (f.length === 0) return;
      const first = f[0]; const last = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    }
    function close() {
      document.removeEventListener("keydown", onKey, true);
      try { onClose && onClose(); } catch {}
      overlay.remove();
      if (lastFocus && typeof lastFocus.focus === "function") {
        try { lastFocus.focus(); } catch {}
      }
    }
    document.addEventListener("keydown", onKey, true);
    return { close };
  }

  helpBtn.addEventListener("click", toggleHelpPanel);

  // Auto-grow chat textarea up to ~5 lines.
  function autoSizeChat() {
    chatArea.style.height = "auto";
    chatArea.style.height = Math.min(chatArea.scrollHeight, 120) + "px";
  }
  chatArea.addEventListener("input", autoSizeChat);
  autoSizeChat();

  let _activeTimer = null;
  let _activeStart = 0;

  // Planner accepts input only when its state is exactly "waiting" (i.e.
  // blocked on wait_for_message). Anything else — including "idle" — means
  // there is no live agent loop listening, so a send would either be queued
  // indefinitely or dropped. We expose this as a body class for CSS and as
  // window.__wpBar.isBusy() for JS click handlers.
  const READY_STATES = ["waiting"];
  // "active" controls the working banner + ticking timer; idle/waiting/asking
  // are all non-active, but only `waiting` is ready to accept input.
  const NON_ACTIVE_STATES = ["idle", "waiting"];
  let _busy = true;
  function setBusy(busy) {
    _busy = busy;
    document.body.classList.toggle("wp-busy", busy);
    const title = busy ? "Planner is not waiting for input right now" : "";
    [chatBtn, fbBtn, acceptBtn].forEach((el) => { if (el) el.title = title; });
    // Disable the textarea outright when the planner isn't listening so the
    // user gets a visible "input disabled" cue (greyed out, no caret) rather
    // than typing into the void and only learning on submit.
    if (chatArea) {
      chatArea.disabled = busy;
      chatArea.placeholder = busy
        ? "Planner is busy — message will be queued"
        : "Message the planner…  ( / to focus, ↵ to send, Shift+↵ newline)";
    }
  }
  setBusy(true); // start busy; flips to ready on first state event

  // Seed the pill from /api/state so first paint reflects reality even if
  // the SSE handshake hasn't delivered a 'state' event yet. Previously,
  // pages opened while the agent was already 'waiting' showed
  // "connecting…" + busy-locked input until the SSE stream caught up.
  fetch("/api/state")
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => { if (s && s.kind) setStateUi(s); })
    .catch(() => {});

  function setStateUi(value) {
    const kind = (value && value.kind) || "idle";
    pillDot.className = "state-dot state-dot-" + kind;
    pillDot.style.background = (value && value.color) ? value.color : "";
    if (_activeTimer) { clearInterval(_activeTimer); _activeTimer = null; }
    setBusy(!READY_STATES.includes(kind));
    if (NON_ACTIVE_STATES.includes(kind)) {
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
  // Track consecutive disconnects so a totally dead server doesn't pin the
  // browser in an infinite reconnect storm. After 5 failures in a row we
  // close the connection and offer a manual reconnect via the bottom-bar
  // hint area. Each successful message resets the counter.
  let _sseFails = 0;
  const es = new EventSource("/api/stream");
  es.onmessage = (ev) => {
    _sseFails = 0;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    window.dispatchEvent(new CustomEvent("wp:sse", { detail: msg }));
    if (msg.type === "state") setStateUi(msg.value);
    if (msg.type === "backlog:cleared" && msg.dropped > 0) {
      showHint(`dropped ${msg.dropped} stale message${msg.dropped === 1 ? "" : "s"} — planner only saw the latest`);
    }
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
    if (msg.type === "modal.open") enqueueWpModal(msg);
    if (msg.type === "plan.deleted") {
      if (PLAN && msg.planId === PLAN.id) {
        location.href = "/projects/" + encodeURIComponent(PLAN.project);
      } else if (!PLAN && location.pathname === "/") {
        // dashboard — refresh counts
        setTimeout(() => location.reload(), 150);
      }
    }
  };
  es.onerror = () => {
    pillName.textContent = "disconnected";
    setBusy(true);
    _sseFails += 1;
    if (_sseFails >= 5) {
      try { es.close(); } catch {}
      showHint("disconnected — reload the page to reconnect");
    }
  };

  // ---------- Chat ----------
  async function sendChat() {
    const text = chatArea.value.trim();
    if (!text) return;
    if (_busy) { showChatHint("planner is not waiting for input"); return; }
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
        autoSizeChat();
        if (data.queued) showChatHint("Queued — position " + (data.position || "?"));
      } else {
        showToast("send failed: " + (data.error || r.status), "error");
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
    if (!PLAN) return;
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
    const badge = document.querySelector(".plan .plan-header .badge");
    if (badge) {
      badge.className = "badge status status-" + status;
      badge.textContent = status;
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

    setFeedback({ project: PLAN.project, target_kind: "plan", target_id: PLAN.id });
    setAccept({ project: PLAN.project, planId: PLAN.id });
    mountDeleteButton();
    mountBackButton();
  }
  mountAiBlockBtn();

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
      chatArea.focus();
    }
  });

  function mountAiBlockBtn() {
    if (document.querySelector(".ai-block-btn-wrap")) return;
    const host =
      document.querySelector(".plan-blocks") ||
      document.querySelector(".project-page") ||
      document.querySelector(".dashboard") ||
      document.querySelector(".plan") ||
      document.querySelector("main") ||
      document.body;
    const wrap = document.createElement("div");
    wrap.className = "ai-block-btn-wrap";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ai-block-btn";
    btn.textContent = "+ AI block";
    btn.addEventListener("click", openAiBlockPopover);
    wrap.appendChild(btn);
    host.appendChild(wrap);
  }

  function currentAiBlockContext() {
    const PAGE = window.__PAGE__;
    const TAB = window.__TAB__;
    if (PLAN) return { kind: "plan", project: PLAN.project, planId: PLAN.id };
    if (TAB) return { kind: "tab", project: TAB.project, tabId: TAB.tabId };
    if (PAGE && PAGE.project) return { kind: "project", project: PAGE.project };
    return { kind: "dashboard" };
  }

  function openAiBlockPopover() {
    if (_busy) { showHint("planner is not waiting for input"); return; }
    closePopover();
    const ctx = currentAiBlockContext();
    const pop = document.createElement("div");
    pop.className = "popover";
    pop.style.position = "fixed";
    pop.style.bottom = "80px";
    pop.style.right = "16px";
    pop.style.width = "380px";
    const heading =
      ctx.kind === "plan"    ? "Add AI-generated block to this plan" :
      ctx.kind === "tab"     ? "Add AI-generated block to this tab" :
      ctx.kind === "project" ? "Ask the planner to add something" :
                               "Ask the planner";
    pop.innerHTML = `
      <h6>${heading}</h6>
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
        if (ctx.kind === "plan") {
          await fetch("/api/generate-block", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ planId: ctx.planId, project: ctx.project, prompt }),
          });
        } else {
          const tag =
            ctx.kind === "tab"     ? `[ai-block project=${ctx.project} tabId=${ctx.tabId}]` :
            ctx.kind === "project" ? `[ai-block project=${ctx.project}]` :
                                     `[ai-block]`;
          await fetch("/api/message", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: `${tag}\n${prompt}`, source: "browser" }),
          });
        }
        closePopover();
        showHint("sent to planner");
      } catch (e) {
        showToast("send failed: " + e, "error");
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
          showToast("delete failed: " + (e.error || r.status), "error");
          btn.disabled = false;
        }
      } catch (e) {
        showToast("delete failed: " + e, "error");
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
    const isTabComment = blockId.includes("~");
    const [commentBlockId, commentTabId] = isTabComment ? blockId.split("~", 2) : [blockId, null];
    const commentTargetKind = isTabComment ? "tab" : "plan";
    const commentTargetId = isTabComment ? commentTabId : PLAN.id;
    const commentBlockKey = isTabComment ? commentBlockId : blockId;
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
        delBtn.disabled = true;
        const r = await fetch("/api/comment", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project: PLAN.project, target_kind: commentTargetKind, target_id: commentTargetId, block_id: commentBlockKey, text: "" }),
        });
        if (r.ok) {
          clearCommentUi(blockId);
          closePopover();
        } else {
          const e = await r.json().catch(() => ({}));
          showToast("delete failed: " + (e.error || r.status), "error");
          delBtn.disabled = false;
        }
      });
    }
    pop.querySelector(".save").addEventListener("click", async () => {
      const text = ta.value.trim();
      if (!text) { closePopover(); return; }
      const r = await fetch("/api/comment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: PLAN.project, target_kind: commentTargetKind, target_id: commentTargetId, block_id: commentBlockKey, text }),
      });
      if (r.ok) {
        PLAN.notes = PLAN.notes || {};
        PLAN.notes[blockId] = text;
        reflectComment(blockId);
        closePopover();
      } else {
        const e = await r.json().catch(() => ({}));
        showToast("save failed: " + (e.error || r.status), "error");
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
    // Only remove standalone .popover here. .popover inside .modal-overlay
    // belongs to ask/new-plan/new-tab modals which manage their own lifecycle
    // — otherwise opening a comment popover would dismiss the active ask
    // modal and the planner would hang on a pending answer.
    document.querySelectorAll(".popover").forEach((p) => {
      if (!p.closest(".modal-overlay")) p.remove();
    });
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" }[c]));
  }

  // ---------- open_modal overlay ----------
  // One-way display modal for results that Claude wants to surface (research,
  // reports, etc). Rendered HTML is precompiled server-side from a .modal.tsx.
  // We just inject and decorate.
  const _wpModalQueue = [];
  let _wpModalVisible = false;
  let _wpModalLastFocus = null;

  function enqueueWpModal(msg) {
    if (!msg || typeof msg.html !== "string") return;
    _wpModalQueue.push(msg);
    if (!_wpModalVisible) renderNextWpModal();
  }

  function renderNextWpModal() {
    const next = _wpModalQueue.shift();
    if (!next) { _wpModalVisible = false; return; }
    _wpModalVisible = true;
    _wpModalLastFocus = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "wp-modal-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = `
      <div class="wp-modal" tabindex="-1">
        <header class="wp-modal-head">
          <h2 class="wp-modal-title"></h2>
          <button type="button" class="wp-modal-close" aria-label="Close">×</button>
        </header>
        <div class="wp-modal-body"></div>
      </div>`;
    overlay.querySelector(".wp-modal-title").textContent = next.title || "";
    overlay.querySelector(".wp-modal-body").innerHTML = next.html;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("wp-modal-visible"));
    const modalEl = overlay.querySelector(".wp-modal");
    modalEl.focus();

    function close() {
      document.removeEventListener("keydown", onKey, true);
      overlay.classList.remove("wp-modal-visible");
      setTimeout(() => {
        overlay.remove();
        if (_wpModalLastFocus && typeof _wpModalLastFocus.focus === "function") {
          try { _wpModalLastFocus.focus(); } catch {}
        }
        _wpModalLastFocus = null;
        renderNextWpModal();
      }, 150);
    }
    function onKey(ev) {
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(); }
    }
    overlay.querySelector(".wp-modal-close").addEventListener("click", close);
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
    document.addEventListener("keydown", onKey, true);

    // Decorate compiled content: highlight code, render mermaid if present.
    if (window.Prism) window.Prism.highlightAllUnder(overlay);
    if (overlay.querySelector("[data-mermaid]")) {
      // ui/mermaid.js exposes __renderMermaidIn (lazy-loaded). If the page
      // shell didn't preload it (no <pre data-mermaid> in the initial body),
      // pull it in once on first modal render.
      if (window.__renderMermaidIn) window.__renderMermaidIn(overlay);
      else import("/ui/mermaid.js").then(() => window.__renderMermaidIn(overlay));
    }
  }

  // ---------- Ask modal ----------
  function openAskModal(id, payload) {
    closePopover();
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.setAttribute("aria-label", "Planner question");
    const wrap = document.createElement("div");
    wrap.className = "popover";
    wrap.style.cssText = "width:520px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow-y:auto;";
    wrap.innerHTML = `<h6>planner is asking</h6>` + renderQuestions(payload.questions) +
      `<div class="row"><button type="button" class="cancel">later</button><button type="button" class="save">submit</button></div>`;
    overlay.appendChild(wrap);
    document.body.appendChild(overlay);
    const modal = wireWpModal(overlay);
    async function dismiss() {
      // POST empty answers so the server's pending ask_user resolves — otherwise
      // the planner blocks forever on a closed modal.
      try {
        await fetch("/api/answer/" + encodeURIComponent(id), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answers: (payload.questions || []).map(() => null) }),
        });
      } catch {}
      modal.close();
    }
    wrap.querySelector(".cancel").addEventListener("click", dismiss);
    wrap.querySelector(".save").addEventListener("click", async () => {
      const answers = collectAnswers(wrap, payload.questions);
      await fetch("/api/answer/" + encodeURIComponent(id), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      modal.close();
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
      else showToast("send failed: " + r.status, "error");
    } catch (e) {
      showToast("send failed: " + e, "error");
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

  // ---------- Help panel (anchored above bar's ? button) ----------
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
        <dd>Type in the bottom-bar input and press <strong>&#x23CE;</strong> to send.</dd>
        <dt>Keyboard shortcuts</dt>
        <dd><code>/</code> &mdash; focus chat &nbsp; <code>&#x23CE;</code> &mdash; send &nbsp; <code>Shift+&#x23CE;</code> &mdash; new line</dd>
        <dd><code>&#x2190;</code> / <code>&#x2192;</code> &mdash; prev/next slide &nbsp; <code>F</code> &mdash; fullscreen</dd>
      </dl>
      <button type="button" class="help-close">Close</button>
    `;
    document.body.appendChild(panel);
    panel.querySelector(".help-close").addEventListener("click", () => panel.remove());
  }
})();
