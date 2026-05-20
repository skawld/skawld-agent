import { ConfigError } from "../core/errors";
import type { Tool, ToolSchema } from "./base";
import { ReadTool } from "./read";
import { WriteTool } from "./write";
import { EditTool } from "./edit";
import { BashTool } from "./bash";
import { GlobTool } from "./glob";
import { GrepTool } from "./grep";
import { TaskCreateTool } from "./task-create";
import { TaskListTool } from "./task-list";
import { TaskGetTool } from "./task-get";
import { TaskUpdateTool } from "./task-update";

export class ToolRegistry {
  // Tool<any>: registry stores heterogeneous tools; input types are checked at call sites.
  private map = new Map<string, Tool<any>>();

  register(tool: Tool<any>): void {
    if (this.map.has(tool.name)) {
      throw new ConfigError(`tool '${tool.name}' already registered`);
    }
    this.map.set(tool.name, tool);
  }

  get(name: string): Tool<any> | undefined {
    return this.map.get(name);
  }

  list(): Tool<any>[] {
    return Array.from(this.map.values());
  }

  schemas(): ToolSchema[] {
    return this.list().map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }
}

/** Returns a registry preloaded with the ten built-in tools in canonical order. */
export function defaultTools(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(new ReadTool());
  reg.register(new WriteTool());
  reg.register(new EditTool());
  reg.register(new BashTool());
  reg.register(new GlobTool());
  reg.register(new GrepTool());
  reg.register(new TaskCreateTool());
  reg.register(new TaskListTool());
  reg.register(new TaskGetTool());
  reg.register(new TaskUpdateTool());
  return reg;
}
