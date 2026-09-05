#!/usr/bin/env bash
# E2E boot: build + start mcp-server, ws-gateway, agent-service against the local RS.
set -e
cd /home/z/my-project/razor-mcp

# --- build node services (emit dist) ---
(cd apps/mcp-server && bunx tsc -p tsconfig.json)
(cd apps/ws-gateway && bunx tsc -p tsconfig.json)
echo "BUILDS_OK"

export MONGODB_URI="mongodb://127.0.0.1:27017/razormcp?replicaSet=rs0&directConnection=true"
export MCP_API_KEY_SALT="e2e-salt-0001"
export MCP_SERVER_INTERNAL_API_KEY="e2e-internal-mcp-key-0001"
export INTERNAL_WS_SECRET="e2e-internal-ws-secret-0001"
export RAZORPAY_WEBHOOK_SECRET="e2e-webhook-secret"
export SPEND_LIMIT_PAISE=500000
export OTP_TTL_SECONDS=300
export RECOVERY_SESSION_TTL_SECONDS=1800
export DEV_MODE=true
export SEED_CATALOG=true
export SEED_WALLETS=true
export MCP_PORT=4000
export WS_PORT=4001
export AGENT_PORT=5000
export MCP_SERVER_URL=http://127.0.0.1:4000
export WS_GATEWAY_URL=http://127.0.0.1:4001
export WS_ALLOWED_ORIGINS=*

mkdir -p /home/z/my-project/scripts/e2e/logs

(cd apps/mcp-server && nohup node dist/server.js > /home/z/my-project/scripts/e2e/logs/mcp.log 2>&1 &)
(cd apps/ws-gateway && nohup node dist/server.js > /home/z/my-project/scripts/e2e/logs/ws.log 2>&1 &)
(cd apps/agent-service && nohup python3 app.py > /home/z/my-project/scripts/e2e/logs/agent.log 2>&1 &)

echo "SERVICES_STARTED"

for i in $(seq 1 40); do
  M=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/health || echo 000)
  W=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4001/health || echo 000)
  A=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5000/health || echo 000)
  if [ "$M" = "200" ] && [ "$W" = "200" ] && [ "$A" = "200" ]; then
    echo "ALL_HEALTHY"
    curl -s http://127.0.0.1:4000/health; echo; curl -s http://127.0.0.1:4001/health; echo; curl -s http://127.0.0.1:5000/health; echo
    exit 0
  fi
  sleep 2
done
echo "HEALTH_TIMEOUT mcp=$M ws=$W agent=$A"
exit 1
