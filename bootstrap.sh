#!/usr/bin/env bash
# web-planner remote bootstrap.
# Usage:  curl -fsSL https://raw.githubusercontent.com/TheEmeraldBee/Claude-Web-Plan/main/bootstrap.sh | bash
#
# Clones the repo to ~/.local/share/web-planner (or $WEB_PLANNER_HOME) and runs
# the interactive installer. Re-running deletes any existing checkout and
# re-clones from scratch so local edits never poison the install.

set -euo pipefail

REPO="https://github.com/TheEmeraldBee/Claude-Web-Plan.git"
BRANCH="${WEB_PLANNER_BRANCH:-main}"
INSTALL_ROOT="${WEB_PLANNER_HOME:-$HOME/.local/share/web-planner}"

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
ok()    { printf "\033[32m%s\033[0m\n" "$*"; }
warn()  { printf "\033[33m%s\033[0m\n" "$*"; }
die()   { printf "\033[31merror: %s\033[0m\n" "$*" >&2; exit 1; }

command -v git  >/dev/null || die "git is required"
command -v node >/dev/null || die "node is required (>= 20)"
command -v npm  >/dev/null || die "npm is required"

bold "web-planner bootstrap"
echo "repo:    ${REPO} (${BRANCH})"
echo "install: ${INSTALL_ROOT}"
echo

if [ -e "${INSTALL_ROOT}" ]; then
  warn "removing existing checkout at ${INSTALL_ROOT}"
  rm -rf "${INSTALL_ROOT}"
fi
mkdir -p "$(dirname "${INSTALL_ROOT}")"
ok "cloning into ${INSTALL_ROOT}"
git clone --quiet --branch "${BRANCH}" "${REPO}" "${INSTALL_ROOT}"

cd "${INSTALL_ROOT}"
bold "running installer"

# The installer is interactive. When invoked via `curl ... | bash`, our stdin
# is the consumed pipe — `read` would hit EOF and abort under `set -e`. Pull
# input from the controlling terminal instead.
if [ -r /dev/tty ]; then
  exec bash ./install.sh < /dev/tty
else
  warn "no controlling tty — run ./install.sh manually from ${INSTALL_ROOT}"
  exit 0
fi
