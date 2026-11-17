import { randomUUID } from "node:crypto";
import { Prisma } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { PaymentProviderError } from "../../lib/paymentProvider.js";
import { createPaystackProvider } from "../../lib/providers/paystack.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { decryptSecret } from "../../lib/secrets.js";
import { logStoreActivity } from "../activity/service.js";
import { createBankAccountSchema, createWithdrawalSchema, listWithdrawalsParamsSchema, validateOrThrow, } from "./schemas.js";
/**
 * ============================================================
 * STORE WALLET — merchant payouts
 * ============================================================
 * The wallet is the tenant's money ledger: CREDITs from paid CARD/online
 * orders (the charge.success webhook), DEBITs from withdrawals.
 *
 * MONEY DISCIPLINE:
 *  - StoreWallet.balance is the live authority. The row lock makes
 *    concurrent debits safe: withdrawals use a conditional decrement
 *    (balance >= amount), so two parallel requests can never overdraw.
 *  - WalletEntry is the append-only audit trail (DB trigger rejects
 *    UPDATE/DELETE) and every row carries balanceAfter — the balance
 *    exactly after that movement.
 *  - Withdrawals debit AT REQUEST TIME: the debit and the Payout row
 *    commit in ONE transaction, so the payout can never exist without
 *    its debit (and vice versa). transfer.success keeps the money
 *    debited; transfer.failed credits it back (WITHDRAWAL_REVERSAL).
 *
 * Provider calls (resolve/createRecipient/initiateTransfer) happen
 * OUTSIDE the wallet transaction: no HTTP call ever holds a wallet
 * row lock.
 * ============================================================
 */
const MIN_WITHDRAWAL = new Prisma.Decimal("100.00");
const WALLET_CURRENCY = "NGN";
const defaultProviderFactory = ({ publicKey, secretKey }) => createPaystackProvider({ publicKey, secretKey });
/** "0123456789" -> "0123••••6789" — the only form of the number we store. */
export function maskAccountNumber(accountNumber) {
    return `${accountNumber.slice(0, 4)}••••${accountNumber.slice(-4)}`;
}
/** Fresh payout reference: wd_ + 128-bit hex. */
export function generateWithdrawalReference() {
    return `wd_${randomUUID().replace(/-/g, "")}`;
}
/** Decrypts the store's Paystack secret and builds the provider. */
async function providerForStore(storeId, providerFactory) {
    const credential = await getPrismaClient().paymentCredential.findUnique({
        where: { storeId_provider: { storeId, provider: "paystack" } },
    });
    if (credential === null) {
        throw new AppError(409, "PAYMENT_NOT_CONFIGURED", "This store has no payment credentials configured");
    }
    return providerFactory({
        publicKey: credential.publicKey,
        secretKey: decryptSecret(credential.secretKeyEncrypted),
    });
}
/**
 * Ensures the store's wallet row exists (create-if-missing) — the row
 * lock is what serializes debits. Uses an atomic upsert, NOT a
 * create-and-catch: PostgreSQL aborts a transaction on the first
 * constraint error, so a swallowed P2002 would poison every later
 * statement in the caller's transaction.
 */
async function ensureWallet(tx, storeId) {
    await tx.storeWallet.upsert({
        where: { storeId },
        update: {},
        create: { storeId },
    });
}
/**
 * Credits the wallet inside the CALLER's transaction: increments the
 * balance (the returned row carries the post-increment balance, so
 * balanceAfter is always exact) and appends the ledger entry.
 */
export async function creditWallet(tx, storeId, input) {
    await ensureWallet(tx, storeId);
    const updated = await tx.storeWallet.update({
        where: { storeId },
        data: { balance: { increment: input.amount } },
    });
    await tx.walletEntry.create({
        data: {
            storeId,
            type: "CREDIT",
            source: input.source,
            amount: input.amount,
            balanceAfter: updated.balance,
            orderId: input.orderId ?? null,
            payoutId: input.payoutId ?? null,
        },
    });
}
function toBankAccountView(row) {
    return {
        id: row.id,
        accountName: row.accountName,
        bankName: row.bankName,
        bankCode: row.bankCode ?? "",
        maskedAccountNumber: row.maskedAccountNumber ?? "",
        isDefault: row.isDefault,
        createdAt: row.createdAt,
    };
}
/**
 * GET the wallet overview: live balance plus the sums the merchant
 * needs and the 25 most recent ledger entries.
 */
