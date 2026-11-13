import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { z, ZodError } from "zod";
import { AppError } from "../lib/AppError.js";
import { errorHandler } from "./errorHandler.js";

function makeRes() {
  const status = vi.fn();
  const json = vi.fn();
  const res = {
    headersSent: false,
    status,
    json,
  } as unknown as Response;
  status.mockReturnValue(res);
  return { res, status, json };
}

function makeReq(log?: { error: (message: string, meta?: unknown) => void }): Request {
  return { log } as unknown as Request;
}

function bodyOf(json: ReturnType<typeof vi.fn>): { error: Record<string, unknown> } {
  return json.mock.calls[0]?.[0] as { error: Record<string, unknown> };
}

describe("errorHandler — response hygiene (no internals, no stack traces)", () => {
  it("never sends internalDetail from an AppError, but logs it server-side", () => {
    const { res, json } = makeRes();
    const log = { error: vi.fn() };
    const err = new AppError(
      500,
      "PAYSTACK_UPSTREAM",
      "Upstream unavailable",
      "tls: handshake timeout",
    );

    errorHandler(err, makeReq(log), res, vi.fn() as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(bodyOf(json).error).toEqual({
      code: "PAYSTACK_UPSTREAM",
      message: "Upstream unavailable",
    });
    expect(JSON.stringify(bodyOf(json))).not.toContain("tls");
    expect(JSON.stringify(bodyOf(json))).not.toContain("handshake");
    expect(log.error).toHaveBeenCalledWith("PAYSTACK_UPSTREAM: Upstream unavailable", {
      detail: "tls: handshake timeout",
    });
  });

  it("logs every AppError server-side, even without internal detail", () => {
    const { res } = makeRes();
    const log = { error: vi.fn() };
    const err = new AppError(404, "STORE_NOT_FOUND", "No store exists at that subdomain");

    errorHandler(err, makeReq(log), res, vi.fn() as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(log.error).toHaveBeenCalledWith(
      "STORE_NOT_FOUND: No store exists at that subdomain",
      undefined,
    );
  });

  it("never leaks the message or stack trace of an unexpected error", () => {
    const { res, json } = makeRes();
    const err = new Error("ECONNREFUSED postgres at 10.0.0.5:5432 password=supersecret");
    err.stack = `Error: ${err.message}\n    at Query.run (pg/lib/query.js:123:45)`;

    errorHandler(err, makeReq(), res, vi.fn() as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = bodyOf(json).error;
    expect(body.code).toBe("INTERNAL_SERVER_ERROR");
    expect(body.message).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(body)).not.toContain("supersecret");
    expect(JSON.stringify(body)).not.toContain("query.js");
  });

  it("maps a ZodError to 400 with field-level details and no stack, and logs the issues server-side", () => {
    const { res, json } = makeRes();
    const log = { error: vi.fn() };
    const schema = z.object({ email: z.string().email() });
    const outcome = schema.safeParse({ email: "not-an-email" });
    if (outcome.success) {
      throw new Error("fixture should fail validation");
    }

    errorHandler(
      new ZodError(outcome.error.issues),
      makeReq(log),
      res,
      vi.fn() as unknown as NextFunction,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    const body = bodyOf(json).error;
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.message).toBe("Please fix the highlighted fields");
    expect(body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "email", message: "Enter a valid value" }),
      ]),
    );
    expect(JSON.stringify(body)).not.toContain("at ");
    expect(log.error).toHaveBeenCalledWith("VALIDATION_ERROR: Invalid request payload", {
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ["email"], message: "Invalid email address" }),
      ]),
    });
  });

  it("maps malformed JSON (SyntaxError with status 400) to a clean 400 and logs it", () => {
    const { res, json } = makeRes();
    const log = { error: vi.fn() };
    const err = new SyntaxError("Unexpected token } in JSON");
    Object.assign(err, { status: 400 });

    errorHandler(err, makeReq(log), res, vi.fn() as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(bodyOf(json).error.code).toBe("VALIDATION_ERROR");
    expect(log.error).toHaveBeenCalledWith("VALIDATION_ERROR: Malformed JSON body");
  });

  it("forwards to next() when headers were already sent", () => {
    const res = { headersSent: true, status: vi.fn(), json: vi.fn() } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    errorHandler(new AppError(500, "X", "boom"), makeReq(), res, next);

    expect(next).toHaveBeenCalled();
  });
});
