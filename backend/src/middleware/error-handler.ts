import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import mongoose from "mongoose";
import { AppError, Errors } from "@/utils/errors";
import { logger } from "@/utils/logger";

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(Errors.notFound(`Route ${req.method} ${req.path} was not found.`, "ROUTE_NOT_FOUND"));
};

interface BodyParserError extends Error {
  status?: number;
  type?: string;
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return error instanceof Error && typeof (error as BodyParserError).type === "string" && "status" in error;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}

/**
 * Central error handler. Only AppError messages and validation issues reach the
 * client; everything else is logged with the request id and reported generically
 * so internal details (stack traces, driver errors) are never leaked.
 */
export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, _next) => {
  const requestId = req.id;
  const send = (status: number, code: string, message: string, details?: unknown) => {
    if (res.headersSent) return;
    res.status(status).json({ error: { code, message, ...(details !== undefined ? { details } : {}), requestId } });
  };

  if (error instanceof AppError) {
    if (error.status >= 500) logger.error({ err: error, requestId }, "application error");
    return send(error.status, error.code, error.message, error.details);
  }
  if (error instanceof ZodError) {
    const issues = error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    return send(400, "VALIDATION_ERROR", "The request is invalid.", issues);
  }
  if (isBodyParserError(error)) {
    if (error.type === "entity.too.large") return send(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    return send(400, "INVALID_JSON", "The request body could not be parsed.");
  }
  if (error instanceof mongoose.Error.CastError) {
    return send(400, "VALIDATION_ERROR", "A parameter has an invalid format.");
  }
  if (isDuplicateKeyError(error)) {
    return send(409, "CONFLICT", "A record with these unique values already exists.");
  }
  logger.error({ err: error, requestId, path: req.path, method: req.method }, "unhandled error");
  return send(500, "INTERNAL_ERROR", "Something went wrong. Please try again later.");
};
