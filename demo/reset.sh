#!/usr/bin/env bash
# Wipe and reseed the FreeScout demo. Run from your machine (repo root):
#   DEMO_SSH=user@host DEMO_DOMAIN=freescout.example.com demo/reset.sh
# The compose dir on the server is ~/$DEMO_DOMAIN. Requires AGENT_PASS in its .env (never in the repo).
set -euo pipefail
HOST=${DEMO_SSH:?set DEMO_SSH=user@host}
DOMAIN=${DEMO_DOMAIN:?set DEMO_DOMAIN to the demo hostname}
DIR="~/$DOMAIN"
cd "$(dirname "$0")/.."
scp -q demo/seed.php "$HOST:/tmp/fs-seed.php"
ssh "$HOST" "cd $DIR && set -a && . ./.env && set +a && \
  docker cp /tmp/fs-seed.php freescout-demo:/tmp/seed.php && \
  docker exec -u nginx -e AGENT_PASS=\"\$AGENT_PASS\" -e DEMO_DOMAIN='$DOMAIN' freescout-demo php /tmp/seed.php --reset && \
  docker exec freescout-demo rm -f /tmp/seed.php && rm -f /tmp/fs-seed.php" 2>&1 | grep -v '^Downloading More Ram'
