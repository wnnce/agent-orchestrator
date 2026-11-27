import { ConflictError, NotFoundError, ValidationError } from "../domain/errors.ts";

export class PipelineNotFoundError extends NotFoundError {}

export class PipelineConflictError extends ConflictError {}

export class PipelineValidationError extends ValidationError {}
