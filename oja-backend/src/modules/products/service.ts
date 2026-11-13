import type { Prisma, PrismaClient, $Enums } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { validateOrThrow } from "../../lib/validate.js";
import { logStoreActivity } from "../activity/service.js";
import { enforceProductCap } from "../subscriptions/service.js";
import { scheduleProductImageCleanup } from "../uploads/cleanup.js";
import { recordInitialStockChanges } from "./ledger.service.js";
import {
  createProductSchema,
  listProductsParamsSchema,
  listPublicProductsParamsSchema,
  setProductOptionsSchema,
  updateProductSchema,
  variantCreateSchema,
  variantUpdateSchema,
  type CreateProductInput,
  type ListProductsParams,
  type ListPublicProductsParams,
  type SetProductOptionsInput,
  type UpdateProductInput,
  type VariantCreateInput,
  type VariantUpdateInput,
} from "./schemas.js";

/** Product rows as served to the dashboard always carry their options,
 * variants (with their option links), category, and unit. */
type ProductRow = Prisma.ProductGetPayload<{ include: typeof variantsInclude }>;

/** Variants ride along on every product read, oldest first, each with its
 * option links resolved to { option name, value }; the product's option
 * dimensions ride along with their values. */
const variantsInclude = {
  variants: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: {
      optionValues: {
        select: {
          optionValue: { select: { value: true, option: { select: { name: true } } } },
        },
      },
    },
  },
  options: {
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    include: { values: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] } },
  },
  category: true,
  unit: true,
} satisfies Prisma.ProductInclude;

type VariantRow = ProductRow["variants"][number];
/** A variant as the API exposes it: option links flattened to {name, value}. */
export type ProductVariantView = Omit<VariantRow, "optionValues"> & {
  options: { name: string; value: string }[];
};
export type ProductView = Omit<ProductRow, "variants"> & { variants: ProductVariantView[] };

/** Reshapes a Prisma product row into the API shape (flattens each
 * variant's option links into `variants[].options`). */
function mapProductView(row: ProductRow): ProductView {
  const { variants, ...rest } = row;
  return {
    ...rest,
    variants: variants.map(({ optionValues, ...variant }) => ({
      ...variant,
      options: optionValues.map((link) => ({
        name: link.optionValue.option.name,
        value: link.optionValue.value,
      })),
    })),
  };
}

/** List-only include: salesCount = orderLineItem rows across all order
 * statuses (variants included). */
const listInclude = {
  ...variantsInclude,
  _count: { select: { orderLineItems: true } },
} satisfies Prisma.ProductInclude;

/**
 * Validates catalog references for tenant ownership. Unknown or
 * cross-tenant ids are classified 404 — the same "indistinguishable"
 * convention as the product itself. Null/undefined pass through (a null
 * clears the link; an undefined leaves it untouched).
 */
async function resolveCatalogRefs(
  prisma: PrismaClient,
  storeId: string,
  refs: { categoryId?: string | null; unitId?: string | null },
): Promise<{ categoryId: string | null; unitId: string | null }> {
  const checks: Promise<void>[] = [];
  if (refs.categoryId !== undefined && refs.categoryId !== null) {
    checks.push(
      prisma.category
        .findFirst({ where: { id: refs.categoryId, storeId }, select: { id: true } })
        .then((row) => {
          if (row === null) throw new AppError(404, "NOT_FOUND", "Category not found");
        }),
    );
  }
  if (refs.unitId !== undefined && refs.unitId !== null) {
    checks.push(
      prisma.unit
        .findFirst({ where: { id: refs.unitId, storeId }, select: { id: true } })
        .then((row) => {
          if (row === null) throw new AppError(404, "NOT_FOUND", "Unit not found");
        }),
    );
  }
  await Promise.all(checks);
  return {
    categoryId: refs.categoryId ?? null,
    unitId: refs.unitId ?? null,
  };
}

export interface ProductListResult {
  items: (ProductView & { salesCount: number })[];
  nextCursor: string | null;
  total: number;
}

/**
 * Creates a product in the tenant's catalog. The tenant is always the
 * caller-supplied storeId from req.tenant — never client input.
 *
 * Enforces the subscription's productCap (409 PRODUCT_LIMIT_REACHED) when the
 * store has a subscription with a non-null cap; no subscription = unlimited.
 *
 * Optional nested variants (create-only this phase). A product WITH
 * variants keeps quantity 0 — its stock is per-variant from here on.
 *
 * BRANCHES: the product's stock rows (BranchStock, the per-branch
 * counters) are created EAGERLY in this transaction — a zero-quantity
 * row for the product and one per variant, all in the store's default
 * branch — so every (branch, product, variant) row always exists for
 * movements to guard against. The seed movements below then increment
 * those rows through the ledger.
 *
 * STARTING STOCK: an `initialStock` (variant-less products) or a
 * per-variant `initialStock` seeds the stock INSIDE the same transaction
 * through the ledger (recordInitialStockChanges, reason INITIAL_STOCK) —
 * the quantity cache is never written directly, and every seed movement
 * is a ledger row. The product row and its seed entries commit or roll
 * back together.
 */
