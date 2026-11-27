import { describe, expect, test } from "bun:test";
import {
  ConflictError,
  ErrorCode,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from "../src/domain/errors.ts";
import { createOpenAPIApp } from "../src/gateway/openapi.ts";
import {
  PipelineConflictError,
  PipelineNotFoundError,
  PipelineValidationError,
} from "../src/pipeline/errors.ts";

describe("Gateway global onError & AppError HTTP status mapping", () => {
  const cases = [
    {
      name: "ValidationError -> 400",
      err: () => new ValidationError("bad input"),
      status: 400,
      code: ErrorCode.VALIDATION_ERROR,
    },
    {
      name: "UnauthorizedError -> 401",
      err: () => new UnauthorizedError("missing token"),
      status: 401,
      code: ErrorCode.UNAUTHORIZED,
    },
    {
      name: "ForbiddenError -> 403",
      err: () => new ForbiddenError("read-only", ErrorCode.TASK_SESSION_READ_ONLY),
      status: 403,
      code: ErrorCode.TASK_SESSION_READ_ONLY,
    },
    {
      name: "NotFoundError -> 404",
      err: () => new NotFoundError("Session ses_1 not found", ErrorCode.SESSION_NOT_FOUND),
      status: 404,
      code: ErrorCode.SESSION_NOT_FOUND,
    },
    {
      name: "ConflictError -> 409",
      err: () => new ConflictError("session archived", ErrorCode.SESSION_ARCHIVED),
      status: 409,
      code: ErrorCode.SESSION_ARCHIVED,
    },
    {
      name: "TooManyRequestsError -> 429",
      err: () => new TooManyRequestsError("queue full", ErrorCode.QUEUE_FULL),
      status: 429,
      code: ErrorCode.QUEUE_FULL,
    },
    {
      name: "ServiceUnavailableError -> 503",
      err: () => new ServiceUnavailableError("runtime stopping"),
      status: 503,
      code: ErrorCode.SERVICE_UNAVAILABLE,
    },
    {
      name: "PipelineNotFoundError -> 404",
      err: () => new PipelineNotFoundError("run missing"),
      status: 404,
      code: ErrorCode.NOT_FOUND,
    },
    {
      name: "PipelineConflictError -> 409",
      err: () => new PipelineConflictError("already completed"),
      status: 409,
      code: ErrorCode.CONFLICT,
    },
    {
      name: "PipelineValidationError -> 400",
      err: () => new PipelineValidationError("invalid node"),
      status: 400,
      code: ErrorCode.VALIDATION_ERROR,
    },
    {
      name: "Unexpected Error -> 500",
      err: () => new Error("database connection dropped"),
      status: 500,
      code: ErrorCode.INTERNAL_ERROR,
    },
  ] as const;

  for (const tc of cases) {
    test(tc.name, async () => {
      const app = createOpenAPIApp();
      app.get("/boom", () => {
        throw tc.err();
      });

      const res = await app.request("/boom");
      expect(res.status).toBe(tc.status);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe(tc.code);
      expect(body.message.length).toBeGreaterThan(0);
    });
  }
});
