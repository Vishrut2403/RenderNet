#!/usr/bin/env bash
# A farm to look at, kept well away from anything real: its own data directory,
# its own database, its own accounts. Runs in the foreground like any other dev
# server, so Ctrl+C is how it stops.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA="${RENDERNET_DEMO_DIR:-$HOME/.rendernet-demo}"
PORT="${RENDERNET_DEMO_PORT:-5500}"

export DATA_DIR="$DATA"
export DB_PATH="$DATA/demo.db"
export PORT
export SIGNUP_CODE="rendernet-demo"

say() { printf '\033[36m%s\033[0m\n' "$*"; }

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

  fnm use $want && npm run demo

The repo carries a .node-version, so plain "fnm use" picks it up. If Node $want
is not installed: fnm install $want
MESSAGE
  exit 1
}

use_supported_node

answering() {
  curl -sf -m 2 "http://localhost:$PORT/api/health" >/dev/null 2>&1
}

build_if_stale() {
  local dist="$ROOT/frontend/dist/index.html"

  # Anything under src/ newer than the bundle means the browser would be handed
  # the previous build.
  if [ ! -f "$dist" ] || [ -n "$(find "$ROOT/frontend/src" "$ROOT/frontend/index.html" \
      -newer "$dist" -print -quit 2>/dev/null)" ]; then
    say "Building the frontend…"
    (cd "$ROOT/frontend" && npm run build >/dev/null)
  fi
}

start() {
  if answering; then
    say "Already running at http://localhost:$PORT"
    exit 0
  fi

  build_if_stale
  mkdir -p "$DATA"

  # Waits for the server this command is about to become, then fills it. Only
  # the first run needs it; a restart keeps whatever was rendered before.
  if [ ! -f "$DATA/seeded" ]; then
    (
      for _ in $(seq 1 60); do
        answering && break
        sleep 0.5
      done

      if answering; then
        say "Filling it with jobs to look at…"
        node "$ROOT/tools/demo/seed.mjs" && touch "$DATA/seeded"
      fi
    ) &
  fi

  echo
  say "http://localhost:$PORT   admin / demo1234"
  echo "  maya / demo1234 sees it as somebody who is not an admin"
  echo "  Ctrl+C stops it · npm run demo:seed adds jobs · npm run demo:reset starts over"
  echo

  cd "$ROOT/backend"
  exec node src/index.js
}

case "${1:-start}" in
  start) start ;;
  seed) node "$ROOT/tools/demo/seed.mjs" ;;
  reset)
    if answering; then
      echo "Stop it first — Ctrl+C in the window running it." >&2
      exit 1
    fi
    rm -rf "$DATA"
    say "Gone. The next start builds it again."
    ;;
  *)
    echo "usage: $0 {start|seed|reset}"
    exit 1
    ;;
esac
