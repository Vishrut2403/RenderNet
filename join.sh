#!/usr/bin/env bash
# One command for a machine that only renders: it installs what is missing, asks
# the farm for a credential of its own, and starts rendering. Nothing is
# submitted or downloaded from here - a browser is still the whole client.
#
#   ./join.sh http://rendernet.local:5500
#
# Safe to run again; the second time it is just how this machine joins.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="${1:-}"
SLOTS="${WORKER_SLOTS:-1}"
CREDENTIAL="$ROOT/.worker-env"

say() { printf '\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

if [ -z "$SERVER" ]; then
  cat >&2 <<MESSAGE
Usage: ./join.sh http://rendernet.local:5500

The address is the one the farm printed when it started. Run this on the machine
you want to render on; the machine submitting scenes needs nothing but a browser.
MESSAGE
  exit 1
fi

SERVER="${SERVER%/}"

# Same floor as the server: below 22 there is no prebuilt better-sqlite3 and
# installing turns into a compile. The worker never opens the database, but
# installing the backend still pulls it in.
node_major() { node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/'; }

check_node() {
  local want current
  want="$(cat "$ROOT/.node-version" 2>/dev/null || echo 22)"
  current="$(node_major)"

  [ -n "$current" ] && [ "$current" -ge "$want" ] 2>/dev/null && return 0

  die "This needs Node $want or newer, and the node on PATH is ${current:+v}${current:-none}$current.

Install one, then run this again:

  fnm install $want   (or nvm install $want, or from nodejs.org)"
}

reachable() {
  curl -sf -m 5 "$SERVER/api/health" >/dev/null 2>&1
}

# Asked for once and kept, so joining again does not leave a trail of credentials
# on the farm that nobody can tell apart.
ask_for_credential() {
  local user password answer token name

  name="$(hostname 2>/dev/null || echo 'a machine')"

  cat <<MESSAGE

This machine needs a credential of its own before it can render.
Somebody with an admin account on the farm can issue one now.

MESSAGE

  read -r -p "  Admin username: " user
  read -r -s -p "  Admin password: " password
  echo

  answer="$(curl -sf -m 15 -X POST "$SERVER/api/auth/login" \
    -H 'Content-Type: application/json' \
    --data-binary "$(printf '{"username":%s,"password":%s}' \
      "$(json_string "$user")" "$(json_string "$password")")" || true)"

  token="$(json_field "$answer" token)"

  [ -n "$token" ] || die "The farm did not accept that username and password."

  answer="$(curl -sf -m 15 -X POST "$SERVER/api/machines" \
    -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' \
    --data-binary "$(printf '{"name":%s}' "$(json_string "$name")")" || true)"

  WORKER_TOKEN="$(json_field "$answer" token)"

  [ -n "$WORKER_TOKEN" ] \
    || die "That account cannot issue machine credentials. An admin has to run this."

  umask 077
  printf 'WORKER_TOKEN=%s\n' "$WORKER_TOKEN" > "$CREDENTIAL"

  say "Issued and saved. Revoke it under Admin if this machine stops helping."
}

# Quoted the way JSON wants rather than pasted in raw: a password is entitled to
# contain a quote or a backslash.
json_string() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"
}

json_field() {
  node -e '
    try {
      const value = JSON.parse(process.argv[1] || "{}")[process.argv[2]];
      if (typeof value === "string") process.stdout.write(value);
    } catch {}
  ' "$1" "$2"
}

check_node

reachable || die "Nothing is answering at $SERVER.

Check the address the farm printed, and that both machines are on the same network."

if [ ! -d "$ROOT/backend/node_modules" ]; then
  say "Installing what the renderer needs (once)…"
  (cd "$ROOT/backend" && npm install --omit=dev --no-audit --no-fund >/dev/null)
fi

command -v blender >/dev/null 2>&1 || [ -n "${BLENDER_PATH:-}" ] \
  || die "No Blender on PATH. Install it, or set BLENDER_PATH to it, then run this again."

if [ -f "$CREDENTIAL" ]; then
  # shellcheck disable=SC1090
  . "$CREDENTIAL"
else
  ask_for_credential
fi

[ -n "${WORKER_TOKEN:-}" ] || die "No credential. Delete $CREDENTIAL and run this again."

say "Rendering for $SERVER with $SLOTS worker(s). Ctrl+C stops."

pids=()

trap 'kill "${pids[@]:-}" 2>/dev/null || true' INT TERM

for slot in $(seq 0 $((SLOTS - 1))); do
  (cd "$ROOT/backend" \
    && API_URL="$SERVER" \
       WORKER_TOKEN="$WORKER_TOKEN" \
       WORKER_REMOTE=1 \
       WORKER_ID="worker-$slot" \
       node src/worker-main.js) &
  pids+=($!)
done

wait
