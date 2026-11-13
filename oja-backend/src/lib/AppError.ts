/**
 * Shared, typed error shape used by every module.
 * Thrown errors carry a status code, a stable machine-readable code, a
 * human message, and an optional internal detail that is never sent to
 * clients — only the global error handler may format responses.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly internalDetail?: string;

  constructor(statusCode: number, code: string, message: string, internalDetail?: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.internalDetail = internalDetail;
  }
}
