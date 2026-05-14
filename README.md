# web-planner

Interactive planning for Claude Code: MCP server + planner agent + browser UI.

Plans are Preact `.plan.tsx` documents composed of annotatable blocks. The agent never voluntarily ends a turn — it blocks on `wait_for_message` and resumes whenever you send something from the browser chat, `wp send`, or by clicking *Send feedback* on a block comment. Diagrams are first-class via Mermaid. Implemented plans are frozen historical record.

## Install

One-liner — clones to `~/.local/share/web-planner` and runs the interactive installer:

```bash
curl -fsSL https://raw.githubusercontent.com/TheEmeraldBee/Claude-Web-Plan/main/bootstrap.sh | bash
```

Override location with `WEB_PLANNER_HOME=<path>` or branch with `WEB_PLANNER_BRANCH=<name>` before piping.

Already cloned? Just run the installer directly:

```bash
./install.sh
```

The installer prompts for:

1. **Theme** — free-form string (the planner reads it and styles plans accordingly).
2. **Browser open command** — e.g. `zen-browser --blank-window {url}`. Empty = print only.
3. **Port** — default `1248`.
4. **Storage root** — default `~/.web-planner/`.
5. **Install `wp` on PATH** — yes/no, plus install dir.
6. **Auto-launch policy** — `always` / `on-ask` / `never`.
7. **Register MCP in `~/.claude.json`** — yes/no.
8. **Register `/web-plan` slash command** — yes/no.

Requires `git`, Node ≥ 20, `npm`, and `jq` (only for auto-registering the MCP — without jq, the installer prints the JSON to paste).

## Use

```bash
/web-plan           # in Claude Code — starts the planner loop
wp status           # what is the planner doing right now
wp send "..."       # send a message (unblocks wait_for_message)
wp plans            # list plans by project
wp open             # open the dashboard
```

The dashboard at `http://localhost:1248` shows every plan, a live state pill, the chat box, and per-block `+ comment` buttons. One comment per block, append/overwrite only, no replies or likes. Click *Send feedback* to bundle every comment on the current plan into a single message that wakes the planner for a revision.

## Layout

```
kit/      Preact component library (@web-planner/kit)
server/   MCP server + HTTP sidecar (port 1248)
cli/      wp terminal CLI
ui/       Static viewer chrome (popovers, SSE, chat)
agent/    Planner agent definition + /web-plan slash command
```

## Data

```
~/.web-planner/
├── config.json
└── projects/
    └── <project-slug>/
        ├── project.json           # name, description, watchPath, tabs
        ├── components.tsx         # per-project block components
        ├── tabs/<id>.tab.tsx      # custom tabs Claude authors
        └── plans/
            ├── <ts>-<slug>.plan.tsx     # plan source
            ├── <ts>-<slug>.meta.json    # title, status, dates
            └── <ts>-<slug>.notes.json   # { blockId: comment }
```

## Pages

- `/` — homepage with one card per project (description, plan count, latest).
- `/projects/<slug>` — project page with a tab bar: **Plans**, **Layout**, plus any custom tabs Claude has authored. The Layout tab renders the project's `watchPath` as a live file tree (respects `.gitignore`, plus nested `.gitignore`s); `fs.watch` pushes `layout:changed` over SSE and the tree re-renders in place.
- `/plans/<project>/<plan-id>` — individual plan with `+ comment` per block, popover editor, and *Send feedback* to wake the agent.
