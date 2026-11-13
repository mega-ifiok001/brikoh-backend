/**
 * Result of a health check. Timestamp is always UTC ISO-8601.
 */
export interface HealthStatus {
  status: "ok";
  uptime: number;
  timestamp: string;
}

/**
 * Returns the process health status.
 */
export function getHealth(): HealthStatus {
  return {
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };
}
