import { builtinTools } from "./builtin/index.ts";
import { toJsonSchema, type ToolRegistry } from "./registry.ts";

const BUILTIN_TOOL_NAMES = new Set(builtinTools.map((tool) => tool.name));

/** A project-defined tool as shown to people browsing the project. */
export interface ProjectToolDescription {
  readonly name: string;
  readonly description: string;
  readonly source: "project";
  /** Whether this tool replaces a built-in tool of the same name. */
  readonly overridesBuiltin: boolean;
  readonly inputSchema: Record<string, unknown>;
}

/** Describes the tools the project itself defines, leaving out built-in ones. */
export function describeProjectTools(registry: ToolRegistry): ProjectToolDescription[] {
  return registry
    .all()
    .filter((tool) => tool.source === "project")
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      source: "project" as const,
      overridesBuiltin: BUILTIN_TOOL_NAMES.has(tool.name),
      inputSchema: toJsonSchema(tool.input),
    }));
}
