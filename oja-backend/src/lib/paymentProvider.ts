/**
 * ============================================================
 * PAYMENT PROVIDER CONTRACT
 * ============================================================
 *
 * Every payment gateway (Paystack today; OPay, Monnify, Flutterwave…
 * later) plugs in as a single file behind this interface — the orders
 * service and webhooks service depend on `PaymentProvider`, never on a
 * provider's internals. Adding a provider means:
 *
 *   1. a new file in src/lib/providers/<name>.ts that satisfies
 *      `PaymentProvider` (with its own unit tests), and
 *   2. an entry in the provider allowlist (src/modules/payments/schemas)
 *      so merchants can configure it.
 *
 * No orders/webhooks code changes.
 *
 * Amounts are DECIMAL STRINGS ("1234.56") at the boundary — never
 * floats. Each provider converts to its minor unit (kobo, etc.) with
 * integer string math. Money stays Decimal(10,2) in the database.
 * ============================================================
 */

export interface CheckoutInitiationInput {
  /** Decimal string amount, e.g. "1234.56". Converted to minor units by the provider. */
  amount: string;
  /**
   * ISO-4217 currency. Supported values (all Paystack-compatible,
   * 2-decimal minor units): NGN, USD, GHS, KES, ZAR.
   */
  currency: "NGN" | "USD" | "GHS" | "KES" | "ZAR";
  /** Buyer email — required by every provider we target for receipting. */
  email: string;
  /** Caller-generated unique reference; echoed back by the provider. */
  reference: string;
  /** Opaque data echoed to the provider (orderId, storeId). */
  metadata: Record<string, string>;
}

export interface CheckoutInitiation {
  /** The provider's echoed reference — same value the caller generated. */
  reference: string;
  /** Hosted checkout URL to redirect the buyer to. */
  authorizationUrl: string;
  /** Provider access code (Paystack); undefined for providers without one. */
  accessCode?: string;
}

/**
 * Settlement-relevant state of a transaction, from the provider's
 * transaction API. Amounts stay DECIMAL STRINGS; paidAt is UTC ISO-8601
 * (whatever the provider reports, normalized by the provider).
 */
export interface TransactionStatus {
  status: "success" | "failed" | "pending" | "unknown";
  paidAt: string | null;
  amount: string | null;
  currency: string | null;
}

/** Bank-account resolution result (POST /bank/resolve on Paystack). */
export interface ResolvedBankAccount {
  /** The account name as known by the provider — the source of truth. */
  accountName: string;
}

/** A created transfer recipient (POST /transferrecipient on Paystack). */
export interface TransferRecipient {
  /** The provider's stable recipient code, stored on BankAccount. */
  recipientCode: string;
}

/** Transfer initiation result (POST /transfer on Paystack). */
export interface TransferInitiation {
  /** The provider's transfer code — the stable reference for webhooks. */
  transferCode: string;
}

/**
 * Transfer verification state (GET /transfer/verify/:reference). fee is
 * the provider's fee as a DECIMAL STRING when reported, else null.
 */
export interface TransferStatus {
  status: "success" | "failed" | "pending" | "unknown";
  fee: string | null;
}

/** Builds a provider from stored (decrypted) merchant credentials. */
export type ProviderFactory = (credentials: {
  publicKey: string;
  secretKey: string;
}) => PaymentProvider;

/**
 * A recurring-billing plan created on the platform's Paystack account.
 */
export interface SubscriptionPlanDefinition {
  name: string;
  /** Decimal-string monthly amount, converted to kobo by the provider. */
  amount: string;
  /** Paystack interval — always "monthly" for Brikoh tiers. */
  interval: "monthly";
}

export interface SubscriptionPlanCreated {
  /** Paystack plan code (PLN_...). */
  planCode: string;
}

/**
 * Initiate a one-time payment that ALSO subscribes the payer to a plan
 * (POST /transaction/initialize with `plan`). The first payment covers the
 * plan amount; Paystack then auto-bills monthly.
 */
export interface SubscriptionCheckoutInitiationInput {
  planCode: string;
  email: string;
  /** Caller-generated unique reference (sub_...). */
  reference: string;
  metadata: Record<string, string>;
}

