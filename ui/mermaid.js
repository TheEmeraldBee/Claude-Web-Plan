// One Mermaid loader for the whole UI. Previously two callsites duplicated
// the init: renderShell's inline <script> and app.js's open_modal handler.
// Both hard-coded Catppuccin Mocha colors regardless of project theme, so
// diagrams under Latte / Nord looked broken.
//
// This module:
// - lazy-loads the mermaid ESM exactly once
// - reads project theme variables from CSS custom properties on :root so the
//   palette tracks set_theme automatically
// - exposes window.__renderMermaidIn(root) for callers that need to render a
//   newly-injected DOM subtree (modal overlays, livePatchBlock, etc.)
// - auto-renders the initial document.body on first load
//
// The mermaid bundle is ~700KB; we only import it on pages that contain a
// <pre data-mermaid> node. renderShell skips loading us entirely otherwise.

let _mermaidPromise = null;

function readThemeVars() {
  const styles = getComputedStyle(document.documentElement);
  const v = (name) => styles.getPropertyValue(name).trim() || undefined;
  const base = v("--base");
  // If --base is light (lightness above ~50%), pick the light mermaid theme.
  // Heuristic: parse #rrggbb and compare to threshold.
  const isLight = (() => {
    if (!base) return false;
    const m = /^#?([a-f0-9]{6})$/i.exec(base);
    if (!m) return false;
    const hex = m[1];
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    // Perceived luminance.
    return (0.299 * r + 0.587 * g + 0.114 * b) > 140;
  })();
  return {
    theme: isLight ? "default" : "dark",
    themeVariables: {
      background: base || (isLight ? "#eff1f5" : "#1e1e2e"),
      primaryColor: v("--surface0") || "#313244",
      primaryTextColor: v("--text") || "#cdd6f4",
      primaryBorderColor: v("--surface1") || "#45475a",
      secondaryColor: v("--mantle") || "#181825",
      tertiaryColor: v("--crust") || "#11111b",
      lineColor: v("--blue") || "#89b4fa",
      textColor: v("--text") || "#cdd6f4",
      fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
    },
  };
}

function ensureMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (!_mermaidPromise) {
    _mermaidPromise = import("https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs")
      .then((m) => {
        window.mermaid = m.default;
        window.mermaid.initialize({ startOnLoad: false, ...readThemeVars() });
        return window.mermaid;
      })
      .catch((e) => {
        _mermaidPromise = null;
        // eslint-disable-next-line no-console
        console.error("[web-planner] mermaid load failed", e);
        throw e;
      });
  }
  return _mermaidPromise;
}

function renderMermaidIn(root = document) {
  const nodes = root.querySelectorAll("pre[data-mermaid]:not([data-rendered])");
  if (nodes.length === 0) return;
  ensureMermaid().then((m) => {
    m.run({ nodes })
      .then(() => nodes.forEach((el) => el.setAttribute("data-rendered", "true")))
      .catch(() => { /* mermaid surfaces its own error into the node */ });
  }).catch(() => { /* already logged */ });
}

window.__renderMermaidIn = renderMermaidIn;
// Backwards compat: some callers still expect __renderMermaid().
window.__renderMermaid = () => renderMermaidIn(document);

// Auto-render initial document content (if any).
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => renderMermaidIn(document));
} else {
  renderMermaidIn(document);
}
