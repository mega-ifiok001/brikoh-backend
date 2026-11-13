import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "generated/", "node_modules/", "coverage/"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  // Admin discipline: merchant-equivalent writes must go through the
  // merchant service functions; admin code may not import the Prisma
  // client directly. The AdminService itself is the single exception —
  // all admin Prisma access lives there (RULES.md layering).
  {
    files: ["src/modules/admin/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../../../generated/prisma/client"],
              message:
                "Admin code must go through AdminService — direct Prisma access belongs in src/modules/admin/service.ts only",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/modules/admin/service.ts", "src/modules/admin/*.test.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  eslintConfigPrettier,
);
