export interface Permission {
  category: string;
  action: string;
  scope: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  output: string;
  artifacts?: string[];
  sideEffects?: string[];
}

export interface ExecutionContext {
  taskId: string;
  project?: string;
  permissions: Permission[];
}

export interface Tool {
  name: string;
  description: string;
  category: "filesystem" | "shell" | "http" | "database" | "browser" | "notification" | "media" | "git";
  parameters: Record<string, unknown>;
  permissions: Permission[];
  requiresApproval: boolean;
  timeout: number;

  execute(params: Record<string, unknown>, context: ExecutionContext): Promise<ToolResult>;
}