/** One variant to persist: an explicit variant or one grid combination. */
interface VariantSpec {
  name: string;
  sellingPrice: string | null | undefined;
  sku: string | null | undefined;
  initialStock: number | undefined;
  /** productOptionValue ids this variant links to (empty for explicit). */
  valueIds: string[];
}

/** Creates a product's option dimensions + their values; returns them
 * grouped by option so the grid can be built from the value ids. */
async function createOptionRows(
  tx: Prisma.TransactionClient,
  storeId: string,
  productId: string,
  options: { name: string; values: string[] }[],
): Promise<{ optionId: string; values: { id: string; value: string }[] }[]> {
  const groups: { optionId: string; values: { id: string; value: string }[] }[] = [];
  for (let i = 0; i < options.length; i += 1) {
    const opt = options[i]!;
    const option = await tx.productOption.create({
      data: { storeId, productId, name: opt.name, sortOrder: i },
      select: { id: true },
    });
    const values: { id: string; value: string }[] = [];
    for (let j = 0; j < opt.values.length; j += 1) {
      const v = await tx.productOptionValue.create({
        data: { storeId, optionId: option.id, value: opt.values[j]!, sortOrder: j },
        select: { id: true, value: true },
      });
      values.push(v);
    }
    groups.push({ optionId: option.id, values });
  }
  return groups;
}

/** Cartesian product of option values → variant specs with derived names
 * ("Red / M"). One option → one axis; two → a grid; zero → no variants. */
function gridSpecs(groups: { optionId: string; values: { id: string; value: string }[] }[]): VariantSpec[] {
  let combos: { valueIds: string[]; labels: string[] }[] = [{ valueIds: [], labels: [] }];
  for (const group of groups) {
    const next: typeof combos = [];
    for (const combo of combos) {
      for (const v of group.values) {
        next.push({ valueIds: [...combo.valueIds, v.id], labels: [...combo.labels, v.value] });
      }
    }
    combos = next;
  }
  return combos.map((c) => ({
    name: c.labels.join(" / "),
    sellingPrice: null,
    sku: null,
    initialStock: undefined,
    valueIds: c.valueIds,
  }));
}

/** Creates the variant rows, their option links, and their default-branch
 * BranchStock rows. Returns each created variant's id + seed quantity. */
async function persistVariants(
  tx: Prisma.TransactionClient,
  storeId: string,
  productId: string,
  branchId: string,
  specs: VariantSpec[],
): Promise<{ id: string; initialStock: number | undefined }[]> {
  const out: { id: string; initialStock: number | undefined }[] = [];
  for (const spec of specs) {
    const variant = await tx.productVariant.create({
      data: {
        storeId,
        productId,
        name: spec.name,
        sellingPrice: spec.sellingPrice ?? null,
        sku: spec.sku ?? null,
      },
      select: { id: true },
    });
    if (spec.valueIds.length > 0) {
      await tx.productVariantOptionValue.createMany({
        data: spec.valueIds.map((optionValueId) => ({ variantId: variant.id, optionValueId })),
      });
    }
    await tx.branchStock.create({
      data: { storeId, branchId, productId, variantId: variant.id, quantity: 0 },
    });
    out.push({ id: variant.id, initialStock: spec.initialStock });
  }
  return out;
}

export async function createProduct(
  storeId: string,
  input: unknown,
  staffMemberId?: string,
): Promise<ProductView> {
  const data = validateOrThrow(createProductSchema, input) as CreateProductInput;
  await enforceProductCap(storeId);
  const prisma = getPrismaClient();
  const { variants, options, initialStock, categoryId, unitId, ...fields } = data;
  const refs = await resolveCatalogRefs(prisma, storeId, { categoryId, unitId });

  const productId = await prisma.$transaction(async (tx) => {
    const store = await tx.store.findUnique({
      where: { id: storeId },
      select: { defaultBranchId: true },
    });
    if (store === null || store.defaultBranchId === null) {
      // Post-onboarding every store has a default branch; a store
      // without one is a broken tenant, not a client mistake.
      throw new AppError(
        409,
        "STORE_NOT_CONFIGURED",
        "This store has no default branch — create one before adding products",
      );
    }
    const branchId = store.defaultBranchId;

    const created = await tx.product.create({
      data: {
        storeId,
        ...fields,
        // Only set when provided — a null explicit write is noise the DB
        // defaults anyway, and omitting keeps the write minimal.
        ...(refs.categoryId !== null ? { categoryId: refs.categoryId } : {}),
        ...(refs.unitId !== null ? { unitId: refs.unitId } : {}),
      },
      select: { id: true },
    });

    // EAGER PRODUCT-LEVEL BRANCH STOCK ROW (the branch-stock invariant):
    // exactly one variant-less row so a variant-less product always has a
    // guarded target. Variant rows get their own below.
    await tx.branchStock.create({
      data: { storeId, branchId, productId: created.id, variantId: null, quantity: 0 },
    });

    // Variant specs: from the option grid when `options` is present, else
    // from the explicit `variants` list.
    let specs: VariantSpec[] = [];
    if (options.length > 0) {
      const groups = await createOptionRows(tx, storeId, created.id, options);
      specs = gridSpecs(groups);
    } else if (variants.length > 0) {
      specs = variants.map((variant) => ({
        name: variant.name,
        sellingPrice: variant.sellingPrice,
        sku: variant.sku,
        initialStock: variant.initialStock,
        valueIds: [],
      }));
    }
    if (specs.length > 50) {
      throw new AppError(409, "VARIANT_LIMIT_REACHED", "A product can have at most 50 variants");
    }

    const createdVariants = await persistVariants(tx, storeId, created.id, branchId, specs);

    // Seed movements: product-level initialStock first (variant-less),
    // then each variant's own initialStock.
    const changes: {
      storeId: string;
      branchId: string;
      productId: string;
      variantId?: string;
      quantityChange: number;
    }[] = [];
    if (initialStock !== undefined) {
      changes.push({ storeId, branchId, productId: created.id, quantityChange: initialStock });
    }
    for (const variant of createdVariants) {
      if (variant.initialStock !== undefined) {
        changes.push({
          storeId,
          branchId,
          productId: created.id,
          variantId: variant.id,
          quantityChange: variant.initialStock,
        });
      }
    }
    if (changes.length > 0) {
      await recordInitialStockChanges(tx, changes);
    }
    return created.id;
  });

  const row = await prisma.product.findUniqueOrThrow({
    where: { id: productId },
    include: variantsInclude,
  });
  await logStoreActivity(prisma, {
    storeId,
    staffMemberId,
    action: "product.created",
    detail: { productId, name: row.name, variantCount: row.variants.length },
  });
  return mapProductView(row);
}

