import { z } from "zod";
import { validateOrThrow } from "../../lib/validate.js";
export { validateOrThrow };
/** PUT /api/dashboard/templates body: the id of a template in the store's visible set. */
export const selectTemplateSchema = z.object({
    templateId: z.string().uuid("templateId must be a valid UUID"),
});
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "accentColor must be a #RRGGBB hex color");
const httpsUrl = z
    .string()
    .max(2048, "logoUrl must be at most 2048 characters")
    .url("logoUrl must be a valid URL")
    .refine((u) => new URL(u).protocol === "https:", "logoUrl must be https");
const shortText = (name, max) => z
    .string()
    .trim()
    .min(1, `${name} must be at least 1 character`)
    .max(max, `${name} must be at most ${max} characters`);
/**
 * PUT /api/dashboard/templates/customization body. Strict: unknown keys
 * are rejected (catches misspelled fields instead of silently dropping
 * them). Replace semantics: every key is optional/nullable and an omitted
 * or null field is cleared back to the template default.
 */
export const templateSettingsSchema = z
    .object({
    accentColor: hexColor.nullable().optional(),
    logoUrl: httpsUrl.nullable().optional(),
    heroText: shortText("heroText", 80).nullable().optional(),
    heroSubtext: shortText("heroSubtext", 160).nullable().optional(),
    announcementBar: z
        .object({
        enabled: z.boolean("announcementBar.enabled must be a boolean"),
        text: shortText("announcementBar.text", 140),
    })
        .strict()
        .nullable()
        .optional(),
})
    .strict();
//# sourceMappingURL=schemas.js.map