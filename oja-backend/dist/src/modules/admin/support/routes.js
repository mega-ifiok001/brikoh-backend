import { Router } from "express";
import { AppError } from "../../../lib/AppError.js";
import { getPrismaClient } from "../../../lib/prisma.js";
import { validateOrThrow } from "../../../lib/validate.js";
import { requireAdminPermission } from "../../../middleware/adminAuth.js";
import { AUDIT_ACTIONS, writeAuditLog } from "../audit.js";
import { notifySupportReply } from "../../notifications/service.js";
import { defaultAlertSender } from "../../notifications/email.js";
import { z } from "zod";
const uuid = z.uuid("must be a valid uuid");
const query = z
    .object({
    status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]).optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
    assignedAdminId: uuid.optional(),
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
})
    .strict();
const body = z.object({ body: z.string().trim().min(1).max(10_000) }).strict();
const assign = z.object({ adminId: uuid.nullable() }).strict();
const status = z.object({ status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]) }).strict();
const router = Router();
const ticketId = (req) => {
    const id = req.params.ticketId;
    if (typeof id !== "string" || id === "")
        throw new AppError(400, "VALIDATION_ERROR", "ticketId is required");
    return id;
};
const admin = (req) => {
    if (!req.admin)
        throw new AppError(401, "UNAUTHORIZED", "Authentication required");
    return req.admin;
};
async function audit(req, action, storeId, detail) {
    await writeAuditLog(getPrismaClient(), {
        adminUserId: admin(req).adminUserId,
        action,
        storeId,
        detail: detail,
    });
}
function notFound() {
    return new AppError(404, "TICKET_NOT_FOUND", "Support ticket not found");
}
router.get("/tickets", requireAdminPermission("admin:support.tickets.view"), async (req, res, next) => {
    try {
        const q = validateOrThrow(query, req.query);
        const rows = await getPrismaClient().supportTicket.findMany({
            where: {
                ...(q.status ? { status: q.status } : {}),
                ...(q.priority ? { priority: q.priority } : {}),
                ...(q.assignedAdminId ? { assignedAdminId: q.assignedAdminId } : {}),
            },
            orderBy: [{ status: "asc" }, { createdAt: "asc" }, { id: "asc" }],
            take: q.limit + 1,
            ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
            include: {
                store: { select: { id: true, name: true } },
                assignedAdmin: { select: { id: true, email: true } },
            },
        });
        await audit(req, AUDIT_ACTIONS.SUPPORT_TICKETS_VIEWED, null, { filters: q });
        const items = rows.slice(0, q.limit);
        res.json({
            items,
            nextCursor: rows.length > q.limit ? (items.at(-1)?.id ?? null) : null,
        });
    }
    catch (e) {
        next(e);
    }
});
router.get("/tickets/:ticketId", requireAdminPermission("admin:support.tickets.view"), async (req, res, next) => {
    try {
        const ticket = await getPrismaClient().supportTicket.findUnique({
            where: { id: ticketId(req) },
            include: {
                store: { select: { id: true, name: true } },
                assignedAdmin: { select: { id: true, email: true } },
            },
        });
        if (!ticket)
            throw notFound();
        const messages = await getPrismaClient().ticketMessage.findMany({
            where: { ticketId: ticket.id },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: 50,
        });
        await audit(req, AUDIT_ACTIONS.SUPPORT_TICKET_VIEWED, ticket.storeId, {
            ticketId: ticket.id,
        });
        res.json({ ticket, messages, nextMessageCursor: null });
    }
    catch (e) {
        next(e);
    }
});
router.post("/tickets/:ticketId/assign", requireAdminPermission("admin:support.tickets.manage"), async (req, res, next) => {
    try {
        const ticket = await getPrismaClient().supportTicket.findUnique({
            where: { id: ticketId(req) },
        });
        if (!ticket)
            throw notFound();
        const input = validateOrThrow(assign, req.body);
        if (input.adminId) {
            const target = await getPrismaClient().adminUser.findUnique({
                where: { id: input.adminId },
            });
            if (!target || !target.isActive)
                throw new AppError(404, "ADMIN_NOT_FOUND", "Admin not found");
        }
        const updated = await getPrismaClient().supportTicket.update({
            where: { id: ticket.id },
            data: { assignedAdminId: input.adminId },
            include: { assignedAdmin: { select: { id: true, email: true } } },
        });
        await audit(req, AUDIT_ACTIONS.SUPPORT_TICKET_ASSIGNED, ticket.storeId, {
            ticketId: ticket.id,
            previousAdminId: ticket.assignedAdminId,
            adminId: input.adminId,
        });
        res.json({ ticket: updated });
    }
    catch (e) {
        next(e);
    }
});
router.patch("/tickets/:ticketId/status", requireAdminPermission("admin:support.tickets.manage"), async (req, res, next) => {
    try {
        const ticket = await getPrismaClient().supportTicket.findUnique({
            where: { id: ticketId(req) },
        });
        if (!ticket)
            throw notFound();
        if (ticket.status === "CLOSED")
            throw new AppError(409, "TICKET_CLOSED", "Closed tickets cannot be changed");
        const input = validateOrThrow(status, req.body);
        const now = new Date();
        const updated = await getPrismaClient().supportTicket.update({
            where: { id: ticket.id },
            data: {
                status: input.status,
                ...(input.status === "RESOLVED" ? { resolvedAt: now } : {}),
                ...(input.status === "CLOSED" ? { closedAt: now } : {}),
            },
        });
        await audit(req, AUDIT_ACTIONS.SUPPORT_TICKET_STATUS_CHANGED, ticket.storeId, {
            ticketId: ticket.id,
            previousStatus: ticket.status,
            status: input.status,
        });
        res.json({ ticket: updated });
    }
    catch (e) {
        next(e);
    }
});
router.post("/tickets/:ticketId/messages", requireAdminPermission("admin:support.tickets.manage"), async (req, res, next) => {
    try {
        const ticket = await getPrismaClient().supportTicket.findUnique({
            where: { id: ticketId(req) },
        });
        if (!ticket)
            throw notFound();
        if (ticket.status === "CLOSED")
            throw new AppError(409, "TICKET_CLOSED", "Closed tickets cannot receive messages");
        const message = await getPrismaClient().ticketMessage.create({
            data: {
                ticketId: ticket.id,
                authorType: "ADMIN",
                authorAdminId: admin(req).adminUserId,
                body: validateOrThrow(body, req.body).body,
            },
        });
        await audit(req, AUDIT_ACTIONS.SUPPORT_TICKET_REPLIED, ticket.storeId, {
            ticketId: ticket.id,
            messageId: message.id,
        });
        void notifySupportReply(defaultAlertSender(), ticket.storeId, ticket.id, message.id);
        res.status(201).json({ message });
    }
    catch (e) {
        next(e);
    }
});
export { router as adminSupportRouter };
//# sourceMappingURL=routes.js.map