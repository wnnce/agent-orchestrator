import { z } from "@hono/zod-openapi";
import type { ZodType } from "zod";

export const errorResponseSchema = z
  .object({
    error: z.string().openapi({ description: "Machine-readable error code or message" }),
    message: z.string().optional().openapi({ description: "Optional human-readable error detail" }),
  })
  .openapi("ErrorResponse");

export function jsonContent<T extends ZodType>(schema: T, description: string) {
  return {
    description,
    content: {
      "application/json": { schema },
    },
  } as const;
}

export function jsonBody<T extends ZodType>(schema: T, description?: string, required = true) {
  return {
    required,
    ...(description ? { description } : {}),
    content: {
      "application/json": { schema },
    },
  } as const;
}

export const badRequestResponse = jsonContent(
  errorResponseSchema,
  "Invalid request parameters or payload",
);
export const unauthorizedResponse = jsonContent(
  errorResponseSchema,
  "Missing or invalid Bearer API token",
);
export const forbiddenResponse = jsonContent(
  errorResponseSchema,
  "Operation not permitted on this resource",
);
export const notFoundResponse = jsonContent(
  errorResponseSchema,
  "Requested resource was not found",
);
export const conflictResponse = jsonContent(
  errorResponseSchema,
  "Operation conflicts with current resource state",
);

export const projectIdParamSchema = z.object({
  projectId: z
    .string()
    .min(1)
    .openapi({ param: { name: "projectId", in: "path" } }),
});
