/**
 * Application error with a stable machine-readable code. Everything that is
 * thrown deliberately by request handlers should be an AppError; anything else
 * is treated as an unexpected failure and reported as INTERNAL_ERROR.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /** Safe to show to API consumers (always true for AppError). */
  readonly expose = true;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  badRequest: (message = "Bad request.", details?: unknown, code = "BAD_REQUEST") =>
    new AppError(400, code, message, details),
  validation: (details: unknown, message = "The request is invalid.") =>
    new AppError(400, "VALIDATION_ERROR", message, details),
  unauthorized: (message = "Authentication is required.", code = "UNAUTHENTICATED") =>
    new AppError(401, code, message),
  forbidden: (message = "You do not have permission to perform this action.", code = "FORBIDDEN") =>
    new AppError(403, code, message),
  notFound: (message = "The requested resource was not found.", code = "NOT_FOUND") =>
    new AppError(404, code, message),
  conflict: (message: string, code = "CONFLICT", details?: unknown) => new AppError(409, code, message, details),
  gone: (message: string, code = "GONE") => new AppError(410, code, message),
  unprocessable: (message: string, code = "UNPROCESSABLE", details?: unknown) =>
    new AppError(422, code, message, details),
  tooManyRequests: (message = "Too many requests. Please slow down.", code = "RATE_LIMITED") =>
    new AppError(429, code, message),
  unavailable: (message: string, code = "SERVICE_UNAVAILABLE") => new AppError(503, code, message),
  notConfigured: (message: string, code = "NOT_CONFIGURED") => new AppError(503, code, message),
};