/**
 * Returns one non-deleted product of the tenant. Unknown, cross-tenant,
 * and soft-deleted products are indistinguishable (404).
 */
export async function getProduct(storeId: string, productId: string): Promise<ProductView> {
  const row = await getPrismaClient().product.findFirst({
    where: { id: productId, storeId, deletedAt: null },
    include: variantsInclude,
  });
  if (row === null) {
    throw new AppError(404, "NOT_FOUND", "Product not found");
  }
  return mapProductView(row);
}

/**
 * Cursor-paginated list of the tenant's non-deleted products, ordered by
 * createdAt DESC with id DESC as the tie-break so the ordering is stable
 * under inserts. Fetches limit+1 rows to learn whether a next page
 * exists; nextCursor is the last returned id when it does. A cursor
 * whose row no longer exists is a validation error — Prisma silently
 * returns an empty page for it, which would be indistinguishable from
 * the end of the list.
 */
export async function listProducts(storeId: string, input: unknown): Promise<ProductListResult> {
  const { limit, cursor } = validateOrThrow(listProductsParamsSchema, input) as ListProductsParams;
  const prisma = getPrismaClient();
  if (cursor !== undefined) {
    const cursorRow = await prisma.product.findUnique({
      where: { id: cursor },
      select: { id: true },
    });
    if (cursorRow === null) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid cursor");
    }
  }
  const [rows, total] = await Promise.all([
    prisma.product.findMany({
      where: { storeId, deletedAt: null },
      include: listInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      skip: cursor === undefined ? 0 : 1,
      cursor: cursor === undefined ? undefined : { id: cursor },
    }),
    prisma.product.count({ where: { storeId, deletedAt: null } }),
  ]);
  const hasMore = rows.length > limit;
  // nextCursor is the last RETURNED item's id, never the lookahead row:
  // the next request positions its cursor on it (skip: 1) and therefore
  // starts at the first not-yet-returned row. Pointing at the lookahead
  // row would silently drop it from every subsequent page.
  return {
    items: rows.slice(0, limit).map(({ _count, ...row }) => ({
      ...mapProductView(row),
      salesCount: _count.orderLineItems,
    })),
    nextCursor: hasMore ? rows[limit - 1]!.id : null,
    total,
  };
}

/**
 * ============================================================
 * PUBLIC STOREFRONT PRODUCT CATALOG
 * ============================================================
 * Unauthenticated, read-only product listing for the customer-facing
 * storefront. Only PUBLISHED, non-deleted products are ever surfaced.
 * The authoritative per-branch stock lives on BranchStock, but its
 * cross-branch total is denormalized onto Product.quantity /
 * ProductVariant.quantity by ledger.service — so we read those totals
 * for store-wide availability on the storefront.
 */

export type StockStatus = "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";

export interface PublicProductOption {
  name: string;
  values: string[];
}

export interface PublicProductVariant {
  id: string;
  name: string;
  /** Overrides the parent product's price when set; null = use product.price. */
  sellingPrice: string | null;
  stockStatus: StockStatus;
  options: { name: string; value: string }[];
}

export interface PublicProductListItem {
  id: string;
  name: string;
  description: string | null;
  price: string;
  discountPrice: string | null;
  coverImageUrl: string | null;
  images: string[];
  category: { id: string; name: string } | null;
  unit: { id: string; name: string } | null;
  options: PublicProductOption[];
  variants: PublicProductVariant[];
  stockStatus: StockStatus;
}

export interface PublicProductListResult {
  items: PublicProductListItem[];
  nextCursor: string | null;
  total: number;
  /** Present (and human-readable) only when the result set is empty. */
  message?: string;
}

