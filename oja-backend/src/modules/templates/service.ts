import { Prisma } from "../../../generated/prisma/client.js";
import type { $Enums, Subscription as SubscriptionRow } from "../../../generated/prisma/client.js";
import type { StoreTemplateGetPayload } from "../../../generated/prisma/models/StoreTemplate.js";
import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { TIER_PLANS, resolvePlan } from "../subscriptions/plan.js";
import { loadSubscription } from "../subscriptions/service.js";

/**
 * ============================================================
 * STOREFRONT TEMPLATES
 * ============================================================
 *
 * The storefront template catalog is dev-controlled platform data
 * (seeded by the migration and seed.ts), not merchant content. What an
 * account can SEE is gated by a template COUNT derived from the plan —
 * the same shape as the resource caps (dashboard-store-templates.md):
 *
 *   STARTER 3, PRO 5, ENTERPRISE null (all).
 *
 * The visible set is a SUPERSET: the catalog is ordered by sortOrder
 * and the first N (the tier's templateCap) are visible, so upgrading
 * never hides a template, it reveals more.
 *
 * Pre-subscription deviation: unlike the resource caps ("no
 * subscription = unlimited"), a store with NO subscription row — which
 * is every store at onboarding, since billing is not wired yet — sees
 * the STARTER set. An inactive subscription (PAST_DUE/CANCELLED) also
 * degrades to the STARTER set: templates are cosmetic, the storefront
 * keeps rendering the base set instead of breaking.
 * ============================================================
 */

/** Minimal surface of a Prisma transaction client that the service uses. */
export type TemplateTx = Pick<Prisma.TransactionClient, "storeTemplate">;

export interface TemplateView {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  previewUrl: string | null;
}

export interface AnnouncementBarSettings {
  enabled: boolean;
  text: string;
}

/**
 * The store's template customization, normalized to a stable full shape:
 * every key is always present, `null` (or a null sub-object) means "use
 * the template's default". Built from the compacted JSONB value — writes
 * strip null/undefined keys, so this is the shape the API always shows.
 */
export interface TemplateSettingsView {
  accentColor: string | null;
  logoUrl: string | null;
  heroText: string | null;
  heroSubtext: string | null;
  announcementBar: AnnouncementBarSettings | null;
}

export interface TemplateCatalog {
  templates: TemplateView[];
  tier: $Enums.SubscriptionTier;
  visibleCount: number;
  selectedTemplateId: string | null;
  settings: TemplateSettingsView | null;
}

/**
 * Normalizes the stored JSONB customization into the stable full shape.
 * Writes only ever store zod-validated objects, so this is mostly a
 * pass-through with null-filling; unknown shapes degrade gracefully to
 * nulls instead of throwing.
 */
export function normalizeSettings(raw: Prisma.JsonValue | null): TemplateSettingsView | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const s = raw as Record<string, unknown>;
  const announcementBar =
    s.announcementBar === null ||
    typeof s.announcementBar !== "object" ||
    Array.isArray(s.announcementBar)
      ? null
      : {
          enabled: Boolean((s.announcementBar as Record<string, unknown>).enabled),
          text: String((s.announcementBar as Record<string, unknown>).text ?? ""),
        };
  return {
    accentColor: typeof s.accentColor === "string" ? s.accentColor : null,
    logoUrl: typeof s.logoUrl === "string" ? s.logoUrl : null,
    heroText: typeof s.heroText === "string" ? s.heroText : null,
    heroSubtext: typeof s.heroSubtext === "string" ? s.heroSubtext : null,
    announcementBar,
  };
}

function templateView(row: StoreTemplateGetPayload<object>): TemplateView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    previewUrl: row.previewUrl,
  };
}

/**
 * Resolves the visibility cut for a (possibly null) subscription. Pure:
 * no Prisma access. `visibleCount` is the number of leading (lowest
 * sortOrder) templates the tier may see; Infinity = all.
 */
export function resolveTemplateVisibility(subscription: SubscriptionRow | null): {
  tier: $Enums.SubscriptionTier;
  visibleCount: number;
} {
  const starterCount = TIER_PLANS.STARTER.limits.templateCap ?? 0;
  if (subscription === null) {
    return { tier: "STARTER", visibleCount: starterCount };
  }
  const plan = resolvePlan(subscription);
  if (!plan.active) {
    // Inactive subscription degrades to the STARTER set: the storefront
    // keeps rendering the base templates instead of losing them all.
    return { tier: "STARTER", visibleCount: starterCount };
  }
  return { tier: plan.tier, visibleCount: plan.limits.templateCap ?? Infinity };
}

