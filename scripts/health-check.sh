#!/bin/bash
# Health check & auto-restart script (bisa dipasang di crontab tiap 2 menit)

ENDPOINT="${VPS_ENDPOINT:-http://localhost:3000}/health"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$ENDPOINT" || echo "000")

if [ "$STATUS" != "200" ]; then
  echo "[$(date -Iseconds)] ⚠️ VPS Render Server unhealthy (HTTP $STATUS). Restarting..."
  if command -v docker &>/dev/null && [ -f docker-compose.yml ]; then
    docker compose restart vps-server worker
  fi
else
  echo "[$(date -Iseconds)] ✅ VPS Render Server healthy (HTTP 200)"
fi