type PublicProductRow = Prisma.ProductGetPayload<{ include: typeof variantsInclude }>;

function variantStockStatus(quantity: number, threshold: number | null): StockStatus {
  if (quantity <= 0) return "OUT_OF_STOCK";
  if (threshold !== null && quantity <= threshold) return "LOW_STOCK";
  return "IN_STOCK";
}

/** Product-level status: aggregate over ACTIVE variants when the product
 * is variant-based; otherwise the product's own cross-branch total. The
 * single `lowStockThreshold` (Inventory Dashboard's "alert at N") is the
 * one source of truth for what "low" means. Archived variants are ignored. */
function productStockStatus(row: PublicProductRow): StockStatus {
  const threshold = row.lowStockThreshold;
  const active = row.variants.filter((v) => v.archivedAt === null);
  if (active.length > 0) {
    const anyAvailable = active.some((v) => v.quantity > 0);
    if (!anyAvailable) return "OUT_OF_STOCK";
    if (threshold !== null && active.some((v) => v.quantity > 0 && v.quantity <= threshold)) {
      return "LOW_STOCK";
    }
    return "IN_STOCK";
  }
  return variantStockStatus(row.quantity, threshold);
}

function mapPublicProduct(row: PublicProductRow): PublicProductListItem {
  // Archived variants are hidden from the storefront entirely.
  const variants: PublicProductVariant[] = row.variants
    .filter((v) => v.archivedAt === null)
    .map((v) => ({
      id: v.id,
      name: v.name,
      sellingPrice: v.sellingPrice !== null ? v.sellingPrice.toFixed(2) : null,
      stockStatus: variantStockStatus(v.quantity, row.lowStockThreshold),
      options: v.optionValues.map((link) => ({
        name: link.optionValue.option.name,
        value: link.optionValue.value,
      })),
    }));
  const options: PublicProductOption[] = row.options.map((o) => ({
    name: o.name,
    values: o.values.map((val) => val.value),
  }));
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: row.price.toFixed(2),
    discountPrice: row.discountPrice !== null ? row.discountPrice.toFixed(2) : null,
    coverImageUrl: row.coverImageUrl,
    images: row.images,
    category: row.category ? { id: row.category.id, name: row.category.name } : null,
    unit: row.unit ? { id: row.unit.id, name: row.unit.name } : null,
    options,
    variants,
    stockStatus: productStockStatus(row),
  };
}

/**
 * Cursor-paginated, unauthenticated list of the store's PUBLISHED
 * products. Supports optional name search (`q`) and category filtering
 * (`categoryId`). A well-formed filter that matches nothing returns an
 * empty 200 with a human-readable `message` — never a 404. The cursor is
 * uuid-validated so a malformed page link is a clean 400.
 */
export async function listPublicProducts(
  storeId: string,
  input: unknown,
): Promise<PublicProductListResult> {
  const { limit, cursor, categoryId, q } = validateOrThrow(
    listPublicProductsParamsSchema,
    input,
  ) as ListPublicProductsParams;
  const prisma = getPrismaClient();

  if (cursor !== undefined) {
    const cursorRow = await prisma.product.findUnique({
      where: { id: cursor },
      select: { id: true },
    });
    if (cursorRow === null) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "That page link is invalid — please start from the first page.",
      );
    }
  }

  const where: Prisma.ProductWhereInput = {
    storeId,
    deletedAt: null,
    status: "PUBLISHED",
  };
  if (categoryId !== undefined) where.categoryId = categoryId;
  if (q !== undefined && q.trim() !== "") {
    where.name = { contains: q.trim(), mode: "insensitive" };
  }

  const [rows, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: listInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      skip: cursor === undefined ? 0 : 1,
      cursor: cursor === undefined ? undefined : { id: cursor },
    }),
    prisma.product.count({ where }),
  ]);

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(mapPublicProduct);

  let message: string | undefined;
  if (items.length === 0) {
    if (q !== undefined && q.trim() !== "" && categoryId !== undefined) {
      message = "No products match your search in this category.";
    } else if (q !== undefined && q.trim() !== "") {
      message = `No products match "${q.trim()}". Try a different spelling or search term.`;
    } else if (categoryId !== undefined) {
      message = "There are no products in this category yet.";
    } else {
      message = "This store hasn't published any products yet.";
    }
  }

  return {
    items,
    nextCursor: hasMore ? rows[limit - 1]!.id : null,
    total,
    message,
  };
}

/**
 * Single published product for the customer-facing detail page. Unknown,
 * cross-tenant, soft-deleted, or DRAFT products are indistinguishable
 * (404) so the storefront never reveals unpublished inventory.
 */
export async function getPublicProduct(
  storeId: string,
  productId: string,
): Promise<PublicProductListItem> {
  const prisma = getPrismaClient();
  const row = await prisma.product.findFirst({
    where: { id: productId, storeId, deletedAt: null, status: "PUBLISHED" },
    include: variantsInclude,
  });
  if (row === null) {
    throw new AppError(
      404,
      "PRODUCT_NOT_FOUND",
      "We couldn't find that product. It may have been removed or isn't available yet.",
    );
  }
  return mapPublicProduct(row);
}

