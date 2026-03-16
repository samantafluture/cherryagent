export interface VoiceIntent {
  project: string;
  repoPath: string;
  taskType: "fix" | "feature" | "refactor" | "test" | "docs" | "investigate";
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

export interface ClaudeRunResult {
  success: boolean;
  output: string;
  filesChanged: number;
  error?: string;
}

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
