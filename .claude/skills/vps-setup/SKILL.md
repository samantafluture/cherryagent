# VPS Deployment Skill

## Context

Sam has a Hostinger KVM1 VPS (Ubuntu 24.04, IP: 187.124.67.117, user: sam) running multiple projects with shared infrastructure. This skill contains the patterns, lessons learned, and playbook for deploying new projects to this VPS.

## VPS Architecture

```
~/apps/
├── infra/                          # Shared services (PostgreSQL, Nginx, Certbot)
│   ├── docker-compose.yml
│   ├── .env
│   ├── pg-init/
│   │   └── 01-create-databases.sh
│   └── nginx/conf.d/
│       ├── fincherry.conf
│       ├── surpride.conf
│       └── recordoc.conf
├── fincherry/                      # FinCherry app (Fastify + React, PostgreSQL)
├── surpride/                       # Surpride app (Fastify + React, SQLite)
└── recordoc/                       # recordoc app (Fastify + React, Supabase→PostgreSQL)
```

### Shared Infrastructure
- **Network:** `infra-net` — all project containers join this Docker network
- **PostgreSQL 16:** container `infra-db`, accessible at `infra-db:5432` from any container on `infra-net`. Host-level access at `127.0.0.1:5432`. One instance, multiple databases (one per project).
- **Nginx:** container `infra-nginx`, reverse proxy with per-project `.conf` files in `~/apps/infra/nginx/conf.d/`. Serves static SPAs from Docker volumes.
- **Certbot:** container `infra-certbot`, auto-renews SSL certs every 12h. Certs stored in `infra_certbot_conf` volume.
- **SSH:** key-based auth only (password disabled), user `sam` with sudo. Deploy key at `~/.ssh/deploy_key` used by GitHub Actions.

## Deploying a New Project — Checklist

### Files to Create in the Repo

1. **`Dockerfile.prod`** — Multi-stage build. Everything builds inside Docker (no Node/pnpm on host).
   - `base` stage: install deps + copy source
   - `web-build` stage: build SPA
   - `api-build` stage: compile TypeScript API
   - `deps-prod` stage: production dependencies with native modules compiled
   - `api` stage: final slim image with compiled code + prod deps

2. **`docker-compose.prod.yml`** — Production compose file.
   - `api` service: always-on, joins `infra-net`, `restart: unless-stopped`
   - `web-assets` service: `profiles: [tools]`, one-shot, copies SPA to nginx volume
   - `worker` service (if needed): always-on, joins `infra-net`
   - Volumes declared as external with explicit `name:` to prevent prefix issues

3. **`scripts/deploy.sh`** — Deploy script called by GitHub Actions:
   ```bash
   git pull origin main
   docker compose -f docker-compose.prod.yml build
   docker compose -f docker-compose.prod.yml run --rm web-assets
   docker compose -f docker-compose.prod.yml run --rm migrate  # if applicable
   docker compose -f docker-compose.prod.yml up -d api worker
   docker exec infra-nginx nginx -s reload
   # health check loop
   docker image prune -f
   ```

4. **`.github/workflows/deploy.yml`** — CI + auto-deploy on push to main.
   - Job 1: CI (typecheck, lint, build)
   - Job 2: Deploy (SSH via `appleboy/ssh-action@v1`, runs `cd ~/apps/<project> && bash scripts/deploy.sh`)
   - Concurrency group to prevent parallel deploys
   - Uses `VPS_SSH_KEY` secret

5. **`nginx/<project>.conf`** — Nginx server block (HTTP→HTTPS redirect, API proxy, SPA static files)

6. **`.env.production.example`** — Documents required env vars

### VPS One-Time Setup Steps

1. **DNS:** Add A record `subdomain.domain.com → 187.124.67.117`. Wait for propagation (`dig` returns correct IP).

2. **SSL cert:**
   ```bash
   docker stop infra-nginx
   docker run --rm -p 80:80 \
     -v infra_certbot_conf:/etc/letsencrypt \
     certbot/certbot certonly \
     --standalone \
     -d <domain> \
     --email samantafluture@gmail.com \
     --agree-tos --no-eff-email
   docker start infra-nginx
   ```

3. **Create volume:** `docker volume create <project>_web`

4. **Clone repo:** `git clone https://TOKEN@github.com/samantafluture/<repo>.git ~/apps/<project>` (use HTTPS, not SSH)

5. **Copy nginx config:** `cp ~/apps/<project>/nginx/<project>.conf ~/apps/infra/nginx/conf.d/`

6. **Update infra compose** (`~/apps/infra/docker-compose.yml`):
   - Add `- <project>_web:/usr/share/nginx/<project>:ro` to nginx volumes
   - Add to top-level volumes:
     ```yaml
     <project>_web:
       name: <project>_web
     ```