/**
 * Updates only the provided fields. `quantity` is never accepted here —
 * the strict schema rejects it. The conditional updateMany is the
 * authority: a zero-row match means unknown, cross-tenant, or
 * soft-deleted, all surfaced as 404.
 *
 * A discountPrice set WITHOUT a new price is validated against the
 * product's CURRENT price (a discount must discount); when both are
 * sent, the schema refine already rejected discountPrice >= price.
 */
export async function updateProduct(
  storeId: string,
  productId: string,
  input: unknown,
  staffMemberId?: string,
): Promise<ProductView> {
  const data = validateOrThrow(updateProductSchema, input) as UpdateProductInput;
  const prisma = getPrismaClient();
  const { categoryId, unitId, ...fields } = data;
  const refs = await resolveCatalogRefs(prisma, storeId, { categoryId, unitId });

  // When images or the cover photo are being replaced, capture the
  // current references BEFORE the write so the removed assets can be
  // cleaned up from Cloudinary afterwards (best-effort, fire-and-forget).
  const imagesChanged = fields.images !== undefined || fields.coverImageUrl !== undefined;
  const existingImages = imagesChanged
    ? await prisma.product.findFirst({
        where: { id: productId, storeId, deletedAt: null },
        select: { images: true, coverImageUrl: true },
      })
    : null;

  if (fields.discountPrice !== undefined && fields.price === undefined) {
    const current = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
      select: { price: true },
    });
    if (current === null) {
      throw new AppError(404, "NOT_FOUND", "Product not found");
    }
    if (fields.discountPrice !== null && Number(fields.discountPrice) >= Number(current.price)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "discountPrice must be lower than price",
        "discountPrice is not lower than the current price",
      );
    }
  }

  const updated = await prisma.product.updateMany({
    where: { id: productId, storeId, deletedAt: null },
    data: {
      ...fields,
      ...(categoryId !== undefined ? { categoryId: refs.categoryId } : {}),
      ...(unitId !== undefined ? { unitId: refs.unitId } : {}),
    },
  });
  if (updated.count === 0) {
    throw new AppError(404, "NOT_FOUND", "Product not found");
  }
  const row = await prisma.product.findUniqueOrThrow({
    where: { id: productId },
    include: variantsInclude,
  });
  await logStoreActivity(prisma, {
    storeId,
    staffMemberId,
    action: "product.updated",
    detail: { productId, name: row.name, updatedFields: Object.keys(data) },
  });

  // Best-effort Cloudinary cleanup of the images this update removed.
  if (existingImages !== null) {
    const kept = new Set<string>([
      ...(fields.images ?? (existingImages.images as string[] | undefined) ?? []),
      ...(fields.coverImageUrl !== undefined
        ? fields.coverImageUrl === null
          ? []
          : [fields.coverImageUrl]
        : existingImages.coverImageUrl !== null
          ? [existingImages.coverImageUrl]
          : []),
    ]);
    const removed = [
      ...(existingImages.images as string[] | undefined) ?? [],
      ...(existingImages.coverImageUrl !== null ? [existingImages.coverImageUrl] : []),
    ].filter((url) => !kept.has(url));
    const uniqueRemoved = [...new Set(removed)];
    if (uniqueRemoved.length > 0) {
      scheduleProductImageCleanup(storeId, uniqueRemoved);
    }
  }

  return mapProductView(row);
}

/**
 * Publishes a product: it becomes buyable at public checkout. Products
 * start DRAFT at creation; this is the explicit go-live step (4.1's
 * "Save as Draft OR Publish"). The conditional updateMany is the
 * authority: a zero-row match means unknown, cross-tenant, or
 * soft-deleted, surfaced as 404. Publishing an already-published product
 * is a silent no-op (idempotent, safe to retry).
 */
export async function publishProduct(
  storeId: string,
  productId: string,
  staffMemberId?: string,
): Promise<ProductView> {
  return setProductStatus(storeId, productId, "PUBLISHED", "product.published", staffMemberId);
}

/**
 * Unpublishes a product: it disappears from public checkout but stays in
 * the inventory list and retains its stock. Idempotent like publish.
 */
export async function unpublishProduct(
  storeId: string,
  productId: string,
  staffMemberId?: string,
): Promise<ProductView> {
  return setProductStatus(storeId, productId, "DRAFT", "product.unpublished", staffMemberId);
}

