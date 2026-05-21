# Changelog

Backfilled from the implemented plans. New entries land at the top.

## Unreleased — Critique cleanup
- Removed dead `/ui/submit.js` + `/ui/chrome.js` script tags from `renderShell` (404 on every page).
- Fixed plan feedback button: now sends `target_kind:'plan'` + `target_id` so a single plan's comments bundle correctly. `wp feedback` CLI matched.
- Repaired custom-tab comments: `/api/tab-comment` → `/api/comment` with `target_kind:'tab'`; SSE listener moved from `tab:comment:*` to `comment:*` with target match.
- Ask-modal "Later" now POSTs empty answers so the planner can't hang on a dismissed modal.
- `closePopover` no longer removes `.modal-overlay` — comment popovers can't dismiss the ask modal.
- `update_tab` falls back to the existing tab title when omitted (previously wiped the title to the id).
- Reserved `modals` tab id alongside `plans` and `layout`.
- Agent doc: removed all card workflow references, fixed corrupted frontmatter, added missing tool grants (`init_project_homepage`, `set_theme`, `list_comments`, `get_comments`), dropped "implemented plans are frozen" wording.
- New `server/src/ids.ts` — UTC + base36 random suffix `nowId`; deduplicated from `mcp.ts` and `http.ts`.
- `setStatus` now syncs the source's `<Plan status="...">` attribute so meta and source agree across renders.
- `Tabs` kit: stable ids derived from slugified label (or explicit `id` prop); comment keys survive tab reordering.
- `wait_for_message` delivers the freshest queued entry instead of dropping the entire backlog.
- `ask_user` clears its timeout handle on answer (no more 30-min closure leaks).
- `mergeKitImports` tolerates multi-line import bodies.
- Moved `plan.html` to `docs/legacy/v1-design.html`. Deleted `StateChips` and `Tree` from the kit (and their CSS). Removed `writeJunkForTest`/`clearCache` from compile. Removed unused `localStorage` write.
- 19 `alert()` calls replaced with `showToast`/`showError`.
- z-index scale via CSS custom properties (`--z-bar`, `--z-popover`, `--z-help`, `--z-modal`, `--z-fullscreen`, `--z-toast`).
- One Mermaid loader (`ui/mermaid.js`) reads `:root` CSS vars so diagrams track project theme; both inline shell and modal usage share it.
- Shared modal primitive (`window.__wpBar.wireModal`) adds Escape-to-close, focus trap, and last-focus restoration to ask/new-plan/new-tab modals.
- Bottom bar seeds initial state from `/api/state` instead of busy-locking until first SSE event.
- Chat textarea visually disables when the planner isn't listening (with explanatory placeholder).
- Global `:focus-visible` outline and `prefers-reduced-motion` honoring across all animations.
- SSE: `retry: 1500` server-side, client closes after 5 consecutive errors and surfaces a reload hint.
- Tightened localhost guard to exact-match `127.0.0.1` / `::1` / `::ffff:127.0.0.1`.
- LICENSE (MIT) added.

## 2026-05-19 — `open_modal` + Modals tab
- Added `open_modal` MCP tool for one-way display modals.
- Modal sources are `.modal.tsx` with `<div class="modal-body">` root; dry-compiled before sending.
- New `Modals` builtin tab archives past modals with reopen/delete/clear-all.
- Removed unused `open_in_browser` tool and its `maybeOpen` helper.

## 2026-05-18 — Simplify: drop cards, rename statuses, unify comments
- Removed card boards and all related tools (`create_card_board`, `create_card`, `update_card`, `delete_card`, `list_cards`, `update_card_source`).
- Renamed statuses: `proposed` → `designing`, `approved` → `ready`, `abandoned` → `rejected`. `implemented` unchanged.
- All plan statuses are now editable — no frozen state.
- Unified comments into a single project-scoped `comments.json` keyed by `target_kind` + `target_id` + `block_id`.

## 2026-05-14 — UX cleanup
- Tab refresh on `tab.updated` SSE; no full reloads.
- Feedback queue + Start Implementation flow.
- Kanban Plans tab (replaced vertical list).
- Comment lifecycle: overwrite-only, never resolved, cleared on block edit.

## 2026-05-14 — Hardening
- Added `delete_plan` tool.
- Added `check` tool that dry-compiles plans + tabs.
- Dry-compile before persist across `create_plan`, `update_block`, `append_block`, `create_tab`, `update_tab`.

Older history in `git log`.
