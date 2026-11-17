/**
 * Shared, typed error shape used by every module.
 * Thrown errors carry a status code, a stable machine-readable code, a
 * human message, and an optional internal detail that is never sent to
 * clients — only the global error handler may format responses.
 */
export class AppError extends Error {
    statusCode;
    code;
    internalDetail;
    constructor(statusCode, code, message, internalDetail) {
        super(message);
        this.name = "AppError";
        this.statusCode = statusCode;
        this.code = code;
        this.internalDetail = internalDetail;
    }
}
//# sourceMappingURL=AppError.js.map