# web-planner

A planning workspace for Claude Code. You and Claude talk through a project, and the conversation becomes a living plan document in your browser that you can annotate block-by-block.

Most planning conversations with an AI end up scrolling through a long chat log. This is the opposite: Claude writes the plan as a structured document with diagrams, file lists, phases, and decision points. You leave little sticky notes on any part of it. Claude reads your notes and revises the document. The browser stays open the whole time — the agent never "finishes" a turn, it just waits for your next message.

## What a session looks like

1. You type `/web-plan add OAuth login` in Claude Code.
2. You open `http://localhost:1248` and a new plan appears with diagrams, steps, and affected files. A little dot in the bottom bar shows what Claude is doing right now — `waiting` means it's blocked on your next message, `thinking` and `implementing` show up while it works.
3. You scroll through the plan. Something looks off in the phase 2 block, so you click **+ comment** next to it and write "use refresh tokens instead of long-lived sessions". You click another block and add a different note.
4. You click **Send feedback**. The browser bundles every comment you've left into one message and wakes Claude.
5. Claude reads your feedback, rewrites just the blocks you commented on, and the page updates in place — no full reload. Your cursor stays where it was.
6. When the plan looks right, you click **Accept**. Claude starts implementing.

You can also just type in the chat box at the bottom of the page (or run `wp send "..."` from a terminal) to talk to Claude without leaving a block-specific comment.

## Why this exists

A few things you can't do with a normal chat-only workflow:

- **Comment on a specific paragraph** instead of having to quote it back in chat.
- **Re-read the plan later** as a real document, not a needle in a 200-message log.
- **Compare revisions** because block ids stay stable across edits — you always know which step #4 is.
- **Diagram-first.** Claude draws Mermaid sequence/flow/state diagrams instead of describing them in prose. Big architecture decisions become a picture instead of three paragraphs.

## Install

The one-liner clones the repo into `~/.local/share/web-planner` and runs the interactive installer:

```bash
curl -fsSL https://raw.githubusercontent.com/TheEmeraldBee/Claude-Web-Plan/main/bootstrap.sh | bash
```

You can change where it lands by setting `WEB_PLANNER_HOME=<path>` (or `WEB_PLANNER_BRANCH=<name>` for a specific branch) before piping.

If you already have the repo checked out somewhere, run `./install.sh` directly.

The installer asks eight questions; reasonable defaults are in brackets and you can hit Enter through all of them:

1. **Theme.** A free-form name stored in `config.json`. Currently informational only — themes are actually applied per-project via the `set_theme` MCP tool once a project exists, using one of the built-in palettes (`catppuccin-mocha`, `catppuccin-latte`, `nord`, `gruvbox-dark`) or a custom CSS-vars object.
2. **Browser open command.** Used by `wp open` to launch a URL. Example: `firefox {url}` or `zen-browser --blank-window {url}`. Empty = `wp open` just prints the URL.
3. **Port.** Defaults to `1248`.
4. **Storage root.** Where plans, projects, and config live. Defaults to `~/.web-planner/`.
5. **Install `wp` on PATH.** Adds a small CLI for terminal-side use. Picks `~/.local/bin` by default.
6. **Auto-launch policy.** Stored in config but not currently wired to any auto-open behavior — leave the default.
7. **Register MCP in `~/.claude.json`.** Lets Claude Code talk to the server.
8. **Register `/web-plan` slash command.** Optional convenience.

Requirements: `git`, Node 20 or newer, `npm`. `jq` is only needed if you want the installer to auto-edit your `~/.claude.json` (without it, it prints the snippet for you to paste).

## Day-to-day commands

```bash
/web-plan              # in Claude Code — opens a planning session
/web-plan add OAuth    # same, but skip the "what do you want to plan?" prompt

wp status              # what is Claude doing right now
wp send "..."          # send a message to Claude (same as the chat box)
wp plans               # list every plan across every project
wp open                # open the dashboard in your browser
wp feedback <project> <plan_id>   # send a plan's comments as feedback
```

