#!/usr/bin/env bash
# Run freescout-mcp locally.
#
#   scripts/run-local.sh [stdio|http|dev|dev:http]   (default: stdio)
#
# First run: asks for the FreeScout URL and a cookie or login, and saves them to .env.
# Later runs: checks .env, installs/builds if needed, then starts the server.
# Everything the script prints goes to stderr, so in stdio mode it can be the MCP command:
#
#   claude mcp add freescout -- /absolute/path/to/freescout-mcp/scripts/run-local.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="${1:-stdio}"
ENV_FILE="${FREESCOUT_ENV_FILE:-$ROOT/.env}"

say() { printf 'run-local: %s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }

case "$MODE" in
  stdio | http | dev | dev:http) ;;
  -h | --help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 0 ;;
  *) die "unknown mode '$MODE' (expected stdio, http, dev or dev:http)" ;;
esac

command -v node >/dev/null || die "node not found; install Node.js 20 or newer"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "Node.js 20 or newer required (found $(node -v))"

# --- First run: ask for the minimum and write .env -------------------------------------------
# Prompts go through /dev/tty because in stdio mode stdin/stdout belong to the MCP client.

ask() { # ask VAR "prompt" [secret]
  local reply
  if [ "${3:-}" = secret ]; then
    printf '%s' "$2" >/dev/tty; IFS= read -rs reply </dev/tty; printf '\n' >/dev/tty
  else
    printf '%s' "$2" >/dev/tty; IFS= read -r reply </dev/tty
  fi
  printf -v "$1" '%s' "$reply"
}

quote() { # single-quote a value for .env
  printf "'%s'" "$1"
}

if [ ! -f "$ENV_FILE" ]; then
  # Only prompt when a person is at a terminal (an MCP client pipes stdin).
  if [ ! -t 0 ] || ! { : >/dev/tty; } 2>/dev/null; then
    die "$ENV_FILE not found. Run scripts/run-local.sh once in a terminal to create it, or copy .env.example to .env"
  fi
  say "no $ENV_FILE yet; let's create it."
  url="" cookie="" user="" password=""
  while [ -z "$url" ]; do ask url "FreeScout URL (e.g. https://support.example.com): "; done
  # HTTP mode: each client sends its own identity in headers, so only the URL is needed.
  if [ "$MODE" = stdio ] || [ "$MODE" = dev ]; then
    ask cookie "Browser Cookie header (Enter to skip and use login instead): " secret
    if [ -z "$cookie" ]; then
      while [ -z "$user" ]; do ask user "FreeScout login email: "; done
      while [ -z "$password" ]; do ask password "FreeScout password: " secret; done
    fi
  fi
  umask 077
  {
    echo "# Written by scripts/run-local.sh. See .env.example for all options."
    echo "FREESCOUT_URL=$(quote "$url")"
    [ -n "$cookie" ] && echo "FREESCOUT_COOKIE=$(quote "$cookie")"
    [ -n "$user" ] && echo "FREESCOUT_USER=$(quote "$user")"
    [ -n "$password" ] && echo "FREESCOUT_PASSWORD=$(quote "$password")"
    if [ "$MODE" = http ] || [ "$MODE" = dev:http ]; then
      echo "MCP_TOKEN=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
    fi
  } >"$ENV_FILE"
  say "saved $ENV_FILE (mode 600)"
fi

# --- Load .env (parsed, not sourced: cookie values contain ';') -------------------------------
# Variables already set in the environment win.

while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  case "$line" in '' | '#'*) continue ;; esac
  line="${line#export }"
  key="${line%%=*}"
  [ "$key" != "$line" ] || continue
  key="$(printf '%s' "$key" | tr -d '[:space:]')"
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
  value="${line#*=}"
  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  [ -n "${!key+x}" ] || export "$key=$value"
done <"$ENV_FILE"
say "loaded $ENV_FILE"