async function setProductStatus(
  storeId: string,
  productId: string,
  status: $Enums.ProductStatus,
  action: string,
  staffMemberId?: string,
): Promise<ProductView> {
  const prisma = getPrismaClient();
  // PUBLISH GATE: a product cannot go live unless it is ready to be
  // shown and sold — it needs a category, a unit, and at least one
  // photo. Name and selling price are DB-required at create, so they
  // cannot be missing. Republishing an already-published product stays
  // a silent no-op (idempotent) and does not re-run the gate.
  if (status === "PUBLISHED") {
    const existing = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
      select: { status: true, categoryId: true, unitId: true, coverImageUrl: true, images: true },
    });
    if (existing === null) {
      throw new AppError(404, "NOT_FOUND", "Product not found");
    }
    if (existing.status !== "PUBLISHED") {
      const missing: string[] = [];
      if (existing.categoryId === null) missing.push("category");
      if (existing.unitId === null) missing.push("unit");
      if (existing.coverImageUrl === null && existing.images.length === 0) {
        missing.push("a product photo");
      }
      if (missing.length > 0) {
        throw new AppError(
          409,
          "PRODUCT_NOT_READY_TO_PUBLISH",
          `Cannot publish — missing: ${missing.join(", ")}`,
        );
      }
    }
  }
  const updated = await prisma.product.updateMany({
    where: { id: productId, storeId, deletedAt: null },
    data: { status },
  });
  if (updated.count === 0) {
    throw new AppError(404, "NOT_FOUND", "Product not found");
  }
  const row = await prisma.product.findUniqueOrThrow({
    where: { id: productId },
    include: variantsInclude,
  });
  await logStoreActivity(prisma, {
    storeId,
    staffMemberId,
    action,
    detail: { productId, name: row.name },
  });
  return mapProductView(row);
}

/**
 * ============================================================
 * PRODUCT OPTIONS & VARIANT MANAGEMENT
 * ============================================================
 * Dimensions (max 2) are defined via setProductOptions, which reconciles
 * the option/value rows and the generated variant grid: existing
 * combinations are preserved (their price/SKU/stock/archive state survive
 * — matching is by the variant's option-value set), missing combinations
 * are created, and dropped combinations are archived. Individual variants
 * are then edited (name/price/SKU) or archived/restored. Nothing is ever
 * hard-deleted — order and ledger history reference the variant.
 */

