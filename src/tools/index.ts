// Tool interface types
export type { Tool, ToolSchema, ToolScope, ToolContext, ToolResult, JSONSchema } from "./base";

// File read tracker
export { FileReadTracker } from "./file-tracker";

// Registry
export { ToolRegistry, defaultTools } from "./registry";

// Tool classes
export { ReadTool } from "./read";
export { WriteTool } from "./write";
export { EditTool } from "./edit";
export { BashTool } from "./bash";
export { GlobTool } from "./glob";
export { GrepTool } from "./grep";
export { TaskCreateTool } from "./task-create";
export { TaskListTool } from "./task-list";
export { TaskGetTool } from "./task-get";
export { TaskUpdateTool } from "./task-update";

// Task persistence types (re-exported for tool authors / consumers).
export type { Task, TaskStatus, CreateTaskInput, TaskPatch } from "../sessions/tasks";
