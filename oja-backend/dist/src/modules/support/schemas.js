import { z } from "zod";
const uuid = z.uuid("must be a valid uuid");
export const ticketQuerySchema = z
    .object({
    status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]).optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
})
    .strict();
export const createTicketSchema = z
    .object({
    subject: z.string().trim().min(1).max(200),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
    message: z.string().trim().min(1).max(10_000),
})
    .strict();
export const messageSchema = z.object({ body: z.string().trim().min(1).max(10_000) }).strict();
//# sourceMappingURL=schemas.js.map