export interface SubscriptionCheckoutInitiation {
  reference: string;
  authorizationUrl: string;
  accessCode?: string;
}

/** Create a recurring subscription directly (used after an upgrade swap). */
export interface CreateRecurringSubscriptionInput {
  /** Paystack customer email (or code) — the store owner's email. */
  customer: string;
  planCode: string;
  /** ISO date for the FIRST debit — set to currentPeriodEnd to avoid a
   * same-cycle immediate charge on a plan swap. */
  startDate?: string;
}

export interface RecurringSubscriptionCreated {
  subscriptionCode: string;
  emailToken: string;
}

export interface DisableRecurringSubscriptionInput {
  subscriptionCode: string;
  emailToken: string;
}

export interface PaymentProvider {
  /** Stable provider key, e.g. "paystack" — matches the credentials allowlist. */
  readonly id: string;
  /** Opens a hosted checkout session. Never throws on HTTP-status; throws PaymentProviderError. */
  initiateCheckout(input: CheckoutInitiationInput): Promise<CheckoutInitiation>;
  /**
   * Authenticates a webhook callback. The provider computes a keyed
   * signature over the RAW request body; `rawBody` must be the exact
   * bytes received (stringified JSON, unparsed). Constant-time compare.
   */
  verifyWebhookSignature(rawBody: string | Buffer, signature: string): Promise<boolean>;
  /**
   * Returns the current state of a transaction by its reference, for the
   * settlement-status endpoint. Throws PaymentProviderError when the
   * provider cannot be reached or rejects the call — callers translate
   * that into an explicit "unavailable" view.
   */
  getTransactionStatus(reference: string): Promise<TransactionStatus>;
  /**
   * Resolves a bank account (bank code + account number) to its owner
   * name — the create-bank-account typo guard. Throws PaymentProviderError
   * on failure.
   */
  resolveBankAccount(bankCode: string, accountNumber: string): Promise<ResolvedBankAccount>;
  /**
   * Creates a transfer recipient on the provider, so withdrawals can be
   * paid into a stored bank account without ever re-sending the full
   * account number. Throws PaymentProviderError on failure.
   */
  createTransferRecipient(input: {
    name: string;
    accountNumber: string;
    bankCode: string;
  }): Promise<TransferRecipient>;
  /**
   * Initiates a withdrawal transfer to a recipient. `amount` is a
   * DECIMAL STRING converted to minor units by the provider; `reference`
   * is the backend-generated payout reference (wd_…). Throws
   * PaymentProviderError when the provider rejects the transfer.
   */
  initiateTransfer(input: {
    recipientCode: string;
    amount: string;
    reference: string;
  }): Promise<TransferInitiation>;
  /**
   * Returns the current state of a transfer by its reference, for
   * payout verification. Throws PaymentProviderError on failure.
   */
  verifyTransfer(reference: string): Promise<TransferStatus>;

  // ---- Platform-side recurring billing (optional; only the platform's
  // Paystack provider implements these). The merchant storefront provider
  // may leave them undefined — subscription flows are the platform's own. ----

  /** Creates a recurring-billing plan on the platform account. */
  createPlan?(input: SubscriptionPlanDefinition): Promise<SubscriptionPlanCreated>;
  /** Opens a checkout that bills the plan amount and subscribes the payer. */
  initializeSubscription?(
    input: SubscriptionCheckoutInitiationInput,
  ): Promise<SubscriptionCheckoutInitiation>;
  /** Directly creates a recurring subscription (post-upgrade swap). */
  createRecurringSubscription?(
    input: CreateRecurringSubscriptionInput,
  ): Promise<RecurringSubscriptionCreated>;
  /** Disables a recurring subscription so it stops billing. */
  disableRecurringSubscription?(input: DisableRecurringSubscriptionInput): Promise<void>;
}

/**
 * Provider-side failure. `status` is the provider's HTTP status when one
 * was observed (0 for network-level failure). Messages never contain
 * credentials or secrets.
 */
export class PaymentProviderError extends Error {
  public readonly status: number;
  public readonly providerCode?: string;

  constructor(status: number, message: string, providerCode?: string) {
    super(message);
    this.name = "PaymentProviderError";
    this.status = status;
    this.providerCode = providerCode;
  }
}
