import { getClient } from "./client.js";

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

/** Revert task on failure: status back to Not started, clear delegate, post error. */
export async function markTaskFailed(
  pageId: string,
  error: string,
): Promise<void> {
  const client = getClient();

  await client.pages.update({
    page_id: pageId,
    properties: {
      Status: { status: { name: "Not started" } },
      Result: {
        rich_text: [{ text: { content: `Error: ${error.slice(0, 1990)}` } }],
      },
      "Delegate to Claude Code": { checkbox: false },
    },
  });

  await addNotionComment(pageId, `Delegation failed:\n${error}`);
}
