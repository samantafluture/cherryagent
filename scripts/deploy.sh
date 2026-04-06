#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Marking repo as safe directory..."
git config --global --add safe.directory "$(pwd)"

echo "==> Configuring git identity..."
git config user.email "sam@cherryagent.dev"
git config user.name "sam"

echo "==> Cleaning stale git lock files..."
for lockfile in .git/index.lock .git/refs/heads/main.lock .git/HEAD.lock; do
  if [ -f "$lockfile" ]; then
    echo "    Removing stale $lockfile"
    rm -f "$lockfile"
  fi
done

echo "==> Checking out main branch..."
git checkout main 2>/dev/null || git checkout -b main origin/main

echo "==> Pulling latest code..."
git clean -fd --exclude=.claude/tasks.md
git checkout -- . ':!.claude/tasks.md'
git fetch origin main && git reset --hard origin/main

echo "==> Building Docker image..."
docker compose -f docker-compose.prod.yml build

echo "==> Starting API container..."
docker compose -f docker-compose.prod.yml up -d --force-recreate api

echo "==> Reloading Nginx..."
if docker exec infra-nginx nginx -t 2>&1; then
  docker exec infra-nginx nginx -s reload
  echo "==> Nginx reloaded successfully."
else
  echo "==> WARNING: Nginx config test failed — skipping reload."
  echo "==> Fix the nginx config on the VPS manually."
fi

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
