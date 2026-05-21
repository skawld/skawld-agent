import type { Tool, ToolContext, ToolResult } from "./base.js";
import { ToolExecutionError } from "../core/errors.js";
import type { CreateTaskInput } from "../sessions/tasks.js";

interface TaskCreateInput {
  subject: string;
  description: string;
  active_form?: string;
  metadata?: Record<string, unknown>;
}

export class TaskCreateTool implements Tool<TaskCreateInput> {
  readonly name = "TaskCreate";
  readonly description = "Create a new persistent task in the current session.";
  readonly input_schema = {
    type: "object" as const,
    properties: {
      subject: { type: "string", description: "Brief task title." },
      description: { type: "string", description: "What needs to be done." },
      active_form: { type: "string", description: "Present-continuous label shown in spinner." },
      metadata: { type: "object", description: "Arbitrary key-value metadata." },
    },
    required: ["subject", "description"],
  };
  readonly scope = "write" as const;
  readonly parallelSafe = true;

  validate(raw: Record<string, unknown>): TaskCreateInput {
    const subject = raw["subject"];
    const description = raw["description"];
    if (typeof subject !== "string" || subject.trim() === "") {
      throw new ToolExecutionError("subject must be a non-empty string", { tool_name: this.name });
    }
    if (typeof description !== "string") {
      throw new ToolExecutionError("description must be a string", { tool_name: this.name });
    }
    const active_form = raw["active_form"];
    if (active_form !== undefined && typeof active_form !== "string") {
      throw new ToolExecutionError("active_form must be a string", { tool_name: this.name });
    }
    const metadata = raw["metadata"];
    if (metadata !== undefined && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))) {
      throw new ToolExecutionError("metadata must be an object", { tool_name: this.name });
    }
    return {
      subject: subject.trim(),
      description,
      active_form: typeof active_form === "string" ? active_form : undefined,
      metadata: metadata as Record<string, unknown> | undefined,
    };
  }

  async execute(input: TaskCreateInput, ctx: ToolContext): Promise<ToolResult> {
    try {
      const createInput: CreateTaskInput = {
        subject: input.subject,
        description: input.description,
        active_form: input.active_form,
        metadata: input.metadata,
      };
      const task = await ctx.sessionStore.createTask(ctx.sessionId, createInput);
      return {
        content: `Task #${task.id} created: ${task.subject}`,
        summary: this.summarize(input),
      };
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : "Failed to create task.",
        summary: this.summarize(input),
        is_error: true,
      };
    }
  }

  summarize(input: TaskCreateInput): string {
    return `Create task: ${input.subject}`;
  }
}