export async function getWalletOverview(storeId) {
    const prisma = getPrismaClient();
    const wallet = await prisma.storeWallet.findUnique({ where: { storeId } });
    const [pendingAgg, withdrawnAgg, creditsAgg, recentEntries] = await Promise.all([
        prisma.payout.aggregate({
            where: { storeId, status: { in: ["REQUESTED", "PROCESSING"] } },
            _sum: { amount: true },
        }),
        prisma.payout.aggregate({
            where: { storeId, status: "SUCCESS" },
            _sum: { amount: true },
        }),
        prisma.walletEntry.aggregate({
            where: { storeId, type: "CREDIT" },
            _sum: { amount: true },
        }),
        prisma.walletEntry.findMany({
            where: { storeId },
            orderBy: { createdAt: "desc" },
            take: 25,
        }),
    ]);
    return {
        wallet: {
            currency: WALLET_CURRENCY,
            available: (wallet?.balance ?? new Prisma.Decimal(0)).toString(),
            pending: (pendingAgg._sum.amount ?? new Prisma.Decimal(0)).toString(),
            withdrawn: (withdrawnAgg._sum.amount ?? new Prisma.Decimal(0)).toString(),
            totalCredits: (creditsAgg._sum.amount ?? new Prisma.Decimal(0)).toString(),
        },
        recentEntries: recentEntries.map((entry) => ({
            id: entry.id,
            type: entry.type,
            source: entry.source,
            amount: entry.amount.toString(),
            balanceAfter: entry.balanceAfter.toString(),
            orderId: entry.orderId,
            payoutId: entry.payoutId,
            createdAt: entry.createdAt,
        })),
    };
}
// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------
/** GET the store's bank accounts. */
export async function listBankAccounts(storeId) {
    const prisma = getPrismaClient();
    const rows = await prisma.bankAccount.findMany({
        where: { storeId },
        orderBy: { createdAt: "desc" },
    });
    return rows.map(toBankAccountView);
}
/**
 * POST a bank account: resolves the account on Paystack (the resolved
 * name is the source of truth and the typo guard), creates a transfer
 * recipient, and stores only the recipientCode + a masked number — the
 * full account number never touches our database.
 */
export async function createBankAccount(storeId, input, providerFactory = defaultProviderFactory) {
    const data = validateOrThrow(createBankAccountSchema, input);
    const provider = await providerForStore(storeId, providerFactory);
    let resolvedName;
    try {
        const resolved = await provider.resolveBankAccount(data.bankCode, data.accountNumber);
        resolvedName = resolved.accountName;
    }
    catch (err) {
        if (err instanceof PaymentProviderError) {
            throw new AppError(400, "BANK_ACCOUNT_UNRESOLVED", `Paystack could not resolve this account: ${err.message}`);
        }
        throw err;
    }
    if (data.accountName !== undefined &&
        data.accountName.trim().toLowerCase() !== resolvedName.trim().toLowerCase()) {
        throw new AppError(400, "BANK_ACCOUNT_UNRESOLVED", "The account name does not match the account number on Paystack");
    }
    let recipientCode;
    try {
        const recipient = await provider.createTransferRecipient({
            name: resolvedName,
            accountNumber: data.accountNumber,
            bankCode: data.bankCode,
        });
        recipientCode = recipient.recipientCode;
    }
    catch (err) {
        if (err instanceof PaymentProviderError) {
            throw new AppError(502, "PAYMENT_PROVIDER_ERROR", `Paystack rejected the recipient creation: ${err.message}`);
        }
        throw err;
    }
    const prisma = getPrismaClient();
    const row = await prisma.$transaction(async (tx) => {
        const created = await tx.bankAccount.create({
            data: {
                storeId,
                accountName: resolvedName,
                bankName: data.bankName,
                bankCode: data.bankCode,
                maskedAccountNumber: maskAccountNumber(data.accountNumber),
                recipientCode,
                isDefault: data.isDefault ?? false,
            },
        });
        if (created.isDefault) {
            await tx.bankAccount.updateMany({
                where: { storeId, id: { not: created.id } },
                data: { isDefault: false },
            });
        }
        await logStoreActivity(tx, {
            storeId,
            action: "wallet.bankAccount.created",
            detail: { bankAccountId: created.id, bankName: created.bankName, bankCode: created.bankCode },
        });
        return created;
    });
    return toBankAccountView(row);
}
/**
 * DELETE a bank account. Refused when the account has payout history —
 * financial attribution must survive (Restrict at the DB level too).
 */
export async function deleteBankAccount(storeId, bankAccountId) {
    const prisma = getPrismaClient();
    const account = await prisma.bankAccount.findFirst({
        where: { id: bankAccountId, storeId },
        select: { id: true },
    });
    if (account === null) {
        throw new AppError(404, "BANK_ACCOUNT_NOT_FOUND", "Bank account not found");
    }
    const payout = await prisma.payout.findFirst({
        where: { bankAccountId },
        select: { id: true },
    });
    if (payout !== null) {
        throw new AppError(409, "BANK_ACCOUNT_HAS_PAYOUTS", "This account has withdrawal history and cannot be deleted");
    }
    await prisma.$transaction(async (tx) => {
        await tx.bankAccount.delete({ where: { id: bankAccountId } });
        await logStoreActivity(tx, {
            storeId,
            action: "wallet.bankAccount.deleted",
            detail: { bankAccountId },
        });
    });
}
function toPayoutView(row) {
    return {
        id: row.id,
        reference: row.reference,
        amount: row.amount.toString(),
        status: row.status,
        createdAt: row.createdAt,
        processedAt: row.processedAt,
        bankAccount: {
            id: row.bankAccount.id,
            maskedAccountNumber: row.bankAccount.maskedAccountNumber,
            bankName: row.bankAccount.bankName,
            accountName: row.bankAccount.accountName,
        },
    };
}
/**
 * POST a withdrawal: debits the wallet (atomic conditional decrement —
 * the row lock serializes concurrent requests, so overdraw is
 * impossible) and creates the REQUESTED payout in ONE transaction, then
 * initiates the Paystack transfer OUTSIDE it. On provider rejection the
 * payout becomes FAILED and the debited amount is credited back
 * (automatic reversal); the response still returns 201 with the FAILED
 * payout — no money left the wallet.
 */
