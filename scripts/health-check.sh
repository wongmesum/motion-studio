#!/bin/bash
# Health check & auto-restart script (bisa dipasang di crontab tiap 2 menit)

BASE="${VPS_ENDPOINT:-http://localhost:3000}"
# Liveness only. `/health` reports 503 while Redis is unreachable, and restarting the app
# cannot fix Redis - it would restart the container every cycle and discard the in-memory
# fallback jobs it is holding. Dependency degradation is reported, not restarted.
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/live" || echo "000")

if [ "$STATUS" != "200" ]; then
  echo "[$(date -Iseconds)] ⚠️ VPS Render Server not answering liveness (HTTP $STATUS). Restarting..."
  if command -v docker &>/dev/null && [ -f docker-compose.yml ]; then
    docker compose restart vps-server
  fi
else
  echo "[$(date -Iseconds)] ✅ VPS Render Server alive (HTTP 200)"
fi
