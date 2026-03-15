import { existsSync, readdirSync, statSync } from "fs";
import { resolve } from "path";
import type { TaskFile } from "./types.js";
import { loadTaskFile } from "./crud.js";

export interface ProjectEntry {
  slug: string;
  name: string;
  repoPath: string;
  taskFilePath: string;
}

export interface ProjectOverview {
  slug: string;
  name: string;
  totalTasks: number;
  activeTasks: number;
  inProgress: number;
  blocked: number;
  topTask?: string;
}

const PROJECTS_BASE = process.env.PROJECTS_BASE ?? "/home/samantafluture/Development";

/**
 * Discover all projects that have a .claude/tasks.md file.
 * Uses a known list of project directories under PROJECTS_BASE.
 */
export function listProjects(knownSlugs?: string[]): ProjectEntry[] {
  const slugs = knownSlugs ?? discoverProjectSlugs();
  const projects: ProjectEntry[] = [];

  for (const slug of slugs) {
    const repoPath = resolve(PROJECTS_BASE, slug);
    const taskFilePath = resolve(repoPath, ".claude/tasks.md");
    if (existsSync(taskFilePath)) {
      const file = loadTaskFile(taskFilePath);
      projects.push({
        slug,
        name: file.projectName,
        repoPath,
        taskFilePath,
      });
    }
  }

  return projects;
}

export function getOverview(projects?: ProjectEntry[]): ProjectOverview[] {
  const entries = projects ?? listProjects();
  return entries.map((project) => {
    const file = loadTaskFile(project.taskFilePath);
    return projectOverview(project, file);
  });
}

function projectOverview(project: ProjectEntry, file: TaskFile): ProjectOverview {
  const allActive = [
    ...file.sections.activeP0.tasks,
    ...file.sections.activeP1.tasks,
    ...file.sections.activeP2.tasks,
  ].filter((t) => !t.checkbox);

  const blocked = file.sections.blocked.tasks.length;
  const done = file.sections.completed.tasks.length;
  const totalTasks = allActive.length + blocked + done;

  return {
    slug: project.slug,
    name: project.name,
    totalTasks,
    activeTasks: allActive.length,
    inProgress: allActive.length,
    blocked,
    topTask: allActive[0]?.title,
  };
}

/**
 * Auto-discover project directories by scanning PROJECTS_BASE
 * for directories that contain .claude/tasks.md
 */
function discoverProjectSlugs(): string[] {
  const slugs: string[] = [];

  try {
    const entries = readdirSync(PROJECTS_BASE);
    for (const entry of entries) {
      const fullPath = resolve(PROJECTS_BASE, entry);
      try {
        if (statSync(fullPath).isDirectory()) {
          const taskFile = resolve(fullPath, ".claude/tasks.md");
          if (existsSync(taskFile)) {
            slugs.push(entry);
          }
        }
      } catch {
        // skip entries we can't stat
      }
    }
  } catch {
    // PROJECTS_BASE doesn't exist
  }

  return slugs;
}