/**
 * Fetches the active templates ordered by sortOrder and slices them to
 * the subscription's visibility cut. Accepts an injected tx so callers
 * can fold the read into their own transaction.
 */
export async function listVisibleTemplates(
  subscription: SubscriptionRow | null,
  tx?: TemplateTx,
): Promise<TemplateView[]> {
  const { visibleCount } = resolveTemplateVisibility(subscription);
  const prisma = tx ?? getPrismaClient();
  const rows = await prisma.storeTemplate.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
  });
  const visible = visibleCount === Infinity ? rows : rows.slice(0, visibleCount);
  return visible.map(templateView);
}

/**
 * The authenticated account's visible template catalog (GET
 * /api/dashboard/templates). Works before onboarding: a tenant-less
 * account has no store, hence no subscription, hence the pre-subscription
 * STARTER set. Once a store exists the cut comes from its subscription.
 */
export async function getTemplateCatalog(accountId: string): Promise<TemplateCatalog> {
  const prisma = getPrismaClient();
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      owner: { select: { storeId: true } },
      staffMembers: { select: { storeId: true } },
    },
  });
  if (account === null) {
    throw new AppError(401, "UNAUTHORIZED", "Account not found");
  }

  const storeId = account.owner?.storeId ?? account.staffMembers[0]?.storeId ?? null;
  let subscription: SubscriptionRow | null = null;
  let selectedTemplateId: string | null = null;
  let settings: TemplateSettingsView | null = null;
  if (storeId !== null) {
    subscription = await loadSubscription(storeId);
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { templateId: true, templateSettings: true },
    });
    selectedTemplateId = store?.templateId ?? null;
    settings = normalizeSettings(store?.templateSettings ?? null);
  }

  const { tier, visibleCount } = resolveTemplateVisibility(subscription);
  const templates = await listVisibleTemplates(subscription);
  return { templates, tier, visibleCount, selectedTemplateId, settings };
}

/**
 * Sets the store's storefront template (PUT /api/dashboard/templates).
 * The target must be in the store's visible set for its tier — a
 * template beyond the count (or unknown/inactive) is rejected BEFORE any
 * write, so a direct API bypass attempt is rejected identically to the
 * UI flow.
 */
export async function selectStoreTemplate(
  storeId: string,
  templateId: string,
): Promise<{ template: TemplateView }> {
  const prisma = getPrismaClient();
  const subscription = await loadSubscription(storeId);
  const visible = await listVisibleTemplates(subscription);
  const chosen = visible.find((t) => t.id === templateId);
  if (chosen === undefined) {
    throw new AppError(
      400,
      "TEMPLATE_NOT_AVAILABLE",
      "That template is not available on your plan — upgrade to see more templates",
    );
  }
  await prisma.store.update({ where: { id: storeId }, data: { templateId } });
  return { template: chosen };
}

/**
 * Sets the store's template customization (PUT
 * /api/dashboard/templates/customization). Replace semantics: the body
 * is the full settings object; an omitted or null field is cleared back
 * to the template default. `{}` clears everything (stored as null, the
 * "never customized" state). Available to every tier — cosmetic, like
 * template selection, so no plan check applies.
 */
export async function setStoreTemplateSettings(
  storeId: string,
  settings: Record<string, unknown>,
): Promise<{ settings: TemplateSettingsView | null }> {
  const prisma = getPrismaClient();
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value !== null && value !== undefined) {
      compacted[key] = value;
    }
  }
  const stored: Prisma.InputJsonValue | undefined =
    Object.keys(compacted).length === 0 ? undefined : (compacted as Prisma.InputJsonValue);
  // DbNull = SQL NULL (vs JSON `null`): the "never customized" state.
  await prisma.store.update({
    where: { id: storeId },
    data: { templateSettings: stored ?? Prisma.DbNull },
  });
  return { settings: normalizeSettings((stored ?? null) as Prisma.JsonValue | null) };
}

/**
 * Resolves the onboarding template choice. Pre-onboarding the account
 * has no store, so the visible set is the pre-subscription STARTER set.
 * Omitted templateId defaults to the first visible template (lowest
 * sortOrder) — the store always ships with a template attached.
 */
export async function resolveOnboardingTemplateId(templateId: string | undefined): Promise<string> {
  const visible = await listVisibleTemplates(null);
  if (templateId === undefined) {
    const first = visible[0];
    if (first === undefined) {
      throw new AppError(500, "TEMPLATES_UNAVAILABLE", "No store templates are configured");
    }
    return first.id;
  }
  if (!visible.some((t) => t.id === templateId)) {
    throw new AppError(
      400,
      "TEMPLATE_NOT_AVAILABLE",
      "That template is not available on your plan — upgrade to see more templates",
    );
  }
  return templateId;
}
