// src/sessions/tasks.ts
export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
  id: string;
  session_id: string;
  subject: string;
  description: string;
  active_form?: string;
  status: TaskStatus;
  owner?: string;
  blocks: string[];
  blocked_by: string[];
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreateTaskInput {
  subject: string;
  description: string;
  active_form?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskPatch {
  subject?: string;
  description?: string;
  active_form?: string;
  status?: TaskStatus | "deleted";
  owner?: string;
  add_blocks?: string[];
  add_blocked_by?: string[];
  remove_blocks?: string[];
  remove_blocked_by?: string[];
  metadata?: Record<string, unknown>;
}
