import { z } from "zod";
import { validateOrThrow } from "../../lib/validate.js";
import { phoneSchema } from "../../lib/validation.js";

export { validateOrThrow };

export const emailSchema = z.email().transform((value) => value.toLowerCase());
export const passwordSchema = z
  .string()
  .min(8, "password must be at least 8 characters")
  .regex(/[a-zA-Z]/, "password must contain at least one letter")
  .regex(/\d/, "password must contain at least one digit");

const nameField = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(100, `${label} must be at most 100 characters`);

// Store names are letters and spaces only — the subdomain is derived
// from the name, and the derived subdomain is letters-and-hyphens only,
// so any digit, punctuation, or symbol would otherwise create an
// unresolvable mismatch. Rejected up front with a plain-language message.
const storeNameField = z
  .string()
  .trim()
  .min(1, "store name is required")
  .max(120, "store name must be at most 120 characters")
  .regex(/^[A-Za-z]+(?:\s+[A-Za-z]+)*$/, "Store name can only contain letters and spaces");

export const registerSchema = z
  .object({
    firstName: nameField("first name"),
    lastName: nameField("last name"),
    phone: phoneSchema,
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string().min(1, "Please confirm your password"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ["confirmPassword"],
    message: "passwords do not match",
  });
export type RegisterInput = z.infer<typeof registerSchema>;

export const onboardingBase = {
  name: storeNameField,
  businessType: z.enum([
    "RETAIL",
    "FOOD_AND_BEVERAGE",
    "FASHION_AND_WEARABLES",
    "HEALTH_AND_BEAUTY",
    "ELECTRONICS",
    "PROFESSIONAL_SERVICES",
    "AGRICULTURE",
    "OTHER",
  ]),
  location: z
    .string()
    .trim()
    .min(2, "location is required")
    .max(120, "location must be at most 120 characters"),
  currency: z.enum(["NGN", "USD", "GHS", "KES", "ZAR"]).default("NGN"),
  businessPhone: phoneSchema,
  // Storefront template choice (see dashboard-store-templates.md).
  // Optional: the server defaults to the first visible template of the
  // pre-subscription STARTER set when omitted. The tier-set check runs
  // in the templates service — the shape check lives here.
  templateId: z.string().uuid("templateId must be a valid UUID").optional(),
};

/**
 * The business profile collected at onboarding. The storefront subdomain
 * is NEVER collected here — it is derived server-side from the store
 * name (see src/lib/slugs.ts). .strict() rejects stale fields (e.g. an
 * old client still sending wantWebsite) instead of silently stripping.
 */
export const onboardingSchema = z.object(onboardingBase).strict();
export type OnboardingInput = z.infer<typeof onboardingSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "password is required"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshTokenSchema = z.string().min(1, "Refresh token is required");
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;

const otpCodeSchema = z.string().regex(/^\d{6}$/, "code must be exactly 6 digits");

export const verifyEmailSchema = z.object({ email: emailSchema, code: otpCodeSchema });
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const verifyPasswordResetOtpSchema = z.object({ email: emailSchema, code: otpCodeSchema });
export type VerifyPasswordResetOtpInput = z.infer<typeof verifyPasswordResetOtpSchema>;

export const resetPasswordSchema = z
  .object({
    resetToken: z
      .string()
      .min(1, "resetToken is required")
      .max(128, "resetToken is too long")
      .startsWith("rst_", "resetToken is invalid"),
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1, "Please confirm your password"),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    path: ["confirmPassword"],
    message: "passwords do not match",
  });
export const googleSignInSchema = z.object({
  // The authorization code Google redirects to the frontend callback
  // with. Single-use; the backend exchanges it for the identity.
  code: z.string().min(1, "code is required"),
  // The exact callback URL the browser was redirected to — must match
  // an entry in the backend's allowed Google redirect URIs (derived
  // from FRONTEND_URL + CORS_EXTRA_ORIGINS).
  redirectUri: z.string().min(1, "redirectUri is required"),
});
export type GoogleSignInInput = z.infer<typeof googleSignInSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Please enter your current password"),
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1, "Please confirm your password"),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    path: ["confirmPassword"],
    message: "passwords do not match",
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
