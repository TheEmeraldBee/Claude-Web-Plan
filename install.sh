#!/usr/bin/env bash
# web-planner installer — interactive.
# Prompts for the 8 config values, writes ~/.web-planner/config.json,
# registers the MCP server in ~/.claude.json, installs the wp CLI on PATH,
# and links the planner agent + /web-plan slash command.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${HOME}"
CONFIG_DIR_DEFAULT="${HOME_DIR}/.web-planner"
CLAUDE_JSON="${HOME_DIR}/.claude.json"
AGENTS_DIR="${HOME_DIR}/.claude/agents"
COMMANDS_DIR="${HOME_DIR}/.claude/commands"

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
muted() { printf "\033[2m%s\033[0m\n" "$*"; }
warn()  { printf "\033[33m%s\033[0m\n" "$*" >&2; }
ok()    { printf "\033[32m%s\033[0m\n" "$*"; }
die()   { printf "\033[31merror: %s\033[0m\n" "$*" >&2; exit 1; }

# The installer is interactive. Refuse to proceed without a TTY so users get
# a clear message instead of a cryptic abort. (bootstrap.sh redirects stdin
# from /dev/tty when invoked via `curl | bash`.)
if [ ! -t 0 ]; then
  # Test whether /dev/tty is actually open-able for this process. Doing this
  # in a subshell first keeps bash from printing the "No such device" complaint
  # against the outer shell.
  if ( exec </dev/tty ) 2>/dev/null; then
    exec </dev/tty
  else
    die "no controlling terminal — run install.sh directly from a shell"
  fi
fi

ask() {
  local prompt="$1" default="$2" var=""
  # Prompts go to stderr so command substitution `X=$(ask ...)` captures only
  # the answer — not the prompt text. (Captured-prompt bug was the reason
  # "aborted" appeared after running through with defaults.)
  if [ -n "$default" ]; then
    printf "%s [%s]: " "$prompt" "$default" >&2
  else
    printf "%s: " "$prompt" >&2
  fi
  read -r var || var=""
  if [ -z "$var" ]; then echo "$default"; else echo "$var"; fi
}

ask_yn() {
  local prompt="$1" default="$2" var=""
  printf "%s [%s]: " "$prompt" "$default" >&2
  read -r var || var=""
  if [ -z "$var" ]; then var="$default"; fi
  case "$var" in
    y|Y|yes|YES) echo "yes" ;;
    n|N|no|NO)   echo "no" ;;
    *)           echo "$default" ;;
  esac
}

bold "web-planner installer"
muted "press Enter to accept defaults in [brackets]"
echo

# 1. Theme
THEME=$(ask "Theme (free-form string; planner reads this and styles accordingly)" "catppuccin-mocha")

# 2. Browser open command
OPEN_CMD=$(ask "Browser open command ({url} substituted; empty = print only)" "")

# 3. Port
PORT=$(ask "Port" "1248")

# 4. Storage root
STORAGE_ROOT=$(ask "Storage root" "$CONFIG_DIR_DEFAULT")

# 5. Install wp on PATH
INSTALL_WP=$(ask_yn "Install wp CLI on PATH?" "yes")
WP_DEST=""
if [ "$INSTALL_WP" = "yes" ]; then
  WP_DEST=$(ask "wp install dir" "${HOME_DIR}/.local/bin")
fi

# 6. Auto-launch policy
AUTO_LAUNCH=$(ask "Auto-launch browser on plan create (always / on-ask / never)" "on-ask")

# 7. Register MCP
REG_MCP=$(ask_yn "Register MCP in ${CLAUDE_JSON}?" "yes")

# 8. Slash command
REG_CMD=$(ask_yn "Register /web-plan slash command?" "yes")

