import { Prisma, type PrismaClient } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { toCsv } from "../../lib/csv.js";
import type { TransactionQuery, TransactionExportQuery } from "./schemas.js";

const LAGOS = "Africa/Lagos";

export type TransactionsDb = Pick<
  PrismaClient,
  "order" | "walletEntry" | "payout" | "creditRepayment" | "invoicePayment"
>;

export interface TransactionItem {
  id: string;
  type: string;
  direction: "IN" | "OUT";
  title: string;
  orderNumber: string | null;
  customerName: string | null;
  paymentMethod: string;
  grossAmount: string;
  feeAmount: string | null;
  netAmount: string | null;
  amount: string;
  currency: "NGN";
  status: "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "REFUNDED";
  reference: string;
  createdAt: string;
  initiatedAt: string;
  paidAt: string | null;
  settledAt: string | null;
  statusExplanation: string | null;
  branchId: string | null;
  balanceAfter: string | null;
  linkedRecords: { orderId: string | null; invoiceId: string | null; customerId: string | null };
  bankAccount: { bankName: string; accountName: string; maskedAccountNumber: string } | null;
}

export interface TransactionPage {
  transactions: TransactionItem[];
  nextCursor: string | null;
  total: number;
  range: { from: string; to: string; timeZone: "Africa/Lagos" };
  summary: { moneyIn: string; moneyOut: string; net: string };
  dailyTotals: { date: string; moneyIn: string; moneyOut: string; net: string }[];
  activeFilterCount: number;
}

type TransactionItemWithFlags = TransactionItem & {
  walletMovement: boolean;
  searchable: string;
};

function lagosMidnight(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!) - 60 * 60 * 1000);
}

function nextDate(date: string): string {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + 1);
  return result.toISOString().slice(0, 10);
}

function lagosDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: LAGOS,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function money(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function statusForOrder(status: string): TransactionItem["status"] {
  if (status === "PAID" || status === "SHIPPED") return "SUCCESS";
  if (status === "REFUNDED") return "REFUNDED";
  if (status === "FAILED" || status === "CANCELLED") return "FAILED";
  return "PENDING";
}

function makeItem(input: TransactionItemWithFlags): TransactionItemWithFlags {
  return input;
}

function mapOrder(order: {
  id: string;
  orderNumber: string;
  total: Prisma.Decimal;
  amountPaid: Prisma.Decimal | null;
  paymentFee: Prisma.Decimal | null;
  paymentMethod: string | null;
  status: string;
  paymentReference: string | null;
  createdAt: Date;
  paidAt: Date | null;
  branchId: string;
  customerId: string;
  customer: { name: string };
  walletEntries: { amount: Prisma.Decimal; balanceAfter: Prisma.Decimal; createdAt: Date }[];
}): TransactionItemWithFlags {
  const status = statusForOrder(order.status);
  const gross = order.total.toFixed(2);
  const received = order.amountPaid?.toFixed(2) ?? gross;
  const isCredit = order.paymentMethod === "CREDIT";
  const method = order.paymentMethod ?? "PAYSTACK";
  const direction = status === "REFUNDED" ? "OUT" : "IN";
  const fee = order.paymentFee?.toFixed(2) ?? null;
  const net = isCredit
    ? received
    : (order.walletEntries[0]?.amount.toFixed(2) ??
      (fee === null ? gross : money(gross).sub(money(fee)).toFixed(2)));
  return makeItem({
    id: `ORDER:${order.id}`,
    type: "SALE",
    direction,
    title: `${status === "REFUNDED" ? "Refunded sale" : isCredit ? "Credit sale" : "Sale"} ${order.orderNumber}`,
    orderNumber: order.orderNumber,
    customerName: order.customer.name,
    paymentMethod: method,
    grossAmount: gross,
    feeAmount: method === "CASH" || method === "TRANSFER" || method === "CREDIT" ? "0.00" : fee,
    netAmount: net,
    amount: gross,
    currency: "NGN",
    status: isCredit && money(received).lessThan(money(gross)) ? "PENDING" : status,
    reference: order.paymentReference ?? order.orderNumber,
    createdAt: (order.paidAt ?? order.createdAt).toISOString(),
    initiatedAt: order.createdAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
    settledAt: order.walletEntries[0]?.createdAt.toISOString() ?? null,
    statusExplanation:
      status === "PENDING"
        ? isCredit
          ? "This sale was recorded on credit; repayments are shown as separate incoming transactions."
          : "Payment has not been confirmed yet."
        : status === "FAILED"
          ? "The payment did not complete."
          : status === "REFUNDED"
            ? "This sale was marked as refunded."
            : null,
    branchId: order.branchId,
    balanceAfter: order.walletEntries[0]?.balanceAfter.toFixed(2) ?? null,
    linkedRecords: { orderId: order.id, invoiceId: null, customerId: order.customerId },
    bankAccount: null,
    walletMovement: order.walletEntries.length > 0,
    searchable:
      `${order.orderNumber} ${order.paymentReference ?? ""} ${order.customer.name} ${gross}`.toLowerCase(),
  });
}

function mapCreditRepayment(row: {
  id: string;
  amount: Prisma.Decimal;
  note: string | null;
  createdAt: Date;
  orderId: string;
  order: { orderNumber: string; customerId: string; customer: { name: string }; branchId: string };
}): TransactionItemWithFlags {
  const amount = row.amount.toFixed(2);
  return makeItem({
    id: `CREDIT_REPAYMENT:${row.id}`,
    type: "CREDIT_REPAYMENT",
    direction: "IN",
    title: `Credit repayment · ${row.order.orderNumber}`,
    orderNumber: row.order.orderNumber,
    customerName: row.order.customer.name,
    paymentMethod: "MANUAL",
    grossAmount: amount,
    feeAmount: "0.00",
    netAmount: amount,
    amount,
    currency: "NGN",
    status: "SUCCESS",
    reference: row.id,
    createdAt: row.createdAt.toISOString(),
    initiatedAt: row.createdAt.toISOString(),
    paidAt: row.createdAt.toISOString(),
    settledAt: null,
    statusExplanation: null,
    branchId: row.order.branchId,
    balanceAfter: null,
    linkedRecords: { orderId: row.orderId, invoiceId: null, customerId: row.order.customerId },
    bankAccount: null,
    walletMovement: false,
    searchable:
      `${row.id} ${row.order.orderNumber} ${row.order.customer.name} ${amount} ${row.note ?? ""}`.toLowerCase(),
  });
}

function mapInvoicePayment(row: {
  id: string;
  amount: Prisma.Decimal;
  note: string | null;
  createdAt: Date;
  invoiceId: string;
  invoice: { number: string | null; customerId: string; customer: { name: string } };
}): TransactionItemWithFlags {
  const amount = row.amount.toFixed(2);
  const invoiceNumber = row.invoice.number ?? row.invoiceId;
  return makeItem({
    id: `INVOICE_PAYMENT:${row.id}`,
    type: "INVOICE_PAYMENT",
    direction: "IN",
    title: `Invoice payment · ${invoiceNumber}`,
    orderNumber: null,
    customerName: row.invoice.customer.name,
    paymentMethod: "MANUAL",
    grossAmount: amount,
    feeAmount: "0.00",
    netAmount: amount,
    amount,
    currency: "NGN",
    status: "SUCCESS",
    reference: row.id,
    createdAt: row.createdAt.toISOString(),
    initiatedAt: row.createdAt.toISOString(),
    paidAt: row.createdAt.toISOString(),
    settledAt: null,
    statusExplanation: null,
    branchId: null,
    balanceAfter: null,
    linkedRecords: { orderId: null, invoiceId: row.invoiceId, customerId: row.invoice.customerId },
    bankAccount: null,
    walletMovement: false,
    searchable:
      `${row.id} ${invoiceNumber} ${row.invoice.customer.name} ${amount} ${row.note ?? ""}`.toLowerCase(),
  });
}

function maskedBank(
  bank: { bankName: string; accountName: string; maskedAccountNumber: string | null } | null,
) {
  if (bank === null) return null;
  return {
    bankName: bank.bankName,
    accountName: bank.accountName,
    maskedAccountNumber: bank.maskedAccountNumber ?? "••••",
  };
}

function mapPayout(row: {
  id: string;
  reference: string;
  amount: Prisma.Decimal;
  fee: Prisma.Decimal | null;
  status: string;
  createdAt: Date;
  processedAt: Date | null;
  bankAccount: { bankName: string; accountName: string; maskedAccountNumber: string | null };
}): TransactionItemWithFlags {
  const amount = row.amount.toFixed(2);
  const fee = row.fee?.toFixed(2) ?? null;
  const net = row.amount.sub(row.fee ?? new Prisma.Decimal(0)).toFixed(2);
  const status: TransactionItem["status"] =
    row.status === "SUCCESS"
      ? "SUCCESS"
      : row.status === "FAILED"
        ? "FAILED"
        : row.status === "PROCESSING"
          ? "PROCESSING"
          : "PENDING";
  return makeItem({
    id: `PAYOUT:${row.id}`,
    type: "WITHDRAWAL",
    direction: "OUT",
    title: "Wallet withdrawal",
    orderNumber: null,
    customerName: null,
    paymentMethod: "PAYSTACK",
    grossAmount: amount,
    feeAmount: fee,
    netAmount: net,
    amount,
    currency: "NGN",
    status,
    reference: row.reference,
    createdAt: row.createdAt.toISOString(),
    initiatedAt: row.createdAt.toISOString(),
    paidAt: status === "SUCCESS" ? (row.processedAt?.toISOString() ?? null) : null,
    settledAt: row.processedAt?.toISOString() ?? null,
    statusExplanation:
      status === "PROCESSING"
        ? "Paystack is processing this withdrawal."
        : status === "PENDING"
          ? "The withdrawal request is awaiting processing."
          : status === "FAILED"
            ? "The withdrawal failed; the wallet ledger records any reversal."
            : null,
    branchId: null,
    balanceAfter: null,
    linkedRecords: { orderId: null, invoiceId: null, customerId: null },
    bankAccount: maskedBank(row.bankAccount),
    walletMovement: true,
    searchable:
      `${row.reference} ${row.bankAccount.bankName} ${row.bankAccount.accountName} ${amount}`.toLowerCase(),
  });
}

function mapWalletEntry(row: {
  id: string;
  type: string;
  source: string;
  amount: Prisma.Decimal;
  balanceAfter: Prisma.Decimal;
  createdAt: Date;
  orderId: string | null;
  payoutId: string | null;
  order: {
    id: string;
    orderNumber: string;
    paymentReference: string | null;
    total: Prisma.Decimal;
    paymentFee: Prisma.Decimal | null;
    customerId: string;
    branchId: string;
    customer: { name: string };
  } | null;
  payout: {
    reference: string;
    amount: Prisma.Decimal;
    fee: Prisma.Decimal | null;
    status: string;
    createdAt: Date;
    processedAt: Date | null;
    bankAccount: { bankName: string; accountName: string; maskedAccountNumber: string | null };
  } | null;
}): TransactionItemWithFlags {
  const amount = row.amount.toFixed(2);
  const reversal = row.source === "WITHDRAWAL_REVERSAL";
  const isOut = row.type === "DEBIT";
  const type =
    row.source === "ORDER_PAYMENT"
      ? "SALE"
      : row.source === "WITHDRAWAL"
        ? "WITHDRAWAL"
        : reversal
          ? "WITHDRAWAL_REVERSAL"
          : "WALLET_ADJUSTMENT";
  const title = row.order
    ? `Paystack payment · ${row.order.orderNumber}`
    : reversal
      ? "Withdrawal reversed"
      : isOut
        ? "Wallet debit"
        : "Wallet credit";
  const bank = row.payout?.bankAccount ?? null;
  return makeItem({
    id: `WALLET:${row.id}`,
    type,
    direction: isOut ? "OUT" : "IN",
    title,
    orderNumber: row.order?.orderNumber ?? null,
    customerName: row.order?.customer.name ?? null,
    paymentMethod: "PAYSTACK",
    grossAmount: row.payout?.amount.toFixed(2) ?? row.order?.total.toFixed(2) ?? amount,
    feeAmount: row.payout?.fee?.toFixed(2) ?? row.order?.paymentFee?.toFixed(2) ?? null,
    netAmount: row.payout
      ? money(amount)
          .sub(row.payout.fee?.toFixed(2) ?? "0.00")
          .toFixed(2)
      : amount,
    amount,
    currency: "NGN",
    status: reversal
      ? "SUCCESS"
      : row.payout?.status === "PROCESSING"
        ? "PROCESSING"
        : row.payout?.status === "REQUESTED"
          ? "PENDING"
          : row.payout?.status === "FAILED"
            ? "FAILED"
            : "SUCCESS",
    reference: row.payout?.reference ?? row.order?.paymentReference ?? row.id,
    createdAt: row.createdAt.toISOString(),
    initiatedAt: row.payout?.createdAt.toISOString() ?? row.createdAt.toISOString(),
    paidAt:
      row.payout?.status === "SUCCESS"
        ? (row.payout.processedAt?.toISOString() ?? null)
        : row.order
          ? row.createdAt.toISOString()
          : null,
    settledAt:
      row.payout?.status === "SUCCESS"
        ? (row.payout.processedAt?.toISOString() ?? null)
        : row.order
          ? row.createdAt.toISOString()
          : null,
    statusExplanation:
      row.payout?.status === "PROCESSING"
        ? "Paystack is processing this withdrawal."
        : row.payout?.status === "REQUESTED"
          ? "The withdrawal request is awaiting processing."
          : row.payout?.status === "FAILED"
            ? "The withdrawal failed; a reversal may appear as a separate wallet entry."
            : null,
    branchId: row.order?.branchId ?? null,
    balanceAfter: row.balanceAfter.toFixed(2),
    linkedRecords: {
      orderId: row.orderId,
      invoiceId: null,
      customerId: row.order?.customerId ?? null,
    },
    bankAccount: maskedBank(bank),
    walletMovement: true,
    searchable:
      `${row.id} ${row.payout?.reference ?? ""} ${row.order?.paymentReference ?? ""} ${row.order?.orderNumber ?? ""} ${row.order?.customer.name ?? ""} ${amount}`.toLowerCase(),
  });
}

function cursorEncode(item: TransactionItem): string {
  return Buffer.from(JSON.stringify({ at: item.createdAt, id: item.id })).toString("base64url");
}

function cursorDecode(cursor: string): { at: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      at?: unknown;
      id?: unknown;
    };
    if (typeof value.at !== "string" || typeof value.id !== "string") throw new Error("bad cursor");
    return { at: value.at, id: value.id };
  } catch {
    throw new AppError(400, "INVALID_TRANSACTION_CURSOR", "Transaction cursor is invalid");
  }
}

