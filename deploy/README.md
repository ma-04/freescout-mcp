# Deploying freescout-mcp (HTTP mode) on a Tailscale-only host

The container listens on `0.0.0.0:8787` *inside* Docker; `docker-compose.yml` publishes that port **only on the
host's Tailscale IP** (`${BIND_IP}:${MCP_PORT}:8787`). Nothing is published on the public interface, and every
`/mcp` request still needs `Authorization: Bearer <MCP_TOKEN>` plus the client's own `X-FreeScout-*` headers.

Layout on the server:

```
~/freescout-mcp/
  .env                 chmod 600: MCP_TOKEN, FREESCOUT_URL, BIND_IP, MCP_PORT, optional FREESCOUT_FORWARD_ALLOW (see .env.example)
  docker-compose.yml   copy of deploy/docker-compose.yml
  src-tree/            rsync'd working tree (no .git, node_modules, dist, .env*); the image is built from it
```

The repository is private, so the server holds no GitHub credentials: the tree is pushed with `rsync` from a
machine that has a checkout, and the image is built on the server itself (native arm64/amd64, no cross-build).

## First deployment (the steps actually run)

Reference host: `user@host` (aarch64, Docker / Compose v2, no sudo, no node), Tailscale IP `100.64.0.10`.
Replace both with your own. The service uses port 8787.

From the laptop, in the repository checkout:

```sh
ssh user@host 'mkdir -p ~/freescout-mcp/src-tree && chmod 700 ~/freescout-mcp'
rsync -az --delete --exclude node_modules --exclude dist --exclude .git --exclude '.env*' \
  ./ user@host:freescout-mcp/src-tree/
```

On the server (`ssh user@host`):

```sh
cd ~/freescout-mcp
# Generate the token straight into the file; it is never printed.
umask 077
{ echo "MCP_TOKEN=$(openssl rand -hex 32)"
  echo "FREESCOUT_URL=https://support.example.com/"
  echo "BIND_IP=100.64.0.10"     # tailscale ip -4
  echo "MCP_PORT=8787"; } > .env
chmod 600 .env
cp src-tree/deploy/docker-compose.yml docker-compose.yml
docker compose build
docker compose up -d
```

Read the token when configuring a client: `ssh user@host 'grep ^MCP_TOKEN ~/freescout-mcp/.env'`.

## Verify

On the server:

```sh
curl http://100.64.0.10:8787/healthz              # {"ok":true,"version":"0.1.0"}
ss -ltn | grep 8787                                  # LISTEN ... 100.64.0.10:8787 ... (and nothing else)
docker inspect freescout-mcp --format '{{.Config.User}} {{json .HostConfig.PortBindings}}'
                                                     # node {"8787/tcp":[{"HostIp":"100.64.0.10","HostPort":"8787"}]}
docker exec freescout-mcp id                         # uid=1000(node)

U=http://100.64.0.10:8787/mcp; T=$(sed -n 's/^MCP_TOKEN=//p' .env)
A='Accept: application/json, text/event-stream'; J='Content-Type: application/json'
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
curl -s -o /dev/null -w '%{http_code}\n' -H "$A" -H "$J" -d "$INIT" $U                          # 401 (no bearer)
curl -s -w ' %{http_code}\n' -H "Authorization: Bearer $T" -H "$A" -H "$J" -d "$INIT" $U       # 401 + JSON-RPC error naming the headers
# A deliberately bogus cookie: initialize works, whoami reaches FreeScout and reports the expired session.
C='X-FreeScout-Cookie: laravel_session=bogus-not-a-real-session'
curl -s -D /tmp/h -H "Authorization: Bearer $T" -H "$C" -H "$A" -H "$J" -d "$INIT" $U            # 200, serverInfo
S=$(grep -i '^mcp-session-id:' /tmp/h | cut -d' ' -f2 | tr -d '\r'); P='Mcp-Protocol-Version: 2025-06-18'
curl -s -H "Authorization: Bearer $T" -H "$C" -H "$A" -H "$J" -H "Mcp-Session-Id: $S" -H "$P" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' $U                               # 202
curl -s -H "Authorization: Bearer $T" -H "$C" -H "$A" -H "$J" -H "Mcp-Session-Id: $S" -H "$P" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"whoami","arguments":{}}}' $U
                                                     # "AuthError: FreeScout session expired or invalid. ..."
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H "Authorization: Bearer $T" -H "$C" -H "Mcp-Session-Id: $S" -H "$P" $U   # 200
unset T
```

From a machine outside the tailnet, the public IP must not answer:

```sh
curl -s -o /dev/null -m 10 -w '%{http_code}\n' http://203.0.113.10:8787/healthz   # 000 (timeout)
```

Results of the first deployment (2026-10-25): healthz `200 {"ok":true,"version":"0.1.0"}`; public IP timed out
(`000`, curl exit 28); `ss` showed only `LISTEN 0 4096 100.64.0.10:8787 0.0.0.0:*`; no bearer `401`, wrong
bearer `401`, bearer without identity `401`, browser Origin `403`; bogus cookie: initialize `200`, initialized
`202`, whoami returned the AuthError text from support.example.com, a different cookie on the same session `403`,
DELETE `200`, the deleted session afterwards `404`. Container user `node` (uid 1000), healthy, port bound to
`100.64.0.10` only.

## Update

From the laptop, after pulling `main`:

```sh
rsync -az --delete --exclude node_modules --exclude dist --exclude .git --exclude '.env*' \
  ./ user@host:freescout-mcp/src-tree/
```

On the server:

```sh
cd ~/freescout-mcp
cp src-tree/deploy/docker-compose.yml docker-compose.yml
docker compose build
docker compose up -d
docker image prune -f
```

(With a checkout on the server instead of rsync, the first step is `git -C src-tree pull`.)

Restarting drops all MCP sessions; clients re-initialize on their next request (the old session id gets `404`).

## Rotate MCP_TOKEN

```sh
cd ~/freescout-mcp
sed -i "s/^MCP_TOKEN=.*/MCP_TOKEN=$(openssl rand -hex 32)/" .env
docker compose up -d --force-recreate
```

Then update the `Authorization: Bearer ...` header in every client (`claude mcp remove freescout` and add it
again with the new header).

## Logs

```sh
docker compose logs -f --tail 100        # in ~/freescout-mcp
```

Logs go to stderr inside the container (json-file driver, 3 x 10 MB). They contain session open/close lines and
redacted tool errors, never cookies, passwords or the bearer token. Set `FREESCOUT_LOG_LEVEL=debug` in `.env`
(then `docker compose up -d`) to also see `METHOD /path` for every FreeScout request.

## Notes

- `restart: always` brings the service back after a reboot. If Docker starts before `tailscaled` has assigned the
  100.x address, the port binding can fail (`cannot assign requested address`) and the container stays down: after
  a reboot, check `docker compose ps` and run `docker compose up -d` if needed. (Untested on this host; making
  `docker.service` start after `tailscaled.service` would need root.)
- The bearer token and the identity headers travel as plain HTTP inside the tailnet; WireGuard encrypts them on
  the wire. Do not publish the port on any other interface.
- The container runs as `node`, with a read-only root filesystem, no capabilities and `no-new-privileges`.
- `FREESCOUT_FORWARD_ALLOW` in `.env` (optional, see `.env.example`) gates `forward_conversation`, the only tool that
  emails someone: unset, the tool is not registered; set, every session can forward only to those addresses/domains.
  Clients cannot change it. The container log says at startup whether forwarding is enabled and for which entries.
