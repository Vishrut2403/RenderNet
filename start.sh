#!/usr/bin/env bash
# One command for the machine that renders: installs what is missing, builds the
# page the browser gets, starts the farm, and then says the two things anybody
# else needs — where to point their browser and what to type to make an account.
# Safe to run again; the second time it is just how the farm is started.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-5500}"

say() { printf '\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }

# better-sqlite3 is compiled against one Node major and refuses to load under any
# other, so this wants the exact version .node-version names rather than merely a
# new enough one. The shell default is whatever the shell says.
use_supported_node() {
  local want current shown bin
  want="$(cat "$ROOT/.node-version" 2>/dev/null || echo 22)"
  current="$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')"
  shown="${current:+v$current}"
  shown="${shown:-none}"

  [ "${current:-0}" = "$want" ] && return 0

  for root in "${FNM_DIR:-}" "$HOME/.local/share/fnm" "$HOME/.fnm" "${XDG_DATA_HOME:-}/fnm"; do
    bin="$root/node-versions"
    [ -d "$bin" ] || continue

    bin="$(ls -d "$bin"/v"$want".*/installation/bin 2>/dev/null | sort -V | tail -1)"

    if [ -n "$bin" ] && [ -x "$bin/node" ]; then
      say "Using Node $("$bin/node" -v); the shell default is $shown"
      PATH="$bin:$PATH"
      export PATH
      return 0
    fi
  done

  cat >&2 <<MESSAGE
This needs Node $want, and the node on PATH is $shown.
better-sqlite3 is compiled per Node major and will not load under another.

Install it, then run this again:

  fnm install $want   (or nvm install $want, or from nodejs.org)
MESSAGE
  exit 1
}

answering() {
  curl -sf -m 2 "http://localhost:$PORT/api/health" >/dev/null 2>&1
}

install_if_missing() {
  local where="$1"

  if [ ! -d "$ROOT/$where/node_modules" ]; then
    say "Installing what $where needs (once)…"
    (cd "$ROOT/$where" && npm install --no-audit --no-fund >/dev/null)
  fi
}

# Anything under src/ newer than the bundle means the browser would be handed
# the previous build.
build_if_stale() {
  local dist="$ROOT/frontend/dist/index.html"

  if [ ! -f "$dist" ] || [ -n "$(find "$ROOT/frontend/src" "$ROOT/frontend/index.html" \
      -newer "$dist" -print -quit 2>/dev/null)" ]; then
    say "Building the page…"
    (cd "$ROOT/frontend" && npm run build >/dev/null)
  fi
}

# The address on the network this machine actually reaches other machines by,
# which is not necessarily the first one it happens to have.
this_machine() {
  ip route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }' \
    || true
}

macos_address() {
  local device
  device="$(route -n get default 2>/dev/null | awk '/interface:/ { print $2 }')" || true
  [ -n "$device" ] && ipconfig getifaddr "$device" 2>/dev/null || true
}

address() {
  local found
  found="$(this_machine)"
  [ -z "$found" ] && found="$(macos_address)"
  echo "${found:-the address of this machine}"
}

use_supported_node

if answering; then
  say "The farm is already running at http://localhost:$PORT"
  exit 0
fi

command -v blender >/dev/null 2>&1 || [ -n "${BLENDER_PATH:-}" ] \
  || warn "No Blender on PATH: the farm will start, but nothing will render until there is."

install_if_missing backend
install_if_missing frontend
build_if_stale

log="$(mktemp -t rendernet-start.XXXXXX)"
cd "$ROOT/backend"
node src/index.js >"$log" 2>&1 &
farm=$!

# Ctrl+C is how this is stopped, and it has to take the farm with it.
trap 'kill "$farm" 2>/dev/null || true' INT TERM

for _ in $(seq 1 60); do
  answering && break
  kill -0 "$farm" 2>/dev/null || { cat "$log"; exit 1; }
  sleep 0.5
done

if ! answering; then
  cat "$log"
  echo "The farm did not come up. What it printed is above." >&2
  exit 1
fi

code="$(grep -oE 'Code:  [a-z0-9-]+' "$log" | head -1 | awk '{ print $2 }')"
name="$(grep -oE 'Name:  http[^ ]+' "$log" | head -1 | awk '{ print $2 }')"

cat <<READY

$(say "The farm is up. On the other machine, open one of these:")

    ${name:-http://rendernet.local:$PORT}
    http://$(address):$PORT      (if that name does not resolve)

  Create account, then type this code:   ${code:-see Admin -> Signup code}

  Nothing to install over there. A browser is the whole client.

$(say "This machine:") http://localhost:$PORT   admin / admin123 on the first sign-in
  Ctrl+C stops the farm. Keep this machine awake while it renders.

READY

tail -n +1 -f "$log" &
tailing=$!
trap 'kill "$farm" "$tailing" 2>/dev/null || true' INT TERM

wait "$farm"
