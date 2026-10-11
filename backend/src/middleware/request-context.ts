import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

const VALID_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Assigns a correlation id to every request and echoes it back to the client. */
export const requestContext: RequestHandler = (req, res, next) => {
  const inbound = req.header("x-request-id");
  req.id = inbound && VALID_ID.test(inbound) ? inbound : randomUUID();
  res.setHeader("x-request-id", req.id);
  next();
};
