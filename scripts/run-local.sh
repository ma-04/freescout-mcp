#!/usr/bin/env bash
# Run freescout-mcp locally.
#
#   scripts/run-local.sh [stdio|http|dev|dev:http]   (default: stdio)
#
# First run: asks for the FreeScout URL and a cookie or login, and saves them to .env.
# Later runs: checks .env, installs/builds if needed, offers to add the server to Claude Code
# and Claude Desktop (stdio mode, in a terminal), then starts the server.
# Everything the script prints goes to stderr, so in stdio mode it can be the MCP command:
#
#   claude mcp add --scope user freescout -- /absolute/path/to/freescout-mcp/scripts/run-local.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="${1:-stdio}"
ENV_FILE="${FREESCOUT_ENV_FILE:-$ROOT/.env}"

say() { printf 'run-local: %s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }

case "$MODE" in
  stdio | http | dev | dev:http) ;;
  -h | --help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 0 ;;
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

# --- Hook it up to Claude (only when a person is at the terminal) -----------------------------

ask_yn() { # ask_yn "question" -> 0 for yes (default yes)
  local reply
  printf '%s [Y/n] ' "$1" >/dev/tty; IFS= read -r reply </dev/tty
  case "$reply" in [nN]*) return 1 ;; *) return 0 ;; esac
}

SCRIPT="$ROOT/scripts/run-local.sh"
NAME="${FREESCOUT_MCP_NAME:-freescout}"

setup_claude_code() {
  if ! command -v claude >/dev/null; then
    say "Claude Code CLI not found; to add it later: claude mcp add --scope user $NAME -- $SCRIPT"
    return
  fi
  local existing
  if existing="$(claude mcp get "$NAME" 2>/dev/null)"; then
    if [[ "$existing" == *"$SCRIPT"* ]]; then
      say "Claude Code: '$NAME' already set up"
      return
    fi
    ask_yn "Claude Code already has an MCP server named '$NAME'. Replace it?" || return 0
    claude mcp remove --scope user "$NAME" >/dev/null 2>&1 || claude mcp remove "$NAME" >/dev/null 2>&1 || true
  else
    ask_yn "Add '$NAME' to Claude Code (all projects)?" || return 0
  fi
  claude mcp add --scope user "$NAME" -- "$SCRIPT" >&2 && say "added to Claude Code; run /mcp in Claude Code to check it"
}

setup_claude_desktop() {
  local dir
  case "$(uname -s)" in
    Darwin) dir="$HOME/Library/Application Support/Claude" ;;
    Linux) dir="${XDG_CONFIG_HOME:-$HOME/.config}/Claude" ;;
    *) return ;;
  esac
  if [ ! -d "$dir" ]; then
    say "Claude Desktop not found ($dir); skipping"
    return
  fi
  if [ -f "$dir/claude_desktop_config.json" ] && CONFIG="$dir/claude_desktop_config.json" NAME="$NAME" SCRIPT="$SCRIPT" \
    node -e 'const c=JSON.parse(require("fs").readFileSync(process.env.CONFIG,"utf8"));process.exit(c.mcpServers?.[process.env.NAME]?.command===process.env.SCRIPT?0:1)' 2>/dev/null; then
    say "Claude Desktop: '$NAME' already set up"
    return
  fi
  ask_yn "Add '$NAME' to Claude Desktop?" || return 0
  # Claude Desktop starts servers with a minimal PATH, so pass the directory of this node along.
  CONFIG="$dir/claude_desktop_config.json" NAME="$NAME" SCRIPT="$SCRIPT" \
    NODE_DIR="$(dirname "$(command -v node)")" node <<'JS' >&2 || say "warning: Claude Desktop config not changed"
const fs = require("fs");
const { CONFIG, NAME, SCRIPT, NODE_DIR } = process.env;
let cfg = {};
if (fs.existsSync(CONFIG)) {
  const raw = fs.readFileSync(CONFIG, "utf8");
  try { cfg = raw.trim() ? JSON.parse(raw) : {}; }
  catch (e) { console.error(`run-local: ${CONFIG} is not valid JSON (${e.message}); fix it or add the server by hand`); process.exit(1); }
  fs.copyFileSync(CONFIG, CONFIG + ".bak");
}
cfg.mcpServers ??= {};
const replaced = NAME in cfg.mcpServers;
cfg.mcpServers[NAME] = {
  command: SCRIPT,
  env: { PATH: [NODE_DIR, "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":") },
};
const tmp = CONFIG + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
fs.renameSync(tmp, CONFIG);
console.error(`run-local: ${replaced ? "updated" : "added"} '${NAME}' in ${CONFIG}${fs.existsSync(CONFIG + ".bak") ? " (backup: .bak)" : ""}`);
console.error("run-local: quit and reopen Claude Desktop to load it");
JS
}

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
  elif [ "$MODE" = stdio ]; then
    echo >&2
    setup_claude_code
    setup_claude_desktop
    cat >&2 <<EOF

Ready. Claude Code / Claude Desktop start the server themselves through this script from now on.
Starting it here once as a test; Ctrl-C to stop.

EOF
  fi
fi

case "$MODE" in
  stdio) exec node dist/index.js ;;
  http) exec node dist/http.js ;;
  dev) exec npx --no-install tsx src/index.ts ;;
  dev:http) exec npx --no-install tsx src/http.ts ;;
esac
