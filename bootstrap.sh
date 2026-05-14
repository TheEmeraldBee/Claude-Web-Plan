#!/usr/bin/env bash
# web-planner remote bootstrap.
# Usage:  curl -fsSL https://raw.githubusercontent.com/TheEmeraldBee/Claude-Web-Plan/main/bootstrap.sh | bash
#
# Clones the repo to ~/.local/share/web-planner (or $WEB_PLANNER_HOME) and runs
# the interactive installer. Idempotent: re-running fetches the latest main
# and re-prompts.

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

if [ -d "${INSTALL_ROOT}/.git" ]; then
  ok "existing checkout found — fetching latest"
  git -C "${INSTALL_ROOT}" fetch --quiet origin "${BRANCH}"
  git -C "${INSTALL_ROOT}" checkout --quiet "${BRANCH}"
  git -C "${INSTALL_ROOT}" reset --hard --quiet "origin/${BRANCH}"
else
  mkdir -p "$(dirname "${INSTALL_ROOT}")"
  ok "cloning into ${INSTALL_ROOT}"
  git clone --quiet --branch "${BRANCH}" "${REPO}" "${INSTALL_ROOT}"
fi

cd "${INSTALL_ROOT}"
bold "running installer"
exec bash ./install.sh
