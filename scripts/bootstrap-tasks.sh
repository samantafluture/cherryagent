#!/usr/bin/env bash
set -euo pipefail

# Bootstrap CherryTasks for a project
# Usage: bash scripts/bootstrap-tasks.sh <project-name> [repo-path]
#
# Examples:
#   bash scripts/bootstrap-tasks.sh "My New Project" /home/sam/apps/myproject
#   bash scripts/bootstrap-tasks.sh "My New Project"  # uses current directory

PROJECT_NAME="${1:-}"
REPO_PATH="${2:-.}"

if [ -z "$PROJECT_NAME" ]; then
  echo "Usage: bash scripts/bootstrap-tasks.sh <project-name> [repo-path]"
  echo ""
  echo "This script:"
  echo "  1. Creates .claude/tasks.md with the standard format"
  echo "  2. Adds Task Management section to CLAUDE.md (if it exists)"
  echo "  3. Installs the CherryTasks skill to ~/.claude/skills/cherrytasks/"
  exit 1
fi

cd "$REPO_PATH"

echo "==> Bootstrapping CherryTasks for: $PROJECT_NAME"
echo "    Path: $(pwd)"

# 1. Create tasks.md
TASKS_FILE=".claude/tasks.md"
mkdir -p .claude

if [ -f "$TASKS_FILE" ]; then
  echo "    tasks.md already exists — skipping"
else
  TODAY=$(date +%Y-%m-%d)
  cat > "$TASKS_FILE" << EOF
# Project: $PROJECT_NAME

> Last synced to repo: —
> Last agent update: $TODAY

## Active Sprint

### P0 — Must do now

### P1 — Should do this week

### P2 — Nice to have

## Blocked

## Completed (recent)

## Notes
- Check CLAUDE.md for architectural decisions before starting work
EOF
  echo "    Created $TASKS_FILE"
fi

# 2. Add Task Management section to CLAUDE.md
if [ -f "CLAUDE.md" ]; then
  if grep -q "Task Management" CLAUDE.md; then
    echo "    CLAUDE.md already has Task Management section — skipping"
  else
    cat >> CLAUDE.md << 'EOF'

## Task Management
See ~/.claude/skills/cherrytasks/SKILL.md for task conventions.
Tasks: .claude/tasks.md
EOF
    echo "    Added Task Management section to CLAUDE.md"
  fi
else
  echo "    No CLAUDE.md found — skipping (create one manually if needed)"
fi

# 3. Install shared skill (if not already present)
SKILL_DIR="$HOME/.claude/skills/cherrytasks"
if [ -f "$SKILL_DIR/SKILL.md" ]; then
  echo "    CherryTasks skill already installed"
else
  mkdir -p "$SKILL_DIR"
  echo "    Skill directory created at $SKILL_DIR"
  echo "    NOTE: Copy SKILL.md from another machine or the cherryagent repo"
fi

echo ""
echo "==> Done! Next steps:"
echo "    1. Commit .claude/tasks.md"
echo "    2. Set up GitHub webhook (if using instant sync):"
echo "       Repo Settings → Webhooks → Add webhook"
echo "       URL: https://cherryagent.samantafluture.com/api/github/webhook"
echo "       Content type: application/json"
echo "       Secret: (use GITHUB_WEBHOOK_SECRET from cherryagent .env)"
echo "       Events: Just the push event"
