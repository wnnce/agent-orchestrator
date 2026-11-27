import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SessionTools } from "../../tools/types.ts";

/** Offers the session's orchestrator tools to Pi as native tool definitions. */
export function piToolsFor(tools: SessionTools): ToolDefinition[] {
  return tools.specs.map((spec) => ({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    // Pi accepts plain JSON Schema here; its type expects a TypeBox schema object.
    parameters: spec.inputSchema as unknown as ToolDefinition["parameters"],
    execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
      const result = await tools.call(spec.name, params, { signal });
      return {
        content: [{ type: "text" as const, text: result.text }],
        isError: !result.ok,
        details: result.ok ? result.data : { error: result.error },
      };
    },
  }));
}
