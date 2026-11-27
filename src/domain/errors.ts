export type HttpErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503;

export const ErrorCode = {
  VALIDATION_ERROR: "validation_error",
  UNAUTHORIZED: "unauthorized",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  TOO_MANY_REQUESTS: "too_many_requests",
  INTERNAL_ERROR: "internal_error",
  SERVICE_UNAVAILABLE: "service_unavailable",

  // Domain-specific machine-readable codes
  PROJECT_NOT_FOUND: "project_not_found",
  SESSION_NOT_FOUND: "session_not_found",
  TASK_NOT_FOUND: "task_not_found",
  ARTIFACT_NOT_FOUND: "artifact_not_found",
  RUNTIME_NOT_FOUND: "runtime_not_found",
  TASK_SESSION_READ_ONLY: "task_session_read_only",
  SESSION_ARCHIVED: "session_archived",
  SESSION_CLOSING: "session_closing",
  QUEUE_FULL: "queue_full",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Base application error carrying a standard RFC HTTP status code and a machine-readable `code`.
 * Caught centrally by the gateway's global `onError` handler.
 */
export class AppError extends Error {
  constructor(
    readonly status: HttpErrorStatus,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, code: string = ErrorCode.VALIDATION_ERROR, options?: ErrorOptions) {
    super(400, code, message, options);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string, code: string = ErrorCode.UNAUTHORIZED, options?: ErrorOptions) {
    super(401, code, message, options);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string, code: string = ErrorCode.FORBIDDEN, options?: ErrorOptions) {
    super(403, code, message, options);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, code: string = ErrorCode.NOT_FOUND, options?: ErrorOptions) {
    super(404, code, message, options);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code: string = ErrorCode.CONFLICT, options?: ErrorOptions) {
    super(409, code, message, options);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message: string, code: string = ErrorCode.TOO_MANY_REQUESTS, options?: ErrorOptions) {
    super(429, code, message, options);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(
    message: string,
    code: string = ErrorCode.SERVICE_UNAVAILABLE,
    options?: ErrorOptions,
  ) {
    super(503, code, message, options);
  }
}
