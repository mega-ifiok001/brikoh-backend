import type { CheckoutInitiationInput } from "../lib/paymentProvider.js";

declare global {
  namespace Express {
    interface Request {
      /** Authenticated account, set by the authenticate middleware. */
      account?: {
        accountId: string;
        storeId?: string;
        role: string;
        staffMemberId?: string;
      };
      /**
       * Resolved tenant, set by the resolveTenant middleware. The
       * authority for tenant identity — always derived from the
       * database via req.account, never from client-supplied input or
       * token claims.
       */
      tenant?: {
        storeId: string;
        role: string;
        staffMemberId?: string;
        permissions: string[];
      };
      /**
       * Authenticated platform staff, set by the requireAdminAuth
       * middleware (admin group). Separate from req.account: admin tokens
       * are minted with their own secret and never mix with merchant
       * tokens. Permissions are the CURRENT RolePermission bindings from
       * the database.
       */
      admin?: {
        adminUserId: string;
        email: string;
        roleName: string;
        permissions: string[];
      };
      /**
       * Public store, set by the resolvePublicStore middleware on
       * subdomain-addressed public routes (e.g. checkout). The store is
       * looked up by its subdomain — the tenant's public address.
       */
      publicStore?: {
        storeId: string;
        name: string;
        subdomain: string | null;
        currency: CheckoutInitiationInput["currency"];
      };
      /** Optional request logger, attached by the request-logging middleware. */
      log?: {
        error: (message: string, meta?: unknown) => void;
      };
      /**
       * The EXACT request bytes as received, captured by the global
       * express.json verify hook. Webhook signature verification
       * (e.g. Paystack HMAC) runs over these bytes — never over a
       * re-serialized body.
       */
      rawBody?: Buffer;
    }
  }
}

export {};
