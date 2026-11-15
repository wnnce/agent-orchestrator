import { z } from "zod";
import type { ActionContext, ActionDefinition } from "../types.ts";

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

export type CreateArtifactActionParams = z.infer<typeof createArtifactSchema>;

export interface CreateArtifactActionResult {
  readonly success: boolean;
  readonly artifactId: string;
  readonly path: string;
  readonly sizeBytes: number;
}

export const createArtifactAction: ActionDefinition<
  CreateArtifactActionParams,
  CreateArtifactActionResult
> = {
  name: "create_artifact",
  description:
    "Store an artifact file (e.g. analysis report, issue summary, diagnostic logs) in the project Artifact Store.",
  parameters: createArtifactSchema,
  scopes: ["all"],
  async handler(
    params: CreateArtifactActionParams,
    context: ActionContext,
  ): Promise<CreateArtifactActionResult> {
    const artifact = await context.createArtifact({
      kind: params.kind,
      content: params.content,
      contentType: params.contentType,
    });
    return {
      success: true,
      artifactId: artifact.id,
      path: artifact.path,
      sizeBytes: artifact.sizeBytes,
    };
  },
};
