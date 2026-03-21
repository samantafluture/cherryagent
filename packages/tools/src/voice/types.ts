export interface VoiceIntent {
  project: string;
  repoPath: string;
  taskType: "fix" | "feature" | "refactor" | "test" | "docs" | "investigate" | "content" | "strategy";
  branchName: string;
  prTitle: string;
  taskDescription: string;
  transcript: string;
}

export interface VoiceSession {
  chatId: string;
  project: string;
  repoPath: string;
  branchName: string;
  prNumber: number | null;
  prUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export type PendingState =
  | "awaiting_transcript_approval"
  | "awaiting_transcript_edit"
  | "awaiting_project_selection"
  | "awaiting_confirmation";

export interface PendingVoiceTask {
  chatId: string;
  transcript: string;
  state: PendingState;
  project?: string;
  repoPath?: string;
  taskType?: VoiceIntent["taskType"];
  branchName?: string;
  prTitle?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRunResult {
  success: boolean;
  output: string;
  filesChanged: number;
  changedFiles: string[];
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/** @deprecated Use AgentRunResult instead */
export type ClaudeRunResult = AgentRunResult;

export interface PrResult {
  success: boolean;
  prUrl: string | null;
  prNumber: number | null;
  error?: string;
}

export interface ProjectMapping {
  slug: string;
  keywords: string[];
  repoPath: string;
}
