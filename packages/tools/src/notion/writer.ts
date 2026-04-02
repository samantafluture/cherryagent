import { getClient, type NotionTask } from "./client.js";

const COMMENT_MAX_LENGTH = 2000;

/** Update task status in Notion. */
export async function updateNotionTaskStatus(
  pageId: string,
  status: "Not started" | "In progress" | "Done",
): Promise<void> {
  const client = getClient();
  await client.pages.update({
    page_id: pageId,
    properties: {
      Status: { status: { name: status } },
    },
  });
}

/** Update the Result rich text field on a task. */
export async function updateNotionTaskResult(
  pageId: string,
  result: string,
): Promise<void> {
  const client = getClient();
  await client.pages.update({
    page_id: pageId,
    properties: {
      Result: {
        rich_text: [{ text: { content: result.slice(0, 2000) } }],
      },
    },
  });
}

/** Clear the "Delegate to Claude Code" checkbox. */
export async function clearDelegateCheckbox(pageId: string): Promise<void> {
  const client = getClient();
  await client.pages.update({
    page_id: pageId,
    properties: {
      "Delegate to Claude Code": { checkbox: false },
    },
  });
}

/** Add a page-level comment with execution output. */
export async function addNotionComment(
  pageId: string,
  text: string,
): Promise<void> {
  const client = getClient();
  const truncated = text.length > COMMENT_MAX_LENGTH
    ? text.slice(0, COMMENT_MAX_LENGTH - 3) + "..."
    : text;

  await client.comments.create({
    parent: { page_id: pageId },
    rich_text: [{ text: { content: truncated } }],
  });
}

/** Batch update: set status + result + clear delegate in one go. */
export async function markTaskDone(
  pageId: string,
  resultSummary: string,
  fullOutput: string,
): Promise<void> {
  const client = getClient();

  // Update properties
  await client.pages.update({
    page_id: pageId,
    properties: {
      Status: { status: { name: "Done" } },
      Result: {
        rich_text: [{ text: { content: resultSummary.slice(0, 2000) } }],
      },
      "Delegate to Claude Code": { checkbox: false },
    },
  });

  // Add comment with full output
  if (fullOutput.trim()) {
    await addNotionComment(pageId, fullOutput);
  }
}

/** Mark task as Done with failure info. Keeps it in history instead of reverting. */
export async function markTaskFailed(
  pageId: string,
  error: string,
): Promise<void> {
  const client = getClient();

  await client.pages.update({
    page_id: pageId,
    properties: {
      Status: { status: { name: "Done" } },
      Result: {
        rich_text: [{ text: { content: `FAILED: ${error.slice(0, 1985)}` } }],
      },
      "Delegate to Claude Code": { checkbox: false },
    },
  });

  await addNotionComment(pageId, `Delegation failed:\n${error}`);
}

/**
 * Create subtasks in Notion for a task that's too large.
 * Copies the parent's Project, Priority (downgraded to P1), and Owner.
 * Marks the parent as "Done" with a note about decomposition.
 */
export async function createSubtasksInNotion(
  parentTask: NotionTask,
  subtaskTitles: string[],
  reason: string,
): Promise<void> {
  const client = getClient();
  const dataSourceId = process.env["NOTION_DATA_SOURCE_ID"];
  if (!dataSourceId) throw new Error("NOTION_DATA_SOURCE_ID env var is required");

  // Create each subtask as a new page in the database
  for (const title of subtaskTitles) {
    const properties: Record<string, unknown> = {
      Task: { title: [{ text: { content: title } }] },
      Status: { status: { name: "Not started" } },
      Priority: { select: { name: "P1 High" } },
      Owner: { select: { name: "Claude Code" } },
      "Delegate to Claude Code": { checkbox: true },
    };
    if (parentTask.project) {
      properties["Project"] = { select: { name: parentTask.project } };
    }

    await client.pages.create({
      parent: { data_source_id: dataSourceId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      properties: properties as any,
    });
  }

  // Mark parent task as done with decomposition note
  await client.pages.update({
    page_id: parentTask.pageId,
    properties: {
      Status: { status: { name: "Done" } },
      Result: {
        rich_text: [{ text: { content: `Decomposed into ${subtaskTitles.length} subtasks: ${reason}` } }],
      },
      "Delegate to Claude Code": { checkbox: false },
    },
  });

  await addNotionComment(
    parentTask.pageId,
    `Task too large for single session. Created ${subtaskTitles.length} subtasks:\n${subtaskTitles.map((t, i) => `${i + 1}. ${t}`).join("\n")}`,
  );
}
