import type { Context } from "grammy";
import { escapeHtml } from "../utils.js";
import {
  listProjects,
  getOverview,
  loadTaskFile,
  saveTaskFile,
  addTask,
  updateTaskStatus,
  deleteTask,
  reorderTask,
  changeTaskPriority,
  addTaskNote,
  editTaskTitle,
  findTask,
  getActiveTasks,
  commitAndPush,
  type ProjectEntry,
  type Task,
  type TaskFile,
  type Priority,
  type TaskStatus,
} from "@cherryagent/tools";

function sizeDisplay(size?: string): string {
  if (!size) return "";
  return ` - #${size.toLowerCase()}`;
}

function ownerDisplay(task: Task): string {
  return task.manual ? " - #sam" : "";
}

function statusSuffix(task: Task): string {
  if (task.status === "wip") return " ⏳";
  if (task.status === "blocked" || task.blockedReason) return " 🔒";
  return "";
}

export function createTaskHandlers() {
  const projects = listProjects();
  const slugMap = new Map<string, ProjectEntry>(projects.map((p) => [p.slug, p]));

  function resolveProject(input: string): ProjectEntry | undefined {
    if (slugMap.has(input)) return slugMap.get(input);
    for (const [slug, project] of slugMap) {
      if (slug.startsWith(input)) return project;
    }
    return undefined;
  }

  // /tasks [project|all]
  async function handleTasksCommand(ctx: Context) {
    const args = ((ctx.match as string) ?? "").trim();

    if (!args) {
      return ctx.reply(
        "<b>CherryTasks</b>\n\n" +
          "<b>View:</b>\n" +
          "  /tasks all — every task across all projects\n" +
          "  /tasks overview — cross-project summary\n" +
          "  /tasks &lt;project&gt; — tasks for a project\n\n" +
          "<b>Manage:</b>\n" +
          '  /task &lt;project&gt; add "&lt;title&gt;"\n' +
          "  /task &lt;project&gt; done &lt;#,#,#&gt;\n" +
          "  /task &lt;project&gt; wip &lt;#,#,#&gt;\n" +
          "  /task &lt;project&gt; block &lt;#,#,#&gt;\n" +
          "  /task &lt;project&gt; up &lt;#&gt;\n" +
          "  /task &lt;project&gt; down &lt;#&gt;\n" +
          "  /task &lt;project&gt; pri &lt;#&gt; &lt;P0|P1|P2&gt;\n" +
          "  /task &lt;project&gt; drop &lt;#,#,#&gt;\n" +
          '  /task &lt;project&gt; note &lt;#&gt; "&lt;text&gt;"\n' +
          '  /task &lt;project&gt; edit &lt;#&gt; "&lt;title&gt;"\n\n' +
          `<b>Projects:</b> ${projects.map((p) => p.slug).join(", ")}`,
        { parse_mode: "HTML" },
      );
    }

    if (args === "overview") {
      return handleOverview(ctx);
    }

    if (args === "all") {
      return handleAllTasks(ctx);
    }

    const project = resolveProject(args);
    if (!project) {
      return ctx.reply(
        `Unknown project: ${args}\nAvailable: ${projects.map((p) => p.slug).join(", ")}`,
      );
    }

    return showProjectTasks(ctx, project);
  }

  async function handleOverview(ctx: Context) {
    const overview = getOverview(projects);
    const icons: Record<string, string> = {
      cherryagent: "🍒",
      cherrytree: "🌳",
      fincherry: "💰",
      saminprogress: "💬",
      surpride: "🏳️‍🌈",
      recordoc: "▶️",
      "voila-prep": "🇫🇷",
    };

    const lines = ["<b>🎯 All Projects</b>", ""];
    let totalActive = 0;

    for (const p of overview) {
      const icon = icons[p.slug] ?? "📁";
      totalActive += p.activeTasks;
      lines.push(
        `${icon} <b>${p.slug}</b> (${p.activeTasks} active / ${p.totalTasks} total)`,
      );
      if (p.blocked > 0) {
        lines.push(`  ▸ ${p.blocked} blocked`);
      }
      if (p.topTask) {
        lines.push(`  ▸ Top: ${formatHtml(p.topTask)}`);
      }
      lines.push("");
    }

    lines.push(`<b>📊 Total: ${totalActive} active across ${overview.length} projects</b>`);

    return ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  }

  async function handleAllTasks(ctx: Context) {
    const icons: Record<string, string> = {
      cherryagent: "🍒",
      cherrytree: "🌳",
      fincherry: "💰",
      saminprogress: "💬",
      surpride: "🏳️‍🌈",
      recordoc: "▶️",
      "voila-prep": "🇫🇷",
    };

    const lines = ["<b>🎯 All Tasks</b>"];

    for (const project of projects) {
      const file = loadTaskFile(project.taskFilePath);
      const icon = icons[project.slug] ?? "📁";

      const sections = [
        { label: "🟢 P0", tasks: file.sections.activeP0.tasks },
        { label: "🟡 P1", tasks: file.sections.activeP1.tasks },
        { label: "⚪ P2", tasks: file.sections.activeP2.tasks },
        { label: "🔒 Blocked", tasks: file.sections.blocked.tasks },
      ];

      const hasAnyTasks = sections.some((s) => s.tasks.length > 0);
      if (!hasAnyTasks) continue;

      lines.push("", `${icon} <b>${escapeHtml(file.projectName)}</b>`, "");

      let taskIndex = 0;
      for (const section of sections) {
        if (section.tasks.length === 0) continue;
        for (const task of section.tasks) {
          taskIndex++;
          lines.push(formatTaskLine(taskIndex, task));
        }
      }
    }

    if (lines.length === 1) {
      lines.push("", "No active tasks across any project.");
    }

    return ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  }

  async function showProjectTasks(ctx: Context, project: ProjectEntry) {
    const file = loadTaskFile(project.taskFilePath);

    const sections = [
      { label: "🟢 P0 — Must do now", tasks: file.sections.activeP0.tasks },
      { label: "🟡 P1 — Should do this week", tasks: file.sections.activeP1.tasks },
      { label: "⚪ P2 — Nice to have", tasks: file.sections.activeP2.tasks },
      { label: "🔒 Blocked", tasks: file.sections.blocked.tasks },
    ];

    const hasAnyTasks = sections.some((s) => s.tasks.length > 0);
    const doneCount = file.sections.completed.tasks.length;

    if (!hasAnyTasks && doneCount === 0) {
      return ctx.reply(
        `<b>🚀 ${escapeHtml(file.projectName)}</b>\n\n` +
          "No tasks yet.\n" +
          `Use /task ${project.slug} add "Title" to create one.`,
        { parse_mode: "HTML" },
      );
    }

    if (!hasAnyTasks) {
      return ctx.reply(
        `<b>🚀 ${escapeHtml(file.projectName)}</b>\n\n` +
          "No active tasks.\n\n" +
          `<i>✅ ${doneCount} completed</i>\n\n` +
          `Use /task ${project.slug} add "Title" to create one.`,
        { parse_mode: "HTML" },
      );
    }

    const lines = [`<b>🚀 ${escapeHtml(file.projectName)}</b>`, ""];

    let taskIndex = 0;
    for (const section of sections) {
      if (section.tasks.length === 0) continue;
      lines.push(`<b>${section.label}</b>`);
      lines.push("");
      for (const task of section.tasks) {
        taskIndex++;
        lines.push(formatTaskLine(taskIndex, task));
      }
      lines.push("");
    }

    if (doneCount > 0) {
      lines.push(`<i>✅ ${doneCount} completed</i>`);
    }

    // Inline keyboard for quick actions on active tasks
    const activeTasks = getActiveTasks(file);
    const keyboard = activeTasks.length > 0
      ? buildTaskKeyboard(project.slug, activeTasks.slice(0, 5))
      : undefined;

    return ctx.reply(lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    });
  }

  // /task <project> <action> [args]
  async function handleTaskCommand(ctx: Context) {
    const args = ((ctx.match as string) ?? "").trim();
    if (!args) {
      return ctx.reply("Usage: /task &lt;project&gt; &lt;action&gt; [args]\nSee /tasks for help.", {
        parse_mode: "HTML",
      });
    }

    const parts = args.split(/\s+/);
    const projectSlug = parts[0]!;
    const action = parts[1]?.toLowerCase();

    const project = resolveProject(projectSlug);
    if (!project) {
      return ctx.reply(
        `Unknown project: ${projectSlug}\nAvailable: ${projects.map((p) => p.slug).join(", ")}`,
      );
    }

    if (!action) {
      return showProjectTasks(ctx, project);
    }

    const file = loadTaskFile(project.taskFilePath);
    // Use the same task list shown in the display (P0 + P1 + P2 + Blocked)
    const allDisplayed = getDisplayedTasks(file);

    switch (action) {
      case "add":
      case "bug": {
        const titleMatch = args.match(/"([^"]+)"/);
        if (!titleMatch) {
          return ctx.reply('Usage: /task &lt;project&gt; add "Task title"', { parse_mode: "HTML" });
        }
        const priority: Priority = action === "bug" ? "P0" : "P2";
        const task = addTask(file, { title: titleMatch[1], priority });
        saveTaskFile(project.taskFilePath, file);
        await syncRepo(project.repoPath);
        return ctx.reply(
          `✅ Added to <b>${project.slug}</b> [${priority}]: ${escapeHtml(task.title)}`,
          { parse_mode: "HTML" },
        );
      }

      case "done":
      case "wip":
      case "block": {
        const indices = parseIndices(parts[2]);
        if (indices.length === 0) {
          return ctx.reply(`Usage: /task ${projectSlug} ${action} &lt;#,#,#&gt;`, { parse_mode: "HTML" });
        }
        const statusMap = { done: "done", wip: "wip", block: "blocked" } as const;
        const emojiMap = { done: "✅", wip: "⏳", block: "🔒" };
        const results: string[] = [];
        for (const index of indices) {
          const task = allDisplayed[index - 1];
          if (!task) {
            results.push(`#${index} — not found`);
            continue;
          }
          updateTaskStatus(file, task.id, statusMap[action]);
          results.push(`#${index} ${emojiMap[action]} ${escapeHtml(task.title)}`);
        }
        saveTaskFile(project.taskFilePath, file);
        await syncRepo(project.repoPath);
        return ctx.reply(results.join("\n"), { parse_mode: "HTML" });
      }

      case "up":
      case "down": {
        const index = Number(parts[2]);
        if (!index) return ctx.reply(`Usage: /task ${projectSlug} ${action} &lt;#&gt;`, { parse_mode: "HTML" });
        const task = allDisplayed[index - 1];
        if (!task) return ctx.reply(`No active task at #${index}`);
        const moved = reorderTask(file, task.id, action);
        if (!moved) return ctx.reply("Can't move further in that direction.");
        saveTaskFile(project.taskFilePath, file);
        await syncRepo(project.repoPath);
        return ctx.reply(`↕️ Moved #${index} ${escapeHtml(task.title)} ${action}`);
      }

      case "pri": {
        const index = Number(parts[2]);
        const priInput = parts[3]?.toUpperCase();
        if (!index || !priInput || !["P0", "P1", "P2"].includes(priInput)) {
          return ctx.reply(
            `Usage: /task ${projectSlug} pri &lt;#&gt; &lt;P0|P1|P2&gt;`,
            { parse_mode: "HTML" },
          );
        }
        const task = allDisplayed[index - 1];
        if (!task) return ctx.reply(`No task at #${index}`);
        if (task.status === "blocked") return ctx.reply("🔒 Unblock the task first before changing priority.");
        const changed = changeTaskPriority(file, task.id, priInput as Priority);
        if (!changed) return ctx.reply(`Task is already ${priInput}.`);
        saveTaskFile(project.taskFilePath, file);
        await syncRepo(project.repoPath);
        const priEmoji = { P0: "🟢", P1: "🟡", P2: "⚪" } as const;
        return ctx.reply(
          `${priEmoji[priInput as Priority]} #${index} ${escapeHtml(task.title)} → ${priInput}`,
        );
      }

      case "drop": {
        const indices = parseIndices(parts[2]);
        if (indices.length === 0) {
          return ctx.reply(`Usage: /task ${projectSlug} drop &lt;#,#,#&gt;`, { parse_mode: "HTML" });
        }
        // Process in reverse order so indices stay valid
        const sorted = [...indices].sort((a, b) => b - a);
        const results: string[] = [];
        for (const index of sorted) {
          const task = allDisplayed[index - 1];
          if (!task) {
            results.push(`#${index} — not found`);
            continue;
          }
          deleteTask(file, task.id);
          results.push(`🗑 #${index} ${escapeHtml(task.title)}`);
        }
        saveTaskFile(project.taskFilePath, file);
        await syncRepo(project.repoPath);
        return ctx.reply(results.join("\n"), { parse_mode: "HTML" });
      }

      case "note": {
        const index = Number(parts[2]);
        const noteMatch = args.match(/"([^"]+)"/);
        if (!index || !noteMatch) {
          return ctx.reply(`Usage: /task ${projectSlug} note &lt;#&gt; "Note text"`, { parse_mode: "HTML" });
        }
        const task = allDisplayed[index - 1];
        if (!task) return ctx.reply(`No active task at #${index}`);
        addTaskNote(file, task.id, noteMatch[1]);
        saveTaskFile(project.taskFilePath, file);
        await syncRepo(project.repoPath);
        return ctx.reply(`📝 Added note to #${index}: ${escapeHtml(task.title)}`);
      }

      case "edit": {
        const index = Number(parts[2]);
        const titleMatch = args.match(/"([^"]+)"/);
        if (!index || !titleMatch) {
          return ctx.reply(`Usage: /task ${projectSlug} edit &lt;#&gt; "New title"`, { parse_mode: "HTML" });
        }
        const task = allDisplayed[index - 1];
        if (!task) return ctx.reply(`No active task at #${index}`);
        editTaskTitle(file, task.id, titleMatch[1]);
        saveTaskFile(project.taskFilePath, file);
        await syncRepo(project.repoPath);
        return ctx.reply(`✏️ #${index} renamed to: ${escapeHtml(titleMatch[1])}`);
      }

      default:
        return ctx.reply(
          `Unknown action: ${action}\nActions: add, bug, done, wip, block, up, down, pri, drop, note, edit`,
        );
    }
  }

  // Callback handler for inline keyboard buttons
  async function handleTaskCallback(ctx: Context) {
    const data = ctx.callbackQuery?.data;
    if (!data || !data.startsWith("task_")) return;

    // Format: task_<action>_<slug>_<taskId>
    const [, action, slug, taskId] = data.split("_");
    if (!action || !slug || !taskId) {
      return ctx.answerCallbackQuery({ text: "Invalid action" });
    }

    const project = resolveProject(slug);
    if (!project) {
      return ctx.answerCallbackQuery({ text: "Project not found" });
    }

    const file = loadTaskFile(project.taskFilePath);
    const task = findTask(file, taskId);
    if (!task) {
      return ctx.answerCallbackQuery({ text: "Task not found" });
    }

    const statusMap: Record<string, TaskStatus> = {
      done: "done",
      wip: "wip",
      block: "blocked",
    };
    const newStatus = statusMap[action];
    if (!newStatus) {
      return ctx.answerCallbackQuery({ text: "Unknown action" });
    }

    updateTaskStatus(file, taskId, newStatus);
    saveTaskFile(project.taskFilePath, file);
    await syncRepo(project.repoPath);

    const labels: Record<string, string> = {
      done: `✅ Done: ${task.title}`,
      wip: `⏳ WIP: ${task.title}`,
      block: `🔒 Blocked: ${task.title}`,
    };
    await ctx.answerCallbackQuery({ text: labels[action] ?? action });

    // Refresh the task list message
    await showProjectTasks(ctx, project).catch(() => {});
  }

  return { handleTasksCommand, handleTaskCommand, handleTaskCallback };
}

