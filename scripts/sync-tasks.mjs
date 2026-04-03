#!/usr/bin/env node

/**
 * sync-tasks.mjs — Parse .claude/tasks.md and sync to GitHub Issues.
 *
 * One-way sync: tasks.md is the source of truth.
 * Creates, updates, and closes Issues based on task state.
 * Uses `gh` CLI for all GitHub API calls (zero npm dependencies).
 *
 * Env vars:
 *   TASKS_FILE — path to tasks.md (default: .claude/tasks.md)
 *   REPO      — owner/repo (default: from gh)
 *   GH_TOKEN  — GitHub token (set automatically in Actions)
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

const TASKS_FILE = process.env.TASKS_FILE || '.claude/tasks.md';
const REPO = process.env.REPO || '';
const SYNC_LABEL = 'cherry-sync';
const MARKER_PREFIX = '<!-- cherry-task-id:';

// ── Label definitions ────────────────────────────────────────────────

const LABELS = {
  [SYNC_LABEL]: { color: 'd4a373', description: 'Synced from tasks.md' },
  P0: { color: 'd73a4a', description: 'Priority: must do now' },
  P1: { color: 'e8a317', description: 'Priority: should do this week' },
  P2: { color: '0e8a16', description: 'Priority: nice to have' },
  blocked: { color: 'b60205', description: 'Task is blocked' },
  'in-progress': { color: '1d76db', description: 'Task in progress' },
  'size-S': { color: 'c5def5', description: 'Small (1-2h)' },
  'size-M': { color: 'bfd4f2', description: 'Medium (3-8h)' },
  'size-L': { color: 'a2c4e0', description: 'Large (1+ days)' },
};

// ── Helpers ──────────────────────────────────────────────────────────

function gh(args, { input } = {}) {
  const repoFlag = REPO ? ` --repo ${REPO}` : '';
  const cmd = `gh ${args}${repoFlag}`;
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      ...(input ? { input } : {}),
    }).trim();
  } catch (err) {
    console.error(`gh command failed: ${cmd}`);
    console.error(err.stderr || err.message);
    throw err;
  }
}

function taskId(title) {
  const normalized = title.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

function cleanTitle(line) {
  return (
    line
      // Remove checkbox
      .replace(/^- \[[ /x]\]\s*/, '')
      // Remove size markers
      .replace(/`\[[SML]\]`/g, '')
      // Remove hashtags
      .replace(/#\w+/g, '')
      // Remove completion dates
      .replace(/✅\s*\d{4}-\d{2}-\d{2}/g, '')
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
      // Remove emoji markers
      .replace(/👤\s*/g, '')
      .replace(/⏳\s*/g, '')
      .replace(/🔴\s*/g, '')
      // Remove inline status markers
      .replace(/\bin-progress\b/gi, '')
      .replace(/\bmanual\b/gi, '')
      .replace(/\bblocked:\s*.*/gi, '')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim()
  );
}

// ── Parser ───────────────────────────────────────────────────────────

