/**
 * Returns the process health status.
 */
export function getHealth() {
    return {
        status: "ok",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
    };
}
//# sourceMappingURL=service.js.map