export type Priority = "P0" | "P1" | "P2";
export type Size = "S" | "M" | "L";
export type TaskStatus = "active" | "wip" | "blocked" | "done";

export interface Subtask {
  title: string;
  checkbox: boolean;
}

export interface Task {
  id: string;
  title: string;
  checkbox: boolean;
  size?: Size;
  tags: string[];
  priority: Priority;
  status: TaskStatus;
  completedDate?: string;
  blockedReason?: string;
  manual: boolean;
  subtasks: Subtask[];
  notes: string[];
}

export interface TaskFile {
  projectName: string;
  lastSyncedToRepo: string;
  lastAgentUpdate: string;
  sections: {
    activeP0: SectionContent;
    activeP1: SectionContent;
    activeP2: SectionContent;
    blocked: SectionContent;
    completed: SectionContent;
    notes: string[];
  };
}

export interface SectionContent {
  tasks: Task[];
  freeformLines: string[];
}
