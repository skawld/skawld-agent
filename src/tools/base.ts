/**
 * Tool interface scaffolding.
 *
 * Only the `ToolSchema` portion is defined here so the providers module can compile
 * standalone. The full `Tool` runtime interface ships in module 02.
 */

export type JSONSchema = Record<string, unknown>;

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, JSONSchema>;
    required?: string[];
  };
}
