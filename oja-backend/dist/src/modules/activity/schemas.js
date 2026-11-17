import { z } from "zod";
export const listStoreActivityParamsSchema = z.object({
    limit: z.coerce
        .number({ error: "limit must be a number" })
        .int("limit must be an integer")
        .min(1, "limit must be at least 1")
        .max(200, "limit must be at most 200")
        .default(50),
    cursor: z.string().trim().min(1, "cursor must be an activity entry id").optional(),
    staffMemberId: z.string().trim().min(1, "Staff member ID is invalid").optional(),
    start: z
        .string()
        .trim()
        .datetime({ offset: true, error: "start must be an ISO datetime" })
        .optional(),
    end: z
        .string()
        .trim()
        .datetime({ offset: true, error: "end must be an ISO datetime" })
        .optional(),
});
//# sourceMappingURL=schemas.js.map