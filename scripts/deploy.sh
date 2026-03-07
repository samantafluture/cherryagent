#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Pulling latest code..."
git pull origin main

echo "==> Building Docker image..."
docker compose -f docker-compose.prod.yml build

echo "==> Starting API container..."
docker compose -f docker-compose.prod.yml up -d api

echo "==> Reloading Nginx..."
docker exec infra-nginx nginx -s reload

echo "==> Waiting for health check..."
MAX_RETRIES=10
RETRY_INTERVAL=3

for i in $(seq 1 $MAX_RETRIES); do
  if docker exec cherryagent-api wget -qO- http://127.0.0.1:3000/health > /dev/null 2>&1; then
    echo "==> Health check passed! (attempt $i/$MAX_RETRIES)"
    break
  fi

  if [ "$i" -eq "$MAX_RETRIES" ]; then
    echo "==> Health check failed after $MAX_RETRIES attempts"
    echo "==> Container logs:"
    docker logs cherryagent-api --tail 50
    exit 1
  fi

  echo "    Attempt $i/$MAX_RETRIES failed, retrying in ${RETRY_INTERVAL}s..."
  sleep $RETRY_INTERVAL
done

echo "==> Pruning unused images..."
docker image prune -f

echo "==> Deploy complete!"
