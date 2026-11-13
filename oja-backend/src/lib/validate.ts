import type { z } from "zod";
import { AppError } from "./AppError.js";

/**
 * Validates external input against a zod schema and throws the uniform
 * 400 VALIDATION_ERROR when it does not match. The wire message is the
 * first issue's message — plain language written for the client (e.g.
 * "Store name can only contain letters and spaces"). The full issue
 * list is attached as internal detail, never sent to clients.
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

export function validateOrThrow<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    const firstIssue = parsed.error.issues[0];
    const message =
      firstIssue === undefined ? "Invalid input" : humanizeZodMessage(firstIssue.message);
    throw new AppError(400, "VALIDATION_ERROR", message, detail);
  }
  return parsed.data;
}
