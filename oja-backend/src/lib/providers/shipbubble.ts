import { AppError } from "../AppError.js";
import { env } from "../../config/env.js";

const API_BASE = "https://api.shipbubble.com/v1";

export class ShipbubbleApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ShipbubbleApiError";
  }
}

export interface ShipbubbleEnvelope<T> {
  status: "success" | "failed";
  message?: string;
  data?: T;
  errors?: string[];
}

/** Server-only Shipbubble REST client. It never logs or returns the API key. */
export class ShipbubbleClient {
  constructor(
    private readonly apiKey = env.SHIPBUBBLE_API_KEY,
    private readonly mode = env.SHIPBUBBLE_MODE,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  assertConfigured(): void {
    if (this.apiKey === undefined) {
      throw new AppError(503, "SHIPBUBBLE_NOT_CONFIGURED", "Shipbubble is not configured on this server");
    }
    const expectedPrefix = this.mode === "sandbox" ? "sb_sandbox_" : "sb_prod_";
    if (!this.apiKey.startsWith(expectedPrefix)) {
      throw new AppError(503, "SHIPBUBBLE_KEY_MODE_MISMATCH", "Shipbubble API key does not match the configured mode");
    }
    if (this.mode === "live" && !env.SHIPBUBBLE_ENABLE_LIVE) {
      throw new AppError(503, "SHIPBUBBLE_LIVE_DISABLED", "Live Shipbubble requests are disabled until billing and operations are approved");
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    this.assertConfigured();

    let response: Response;
    try {
      response = await this.fetcher(`${API_BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...init.headers,
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new AppError(502, "SHIPBUBBLE_UNAVAILABLE", "Shipbubble could not be reached; try again shortly");
    }

    const body = (await response.json().catch(() => null)) as ShipbubbleEnvelope<T> | null;
    if (!response.ok || body?.status !== "success" || body.data === undefined) {
      // Provider error text is intentionally not returned to the client; it
      // may contain account details. The HTTP status is retained for logs.
      throw new ShipbubbleApiError("Shipbubble request failed", response.status);
    }
    return body.data;
  }

  validateAddress(input: {
    name: string;
    email: string;
    phone: string;
    address: string;
  }): Promise<{ address_code: number; formatted_address?: string }> {
    return this.request("/shipping/address/validate", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  fetchRates(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("/shipping/fetch_rates", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  createLabel(input: {
    request_token: string;
    service_code: string;
    courier_id: string | number;
  }): Promise<Record<string, unknown>> {
    return this.request("/shipping/labels", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  cancelLabel(orderId: string): Promise<Record<string, unknown>> {
    return this.request(`/shipping/labels/cancel/${encodeURIComponent(orderId)}`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }
}

export const shipbubbleClient = new ShipbubbleClient();