7. **Restart infra:** `cd ~/apps/infra && docker compose up -d`

8. **Create `.env`:** `cp .env.production.example .env && vim .env && chmod 600 .env`

9. **Fix line endings (if needed):** `sed -i 's/\r$//' scripts/deploy.sh`

10. **First deploy:** `bash scripts/deploy.sh`

11. **If nginx crash-loops** (because it started before API existed): `docker restart infra-nginx`

12. **Add `VPS_SSH_KEY` to GitHub repo** (if separate repo): Settings → Secrets → Actions → paste `~/.ssh/deploy_key`

13. **Add database** (if using shared PostgreSQL):
    ```bash
    docker exec -it infra-db psql -U postgres -c "CREATE USER <project> WITH PASSWORD '<password>';"
    docker exec -it infra-db psql -U postgres -c "CREATE DATABASE <project> OWNER <project>;"
    ```

14. **Add cron jobs:** `crontab -e` — add backup schedule

## Critical Lessons Learned

### Docker Volume Naming
Docker Compose prefixes volume names with the project name (e.g., `infra_fincherry_web`). To prevent this, ALWAYS declare external volumes with explicit `name:`:
```yaml
volumes:
  project_web:
    external: true
    name: project_web
```
Or create the volume manually with `docker volume create project_web` and reference it consistently.

### Native Node Modules (better-sqlite3, argon2, etc.)
`pnpm rebuild` silently does nothing in Docker. Use direct node-gyp instead:
```dockerfile
# In deps-prod stage:
RUN apk add --no-cache python3 make g++
RUN pnpm install --frozen-lockfile --prod
RUN cd /app/node_modules/.pnpm/better-sqlite3@X.X.X/node_modules/better-sqlite3 && npx --yes node-gyp rebuild
```

### pnpm Monorepo Dependencies
Copying `node_modules` between Docker stages breaks pnpm's symlink structure. Either:
- Run `pnpm install --frozen-lockfile --prod` fresh in the final stage with correct working directory
- Or use a dedicated `deps-prod` stage and copy the entire `node_modules` from there

### Nginx Crash Loop on First Deploy
Nginx fails if it can't resolve an upstream hostname (e.g., `fincherry-api`) that doesn't exist yet. This is expected on first deploy. Solution: deploy the app first, then `docker restart infra-nginx`.

### Line Endings
Scripts created on Windows/WSL may have `\r\n` line endings that break bash. Fix with:
```bash
sed -i 's/\r$//' scripts/deploy.sh
```

### Git Clone on VPS
Always use HTTPS (not SSH) for cloning on the VPS. Private repos need a GitHub Personal Access Token with `repo` scope:
```bash
git clone https://TOKEN@github.com/user/repo.git
```

### DATABASE_URL Special Characters
If a database password contains `@`, `#`, or other URL-special characters, they break the connection string. Use passwords without special characters (e.g., `openssl rand -hex 24`).

### Deploy Script Must CD First
The GitHub Actions workflow must `cd ~/apps/<project>` before running `bash scripts/deploy.sh`.

## Common Commands

```bash
# Check all running containers
docker ps

# Check specific project logs
docker logs <container-name> --tail 50
docker logs <container-name> -f          # follow live

# Restart a service
docker restart <container-name>

# Rebuild and redeploy (on VPS)
cd ~/apps/<project>
git pull
bash scripts/deploy.sh

# Force rebuild (no cache)
docker compose -f docker-compose.prod.yml build --no-cache

# Shell into a container
docker exec -it <container-name> sh

# Check disk usage
df -h
docker system df
docker image prune -a -f    # remove ALL unused images

# Database access
docker exec -it infra-db psql -U postgres
docker exec -it infra-db psql -U <project> -d <project>

# Nginx
docker exec infra-nginx nginx -t        # test config
docker exec infra-nginx nginx -s reload  # reload

# SSL certs
docker exec infra-certbot certbot certificates
```

## Current Container Names

| Container         | Project    | Service              |
|-------------------|------------|----------------------|
| `infra-db`        | infra      | PostgreSQL 16        |
| `infra-nginx`     | infra      | Nginx reverse proxy  |
| `infra-certbot`   | infra      | SSL cert renewal     |
| `fincherry-api`   | fincherry  | FinCherry API        |
| `surpride-api`    | surpride   | Surpride API         |
| `recordoc-api`    | recordoc   | recordoc API         |
| `recordoc-worker` | recordoc   | recordoc Worker      |

## Current Domains

| Domain                           | Project    |
|----------------------------------|------------|
| fincherry.samantafluture.com     | fincherry  |
| surpride.samantafluture.com      | surpride   |
| recordoc.app                     | recordoc   |