/** Case-insensitively de-dupes a list of trimmed strings, keeping order. */
function dedupeValues(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** Stable key for a combination of option-value ids. */
function comboKey(valueIds: readonly string[]): string {
  return [...valueIds].sort().join(",");
}

/** Cartesian product of per-option value-id lists. Zero options → no
 * combinations (a variant-less product), never one empty combination. */
function valueCombos(groups: { optionId: string; valueIds: string[] }[]): string[][] {
  if (groups.length === 0) return [];
  let combos: string[][] = [[]];
  for (const group of groups) {
    const next: string[][] = [];
    for (const combo of combos) {
      for (const valueId of group.valueIds) {
        next.push([...combo, valueId]);
      }
    }
    combos = next;
  }
  return combos;
}

async function assertProductInStore(
  prisma: ReturnType<typeof getPrismaClient> | Prisma.TransactionClient,
  storeId: string,
  productId: string,
): Promise<void> {
  const product = await prisma.product.findFirst({
    where: { id: productId, storeId, deletedAt: null },
    select: { id: true },
  });
  if (product === null) {
    throw new AppError(404, "NOT_FOUND", "Product not found");
  }
}

export async function setProductOptions(
  storeId: string,
  productId: string,
  input: unknown,
  staffMemberId?: string,
): Promise<ProductView> {
  const data = validateOrThrow(setProductOptionsSchema, input) as SetProductOptionsInput;
  const prisma = getPrismaClient();

  await prisma.$transaction(async (tx) => {
    await assertProductInStore(tx, storeId, productId);

    const currentOptions = await tx.productOption.findMany({
      where: { productId },
      include: { values: true },
    });
    const currentVariants = await tx.productVariant.findMany({
      where: { productId },
      include: { optionValues: { select: { optionValueId: true } } },
    });

    // 1. Upsert the desired options + values (stable ids for kept ones).
    const desiredByOption: { optionId: string; valueIds: string[] }[] = [];
    const keptOptionNames = new Set<string>();
    for (let i = 0; i < data.options.length; i += 1) {
      const opt = data.options[i]!;
      keptOptionNames.add(opt.name);
      const existing = currentOptions.find((c) => c.name === opt.name);
      const optionId = existing
        ? (
            await tx.productOption.update({
              where: { id: existing.id },
              data: { sortOrder: i },
              select: { id: true },
            })
          ).id
        : (
            await tx.productOption.create({
              data: { storeId, productId, name: opt.name, sortOrder: i },
              select: { id: true },
            })
          ).id;

      const values = dedupeValues(opt.values);
      const valueIds: string[] = [];
      for (let j = 0; j < values.length; j += 1) {
        const value = values[j]!;
        const existingValue = existing?.values.find((c) => c.value === value);
        const valueId = existingValue
          ? (
              await tx.productOptionValue.update({
                where: { id: existingValue.id },
                data: { sortOrder: j },
                select: { id: true },
              })
            ).id
          : (
              await tx.productOptionValue.create({
                data: { storeId, optionId, value, sortOrder: j },
                select: { id: true },
              })
            ).id;
        valueIds.push(valueId);
      }
      desiredByOption.push({ optionId, valueIds });
    }

    // 2. Desired combinations + their keys.
    const combos = valueCombos(desiredByOption);
    if (combos.length > 50) {
      throw new AppError(
        409,
        "VARIANT_LIMIT_REACHED",
        "This combination generates more than 50 variants — reduce the number of values",
      );
    }
    const desiredKeys = new Set(combos.map((ids) => comboKey(ids)));

    // 3. Archive existing variants whose combination is no longer desired.
    const existingByKey = new Map<string, { id: string; archivedAt: Date | null }>();
    for (const variant of currentVariants) {
      const key = comboKey(variant.optionValues.map((l) => l.optionValueId));
      existingByKey.set(key, { id: variant.id, archivedAt: variant.archivedAt });
      if (!desiredKeys.has(key) && variant.archivedAt === null) {
        await tx.productVariant.update({
          where: { id: variant.id },
          data: { archivedAt: new Date() },
        });
      }
    }

    // 4. Create missing combinations (variant + links + branch stock row).
    const store = await tx.store.findUnique({
      where: { id: storeId },
      select: { defaultBranchId: true },
    });
    const branchId = store?.defaultBranchId ?? null;
    for (const combo of combos) {
      const key = comboKey(combo);
      const existing = existingByKey.get(key);
      if (existing !== undefined) {
        // Restore a previously-archived combination that is desired again.
        if (existing.archivedAt !== null) {
          await tx.productVariant.update({
            where: { id: existing.id },
            data: { archivedAt: null },
          });
        }
        continue;
      }
      const created = await tx.productVariant.create({
        data: {
          storeId,
          productId,
          name: "", // set from the values below
          sellingPrice: null,
          sku: null,
        },
        select: { id: true },
      });
      await tx.productVariantOptionValue.createMany({
        data: combo.map((optionValueId) => ({ variantId: created.id, optionValueId })),
      });
      if (branchId !== null) {
        await tx.branchStock.create({
          data: { storeId, branchId, productId, variantId: created.id, quantity: 0 },
        });
      }
    }

    // 5. Write the derived name for every desired variant (values may have
    //    been renamed). Read back the value texts for the combo.
    const valueTexts = new Map<string, string>();
    for (const group of desiredByOption) {
      const rows = await tx.productOptionValue.findMany({
        where: { id: { in: group.valueIds } },
        select: { id: true, value: true },
      });
      for (const row of rows) valueTexts.set(row.id, row.value);
    }
    for (const combo of combos) {
      const existing = existingByKey.get(comboKey(combo));
      if (existing === undefined) continue;
      const name = combo.map((id) => valueTexts.get(id) ?? "").join(" / ");
      await tx.productVariant.update({ where: { id: existing.id }, data: { name } });
    }

    // 6. Delete option/value rows no longer desired (cascade removes their
    //    links; archived variants keep their derived `name` as the label).
    for (const cur of currentOptions) {
      if (!keptOptionNames.has(cur.name)) {
        await tx.productOption.delete({ where: { id: cur.id } });
        continue;
      }
      const opt = data.options.find((o) => o.name === cur.name)!;
      const keptValues = new Set(dedupeValues(opt.values));
      for (const cv of cur.values) {
        if (!keptValues.has(cv.value)) {
          await tx.productOptionValue.delete({ where: { id: cv.id } });
        }
      }
    }
  });

  await logStoreActivity(prisma, {
    storeId,
    staffMemberId,
    action: "product.options.updated",
    detail: { productId, optionCount: data.options.length },
  });
  return getProduct(storeId, productId);
}

/** POST /products/:productId/variants — add a single variant. */
export async function addProductVariant(
  storeId: string,
  productId: string,
  input: unknown,
  staffMemberId?: string,
): Promise<ProductView> {
  const data = validateOrThrow(variantCreateSchema, input) as VariantCreateInput;
  const prisma = getPrismaClient();

  await prisma.$transaction(async (tx) => {
    await assertProductInStore(tx, storeId, productId);
    const store = await tx.store.findUnique({
      where: { id: storeId },
      select: { defaultBranchId: true },
    });
    if (store === null || store.defaultBranchId === null) {
      throw new AppError(
        409,
        "STORE_NOT_CONFIGURED",
        "This store has no default branch — create one before adding products",
      );
    }

    const count = await tx.productVariant.count({ where: { productId } });
    if (count >= 50) {
      throw new AppError(409, "VARIANT_LIMIT_REACHED", "A product can have at most 50 variants");
    }

    // Resolve option values (creates the value under an existing option if
    // the named value is new; an unknown OPTION is a 400).
    const valueIds: string[] = [];
    const labels: string[] = [];
    for (const ov of data.optionValues ?? []) {
      const option = await tx.productOption.findFirst({
        where: { productId, name: ov.option },
        select: { id: true },
      });
      if (option === null) {
        throw new AppError(400, "VALIDATION_ERROR", `Unknown option "${ov.option}"`);
      }
      const existing = await tx.productOptionValue.findFirst({
        where: { optionId: option.id, value: ov.value },
        select: { id: true },
      });
      const valueId = existing
        ? existing.id
        : (
            await tx.productOptionValue.create({
              data: { storeId, optionId: option.id, value: ov.value, sortOrder: 0 },
              select: { id: true },
            })
          ).id;
      valueIds.push(valueId);
      labels.push(ov.value);
    }

    const variant = await tx.productVariant.create({
      data: {
        storeId,
        productId,
        name: data.name ?? (labels.length > 0 ? labels.join(" / ") : "Default"),
        sellingPrice: data.sellingPrice ?? null,
        sku: data.sku ?? null,
      },
      select: { id: true },
    });
    if (valueIds.length > 0) {
      await tx.productVariantOptionValue.createMany({
        data: valueIds.map((optionValueId) => ({ variantId: variant.id, optionValueId })),
      });
    }
    await tx.branchStock.create({
      data: {
        storeId,
        branchId: store.defaultBranchId,
        productId,
        variantId: variant.id,
        quantity: 0,
      },
    });
    if (data.initialStock !== undefined) {
      await recordInitialStockChanges(tx, [
        {
          storeId,
          branchId: store.defaultBranchId,
          productId,
          variantId: variant.id,
          quantityChange: data.initialStock,
        },
      ]);
    }
  });

  await logStoreActivity(prisma, {
    storeId,
    staffMemberId,
    action: "product.variant.created",
    detail: { productId },
  });
  return getProduct(storeId, productId);
}

async function findVariantInProduct(
  prisma: ReturnType<typeof getPrismaClient> | Prisma.TransactionClient,
  storeId: string,
  productId: string,
  variantId: string,
): Promise<{ id: string; archivedAt: Date | null }> {
  const variant = await prisma.productVariant.findFirst({
    where: { id: variantId, storeId, productId },
    select: { id: true, archivedAt: true },
  });
  if (variant === null) {
    throw new AppError(404, "VARIANT_NOT_FOUND", "Variant not found");
  }
  return variant;
}

/** PATCH /products/:productId/variants/:variantId — name/price/SKU. */
export async function updateProductVariant(
  storeId: string,
  productId: string,
  variantId: string,
  input: unknown,
  staffMemberId?: string,
): Promise<ProductView> {
  const data = validateOrThrow(variantUpdateSchema, input) as VariantUpdateInput;
  const prisma = getPrismaClient();
  await assertProductInStore(prisma, storeId, productId);
  await findVariantInProduct(prisma, storeId, productId, variantId);

  await prisma.productVariant.update({
    where: { id: variantId },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.sellingPrice !== undefined ? { sellingPrice: data.sellingPrice } : {}),
      ...(data.sku !== undefined ? { sku: data.sku } : {}),
    },
  });
  await logStoreActivity(prisma, {
    storeId,
    staffMemberId,
    action: "product.variant.updated",
    detail: { productId, variantId, updatedFields: Object.keys(data) },
  });
  return getProduct(storeId, productId);
}

