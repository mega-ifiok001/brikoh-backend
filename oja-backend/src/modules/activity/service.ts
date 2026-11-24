import type { Prisma } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { validateOrThrow } from "../../lib/validate.js";
import { listStoreActivityParamsSchema, type ListStoreActivityParams } from "./schemas.js";

export interface LogStoreActivityInput {
  storeId: string;
  /** Null for system- and sale-originated entries (webhooks). */
  staffMemberId?: string | null;
  /** Dotted action name, e.g. "product.created", "stock.adjusted". */
  action: string;
  detail?: Record<string, unknown>;
}

/**
 * Writes one store-activity entry. The `db` argument is injected (the
 * caller's transaction, or the global client) so the entry is atomic
 * with the change that produced it — an activity row never outlives the
 * mutation it records, and a rolled-back change leaves no orphan log.
 *
 * Rows are append-only at the DB level (store_activity_log_append_only
 * trigger): there is no update/delete path, by design.
 */
export async function logStoreActivity(
  db: Pick<Prisma.TransactionClient, "storeActivityLog">,
  input: LogStoreActivityInput,
): Promise<void> {
  await db.storeActivityLog.create({
    data: {
      storeId: input.storeId,
      staffMemberId: input.staffMemberId ?? null,
      action: input.action,
      detail: (input.detail ?? {}) as Prisma.InputJsonValue,
    },
  });
}

export interface ListStoreActivityResult {
  items: {
    id: string;
    storeId: string;
    staffMemberId: string | null;
    action: string;
    detail: Record<string, unknown>;
    createdAt: Date;
  }[];
  nextCursor: string | null;
  total: number;
}

/**
 * Reads the tenant's activity log, newest first, cursor-paginated.
 * `date` selects one UTC calendar day on createdAt.
 */
export async function listStoreActivity(
  storeId: string,
  input: unknown,
): Promise<ListStoreActivityResult> {
  const { limit, cursor, staffMemberId, date } = validateOrThrow(
    listStoreActivityParamsSchema,
    input,
  ) as ListStoreActivityParams;
  const prisma = getPrismaClient();

  if (cursor !== undefined) {
    const cursorRow = await prisma.storeActivityLog.findUnique({
      where: { id: cursor },
      select: { id: true },
    });
    if (cursorRow === null) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid cursor");
    }
  }

  const where: Prisma.StoreActivityLogWhereInput = {
    storeId,
    ...(staffMemberId !== undefined ? { staffMemberId } : {}),
    ...(date !== undefined
      ? {
          createdAt: {
            gte: new Date(`${date}T00:00:00.000Z`),
            lt: new Date(new Date(`${date}T00:00:00.000Z`).getTime() + 86_400_000),
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.storeActivityLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      skip: cursor === undefined ? 0 : 1,
      cursor: cursor === undefined ? undefined : { id: cursor },
    }),
    prisma.storeActivityLog.count({ where }),
  ]);

  const hasMore = rows.length > limit;
  return {
    items: rows.slice(0, limit).map((row) => ({
      id: row.id,
      storeId: row.storeId,
      staffMemberId: row.staffMemberId,
      action: row.action,
      detail: row.detail as Record<string, unknown>,
      createdAt: row.createdAt,
    })),
    nextCursor: hasMore ? rows[limit - 1]!.id : null,
    total,
  };
}
