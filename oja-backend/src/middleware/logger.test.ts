import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { requestLogger } from "./logger.js";

function makeRes(statusCode = 200) {
  const listeners: Record<string, (() => void) | undefined> = {};
  const res = {
    statusCode,
    on: vi.fn((event: string, cb: () => void) => {
      listeners[event] = cb;
    }),
  } as unknown as Response;
  return { res, listeners };
}

function makeReq() {
  return { method: "GET", originalUrl: "/api/public/health" } as unknown as Request;
}

describe("requestLogger", () => {
  it("attaches req.log for the error handler", () => {
    const { res } = makeRes();
    const req = makeReq();

    requestLogger(req, res, vi.fn() as unknown as NextFunction);

    expect(typeof req.log?.error).toBe("function");
  });

  it("req.log.error writes a method + path prefixed line via console.error", () => {
    const { res } = makeRes();
    const req = makeReq();
    requestLogger(req, res, vi.fn() as unknown as NextFunction);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    req.log?.error?.("NOT_FOUND: Route GET /nope not found");

    expect(errorSpy).toHaveBeenCalledWith(
      "[http] GET /api/public/health — NOT_FOUND: Route GET /nope not found",
      "",
    );
  });

  it("emits an access line when the response finishes", () => {
    const { res, listeners } = makeRes(201);
    const req = { method: "POST", originalUrl: "/api/public/auth/register" } as unknown as Request;
    requestLogger(req, res, vi.fn() as unknown as NextFunction);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(listeners.finish).toBeTypeOf("function");
    listeners.finish?.();

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[http\] 201 POST \/api\/public\/auth\/register — \d+ms$/),
    );
  });

  it("calls next() to continue the request chain", () => {
    const { res } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    requestLogger(makeReq(), res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
