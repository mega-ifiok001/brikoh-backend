/** Writes one audit entry. */
export async function writeAuditLog(db, entry) {
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
};
//# sourceMappingURL=audit.js.map