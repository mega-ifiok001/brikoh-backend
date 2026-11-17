/**
 * The full known set of feature-level permission flags. StaffMember
 * rows keep a text[] subset; owners implicitly hold every permission
 * (authorize bypasses the check for OWNER). Extend this list when a
 * module introduces a new permission — the allowlist is enforced here,
 * not by the database (adding a permission needs no migration).
 */
export const PERMISSIONS = [
    "products.manage",
    "orders.manage",
    "customers.manage",
    "invoices.manage",
    "purchases.manage",
    "discounts.manage",
    "staff.manage",
    "locations.manage",
    "catalog.manage",
    "analytics.manage",
    "viewProfit",
    "marketing.manage",
    "support.tickets.manage",
];
/** True when the value is one of the known permissions. */
export function isPermission(value) {
    return PERMISSIONS.includes(value);
}
//# sourceMappingURL=permissions.js.map