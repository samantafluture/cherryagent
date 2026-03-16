import type { VoiceSession } from "./types.js";

/** In-memory session store keyed by chatId. */
const sessions = new Map<string, VoiceSession>();

/** Time window for auto-resuming a session (15 minutes). */
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

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