export async function createWithdrawal(storeId, input, providerFactory = defaultProviderFactory) {
    const data = validateOrThrow(createWithdrawalSchema, input);
    const amount = new Prisma.Decimal(data.amount);
    if (amount.lessThan(MIN_WITHDRAWAL)) {
        throw new AppError(400, "WITHDRAWAL_BELOW_MINIMUM", `The minimum withdrawal is ${MIN_WITHDRAWAL.toString()}`);
    }
    const prisma = getPrismaClient();
    const reference = generateWithdrawalReference();
    // Phase 1 — the wallet debit + payout row, atomically.
    const bankAccount = await prisma.bankAccount.findFirst({
        where: { id: data.bankAccountId, storeId },
    });
    if (bankAccount === null) {
        throw new AppError(404, "BANK_ACCOUNT_NOT_FOUND", "Bank account not found");
    }
    const created = await prisma.$transaction(async (tx) => {
        await ensureWallet(tx, storeId);
        const debited = await tx.storeWallet.updateMany({
            where: { storeId, balance: { gte: amount } },
            data: { balance: { decrement: amount } },
        });
        if (debited.count === 0) {
            throw new AppError(409, "INSUFFICIENT_WALLET_BALANCE", "Insufficient wallet balance");
        }
        const wallet = await tx.storeWallet.findUniqueOrThrow({ where: { storeId } });
        const payout = await tx.payout.create({
            data: {
                storeId,
                bankAccountId: bankAccount.id,
                reference,
                amount,
            },
        });
        await tx.walletEntry.create({
            data: {
                storeId,
                type: "DEBIT",
                source: "WITHDRAWAL",
                amount,
                balanceAfter: wallet.balance,
                payoutId: payout.id,
            },
        });
        await logStoreActivity(tx, {
            storeId,
            action: "wallet.withdrawal.requested",
            detail: { payoutId: payout.id, reference, amount: amount.toString() },
        });
        return payout;
    });
    // Phase 2 — the provider call, outside the wallet transaction.
    const provider = await providerForStore(storeId, providerFactory);
    try {
        const initiated = await provider.initiateTransfer({
            recipientCode: bankAccount.recipientCode ?? "",
            amount: amount.toString(),
            reference,
        });
        await prisma.payout.updateMany({
            where: { id: created.id, status: "REQUESTED" },
            data: { status: "PROCESSING", transferCode: initiated.transferCode },
        });
    }
    catch (err) {
        if (!(err instanceof PaymentProviderError)) {
            throw err;
        }
        // The provider rejected the transfer: mark FAILED and reverse the
        // debit inside one transaction (idempotent — only a still-REQUESTED
        // payout takes the reversal).
        await prisma.$transaction(async (tx) => {
            const reversed = await tx.payout.updateMany({
                where: { id: created.id, status: "REQUESTED" },
                data: { status: "FAILED", processedAt: new Date() },
            });
            if (reversed.count === 1) {
                await creditWallet(tx, storeId, {
                    amount,
                    payoutId: created.id,
                    source: "WITHDRAWAL_REVERSAL",
                });
                await logStoreActivity(tx, {
                    storeId,
                    action: "wallet.withdrawal.failed",
                    detail: { payoutId: created.id, reference, amount: amount.toString() },
                });
            }
        });
    }
    const viewRow = await prisma.payout.findUniqueOrThrow({
        where: { id: created.id },
        include: { bankAccount: true },
    });
    return toPayoutView(viewRow);
}
/** GET the store's withdrawals, cursor-paginated newest-first. */
export async function listWithdrawals(storeId, params) {
    const { cursor, limit } = validateOrThrow(listWithdrawalsParamsSchema, params);
    const pageSize = limit ?? 20;
    const prisma = getPrismaClient();
    const where = cursor !== undefined ? { storeId, id: { lt: cursor } } : { storeId };
    const rows = await prisma.payout.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: pageSize + 1,
        include: { bankAccount: true },
    });
    const hasMore = rows.length > pageSize;
    const page = hasMore ? rows.slice(0, pageSize) : rows;
    const last = page[page.length - 1];
    return {
        items: page.map(toPayoutView),
        nextCursor: hasMore && last !== undefined ? last.id : null,
    };
}
//# sourceMappingURL=service.js.map