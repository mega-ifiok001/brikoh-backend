import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../../lib/AppError.js";
import { getPrismaClient } from "../../../lib/prisma.js";
import { validateOrThrow } from "../../../lib/validate.js";
import { requireAdminPermission } from "../../../middleware/adminAuth.js";
import { AUDIT_ACTIONS, writeAuditLog } from "../audit.js";
const router = Router();
const uuid = z.uuid("must be a valid uuid");
const create = z
    .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(10_000),
    targetTier: z.enum(["STARTER", "PRO", "ENTERPRISE"]).nullable().optional(),
})
    .strict();
const update = create
    .partial()
    .extend({ publish: z.boolean().optional(), isActive: z.boolean().optional() })
    .strict();
const query = z
    .object({ cursor: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
    .strict();
const aid = (req) => {
    const value = req.params.announcementId;
    if (typeof value !== "string" || value === "")
        throw new AppError(400, "VALIDATION_ERROR", "announcementId is required");
    return value;
};
const actor = (req) => {
    if (!req.admin)
        throw new AppError(401, "UNAUTHORIZED", "Authentication required");
    return req.admin.adminUserId;
};
async function audit(req, action, detail) {
    await writeAuditLog(getPrismaClient(), {
        adminUserId: actor(req),
        action,
        detail: detail,
    });
}
router.post("/", requireAdminPermission("admin:announcements.manage"), async (req, res, next) => {
    try {
        const input = validateOrThrow(create, req.body);
        const announcement = await getPrismaClient().announcement.create({
            data: { ...input, targetTier: input.targetTier ?? null, createdByAdminId: actor(req) },
        });
        await audit(req, AUDIT_ACTIONS.ANNOUNCEMENT_CREATED, {
            announcementId: announcement.id,
            targetTier: announcement.targetTier,
        });
        res.status(201).json({ announcement });
    }
    catch (err) {
        next(err);
    }
});
router.get("/", requireAdminPermission("admin:announcements.view"), async (req, res, next) => {
    try {
        const q = validateOrThrow(query, req.query);
        const rows = await getPrismaClient().announcement.findMany({
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: q.limit + 1,
            ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        });
        await audit(req, AUDIT_ACTIONS.ANNOUNCEMENTS_VIEWED, { cursor: q.cursor ?? null });
        res.json({
            items: rows.slice(0, q.limit),
            nextCursor: rows.length > q.limit ? (rows[q.limit]?.id ?? null) : null,
        });
    }
    catch (err) {
        next(err);
    }
});
router.patch("/:announcementId", requireAdminPermission("admin:announcements.manage"), async (req, res, next) => {
    try {
        const current = await getPrismaClient().announcement.findUnique({ where: { id: aid(req) } });
        if (!current)
            throw new AppError(404, "ANNOUNCEMENT_NOT_FOUND", "Announcement not found");
        const input = validateOrThrow(update, req.body);
        if (current.publishedAt && input.publish === false)
            throw new AppError(409, "ANNOUNCEMENT_PUBLISHED", "Published announcements cannot be unpublished");
        const announcement = await getPrismaClient().announcement.update({
            where: { id: current.id },
            data: {
                ...(input.title !== undefined ? { title: input.title } : {}),
                ...(input.body !== undefined ? { body: input.body } : {}),
                ...(input.targetTier !== undefined ? { targetTier: input.targetTier } : {}),
                ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
                ...(input.publish && !current.publishedAt ? { publishedAt: new Date() } : {}),
            },
        });
        await audit(req, AUDIT_ACTIONS.ANNOUNCEMENT_UPDATED, {
            announcementId: announcement.id,
            published: input.publish === true,
            isActive: announcement.isActive,
            targetTier: announcement.targetTier,
        });
        res.json({ announcement });
    }
    catch (err) {
        next(err);
    }
});
router.get("/:announcementId/views", requireAdminPermission("admin:announcements.view"), async (req, res, next) => {
    try {
        const announcement = await getPrismaClient().announcement.findUnique({
            where: { id: aid(req) },
            select: { id: true },
        });
        if (!announcement)
            throw new AppError(404, "ANNOUNCEMENT_NOT_FOUND", "Announcement not found");
        const viewCount = await getPrismaClient().announcementView.count({
            where: { announcementId: announcement.id },
        });
        await audit(req, AUDIT_ACTIONS.ANNOUNCEMENT_VIEWS_VIEWED, {
            announcementId: announcement.id,
        });
        res.json({ announcementId: announcement.id, viewCount });
    }
    catch (err) {
        next(err);
    }
});
export { router as adminAnnouncementsRouter };
//# sourceMappingURL=routes.js.map