function parseTasks(markdown) {
  const lines = markdown.split('\n');
  const tasks = [];
  let currentPriority = null;
  let currentTask = null;
  let inCompleted = false;
  let inNotes = false;

  for (const line of lines) {
    // Skip merge conflict markers
    if (/^<{7}|^={7}|^>{7}/.test(line)) continue;

    // Track sections
    if (/^###\s+P0\b/i.test(line)) {
      currentPriority = 'P0';
      inCompleted = false;
      inNotes = false;
      continue;
    }
    if (/^###\s+P1\b/i.test(line)) {
      currentPriority = 'P1';
      inCompleted = false;
      inNotes = false;
      continue;
    }
    if (/^###\s+P2\b/i.test(line)) {
      currentPriority = 'P2';
      inCompleted = false;
      inNotes = false;
      continue;
    }
    if (/^##\s+Blocked\b/i.test(line)) {
      currentPriority = 'blocked';
      inCompleted = false;
      inNotes = false;
      continue;
    }
    if (/^##\s+Completed/i.test(line)) {
      inCompleted = true;
      inNotes = false;
      continue;
    }
    if (/^##\s+Notes/i.test(line)) {
      inNotes = true;
      continue;
    }

    // Stop processing in Notes section
    if (inNotes) continue;

    // Skip blockquote lines (agent notes, metadata)
    if (/^\s*>/.test(line)) continue;

    // Top-level task line
    const taskMatch = line.match(/^- \[([ /x])\]\s+(.+)/);
    if (taskMatch) {
      const [, checkbox, rest] = taskMatch;
      const title = cleanTitle(line);
      if (!title) continue;

      // Parse size
      const sizeMatch = rest.match(/`\[([SML])\]`/);
      const size = sizeMatch ? sizeMatch[1] : null;

      // Parse tags
      const tags = [...rest.matchAll(/#(\w+)/g)].map((m) => m[1]);

      // Parse status
      let status = 'open';
      if (checkbox === 'x') status = 'done';
      else if (checkbox === '/') status = 'in-progress';
      else if (/⏳/.test(rest)) status = 'in-progress';

      // Parse blocked reason
      const blockedMatch = rest.match(/(?:🔴\s*)?blocked:\s*(.+)/i);
      const blockedReason = blockedMatch ? blockedMatch[1].trim() : null;

      // Detect manual
      const isManual = /👤|manual/i.test(rest);

      // Determine priority
      let priority = currentPriority || 'P2';
      if (blockedReason || currentPriority === 'blocked') {
        priority = 'blocked';
      }

      // Parse completion date
      const dateMatch = rest.match(/(?:✅\s*)?(\d{4}-\d{2}-\d{2})/);
      const completionDate = dateMatch ? dateMatch[1] : null;

      currentTask = {
        title,
        rawLine: line.trim(),
        id: taskId(title),
        status,
        priority,
        size,
        tags,
        isManual,
        blockedReason,
        subtasks: [],
        completionDate,
        inCompleted,
      };
      tasks.push(currentTask);
      continue;
    }

    // Subtask line (2+ space indent)
    const subtaskMatch = line.match(/^\s{2,}- \[([ x])\]\s+(.+)/);
    if (subtaskMatch && currentTask) {
      currentTask.subtasks.push({
        title: subtaskMatch[2].trim(),
        done: subtaskMatch[1] === 'x',
      });
    }
  }

  return tasks;
}

// ── Label setup ──────────────────────────────────────────────────────

function ensureLabels(extraTags) {
  console.log('Ensuring labels exist...');

  // Static labels
  for (const [name, { color, description }] of Object.entries(LABELS)) {
    gh(`label create "${name}" --color "${color}" --description "${description}" --force`);
  }

  // Dynamic tag labels
  for (const tag of extraTags) {
    if (!LABELS[tag]) {
      gh(`label create "${tag}" --color "ededed" --description "Tag: ${tag}" --force`);
    }
  }
}

// ── Issue body builder ───────────────────────────────────────────────

function buildBody(task) {
  const parts = [`${MARKER_PREFIX} ${task.id} -->`];
  parts.push('');

  // Metadata line
  const meta = [];
  if (task.priority !== 'blocked') meta.push(`**Priority:** ${task.priority}`);
  if (task.size) meta.push(`**Size:** ${task.size}`);
  if (task.isManual) meta.push('**Manual task**');
  if (meta.length) parts.push(meta.join(' | '));

  // Blocked reason
  if (task.blockedReason) {
    parts.push('');
    parts.push(`> **Blocked:** ${task.blockedReason}`);
  }

  // Subtasks
  if (task.subtasks.length) {
    parts.push('');
    parts.push('### Subtasks');
    for (const sub of task.subtasks) {
      parts.push(`- [${sub.done ? 'x' : ' '}] ${sub.title}`);
    }
  }

  parts.push('');
  parts.push('---');
  parts.push('*Synced from `.claude/tasks.md` by cherry-sync*');

  return parts.join('\n');
}

// ── Sync engine ──────────────────────────────────────────────────────

function fetchExistingIssues() {
  const json = gh(
    `issue list --label "${SYNC_LABEL}" --state all --limit 500 --json number,title,body,state,labels`
  );
  if (!json) return new Map();

  const issues = JSON.parse(json);
  const map = new Map();

  for (const issue of issues) {
    const match = issue.body?.match(new RegExp(`${MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(\\w+)\\s*-->`));
    if (match) {
      map.set(match[1], {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels?.map((l) => l.name) || [],
      });
    }
  }

  return map;
}

function computeLabels(task) {
  const labels = [SYNC_LABEL];

  // Priority / blocked
  if (task.priority === 'blocked') {
    labels.push('blocked');
  } else {
    labels.push(task.priority);
  }

  // Size
  if (task.size) labels.push(`size-${task.size}`);

  // Status
  if (task.status === 'in-progress') labels.push('in-progress');

  // Tags
  for (const tag of task.tags) {
    labels.push(tag);
  }

  // Manual
  if (task.isManual) labels.push('manual');

  return [...new Set(labels)];
}

function syncIssues(tasks) {
  const existing = fetchExistingIssues();
  const seenIds = new Set();

  let created = 0;
  let updated = 0;
  let closed = 0;
  let reopened = 0;
  let skipped = 0;

  for (const task of tasks) {
    seenIds.add(task.id);
    const issue = existing.get(task.id);
    const labels = computeLabels(task);
    const labelsStr = labels.map((l) => `"${l}"`).join(',');
    const body = buildBody(task);

    if (!issue) {
      // New task — create Issue
      if (task.status === 'done') {
        // Completed task with no existing Issue — skip, no point creating to immediately close
        skipped++;
        continue;
      }

      console.log(`  CREATE: ${task.title}`);
      gh(`issue create --title "${task.title.replace(/"/g, '\\"')}" --label ${labelsStr} --body-file -`, {
        input: body,
      });
      created++;
    } else {
      // Existing Issue — update or close/reopen
      if (task.status === 'done' && issue.state === 'OPEN') {
        console.log(`  CLOSE: #${issue.number} ${task.title}`);
        gh(`issue close ${issue.number}`);
        closed++;
      } else if (task.status !== 'done' && issue.state === 'CLOSED') {
        console.log(`  REOPEN: #${issue.number} ${task.title}`);
        gh(`issue reopen ${issue.number}`);
        gh(`issue edit ${issue.number} --title "${task.title.replace(/"/g, '\\"')}" --add-label ${labelsStr} --body-file -`, {
          input: body,
        });
        reopened++;
      } else if (issue.state === 'OPEN') {
        // Check if update needed (compare body and labels)
        const currentLabels = new Set(issue.labels);
        const desiredLabels = new Set(labels);
        const labelsChanged =
          currentLabels.size !== desiredLabels.size ||
          [...desiredLabels].some((l) => !currentLabels.has(l));
        const bodyChanged = issue.body?.trim() !== body.trim();

        if (labelsChanged || bodyChanged) {
          console.log(`  UPDATE: #${issue.number} ${task.title}`);
          // Remove old labels that aren't in the desired set
          const toRemove = [...currentLabels].filter((l) => !desiredLabels.has(l));
          for (const label of toRemove) {
            try {
              gh(`issue edit ${issue.number} --remove-label "${label}"`);
            } catch {
              // Label might not exist, ignore
            }
          }
          gh(`issue edit ${issue.number} --title "${task.title.replace(/"/g, '\\"')}" --add-label ${labelsStr} --body-file -`, {
            input: body,
          });
          updated++;
        } else {
          skipped++;
        }
      } else {
        skipped++;
      }
    }
  }

  console.log(
    `\nSync complete: ${created} created, ${updated} updated, ${closed} closed, ${reopened} reopened, ${skipped} unchanged`
  );
}

// ── Main ─────────────────────────────────────────────────────────────

function main() {
  console.log(`Reading ${TASKS_FILE}...`);

  let markdown;
  try {
    markdown = readFileSync(TASKS_FILE, 'utf-8');
  } catch (err) {
    console.error(`Cannot read ${TASKS_FILE}: ${err.message}`);
    process.exit(1);
  }

  const tasks = parseTasks(markdown);
  console.log(`Parsed ${tasks.length} tasks`);

  if (tasks.length === 0) {
    console.log('No tasks found, nothing to sync.');
    return;
  }

  // Collect all unique tags for label creation
  const allTags = new Set();
  for (const task of tasks) {
    for (const tag of task.tags) allTags.add(tag);
    if (task.isManual) allTags.add('manual');
  }

  ensureLabels(allTags);
  syncIssues(tasks);
}

main();