echo
bold "summary"
echo "  theme:          ${THEME}"
echo "  open command:   ${OPEN_CMD:-<empty>}"
echo "  port:           ${PORT}"
echo "  storage root:   ${STORAGE_ROOT}"
echo "  wp install:     ${INSTALL_WP}${WP_DEST:+ → $WP_DEST}"
echo "  auto-launch:    ${AUTO_LAUNCH}"
echo "  register MCP:   ${REG_MCP}"
echo "  /web-plan:      ${REG_CMD}"
echo
CONFIRM=$(ask_yn "Proceed?" "yes")
[ "$CONFIRM" = "yes" ] || die "aborted"

# --- write config ---
mkdir -p "$STORAGE_ROOT"
cat > "${STORAGE_ROOT}/config.json" <<EOF
{
  "port": ${PORT},
  "storageRoot": "${STORAGE_ROOT}",
  "theme": "${THEME}",
  "openCommand": "${OPEN_CMD}",
  "autoLaunch": "${AUTO_LAUNCH}"
}
EOF
ok "wrote ${STORAGE_ROOT}/config.json"

# --- install deps + build CLI ---
bold "installing dependencies"
( cd "$ROOT" && npm install --silent ) || die "npm install failed"
( cd "$ROOT/cli" && node build.mjs ) || die "wp build failed"

# --- install wp ---
if [ "$INSTALL_WP" = "yes" ]; then
  mkdir -p "$WP_DEST"
  ln -sf "${ROOT}/cli/dist/wp.mjs" "${WP_DEST}/wp"
  ok "linked ${WP_DEST}/wp → ${ROOT}/cli/dist/wp.mjs"
  case ":${PATH}:" in
    *":${WP_DEST}:"*) ;;
    *) warn "note: ${WP_DEST} is not on your PATH — add it to your shell rc" ;;
  esac
fi

# --- link agent ---
mkdir -p "$AGENTS_DIR"
ln -sf "${ROOT}/agent/web-planner.md" "${AGENTS_DIR}/web-planner.md"
ok "linked ${AGENTS_DIR}/web-planner.md"

# --- slash command ---
if [ "$REG_CMD" = "yes" ]; then
  mkdir -p "$COMMANDS_DIR"
  ln -sf "${ROOT}/agent/web-plan.md" "${COMMANDS_DIR}/web-plan.md"
  ok "linked /web-plan command → ${COMMANDS_DIR}/web-plan.md"
fi

# --- register MCP ---
if [ "$REG_MCP" = "yes" ]; then
  if [ ! -f "$CLAUDE_JSON" ]; then
    echo '{}' > "$CLAUDE_JSON"
  fi
  if command -v jq >/dev/null 2>&1; then
    TMP="$(mktemp)"
    jq --arg cwd "$ROOT" \
       --arg entry "${ROOT}/server/src/mcp.ts" \
       --arg cfg "${STORAGE_ROOT}/config.json" '
      .mcpServers = (.mcpServers // {}) |
      .mcpServers["web-planner"] = {
        command: "node",
        args: ["--import", "tsx/esm", $entry],
        env: { WEB_PLANNER_CONFIG: $cfg }
      }
    ' "$CLAUDE_JSON" > "$TMP" && mv "$TMP" "$CLAUDE_JSON"
    ok "registered MCP server in ${CLAUDE_JSON}"
  else
    warn "jq not found — paste this into ${CLAUDE_JSON} under \"mcpServers\":"
    cat <<EOF

  "web-planner": {
    "command": "node",
    "args": ["--import", "tsx/esm", "${ROOT}/server/src/mcp.ts"],
    "env": { "WEB_PLANNER_CONFIG": "${STORAGE_ROOT}/config.json" }
  }
EOF
  fi
fi

echo
bold "done."
echo "open the dashboard:  http://localhost:${PORT}/"
[ "$REG_CMD" = "yes" ] && echo "kick it off:         /web-plan in Claude Code"
[ "$INSTALL_WP" = "yes" ] && echo "from terminal:       wp status   |   wp send 'hello'"
