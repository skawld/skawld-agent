import type { Tool, ToolContext, ToolResult } from "./base.js";
import type { Task } from "../sessions/tasks.js";

function renderTaskLine(task: Task, allTasks: Task[]): string {
  let line = `#${task.id} [${task.status}] ${task.subject}`;
  if (task.owner) line += ` (${task.owner})`;

  // Only include blockers that are not completed
  const activeBlockers = task.blocked_by.filter(blockerId => {
    const blocker = allTasks.find(t => t.id === blockerId);
    return blocker && blocker.status !== "completed";
  });
  if (activeBlockers.length > 0) {
    line += ` [blocked by ${activeBlockers.map(id => `#${id}`).join(", ")}]`;
  }

  return line;
}

export class TaskListTool implements Tool<Record<string, never>> {
  readonly name = "TaskList";
  readonly description = "List all tasks in the current session.";
  readonly input_schema = {
    type: "object" as const,
    properties: {},
    required: [],
  };
  readonly scope = "read" as const;
  readonly parallelSafe = true;

  validate(_raw: Record<string, unknown>): Record<string, never> {
    return {};
  }

  async execute(_input: Record<string, never>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const tasks = await ctx.sessionStore.listTasks(ctx.sessionId);
      if (tasks.length === 0) {
        return { content: "No tasks found.", summary: this.summarize({}) };
      }
      const lines = tasks.map(t => renderTaskLine(t, tasks));
      return { content: lines.join("\n"), summary: this.summarize({}) };
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : "Failed to list tasks.",
        summary: this.summarize({}),
        is_error: true,
      };
    }
  }

  summarize(_input: Record<string, never>): string {
    return "List tasks";
  }
}