// --- Helpers ---

/** Returns tasks in the same order as displayed: P0 + P1 + P2 + Blocked */
function getDisplayedTasks(file: TaskFile): Task[] {
  return [
    ...file.sections.activeP0.tasks,
    ...file.sections.activeP1.tasks,
    ...file.sections.activeP2.tasks,
    ...file.sections.blocked.tasks,
  ];
}

function formatTaskLine(index: number, task: Task): string {
  const size = sizeDisplay(task.size);
  const owner = ownerDisplay(task);
  const suffix = statusSuffix(task);
  const blocked = task.blockedReason ? `\n   🔒 ${formatHtml(task.blockedReason)}` : "";
  return `<b>${index}</b> - ${formatHtml(task.title)}${size}${owner}${suffix}${blocked}`;
}

function buildTaskKeyboard(slug: string, tasks: Task[]) {
  // Find the starting index for each task (1-based, matching displayed order)
  return tasks.map((task, i) => {
    const n = i + 1;
    return [
      { text: `#${n} ✅ Done`, callback_data: `task_done_${slug}_${task.id}` },
      { text: `#${n} ⏳ WIP`, callback_data: `task_wip_${slug}_${task.id}` },
      { text: `#${n} 🔒 Block`, callback_data: `task_block_${slug}_${task.id}` },
    ];
  });
}

/** Parse comma-separated indices like "1,2,3" or a single "1" */
function parseIndices(input?: string): number[] {
  if (!input) return [];
  return input
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => n > 0 && Number.isInteger(n));
}

/** Escape HTML and convert backtick-wrapped text to <code> tags */
function formatHtml(text: string): string {
  const escaped = escapeHtml(text);
  return escaped.replace(/`([^`]+)`/g, "<code>$1</code>");
}

async function syncRepo(repoPath: string): Promise<void> {
  try {
    await commitAndPush(repoPath);
  } catch (err) {
    console.error(`[tasks] Git sync failed for ${repoPath}:`, err);
  }
}
