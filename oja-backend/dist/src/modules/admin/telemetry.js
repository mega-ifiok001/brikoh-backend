function reached(at, previous) {
    return at !== null && previous !== null && at.getTime() >= previous.getTime();
}
function conversion(count, previous) {
    return previous === 0 ? null : Math.round((count / previous) * 1000) / 10;
}
export function computeFunnel(rows) {
    const published = rows.filter((row) => reached(row.publishedAt, row.createdAt));
    const ordered = published.filter((row) => reached(row.orderedAt, row.publishedAt));
    const paid = ordered.filter((row) => reached(row.paidAt, row.orderedAt));
    const upgraded = paid.filter((row) => reached(row.upgradedAt, row.paidAt));
    const counts = [rows.length, published.length, ordered.length, paid.length, upgraded.length];
    const keys = [
        "registered",
        "firstProductPublished",
        "firstOrderPlaced",
        "firstOrderPaid",
        "upgradedToPaidTier",
    ];
    return keys.map((key, index) => ({
        key,
        count: counts[index],
        conversionFromPrevious: index === 0 ? 100 : conversion(counts[index], counts[index - 1]),
    }));
}
export function medianFirstOrderSeconds(values) {
    if (values.length === 0)
        return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
//# sourceMappingURL=telemetry.js.map