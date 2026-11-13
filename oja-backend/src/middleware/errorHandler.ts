import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../lib/AppError.js";

/**
 * The single place that formats error responses.
 * Mounted last in app.ts. Every thrown error — AppError, zod validation
 * failure, or anything unexpected — is normalized here. Modules never
 * format their own error responses.
 */

function humanizeZodMessage(msg: string): string {
  const replacements: [RegExp, string][] = [
    [/^Required$/, "This field is required"],
    [/^Expected (string|number|boolean), received .+$/, "Enter a valid value"],
    [/^Invalid (string|email|url|uuid|email address)$/, "Enter a valid value"],
    [/^String must contain at least (\d+) character/, "Must be at least $1 characters"],
    [/^String must contain at most (\d+) characters/, "Must be at most $1 characters"],
    [/^Number must be (greater than or equal to|less than or equal to) (\d+)/, "Must be $1 $2"],
    [/^Invalid date$/, "Enter a valid date"],
    [/^Invalid UUID$/, "Enter a valid ID"],
  ];
  for (const [re, replacement] of replacements) {
    if (re.test(msg)) return msg.replace(re, replacement);
  }
  return msg;
}

export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof AppError) {
    // Every client-visible error is also logged server-side (method +
    // path are prefixed by req.log) so production failures always show
    // up in Render's Logs tab. internalDetail stays server-side only.
    req.log?.error?.(
      `${err.code}: ${err.message}`,
      err.internalDetail !== undefined ? { detail: err.internalDetail } : undefined,
    );
    res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
    return;
  }

  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({
      field: issue.path.join(".") || "root",
      message: humanizeZodMessage(issue.message),
    }));
    req.log?.error?.("VALIDATION_ERROR: Invalid request payload", { issues: err.issues });
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Please fix the highlighted fields",
        details,
      },
    });
    return;
  }

  // body-parser rejects malformed JSON with a SyntaxError carrying
  // status 400 — a client error, never a 500.
  if (err instanceof SyntaxError && "status" in err && err.status === 400) {
    req.log?.error?.("VALIDATION_ERROR: Malformed JSON body");
    res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "Malformed JSON body" },
    });
    return;
  }

  req.log?.error?.("Unhandled error", { error: err instanceof Error ? err.message : String(err) });
  res.status(500).json({
    error: { code: "INTERNAL_SERVER_ERROR", message: "Internal server error" },
  });
}
