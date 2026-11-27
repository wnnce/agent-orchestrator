import type { z } from "zod";
import { toJsonSchema } from "../../src/tools/registry.ts";
import type { SessionTools } from "../../src/tools/types.ts";

export interface FakeTool {
  readonly name: string;
  readonly description?: string;
  readonly input: z.ZodObject;
  run(args: unknown): unknown;
}

/** Session tools for runtime adapter tests: records each call and returns the tool's result. */
export function fakeSessionTools(tools: readonly FakeTool[]): {
  tools: SessionTools;
  calls: Array<{ name: string; args: unknown }>;
} {
  const calls: Array<{ name: string; args: unknown }> = [];
  return {
    calls,
    tools: {
      specs: tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? tool.name,
        input: tool.input,
        inputSchema: toJsonSchema(tool.input),
      })),
      async call(name, args) {
        calls.push({ name, args });
        const tool = tools.find((candidate) => candidate.name === name);
        if (!tool) return { ok: false, text: '{"error":"unknown"}', error: "unknown" };
        const data = await tool.run(args);
        return { ok: true, text: JSON.stringify(data), data };
      },
    },
  };
}
