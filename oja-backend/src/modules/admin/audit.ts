import type { Prisma, PrismaClient } from "../../../generated/prisma/client.js";

/**
 * Audit wrapper — the ONLY way audit rows are written. Mutating admin
 * actions (login, 2FA rotation, pricing changes, webhook reprocess) are
 * recorded at "which record" granularity. The cross-tenant read views
 * (overview / merchants / stores / orders) are ALSO logged on every
 * access by contract — `admin.*.viewed` actions — so the platform's
 * surveillance surface is auditable. The table itself is append-only at
 * the database level (see audit.appendonly.test.ts).
 */

export type AuditDb = Pick<PrismaClient, "adminAuditLog">;

export interface AuditLogEntry {
  adminUserId: string;
  action: string;
  /** Platform-level actions concern no single tenant — null. */
  storeId?: string | null;
  detail: Prisma.InputJsonValue;
}

/** Writes one audit entry. */
export async function writeAuditLog(db: AuditDb, entry: AuditLogEntry): Promise<void> {
  await db.adminAuditLog.create({
    data: {
      adminUserId: entry.adminUserId,
      action: entry.action,
      storeId: entry.storeId ?? null,
      detail: entry.detail,
    },
  });
}

/** Action keys — single source of truth for audit actions. */
export const AUDIT_ACTIONS = {
  LOGIN: "admin.session.login",
  TWO_FACTOR_ROTATED: "admin.2fa.rotated",
  ADMIN_2FA_RESET: "admin.2fa.reset",
  PRICING_UPDATED: "billing.pricing.updated",
  WEBHOOK_REPROCESSED: "webhooks.event.reprocessed",
  OVERVIEW_VIEWED: "admin.overview.viewed",
  MERCHANTS_VIEWED: "admin.merchants.viewed",
  STORES_VIEWED: "admin.stores.viewed",
  ORDERS_VIEWED: "admin.orders.viewed",
  SUPPORT_TICKETS_VIEWED: "admin.support_tickets.viewed",
  SUPPORT_TICKET_VIEWED: "admin.support_ticket.viewed",
  SUPPORT_TICKET_ASSIGNED: "admin.support_ticket.assigned",
  SUPPORT_TICKET_STATUS_CHANGED: "admin.support_ticket.status_changed",
  SUPPORT_TICKET_REPLIED: "admin.support_ticket.replied",
  ANNOUNCEMENTS_VIEWED: "admin.announcements.viewed",
  ANNOUNCEMENT_CREATED: "admin.announcement.created",
  ANNOUNCEMENT_UPDATED: "admin.announcement.updated",
  ANNOUNCEMENT_VIEWS_VIEWED: "admin.announcement_views.viewed",
  TELEMETRY_FUNNEL_VIEWED: "admin.telemetry.funnel.viewed",
  TELEMETRY_MEDIAN_FIRST_ORDER_VIEWED: "admin.telemetry.median_first_order.viewed",
  AWAITING_PAYMENT_ORDERS_VIEWED: "admin.awaiting_payment_orders.viewed",
  ADMIN_STAFF_VIEWED: "admin.staff.viewed",
} as const;