export async function archiveProductVariant(
  storeId: string,
  productId: string,
  variantId: string,
  staffMemberId?: string,
): Promise<ProductView> {
  const prisma = getPrismaClient();
  await assertProductInStore(prisma, storeId, productId);
  await findVariantInProduct(prisma, storeId, productId, variantId);
  await prisma.productVariant.update({ where: { id: variantId }, data: { archivedAt: new Date() } });
  await logStoreActivity(prisma, {
    storeId,
    staffMemberId,
    action: "product.variant.archived",
    detail: { productId, variantId },
  });
  return getProduct(storeId, productId);
}

export async function restoreProductVariant(
  storeId: string,
  productId: string,
  variantId: string,
  staffMemberId?: string,
): Promise<ProductView> {
  const prisma = getPrismaClient();
  await assertProductInStore(prisma, storeId, productId);
  await findVariantInProduct(prisma, storeId, productId, variantId);
  await prisma.productVariant.update({ where: { id: variantId }, data: { archivedAt: null } });
  await logStoreActivity(prisma, {
    storeId,
    staffMemberId,
    action: "product.variant.restored",
    detail: { productId, variantId },
  });
  return getProduct(storeId, productId);
}

/**
 * Soft-deletes the product: the row is kept because order and ledger
 * history reference it (Restrict foreign keys make hard deletion
 * impossible by design). Idempotent: deleting an already-deleted product
 * succeeds silently so clients can retry safely.
 */
export async function softDeleteProduct(
  storeId: string,
  productId: string,
  staffMemberId?: string,
): Promise<void> {
  const prisma = getPrismaClient();
  const existingImages = await prisma.product.findFirst({
    where: { id: productId, storeId, deletedAt: null },
    select: { images: true, coverImageUrl: true },
  });
  const updated = await prisma.product.updateMany({
    where: { id: productId, storeId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  if (updated.count === 0) {
    const exists = await prisma.product.findFirst({
      where: { id: productId, storeId },
      select: { id: true },
    });
    if (exists === null) {
      throw new AppError(404, "NOT_FOUND", "Product not found");
    }
  } else {
    await logStoreActivity(prisma, {
      storeId,
      staffMemberId,
      action: "product.deleted",
      detail: { productId },
    });
    if (existingImages !== null) {
      const allImages = [
        ...((existingImages.images as string[] | undefined) ?? []),
        ...(existingImages.coverImageUrl !== null ? [existingImages.coverImageUrl] : []),
      ];
      const unique = [...new Set(allImages)];
      if (unique.length > 0) {
        scheduleProductImageCleanup(storeId, unique);
      }
    }
  }
}
