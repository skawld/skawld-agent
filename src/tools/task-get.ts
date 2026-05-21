import type { Tool, ToolContext, ToolResult } from "./base.js";
import type { Task } from "../sessions/tasks.js";
import { ToolExecutionError } from "../core/errors.js";

interface TaskGetInput {
  task_id: string;
}

function renderTask(task: Task): string {
  const lines: string[] = [
    `Task #${task.id}`,
    `  subject:     ${task.subject}`,
    `  status:      ${task.status}`,
    `  description: ${task.description}`,
  ];
  if (task.active_form) lines.push(`  active_form: ${task.active_form}`);
  if (task.owner) lines.push(`  owner:       ${task.owner}`);
  if (task.blocks.length > 0) lines.push(`  blocks:      ${task.blocks.map(id => `#${id}`).join(", ")}`);
  if (task.blocked_by.length > 0) lines.push(`  blocked_by:  ${task.blocked_by.map(id => `#${id}`).join(", ")}`);
  if (task.metadata && Object.keys(task.metadata).length > 0) {
    lines.push(`  metadata:    ${JSON.stringify(task.metadata)}`);
  }
  lines.push(`  created_at:  ${task.created_at}`);
  lines.push(`  updated_at:  ${task.updated_at}`);
  return lines.join("\n");
}

export class TaskGetTool implements Tool<TaskGetInput> {
  readonly name = "TaskGet";
  readonly description = "Retrieve full details of a single task by id.";
  readonly input_schema = {
    type: "object" as const,
    properties: {
      task_id: { type: "string", description: "The task id to retrieve." },
    },
    required: ["task_id"],
  };
  readonly scope = "read" as const;
  readonly parallelSafe = true;

  validate(raw: Record<string, unknown>): TaskGetInput {
    const task_id = raw["task_id"];
    if (typeof task_id !== "string" || task_id.trim() === "") {
      throw new ToolExecutionError("task_id must be a non-empty string", { tool_name: this.name });
    }
    return { task_id: task_id.trim() };
  }

  async execute(input: TaskGetInput, ctx: ToolContext): Promise<ToolResult> {
    try {
      const task = await ctx.sessionStore.getTask(ctx.sessionId, input.task_id);
      if (!task) {
        return { content: "Task not found.", summary: this.summarize(input), is_error: true };
      }
      return { content: renderTask(task), summary: this.summarize(input) };
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : "Failed to get task.",
        summary: this.summarize(input),
        is_error: true,
      };
    }
  }

  summarize(input: TaskGetInput): string {
    return `Get task #${input.task_id}`;
  }
}
