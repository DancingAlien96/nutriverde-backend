import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { env } from "../config/env.js";

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: "Not Found" });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "ValidationError",
      issues: err.flatten().fieldErrors,
    });
  }

  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }

  console.error("Unhandled error:", err);
  return res.status(500).json({
    error: "InternalServerError",
    ...(env.NODE_ENV === "development" && err instanceof Error
      ? { message: err.message, stack: err.stack }
      : {}),
  });
}