function compareDescending(a: TransactionItem, b: TransactionItem): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

function publicItem(item: TransactionItemWithFlags): TransactionItem {
  const result = { ...item };
  Reflect.deleteProperty(result, "walletMovement");
  Reflect.deleteProperty(result, "searchable");
  return result;
}

function matchesFilters(
  item: TransactionItemWithFlags,
  query: TransactionQuery | TransactionExportQuery,
): boolean {
  if (query.type !== undefined && item.type !== query.type) return false;
  if (query.direction !== undefined && item.direction !== query.direction) return false;
  if (query.status !== undefined && item.status !== query.status) return false;
  if (query.method !== undefined && item.paymentMethod !== query.method) return false;
  if (query.branchId !== undefined && item.branchId !== query.branchId) return false;
  if (query.search !== undefined && !item.searchable.includes(query.search.toLowerCase()))
    return false;
  return true;
}

function summarise(items: TransactionItemWithFlags[]) {
  let moneyIn = new Prisma.Decimal(0);
  let moneyOut = new Prisma.Decimal(0);
  const byDate = new Map<string, { moneyIn: Prisma.Decimal; moneyOut: Prisma.Decimal }>();
  for (const item of items) {
    const qualifies = item.status === "SUCCESS" || item.walletMovement;
    if (!qualifies) continue;
    const amount = money(item.direction === "IN" ? (item.netAmount ?? "0.00") : item.amount);
    const date = lagosDate(new Date(item.createdAt));
    const totals = byDate.get(date) ?? {
      moneyIn: new Prisma.Decimal(0),
      moneyOut: new Prisma.Decimal(0),
    };
    if (item.direction === "IN") {
      moneyIn = moneyIn.add(amount);
      totals.moneyIn = totals.moneyIn.add(amount);
    } else {
      moneyOut = moneyOut.add(amount);
      totals.moneyOut = totals.moneyOut.add(amount);
    }
    byDate.set(date, totals);
  }
  return {
    summary: {
      moneyIn: moneyIn.toFixed(2),
      moneyOut: moneyOut.toFixed(2),
      net: moneyIn.sub(moneyOut).toFixed(2),
    },
    dailyTotals: [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, totals]) => ({
        date,
        moneyIn: totals.moneyIn.toFixed(2),
        moneyOut: totals.moneyOut.toFixed(2),
        net: totals.moneyIn.sub(totals.moneyOut).toFixed(2),
      })),
  };
}

