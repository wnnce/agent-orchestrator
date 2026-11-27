import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { AppError, ErrorCode } from "../domain/errors.ts";
import type { Logger } from "../observability/logger.ts";

export interface CreateOpenAPIAppOptions {
  readonly logger?: Logger | undefined;
}

/**
 * Maps thrown `AppError` / `HTTPException` / unexpected errors into standard HTTP status responses
 * with the gateway's `{ error, message }` contract.
 */
export function handleGatewayError(err: Error, c: Context, logger?: Logger): Response {
  if (err instanceof AppError) {
    if (err.status >= 500) {
      logger?.error("gateway request failed", {
        method: c.req.method,
        path: c.req.path,
        status: err.status,
        code: err.code,
        error: err,
      });
    } else {
      logger?.warn("gateway request rejected", {
        method: c.req.method,
        path: c.req.path,
        status: err.status,
        code: err.code,
        message: err.message,
      });
    }
    return c.json({ error: err.code, message: err.message }, err.status);
  }

  if (err instanceof HTTPException) {
    const status = err.status;
    const code =
      status === 400
        ? ErrorCode.VALIDATION_ERROR
        : status === 401
          ? ErrorCode.UNAUTHORIZED
          : status === 403
            ? ErrorCode.FORBIDDEN
            : status === 404
              ? ErrorCode.NOT_FOUND
              : "http_error";
    return c.json({ error: code, message: err.message }, status);
  }

  logger?.error("gateway unhandled error", {
    method: c.req.method,
    path: c.req.path,
    error: err,
  });
  return c.json(
    {
      error: ErrorCode.INTERNAL_ERROR,
      message: err instanceof Error ? err.message : String(err),
    },
    500,
  );
}

/**
 * Creates an `OpenAPIHono` instance with unified Zod validation formatting and global `onError`
 * handling for `AppError` and unexpected exceptions.
 */
export function createOpenAPIApp(options?: CreateOpenAPIAppOptions): OpenAPIHono {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        const firstIssue = result.error.issues[0];
        const pathPrefix =
          firstIssue && firstIssue.path.length > 0 ? `${firstIssue.path.join(".")}: ` : "";
        const message = firstIssue
          ? `${pathPrefix}${firstIssue.message}`
          : "Invalid request parameters or payload";
        return c.json({ error: ErrorCode.VALIDATION_ERROR, message }, 400);
      }
    },
  });

  app.onError((err, c) => handleGatewayError(err, c, options?.logger));
  return app;
}
