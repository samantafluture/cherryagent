import type { PendingVoiceTask, VoiceSession } from "./types.js";

/** In-memory session store keyed by chatId. */
const sessions = new Map<string, VoiceSession>();

/** In-memory pending task store keyed by chatId. */
const pendingTasks = new Map<string, PendingVoiceTask>();

/** Time window for auto-resuming a session (15 minutes). */
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

/** Pending tasks expire after 5 minutes of inactivity. */
const PENDING_TIMEOUT_MS = 5 * 60 * 1000;

export function getActiveSession(chatId: string): VoiceSession | null {
  const session = sessions.get(chatId);
  if (!session) return null;

  // Expire old sessions
  if (Date.now() - session.updatedAt > SESSION_TIMEOUT_MS) {
    sessions.delete(chatId);
    return null;
  }

  return session;
}

export function createSession(session: VoiceSession): void {
  sessions.set(session.chatId, session);
}

export function updateSession(
  chatId: string,
  updates: Partial<Pick<VoiceSession, "prNumber" | "prUrl" | "updatedAt">>,
): VoiceSession | null {
  const session = sessions.get(chatId);
  if (!session) return null;

  Object.assign(session, updates, { updatedAt: Date.now() });
  return session;
}

export function deleteSession(chatId: string): void {
  sessions.delete(chatId);
}

export function getAllSessions(): VoiceSession[] {
  return Array.from(sessions.values());
}

// --- Pending voice tasks ---

export function getPendingTask(chatId: string): PendingVoiceTask | null {
  const task = pendingTasks.get(chatId);
  if (!task) return null;

  if (Date.now() - task.updatedAt > PENDING_TIMEOUT_MS) {
    pendingTasks.delete(chatId);
    return null;
  }

  return task;
}

export function setPendingTask(task: PendingVoiceTask): void {
  pendingTasks.set(task.chatId, task);
}

export function updatePendingTask(
  chatId: string,
  updates: Partial<Omit<PendingVoiceTask, "chatId">>,
): PendingVoiceTask | null {
  const task = getPendingTask(chatId);
  if (!task) return null;

  Object.assign(task, updates, { updatedAt: Date.now() });
  return task;
}

export function deletePendingTask(chatId: string): void {
  pendingTasks.delete(chatId);
}