function activeFilterCount(query: TransactionQuery | TransactionExportQuery): number {
  return [
    query.direction,
    query.type,
    query.status,
    query.method,
    query.branchId,
    query.search,
  ].filter((value) => value !== undefined).length;
}

export class TransactionsService {
  constructor(private readonly db: TransactionsDb = getPrismaClient()) {}

  private async collect(storeId: string, query: TransactionQuery | TransactionExportQuery) {
    const from = lagosMidnight(query.from);
    const to = lagosMidnight(nextDate(query.to));
    const createdAt = { gte: from, lt: to };

    const [orders, repayments, invoicePayments, payouts, walletEntries] = await Promise.all([
      query.view === "wallet"
        ? Promise.resolve([])
        : this.db.order.findMany({
            where: {
              storeId,
              OR: [{ createdAt }, { paidAt: createdAt }],
              ...(query.branchId ? { branchId: query.branchId } : {}),
            },
            include: {
              customer: { select: { name: true } },
              walletEntries: {
                select: { amount: true, balanceAfter: true, createdAt: true },
                orderBy: { createdAt: "desc" },
                take: 1,
              },
            },
          }),
      query.view === "wallet"
        ? Promise.resolve([])
        : this.db.creditRepayment.findMany({
            where: {
              storeId,
              createdAt,
              ...(query.branchId ? { order: { branchId: query.branchId } } : {}),
            },
            include: {
              order: {
                select: {
                  id: true,
                  orderNumber: true,
                  customerId: true,
                  branchId: true,
                  customer: { select: { name: true } },
                },
              },
            },
          }),
      query.view === "wallet"
        ? Promise.resolve([])
        : this.db.invoicePayment.findMany({
            where: { storeId, createdAt },
            include: {
              invoice: {
                select: {
                  id: true,
                  number: true,
                  customerId: true,
                  customer: { select: { name: true } },
                },
              },
            },
          }),
      query.view === "wallet"
        ? Promise.resolve([])
        : this.db.payout.findMany({
            where: { storeId, createdAt },
            include: {
              bankAccount: {
                select: { bankName: true, accountName: true, maskedAccountNumber: true },
              },
            },
          }),
      this.db.walletEntry.findMany({
        where: {
          storeId,
          createdAt,
          ...(query.view === "all"
            ? { source: { in: ["WITHDRAWAL_REVERSAL", "ADJUSTMENT"] } }
            : {}),
          ...(query.branchId ? { order: { branchId: query.branchId } } : {}),
        },
        include: {
          order: {
            select: {
              id: true,
              orderNumber: true,
              paymentReference: true,
              total: true,
              paymentFee: true,
              customerId: true,
              branchId: true,
              customer: { select: { name: true } },
            },
          },
          payout: {
            select: {
              reference: true,
              amount: true,
              fee: true,
              status: true,
              createdAt: true,
              processedAt: true,
              bankAccount: {
                select: { bankName: true, accountName: true, maskedAccountNumber: true },
              },
            },
          },
        },
      }),
    ]);

    const items: TransactionItemWithFlags[] = [
      ...orders.map(mapOrder),
      ...repayments.map(mapCreditRepayment),
      ...invoicePayments.map(mapInvoicePayment),
      ...payouts.map(mapPayout),
      ...walletEntries.map(mapWalletEntry),
    ];
    const filtered = items
      .filter((item) => {
        const at = new Date(item.createdAt).getTime();
        return at >= from.getTime() && at < to.getTime() && matchesFilters(item, query);
      })
      .sort(compareDescending);
    return { filtered, from, to };
  }

