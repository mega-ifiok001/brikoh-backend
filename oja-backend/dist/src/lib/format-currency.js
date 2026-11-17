/**
 * Formats a decimal-string amount for display in the store's currency,
 * e.g. `formatMoney("4900.00", "NGN")` -> `"₦4,900.00"`.
 *
 * Deliberately deterministic (a fixed symbol table + manual grouping)
 * rather than Intl.NumberFormat: the backend renders the same string in
 * emails regardless of the host's ICU/locale data, so receipts don't
 * drift between environments.
 */
const CURRENCY_SYMBOLS = {
    NGN: "₦",
    USD: "$",
    GHS: "GH₵",
    KES: "KSh",
    ZAR: "R",
};
function groupThousands(integerPart) {
    return integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
export function formatMoney(amount, currency) {
    const symbol = CURRENCY_SYMBOLS[currency] ?? "";
    const normalized = amount.trim();
    const negative = normalized.startsWith("-");
    const unsigned = negative ? normalized.slice(1) : normalized;
    const [rawInteger = "0", rawFraction = ""] = unsigned.split(".");
    const fraction = rawFraction.padEnd(2, "0").slice(0, 2);
    const integer = rawInteger.replace(/^0+(?=\d)/, "") || "0";
    const body = `${groupThousands(integer)}.${fraction}`;
    return `${negative ? "-" : ""}${symbol}${body}`;
}
//# sourceMappingURL=format-currency.js.map