# --- Check the environment --------------------------------------------------------------------

[ -n "${FREESCOUT_URL:-}" ] || die "FREESCOUT_URL is not set in $ENV_FILE"
[[ "$FREESCOUT_URL" =~ ^https?://[^/]+ ]] || die "FREESCOUT_URL must start with http:// or https:// (got '$FREESCOUT_URL')"

if [ "$MODE" = stdio ] || [ "$MODE" = dev ]; then
  if [ -n "${FREESCOUT_COOKIE:-}" ]; then
    [[ "$FREESCOUT_COOKIE" == *=* ]] || die "FREESCOUT_COOKIE should look like 'laravel_session=...; remember_web_...=...'"
    [[ "$FREESCOUT_COOKIE" == *remember_web_* ]] ||
      say "warning: FREESCOUT_COOKIE has no remember_web_* cookie; it will expire with the session (tick 'Remember Me' when logging in)"
  elif [ -z "${FREESCOUT_USER:-}" ] || [ -z "${FREESCOUT_PASSWORD:-}" ]; then
    die "set FREESCOUT_COOKIE, or FREESCOUT_USER and FREESCOUT_PASSWORD, in $ENV_FILE"
  fi
else
  if [ -z "${MCP_TOKEN:-}" ]; then
    MCP_TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
    export MCP_TOKEN
    printf '\nMCP_TOKEN=%s\n' "$MCP_TOKEN" >>"$ENV_FILE"
    say "MCP_TOKEN not set; generated one and saved it to $ENV_FILE"
  elif [ "${#MCP_TOKEN}" -lt 32 ]; then
    die "MCP_TOKEN must be at least 32 characters (openssl rand -hex 32)"
  fi
fi

if command -v curl >/dev/null; then
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${FREESCOUT_URL%/}/login" || true)"
  case "$code" in
    2?? | 3??) say "FreeScout reachable (${FREESCOUT_URL%/}/login -> $code)" ;;
    000) say "warning: could not reach $FREESCOUT_URL (check the URL / VPN)" ;;
    *) say "warning: ${FREESCOUT_URL%/}/login answered HTTP $code" ;;
  esac
fi

# --- Install, build, start --------------------------------------------------------------------

if [ ! -d node_modules ]; then
  say "installing dependencies"
  npm install --no-audit --no-fund >&2
fi

if [ "$MODE" = stdio ] || [ "$MODE" = http ]; then
  if [ ! -f dist/index.js ] || [ ! -f dist/http.js ] ||
    [ -n "$(find src package.json tsconfig.json -newer dist/index.js -print -quit)" ]; then
    say "building"
    npm run --silent build >&2
  fi
fi

# --- Show how to add it to Claude Code (only when a person is at the terminal) ----------------

if [ -t 0 ]; then
  if [ "$MODE" = http ] || [ "$MODE" = dev:http ]; then
    cat >&2 <<EOF

Ready. Add it to Claude Code with:

  claude mcp add --transport http freescout http://${MCP_HOST:-127.0.0.1}:${MCP_PORT:-8787}/mcp \\
    --header "Authorization: Bearer $MCP_TOKEN" \\
    --header "X-FreeScout-Cookie: <your FreeScout cookie>"

  (or --header "X-FreeScout-User: ..." --header "X-FreeScout-Password: ..." instead of the cookie)

Starting the HTTP server now; Ctrl-C to stop.

EOF
  else
    cat >&2 <<EOF

Ready. Add it to Claude Code with:

  claude mcp add freescout -- $ROOT/scripts/run-local.sh

Claude Code starts the server itself from then on. Starting it here as a test; Ctrl-C to stop.

EOF
  fi
fi

case "$MODE" in
  stdio) exec node dist/index.js ;;
  http) exec node dist/http.js ;;
  dev) exec npx --no-install tsx src/index.ts ;;
  dev:http) exec npx --no-install tsx src/http.ts ;;
esac
