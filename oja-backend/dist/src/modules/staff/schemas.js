import { z } from "zod";
import { emailSchema, passwordSchema } from "../auth/schemas.js";
import { isPermission } from "../../lib/permissions.js";
import { validateOrThrow } from "../../lib/validate.js";
export { validateOrThrow };
export const staffRoleSchema = z.enum(["ADMIN", "MANAGER", "STAFF"]);
export const updateStaffSchema = z
    .object({
    role: staffRoleSchema.optional(),
    permissions: z
        .array(z.string())
        .refine((values) => values.every((value) => value === "all" || isPermission(value)), "permissions contains an unknown flag (see lib/permissions.ts)")
        .optional(),
    isActive: z.boolean().optional(),
})
    .refine((data) => data.role !== undefined || data.permissions !== undefined || data.isActive !== undefined, { message: "at least one of role, permissions, or isActive is required" });
export const inviteSchema = z.object({
    email: emailSchema,
    role: staffRoleSchema,
});
export const acceptInviteSchema = z.object({
    token: z.string().trim().min(1, "token is required"),
    password: passwordSchema,
});
//# sourceMappingURL=schemas.js.map