  async list(storeId: string, query: TransactionQuery): Promise<TransactionPage> {
    const { filtered } = await this.collect(storeId, query);
    const totals = summarise(filtered);
    let cursorIndex = -1;
    if (query.cursor !== undefined) {
      const cursor = cursorDecode(query.cursor);
      cursorIndex = filtered.findIndex(
        (item) => item.createdAt === cursor.at && item.id === cursor.id,
      );
      if (cursorIndex < 0) {
        throw new AppError(
          400,
          "INVALID_TRANSACTION_CURSOR",
          "Transaction cursor is no longer available",
        );
      }
    }
    const page = filtered.slice(cursorIndex + 1, cursorIndex + 1 + query.limit);
    const hasMore = cursorIndex + 1 + page.length < filtered.length;
    const { summary, dailyTotals } = totals;
    return {
      transactions: page.map(publicItem),
      nextCursor: hasMore && page.length > 0 ? cursorEncode(page[page.length - 1]!) : null,
      total: filtered.length,
      range: { from: query.from, to: query.to, timeZone: LAGOS },
      summary,
      dailyTotals,
      activeFilterCount: activeFilterCount(query),
    };
  }

  async detail(storeId: string, transactionId: string): Promise<TransactionItem> {
    const splitAt = transactionId.indexOf(":");
    const prefix = transactionId.slice(0, splitAt);
    const id = transactionId.slice(splitAt + 1);
    if (splitAt < 1 || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw new AppError(400, "INVALID_TRANSACTION_ID", "Transaction ID is invalid");
    }
    let item: TransactionItemWithFlags | undefined;
    if (prefix === "ORDER") {
      const row = await this.db.order.findFirst({
        where: { id, storeId },
        include: {
          customer: { select: { name: true } },
          walletEntries: {
            select: { amount: true, balanceAfter: true, createdAt: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      });
      if (row !== null) item = mapOrder(row);
    } else if (prefix === "PAYOUT") {
      const row = await this.db.payout.findFirst({
        where: { id, storeId },
        include: {
          bankAccount: { select: { bankName: true, accountName: true, maskedAccountNumber: true } },
        },
      });
      if (row !== null) item = mapPayout(row);
    } else if (prefix === "CREDIT_REPAYMENT") {
      const row = await this.db.creditRepayment.findFirst({
        where: { id, storeId },
        include: {
          order: {
            select: {
              id: true,
              orderNumber: true,
              customerId: true,
              branchId: true,
              customer: { select: { name: true } },
            },
          },
        },
      });
      if (row !== null) item = mapCreditRepayment(row);
    } else if (prefix === "INVOICE_PAYMENT") {
      const row = await this.db.invoicePayment.findFirst({
        where: { id, storeId },
        include: {
          invoice: {
            select: {
              id: true,
              number: true,
              customerId: true,
              customer: { select: { name: true } },
            },
          },
        },
      });
      if (row !== null) item = mapInvoicePayment(row);
    } else if (prefix === "WALLET") {
      const row = await this.db.walletEntry.findFirst({
        where: { id, storeId },
        include: {
          order: {
            select: {
              id: true,
              orderNumber: true,
              paymentReference: true,
              total: true,
              paymentFee: true,
              customerId: true,
              branchId: true,
              customer: { select: { name: true } },
            },
          },
          payout: {
            select: {
              reference: true,
              amount: true,
              fee: true,
              status: true,
              createdAt: true,
              processedAt: true,
              bankAccount: {
                select: { bankName: true, accountName: true, maskedAccountNumber: true },
              },
            },
          },
        },
      });
      if (row !== null) item = mapWalletEntry(row);
    }
    if (item === undefined)
      throw new AppError(404, "TRANSACTION_NOT_FOUND", "Transaction not found");
    return publicItem(item);
  }

  async exportCsv(storeId: string, query: TransactionExportQuery): Promise<string> {
    const { filtered } = await this.collect(storeId, query);
    return toCsv(
      filtered.map((item) => ({
        date: lagosDate(new Date(item.createdAt)),
        type: item.type,
        direction: item.direction,
        title: item.title,
        orderNumber: item.orderNumber ?? "",
        customer: item.customerName ?? "",
        paymentMethod: item.paymentMethod,
        grossAmount: item.grossAmount,
        feeAmount: item.feeAmount ?? "",
        netAmount: item.netAmount ?? "",
        status: item.status,
        reference: item.reference,
      })),
    );
  }
}