In the browser:

- **+ comment** on any block opens a one-line note editor. One comment per block; saving overwrites the previous one.
- **Send feedback** bundles every open comment on the current plan and sends it to Claude as a single message.
- **Accept** marks the plan as ready and asks Claude to start implementing.
- **+ AI block** (centered below the content) asks Claude to generate a new block in place.
- **+ New plan** on a project's Plans tab kicks off a brand-new plan with a brief.
- **+** on the tab bar lets Claude author a custom tab (Architecture, Decisions Log, Glossary, whatever).
- Press **/** anywhere to focus the chat box. Press **Escape** to close popovers and modals.

## Project pages

Every plan lives inside a **project** (defaulting to whatever your current working directory is named). A project's homepage at `/projects/<slug>` has a tab bar:

- **Plans** — kanban board grouped by status (`designing` / `ready` / `implemented` / `rejected`). Drag plans between columns to change status.
- **Modals** — past one-way modals Claude has surfaced (research notes, reports). You can reopen any of them or clear the history.
- **Layout** — a live file tree of the project's source directory. Respects `.gitignore` (and nested ones). When files change on disk, the tree updates in place over SSE.
- **Custom tabs** — anything else Claude authors. Common ones: "Architecture", "Decisions Log", "Glossary". Each is a `.tab.tsx` file Claude can rewrite when you comment on its blocks.

The dashboard at `/` lists every project as a card with plan counts and the latest plan title.

## How plans are stored

Plans are Preact `.plan.tsx` files. Claude composes them from a small kit of components (blocks, callouts, step lists, diagrams, tab panels, slideshows). The server compiles them in-memory on every read, so the source on disk is also the source of truth — you can `git`-track plans, diff revisions, and read them with any editor.

```
~/.web-planner/
├── config.json
└── projects/
    └── <project-slug>/
        ├── project.json        # project name, description, watched source path, tab order
        ├── components.tsx      # per-project block components Claude has invented
        ├── comments.json       # every comment in the project (across plans + tabs)
        ├── plans/
        │   ├── <id>.plan.tsx   # plan source (Preact)
        │   └── <id>.meta.json  # title, status, timestamps
        ├── tabs/
        │   └── <id>.tab.tsx    # custom tabs
        └── modals/
            └── <id>.modal.tsx  # archived open_modal displays
```

`<id>` is `YYYY-MM-DD-HHMMSS-<slug>-<random>` (UTC, base36 suffix to avoid collisions when two writes land in the same second).

## Repo layout

```
kit/      Preact component library published as @web-planner/kit
server/   MCP server + HTTP sidecar (port 1248); SSE for browser push
cli/      wp terminal CLI
ui/       Static viewer chrome — popovers, SSE client, chat, modal queue
agent/    Planner agent definition + /web-plan slash command
docs/     Background docs (the original design doc lives in docs/legacy/)
```

## Common questions

**Does Claude finish a turn?** No. The agent's outer loop ends every turn at `wait_for_message`, which blocks until you send something. The state pill says `waiting` while the agent is blocked on input (and `idle` if no agent is running). You can leave the browser open indefinitely.

**Can I edit an already-implemented plan?** Yes. There's no frozen state — every status is editable. Implemented plans are historical record, but Claude can rewrite them, and you can delete them. Convention is to propose a new plan that references the old one when the change is large.

**What happens if I close the browser mid-session?** Nothing breaks. The agent is still blocked on the next message. Reopen the page and pick up where you left off. The state pill seeds from `/api/state` on load so the page always reflects current reality.

**Does it work over the network?** No — the server binds to `127.0.0.1` and rejects anything else. Tunnel through SSH if you really need to.

**Where are comments stored?** In one `comments.json` per project. Comments survive plan edits unless Claude addresses the commented block (it clears the comment when the block changes meaningfully). You can also delete a comment from the popover.

## License

MIT — see `LICENSE`.
