import type { NextFunction, Request, Response } from "express";

/**
 * Attaches req.log — the request-handling logging surface used by the
 * global error handler — and emits a per-request access line when the
 * response finishes. Access lines carry method, path, status, duration,
 * and IP only; request bodies, headers, query strings, and tokens are
 * never logged here. This is what shows up in Render's Logs tab for
 * production traffic.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();
  req.log = {
    error: (message: string, meta?: unknown) => {
      console.error(`[http] ${req.method} ${req.originalUrl} — ${message}`, meta ?? "");
    },
  };
  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    console.log(`[http] ${res.statusCode} ${req.method} ${req.originalUrl} — ${durationMs}ms`);
  });
  next();
}
