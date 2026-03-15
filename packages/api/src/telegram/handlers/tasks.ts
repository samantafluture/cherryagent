import type { Context } from "grammy";
import {
  listProjects,
  getOverview,
  loadTaskFile,
  saveTaskFile,
  addTask,
  updateTaskStatus,
  deleteTask,
  reorderTask,
  addTaskNote,
  editTaskTitle,
  findTask,
  getActiveTasks,
  commitAndPush,
  type ProjectEntry,
  type Task,
  type Priority,
} from "@cherryagent/tools";

export function createTaskHandlers() {
  const projects = listProjects();
  const slugMap = new Map<string, ProjectEntry>(projects.map((p) => [p.slug, p]));

  function resolveProject(input: string): ProjectEntry | undefined {
    // Exact match
    if (slugMap.has(input)) return slugMap.get(input);
    // Prefix match
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
          "  /tasks all — cross-project overview\n" +
          "  /tasks &lt;project&gt; — tasks for a project\n\n" +
          "<b>Manage:</b>\n" +
          '  /task &lt;project&gt; add "&lt;title&gt;"\n' +
          "  /task &lt;project&gt; done &lt;#&gt;\n" +
          "  /task &lt;project&gt; wip &lt;#&gt;\n" +
          "  /task &lt;project&gt; block &lt;#&gt;\n" +
          "  /task &lt;project&gt; up &lt;#&gt;\n" +
          "  /task &lt;project&gt; down &lt;#&gt;\n" +
          "  /task &lt;project&gt; drop &lt;#&gt;\n" +
          '  /task &lt;project&gt; note &lt;#&gt; "&lt;text&gt;"\n' +
          '  /task &lt;project&gt; edit &lt;#&gt; "&lt;title&gt;"\n\n' +
          `<b>Projects:</b> ${projects.map((p) => p.slug).join(", ")}`,
        { parse_mode: "HTML" },
      );
    }

    if (args === "all") {
      return handleOverview(ctx);
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
      cherryagent: "\ud83c\udf52",
      cherrytree: "\ud83c\udf33",
      fincherry: "\ud83d\udcb0",
      saminprogress: "\u270d\ufe0f",
      surpride: "\ud83c\udf89",
      recordoc: "\ud83d\udcdd",
    };

    const lines = ["<b>\ud83d\udccb All Projects</b>", ""];
    let totalActive = 0;

    for (const p of overview) {
      const icon = icons[p.slug] ?? "\ud83d\udcc1";
      totalActive += p.activeTasks;
      lines.push(
        `${icon} <b>${p.slug}</b> (${p.activeTasks} active / ${p.totalTasks} total)`,
      );
      if (p.blocked > 0) {
        lines.push(`  \u25b8 ${p.blocked} blocked`);
      }
      if (p.topTask) {
        lines.push(`  \u25b8 Top: ${escapeHtml(p.topTask)}`);
      }
      lines.push("");
    }

    lines.push(`<b>\ud83d\udcca Total: ${totalActive} active across ${overview.length} projects</b>`);

    return ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  }

  async function showProjectTasks(ctx: Context, project: ProjectEntry) {
    const file = loadTaskFile(project.taskFilePath);
    const sections = [
      { label: "\ud83d\udfe2 P0 — Must do now", tasks: file.sections.activeP0.tasks },
      { label: "\ud83d\udfe1 P1 — Should do this week", tasks: file.sections.activeP1.tasks },
      { label: "\u26aa P2 — Nice to have", tasks: file.sections.activeP2.tasks },
      { label: "\ud83d\uded1 Blocked", tasks: file.sections.blocked.tasks },
    ];

    const lines = [`<b>${escapeHtml(file.projectName)} Tasks</b>`, ""];

    let taskIndex = 0;
    for (const section of sections) {
      if (section.tasks.length === 0) continue;
      lines.push(`<b>${section.label}</b>`);
      for (const task of section.tasks) {
        taskIndex++;
        const check = task.checkbox ? "\u2705" : "\u2b1c";
        const size = task.size ? ` [${task.size}]` : "";
        const tags = task.tags.length > 0 ? " " + task.tags.map((t) => `#${t}`).join(" ") : "";
        const manual = task.manual ? " \ud83d\udc64" : "";
        const blocked = task.blockedReason ? ` \ud83d\udd34 ${escapeHtml(task.blockedReason)}` : "";
        lines.push(
          `${taskIndex}. ${check} ${escapeHtml(task.title)}${size}${tags}${manual}${blocked}`,
        );
      }
      lines.push("");
    }

    // Show recent completions count
    const doneCount = file.sections.completed.tasks.length;
    if (doneCount > 0) {
      lines.push(`<i>\u2705 ${doneCount} completed tasks</i>`);
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
    const allActive = getActiveTasks(file);

    switch (action) {
      case "add":
      case "bug": {
        const titleMatch = args.match(/"([^"]+)"/);
        if (!titleMatch) {
          return ctx.reply('Usage: /task <project> add "Task title"');
        }
        const priority: Priority = action === "bug" ? "P0" : "P2";
        const task = addTask(file, { title: titleMatch[1], priority });
        saveTaskFile(project.taskFilePath, file);
        await syncRepo(project.repoPath);
        return ctx.reply(
          `\u2705 Added to ${project.slug} [${priority}]: ${escapeHtml(task.title)}`,
          { parse_mode: "HTML" },
        );
      }

      case "done":
      case "wip":
      case "block": {
        const index = Number(parts[2]);
        if (!index) return ctx.reply(`Usage: /task ${projectSlug} ${action} <#>`);
        const task = allActive[index - 1];
        if (!task) return ctx.reply(`No active task at #${index}`);
        const statusMap = { done: "done", wip: "active", block: "blocked" } as const;
        updateTaskStatus(file, task.id, statusMap[action]);
        saveTaskFile(project.taskFilePath, file);
        await syncRepo(project.repoPath);
        const emoji = { done: "\u2705", wip: "\ud83d\udfe1", block: "\ud83d\uded1" }[action];
        return ctx.reply(`${emoji} ${escapeHtml(task.title)} → ${action}`);
      }

      case "up":
      case "down": {
        const index = Number(parts[2]);
        if (!index) return ctx.reply(`Usage: /task ${projectSlug} ${action} <#>`);
        const task = allActive[index - 1];
        if (!task) return ctx.reply(`No active task at #${index}`);
        const moved = reorderTask(file, task.id, action);
        if (!moved) return ctx.reply("Can't move further in that direction.");
        saveTaskFile(project.taskFilePath, file);
        await syncRepo(project.repoPath);
        return ctx.reply(`\u2194\ufe0f Moved ${escapeHtml(task.title)} ${action}`);
      }

      case "drop": {
        const index = Number(parts[2]);
        if (!index) return ctx.reply(`Usage: /task ${projectSlug} drop <#>`);
        const task = allActive[index - 1];
        if (!task) return ctx.reply(`No active task at #${index}`);
        deleteTask(file, task.id);
        saveTaskFile(project.taskFilePath, file);
        await syncRepo(project.repoPath);
        return ctx.reply(`\ud83d\uddd1 Removed: ${escapeHtml(task.title)}`);
      }

      case "note": {
        const index = Number(parts[2]);
        const noteMatch = args.match(/"([^"]+)"/);
        if (!index || !noteMatch) {
          return ctx.reply(`Usage: /task ${projectSlug} note <#> "Note text"`);
        }
        const task = allActive[index - 1];
        if (!task) return ctx.reply(`No active task at #${index}`);
        addTaskNote(file, task.id, noteMatch[1]);
        saveTaskFile(project.taskFilePath, file);
        await syncRepo(project.repoPath);
        return ctx.reply(`\ud83d\udcdd Added note to: ${escapeHtml(task.title)}`);
      }

      case "edit": {
        const index = Number(parts[2]);
        const titleMatch = args.match(/"([^"]+)"/);
        if (!index || !titleMatch) {
          return ctx.reply(`Usage: /task ${projectSlug} edit <#> "New title"`);
        }
        const task = allActive[index - 1];
        if (!task) return ctx.reply(`No active task at #${index}`);
        editTaskTitle(file, task.id, titleMatch[1]);
        saveTaskFile(project.taskFilePath, file);
        await syncRepo(project.repoPath);
        return ctx.reply(`\u270f\ufe0f Renamed to: ${escapeHtml(titleMatch[1])}`);
      }

      default:
        return ctx.reply(
          `Unknown action: ${action}\nActions: add, bug, done, wip, block, up, down, drop, note, edit`,
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

    switch (action) {
      case "done":
        updateTaskStatus(file, taskId, "done");
        saveTaskFile(project.taskFilePath, file);
        await syncRepo(project.repoPath);
        await ctx.answerCallbackQuery({ text: `Done: ${task.title}` });
        break;
      case "wip":
        updateTaskStatus(file, taskId, "active");
        saveTaskFile(project.taskFilePath, file);
        await syncRepo(project.repoPath);
        await ctx.answerCallbackQuery({ text: `In progress: ${task.title}` });
        break;
      case "block":
        updateTaskStatus(file, taskId, "blocked");
        saveTaskFile(project.taskFilePath, file);
        await syncRepo(project.repoPath);
        await ctx.answerCallbackQuery({ text: `Blocked: ${task.title}` });
        break;
      default:
        return ctx.answerCallbackQuery({ text: "Unknown action" });
    }

    // Refresh the task list message
    await showProjectTasks(ctx, project).catch(() => {});
  }

  return { handleTasksCommand, handleTaskCommand, handleTaskCallback };
}

// --- Helpers ---

function buildTaskKeyboard(slug: string, tasks: Task[]) {
  return tasks.map((task) => [
    { text: `\u2705 ${truncate(task.title, 20)}`, callback_data: `task_done_${slug}_${task.id}` },
    { text: "\ud83d\udfe1 WIP", callback_data: `task_wip_${slug}_${task.id}` },
    { text: "\ud83d\uded1", callback_data: `task_block_${slug}_${task.id}` },
  ]);
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "\u2026" : text;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function syncRepo(repoPath: string): Promise<void> {
  try {
    await commitAndPush(repoPath);
  } catch (err) {
    console.error(`[tasks] Git sync failed for ${repoPath}:`, err);
  }
}
