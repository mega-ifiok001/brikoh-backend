import { describe, expect, it } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { ZodError, z } from "zod";
import { AppError } from "../lib/AppError.js";
import { errorHandler } from "../middleware/errorHandler.js";

function runHandler(err: unknown): { status: number; body: unknown } {
  const res = {
    statusCode: 200,
    headersSent: false,
    body: undefined as unknown,
    status(this: { statusCode: number }, code: number) {
      this.statusCode = code;
      return this;
    },
    json(this: { body: unknown }, body: unknown) {
      this.body = body;
      return this;
    },
  };

  errorHandler(err, {} as Request, res as unknown as Response, (() => {}) as NextFunction);
  return { status: res.statusCode, body: res.body };
}

describe("errorHandler (unit)", () => {
  it("formats an AppError with its status code and code/message shape", () => {
    const { status, body } = runHandler(new AppError(404, "NOT_FOUND", "Route not found"));

    expect(status).toBe(404);
    expect(body).toEqual({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });

  it("never leaks the internal detail of an AppError", () => {
    const { body } = runHandler(
      new AppError(500, "DB_ERROR", "Something failed", "connection pool exhausted"),
    );

    expect(JSON.stringify(body)).not.toContain("connection pool exhausted");
  });

  it("formats a zod validation error as a 400", () => {
    const schema = z.object({ name: z.string() });
    const { status, body } = runHandler(new ZodError(schema.safeParse({}).error?.issues ?? []));

    expect(status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: expect.any(String) as string,
        details: expect.any(Array) as unknown[],
      },
    });
  });

  it("maps an unknown error to a generic 500 without leaking details", () => {
    const { status, body } = runHandler(new Error("database credentials leaked"));

    expect(status).toBe(500);
    expect(body).toEqual({
      error: { code: "INTERNAL_SERVER_ERROR", message: "Internal server error" },
    });
  });

  it("maps a non-Error throw (edge case) to a generic 500", () => {
    const { status } = runHandler("boom");

    expect(status).toBe(500);
  });

  it("delegates to next when headers are already sent", () => {
    const res = { headersSent: true } as unknown as Response;
    const req = {} as Request;
    let forwarded: unknown;
    const next = ((e: unknown) => {
      forwarded = e;
    }) as NextFunction;

    const original = new AppError(500, "X", "y");
    errorHandler(original, req, res, next);

    expect(forwarded).toBe(original);
  });
});
