import { execFile } from "node:child_process";
import type { ClaudeRunResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Run Claude Code CLI as a subprocess on a given repo directory.
 * Uses --print mode with --dangerously-skip-permissions for headless execution.
 */
export function runClaudeCode(opts: {
  repoPath: string;
  prompt: string;
  timeoutMs?: number;
}): Promise<ClaudeRunResult> {
  const { repoPath, prompt, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  return new Promise((resolve) => {
    const child = execFile(
      "claude",
      ["--print", "--dangerously-skip-permissions", prompt],
      {
        cwd: repoPath,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        env: { ...process.env, CLAUDE_CODE_HEADLESS: "1" },
      },
      (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          resolve({
            success: false,
            output: stdout || stderr || error.message,
            filesChanged: 0,
            error: error.message,
          });
          return;
        }

        // Count changed files from git status
        countChangedFiles(repoPath).then((filesChanged) => {
          resolve({
            success: true,
            output: stdout,
            filesChanged,
          });
        });
      },
    );

    // Kill on timeout (execFile handles this, but be explicit)
    child.on("error", (err: Error) => {
      resolve({
        success: false,
        output: "",
        filesChanged: 0,
        error: err.message,
      });
    });
  });
}

function countChangedFiles(repoPath: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["status", "--porcelain"],
      { cwd: repoPath },
      (error: Error | null, stdout: string) => {
        if (error) {
          resolve(0);
          return;
        }
        const lines = stdout.trim().split("\n").filter(Boolean);
        resolve(lines.length);
      },
    );
  });
}
