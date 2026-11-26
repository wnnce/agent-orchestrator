export class PipelineNotFoundError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "PipelineNotFoundError";
  }
}

export class PipelineConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "PipelineConflictError";
  }
}

export class PipelineValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "PipelineValidationError";
  }
}
