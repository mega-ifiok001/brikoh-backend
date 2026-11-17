/**
 * The system's ONE shared human-readable date formatter (RULES.md: dates
 * shown to humans go through a single utility, never ad-hoc formatting).
 * Fixed to UTC: every stored timestamp is UTC, so a raw instant would
 * render differently per viewer timezone unless normalized here.
 */
export function formatHumanDate(date) {
    return new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeZone: "UTC",
    }).format(date);
}
//# sourceMappingURL=format-date.js.map