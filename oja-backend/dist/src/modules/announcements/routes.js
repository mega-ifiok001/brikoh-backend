import { Router } from "express";
import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { resolvePlan } from "../subscriptions/plan.js";
const router = Router();
const id = (req) => {
    const value = req.params.announcementId;
    if (typeof value !== "string" || value === "")
        throw new AppError(400, "VALIDATION_ERROR", "announcementId is required");
    return value;
};
const tenant = (req) => {
    if (!req.tenant)
        throw new AppError(401, "UNAUTHORIZED", "Authentication required");
    return req.tenant.storeId;
};
router.get("/", async (req, res, next) => {
    try {
        const storeId = tenant(req);
        const store = await getPrismaClient().store.findUnique({
            where: { id: storeId },
            select: {
                subscription: {
                    select: {
                        tier: true,
                        status: true,
                        staffCap: true,
                        locationCap: true,
                        productCap: true,
                        orderCap: true,
                        templateCap: true,
                    },
                },
            },
        });
        if (!store)
            throw new AppError(401, "UNAUTHORIZED", "Authentication required");
        const tier = resolvePlan(store.subscription).tier;
        const items = await getPrismaClient().announcement.findMany({
            where: {
                isActive: true,
                publishedAt: { not: null },
                OR: [{ targetTier: null }, { targetTier: tier }],
            },
            orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
            select: {
                id: true,
                title: true,
                body: true,
                targetTier: true,
                publishedAt: true,
                createdAt: true,
            },
        });
        res.json({ items });
    }
    catch (err) {
        next(err);
    }
});
router.post("/:announcementId/view", async (req, res, next) => {
    try {
        const storeId = tenant(req);
        const store = await getPrismaClient().store.findUnique({
            where: { id: storeId },
            select: {
                subscription: {
                    select: {
                        tier: true,
                        status: true,
                        staffCap: true,
                        locationCap: true,
                        productCap: true,
                        orderCap: true,
                        templateCap: true,
                    },
                },
            },
        });
        const tier = resolvePlan(store?.subscription ?? null).tier;
        const announcement = await getPrismaClient().announcement.findFirst({
            where: {
                id: id(req),
                isActive: true,
                publishedAt: { not: null },
                OR: [{ targetTier: null }, { targetTier: tier }],
            },
            select: { id: true },
        });
        if (!announcement)
            throw new AppError(404, "ANNOUNCEMENT_NOT_FOUND", "Announcement not found");
        await getPrismaClient().announcementView.upsert({
            where: { announcementId_storeId: { announcementId: announcement.id, storeId } },
            create: { announcementId: announcement.id, storeId },
            update: {},
        });
        res.status(204).end();
    }
    catch (err) {
        next(err);
    }
});
export { router as announcementsRouter };
//# sourceMappingURL=routes.js.map