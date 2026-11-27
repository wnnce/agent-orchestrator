import { OpenAPIHono } from "@hono/zod-openapi";

/**
 * Creates an `OpenAPIHono` instance with a consistent 400 validation error payload
 * matching the gateway's `{ error, message }` contract.
 */
export function createOpenAPIApp(): OpenAPIHono {
  return new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        const firstIssue = result.error.issues[0];
        const pathPrefix =
          firstIssue && firstIssue.path.length > 0 ? `${firstIssue.path.join(".")}: ` : "";
        const message = firstIssue
          ? `${pathPrefix}${firstIssue.message}`
          : "Invalid request parameters or payload";
        return c.json({ error: "validation_error", message }, 400);
      }
    },
  });
}
