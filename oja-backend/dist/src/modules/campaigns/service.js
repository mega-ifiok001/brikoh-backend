import { Prisma } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { validateOrThrow } from "../../lib/validate.js";
import { logStoreActivity } from "../activity/service.js";
import { SALES_STATUSES } from "../analytics/constants.js";
import { campaignCreateSchema, campaignUpdateSchema, listCampaignsParamsSchema, } from "./schemas.js";
/** "Now is inside the window" — same semantics as the storefront banner. */
function liveWindowWhere(now) {
    return {
        OR: [
            { startsAt: null, endsAt: null },
            { startsAt: null, endsAt: { gt: now } },
            { startsAt: { lte: now }, endsAt: null },
            { startsAt: { lte: now }, endsAt: { gt: now } },
        ],
    };
}
function mapRow(row) {
    return {
        id: row.id,
        name: row.name,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        bannerTitle: row.bannerTitle,
        bannerSubtitle: row.bannerSubtitle,
        ctaLabel: row.ctaLabel,
        discountId: row.discountId,
        discountCode: row.discount?.code ?? null,
        isActive: row.isActive,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
/** Cursor-paginated, newest-first campaigns with an optional isActive filter. */
export async function listCampaigns(storeId, rawParams) {
    const params = validateOrThrow(listCampaignsParamsSchema, rawParams);
    const prisma = getPrismaClient();
    const where = { storeId };
    if (params.isActive !== undefined)
        where.isActive = params.isActive;
    if (params.cursor !== undefined)
        where.id = { lt: params.cursor };
    const rows = await prisma.campaign.findMany({
        where,
        include: { discount: { select: { code: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: params.limit,
    });
    const nextCursor = rows.length === params.limit && rows.length > 0 ? rows.at(-1).id : null;
    return { items: rows.map(mapRow), nextCursor };
}
/**
 * Marketing header summary (dashboard-campaigns.md). Computed live:
 * campaigns are banners — there is no sent/reach tracking — so the
 * performance story is the linked coupon's redemption/attribution.
 */
export async function getCampaignStats(storeId) {
    const prisma = getPrismaClient();
    const now = new Date();
    const [totalCampaigns, activeCampaigns, activeCoupons, totalRedemptions, campaigns] = await Promise.all([
        prisma.campaign.count({ where: { storeId } }),
        prisma.campaign.count({ where: { storeId, isActive: true, ...liveWindowWhere(now) } }),
        prisma.discount.count({
            where: {
                storeId,
                isActive: true,
                ...liveWindowWhere(now),
                // Coupon-ness matches the sale-time rule: at least one coupon
                // limit present (perCustomerUses defaults to 1 for every
                // discount and is deliberately not a signal).
                OR: [
                    { maxUses: { not: null } },
                    { minSubtotal: { not: null } },
                    { firstOrderOnly: { not: null } },
                ],
            },
        }),
        prisma.couponRedemption.count({ where: { storeId } }),
        prisma.campaign.findMany({
            where: { storeId },
            include: { discount: { select: { code: true } } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        }),
    ]);
    const discountIds = campaigns
        .map((campaign) => campaign.discountId)
        .filter((id) => id !== null);
    const redemptionsByDiscount = new Map();
    const attributionByDiscount = new Map();
    if (discountIds.length > 0) {
        const groups = await prisma.couponRedemption.groupBy({
            by: ["discountId"],
            where: { storeId, discountId: { in: discountIds } },
            _count: true,
        });
        for (const group of groups) {
            redemptionsByDiscount.set(group.discountId, group._count);
        }
        const redemptions = await prisma.couponRedemption.findMany({
            where: { storeId, discountId: { in: discountIds } },
            select: {
                discountId: true,
                order: { select: { status: true, total: true } },
            },
        });
        for (const redemption of redemptions) {
            if (!SALES_STATUSES.includes(redemption.order.status))
                continue;
            const current = attributionByDiscount.get(redemption.discountId) ?? {
                orders: 0,
                revenue: new Prisma.Decimal(0),
            };
            current.orders += 1;
            current.revenue = current.revenue.add(redemption.order.total);
            attributionByDiscount.set(redemption.discountId, current);
        }
    }
    return {
        totalCampaigns,
        activeCampaigns,
        activeCoupons,
        totalRedemptions,
        campaigns: campaigns.map((campaign) => {
            const attribution = campaign.discountId === null ? undefined : attributionByDiscount.get(campaign.discountId);
            return {
                id: campaign.id,
                name: campaign.name,
                discountCode: campaign.discount?.code ?? null,
                redemptions: campaign.discountId === null ? 0 : (redemptionsByDiscount.get(campaign.discountId) ?? 0),
                attributedOrders: attribution?.orders ?? 0,
                attributedRevenue: (attribution?.revenue ?? new Prisma.Decimal(0)).toFixed(2),
            };
        }),
    };
}
/** Verifies a linked discount belongs to the tenant (404 when it does not). */
async function assertDiscountInStore(storeId, discountId) {
    const row = await getPrismaClient().discount.findFirst({
        where: { id: discountId, storeId },
        select: { id: true },
    });
    if (row === null) {
        throw new AppError(404, "DISCOUNT_NOT_FOUND", "Discount not found");
    }
}
/** Creates a campaign; a linked discountId must belong to the store. */
export async function createCampaign(storeId, staffMemberId, rawInput) {
    const data = validateOrThrow(campaignCreateSchema, rawInput);
    const prisma = getPrismaClient();
    if (data.discountId !== undefined && data.discountId !== null) {
        await assertDiscountInStore(storeId, data.discountId);
    }
    const row = await prisma.campaign.create({
        data: {
            storeId,
            name: data.name,
            startsAt: data.startsAt ?? null,
            endsAt: data.endsAt ?? null,
            bannerTitle: data.bannerTitle ?? null,
            bannerSubtitle: data.bannerSubtitle ?? null,
            ctaLabel: data.ctaLabel ?? null,
            discountId: data.discountId ?? null,
            isActive: data.isActive ?? true,
        },
        include: { discount: { select: { code: true } } },
    });
    await logStoreActivity(prisma, {
        storeId,
        staffMemberId: staffMemberId ?? null,
        action: "campaign.created",
        detail: { campaignId: row.id, name: row.name },
    });
    return mapRow(row);
}
/** One campaign; unknown or cross-tenant ids are indistinguishable (404). */
export async function getCampaign(storeId, campaignId) {
    const row = await getPrismaClient().campaign.findFirst({
        where: { id: campaignId, storeId },
        include: { discount: { select: { code: true } } },
    });
    if (row === null) {
        throw new AppError(404, "CAMPAIGN_NOT_FOUND", "Campaign not found");
    }
    return mapRow(row);
}
/**
 * Updates only the provided fields. The conditional updateMany is the
 * authority: a zero-row match means unknown or cross-tenant (404).
 * Explicit null clears the optional fields; a new discountId must
 * belong to the store.
 */
export async function updateCampaign(storeId, staffMemberId, campaignId, rawInput) {
    const data = validateOrThrow(campaignUpdateSchema, rawInput);
    const prisma = getPrismaClient();
    if (data.discountId !== undefined && data.discountId !== null) {
        await assertDiscountInStore(storeId, data.discountId);
    }
    const updated = await prisma.campaign.updateMany({
        where: { id: campaignId, storeId },
        data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.startsAt !== undefined ? { startsAt: data.startsAt } : {}),
            ...(data.endsAt !== undefined ? { endsAt: data.endsAt } : {}),
            ...(data.bannerTitle !== undefined ? { bannerTitle: data.bannerTitle } : {}),
            ...(data.bannerSubtitle !== undefined ? { bannerSubtitle: data.bannerSubtitle } : {}),
            ...(data.ctaLabel !== undefined ? { ctaLabel: data.ctaLabel } : {}),
            ...(data.discountId !== undefined ? { discountId: data.discountId } : {}),
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        },
    });
    if (updated.count === 0) {
        throw new AppError(404, "CAMPAIGN_NOT_FOUND", "Campaign not found");
    }
    const row = await prisma.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        include: { discount: { select: { code: true } } },
    });
    await logStoreActivity(prisma, {
        storeId,
        staffMemberId: staffMemberId ?? null,
        action: "campaign.updated",
        detail: { campaignId, updatedFields: Object.keys(data) },
    });
    return mapRow(row);
}
/**
 * Deletes a campaign. The linked discount and its redemption history are
 * untouched. The conditional delete is the authority; zero-row match =
 * 404.
 */
export async function deleteCampaign(storeId, staffMemberId, campaignId) {
    const prisma = getPrismaClient();
    const deleted = await prisma.campaign.deleteMany({
        where: { id: campaignId, storeId },
    });
    if (deleted.count === 0) {
        throw new AppError(404, "CAMPAIGN_NOT_FOUND", "Campaign not found");
    }
    await logStoreActivity(prisma, {
        storeId,
        staffMemberId: staffMemberId ?? null,
        action: "campaign.deleted",
        detail: { campaignId },
    });
}
//# sourceMappingURL=service.js.map