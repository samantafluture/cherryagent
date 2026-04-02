import { Client } from "@notionhq/client";
import type {
  QueryDataSourceParameters,
  QueryDataSourceResponse,
} from "@notionhq/client/build/src/api-endpoints.js";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints/common.js";

export interface NotionTask {
  pageId: string;
  title: string;
  status: "Not started" | "In progress" | "Done";
  project: string;
  priority: string;
  type: string;
  owner: string;
  dueDate: string | null;
  githubRepo: string;
  branch: string;
  filePath: string;
  lastEdited: string;
  delegated: boolean;
}

let clientInstance: Client | null = null;

function getClient(): Client {
  if (!clientInstance) {
    const auth = process.env["NOTION_API_KEY"];
    if (!auth) throw new Error("NOTION_API_KEY env var is required");
    clientInstance = new Client({ auth });
  }
  return clientInstance;
}

function getDataSourceId(): string {
  const id = process.env["NOTION_DATA_SOURCE_ID"];
  if (!id) throw new Error("NOTION_DATA_SOURCE_ID env var is required");
  return id;
}

function extractText(prop: PageObjectResponse["properties"][string]): string {
  if (prop.type === "rich_text") {
    return prop.rich_text.map((t) => t.plain_text).join("");
  }
  if (prop.type === "title") {
    return prop.title.map((t) => t.plain_text).join("");
  }
  return "";
}

function extractSelect(prop: PageObjectResponse["properties"][string]): string {
  if (prop.type === "select" && prop.select) {
    return prop.select.name;
  }
  return "";
}

function extractStatus(prop: PageObjectResponse["properties"][string]): string {
  if (prop.type === "status" && prop.status) {
    return prop.status.name;
  }
  return "";
}

function extractCheckbox(prop: PageObjectResponse["properties"][string]): boolean {
  if (prop.type === "checkbox") {
    return prop.checkbox;
  }
  return false;
}

function extractDate(prop: PageObjectResponse["properties"][string]): string | null {
  if (prop.type === "date" && prop.date) {
    return prop.date.start;
  }
  return null;
}

function extractLastEdited(prop: PageObjectResponse["properties"][string]): string {
  if (prop.type === "last_edited_time") {
    return prop.last_edited_time;
  }
  return "";
}

function pageToTask(page: PageObjectResponse): NotionTask {
  const p = page.properties;
  return {
    pageId: page.id,
    title: extractText(p["Task"]!),
    status: extractStatus(p["Status"]!) as NotionTask["status"],
    project: extractSelect(p["Project"]!),
    priority: extractSelect(p["Priority"]!),
    type: extractSelect(p["Type"]!),
    owner: extractSelect(p["Owner"]!),
    dueDate: extractDate(p["Due Date"]!),
    githubRepo: extractText(p["GitHub Repo"]!),
    branch: extractText(p["Branch"]!),
    filePath: extractText(p["File Path"]!),
    lastEdited: extractLastEdited(p["Last Edited"]!),
    delegated: extractCheckbox(p["Delegate to Claude Code"]!),
  };
}

async function queryAll(filter: QueryDataSourceParameters["filter"]): Promise<NotionTask[]> {
  const client = getClient();
  const dataSourceId = getDataSourceId();
  const tasks: NotionTask[] = [];
  let cursor: string | undefined;

  do {
    const response: QueryDataSourceResponse = await client.dataSources.query({
      data_source_id: dataSourceId,
      filter,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const page of response.results) {
      if (page.object === "page" && "properties" in page) {
        tasks.push(pageToTask(page as PageObjectResponse));
      }
    }

    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return tasks;
}

/** Query active tasks (Not started + In progress) for a specific project. */
export async function queryTasksByProject(project: string): Promise<NotionTask[]> {
  return queryAll({
    and: [
      { property: "Project", select: { equals: project } },
      {
        or: [
          { property: "Status", status: { equals: "Not started" } },
          { property: "Status", status: { equals: "In progress" } },
        ],
      },
    ],
  });
}

/** Query recently completed tasks for a project (done within the last N days). */
export async function queryRecentlyCompleted(
  project: string,
  days = 7,
): Promise<NotionTask[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  return queryAll({
    and: [
      { property: "Project", select: { equals: project } },
      { property: "Status", status: { equals: "Done" } },
      { property: "Last Edited", last_edited_time: { on_or_after: since.toISOString() } },
    ],
  });
}

/** Query all non-done tasks across all projects. */
export async function queryAllActiveTasks(): Promise<NotionTask[]> {
  return queryAll({
    or: [
      { property: "Status", status: { equals: "Not started" } },
      { property: "Status", status: { equals: "In progress" } },
    ],
  });
}

/** Query all recently completed tasks across all projects. */
export async function queryAllRecentlyCompleted(days = 7): Promise<NotionTask[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  return queryAll({
    and: [
      { property: "Status", status: { equals: "Done" } },
      { property: "Last Edited", last_edited_time: { on_or_after: since.toISOString() } },
    ],
  });
}
