import { z } from "zod";
import { defineTool } from "../types.ts";

export const createArtifactSchema = z.object({
  kind: z
    .string()
    .describe("Category or kind of the artifact (e.g. report, analysis, diff, summary, export)"),
  content: z.string().describe("Text or serialized content to persist in the artifact"),
  contentType: z
    .string()
    .optional()
    .default("text/plain")
    .describe("MIME content type (default: text/plain, or application/json, text/markdown, etc.)"),
});

export const createArtifactTool = defineTool({
  name: "create_artifact",
  description:
    "Store an artifact file (e.g. analysis report, issue summary, diagnostic logs) in the project Artifact Store.",
  input: createArtifactSchema,
  async run(input, ctx) {
    const artifact = await ctx.artifacts.create({
      kind: input.kind,
      content: input.content,
      contentType: input.contentType,
    });
    return {
      success: true,
      artifactId: artifact.id,
      path: artifact.path,
      sizeBytes: artifact.sizeBytes,
    };
  },
});
