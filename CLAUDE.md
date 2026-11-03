# CLAUDE.md

## Backwards compatibility (always)

Installs update themselves: `scripts/run-local.sh` fast-forwards to `origin/main` and rebuilds on start, with
no one watching. Every change merged to `main` must keep existing installs working without user action.

- `.env`: never rename or remove a variable or change its meaning. New variables are optional with safe defaults.
- `scripts/run-local.sh`: keep the path, the modes (`stdio`, `http`, `dev`, `dev:http`) and no-argument = stdio.
  Claude Code and Claude Desktop configs point at it directly. Must run on macOS bash 3.2 and never prompt
  when stdin is not a terminal. In stdio mode nothing may be written to stdout except MCP.
- MCP tools: never rename or remove a tool or a parameter, or make an optional parameter required. Add new
  parameters as optional. Keep output fields; add new ones.
- HTTP mode: keep headers, `MCP_*` variables and the `/mcp` and `/healthz` endpoints.
- Node: keep `engines` (>= 20) unless the script installs the newer version itself.
- Auto-update: never rewrite `main` history (updates are fast-forward only). Don't break the update path itself.
- Before merging, run the new code against an install made from the previous `main` (existing `.env`, existing
  Claude config) and check it still starts and answers `initialize`.
