# Brikoh Backend Audit

**Review date:** 16 November 2026  
**Scope:** Static review of the `oja-backend` source tree, Prisma schema and migration history, test layout, environment template, and repository CI workflow.  
**Overall assessment:** Broad product coverage and thoughtful security controls are present. The backend now has a package manifest, lockfile, and installed dependencies in the current workspace, resolving the earlier local setup gap. A subscription-billing risk remains, and clean-checkout CI plus production readiness have not been verified.

## Executive summary

The backend contains a substantial multi-tenant SaaS API: 34 feature modules, 54 Prisma migrations, and 110 `*.test.ts` files. The codebase includes authentication, tenant resolution, permissions, catalog and stock, orders/POS, storefront checkout, Paystack webhooks, wallet/payouts, subscriptions, invoices, staff, reporting, expenses, and platform administration. Security-positive patterns include database-derived tenant membership, explicit route groups, input schemas, separate admin JWT configuration, encrypted merchant payment credentials, raw-body webhook verification, unique event IDs, and database-backed append-only audit/stock ledgers.

One high-priority issue needs resolution before release:

1. **The subscription sweeper clears the legacy Paystack subscription identifiers without making a provider disable call.** Its comments say the old subscription is retried, but the implementation clears `swapPending` and the legacy identifiers. This can leave the old recurring subscription active and also remove data used to recognize and quarantine a late old-plan charge.

The package manifest and lockfile are present and tracked in Git, and `node_modules` is present in the current workspace. The audit update did not execute install, tests, lint, typecheck, or build. Clean-checkout installation is therefore still unverified. Migrations against a live database, provider callbacks, deployment configuration, and production monitoring were also not verified.

## Findings

### Critical / high priority

#### A1. Backend package metadata was missing from the earlier audit snapshot

**Status:** Resolved in the current workspace; clean-checkout delivery remains to be verified.  
**Evidence:** The current `oja-backend` directory contains `package.json`, `package-lock.json`, and `node_modules`. The manifest defines `npm ci` compatible scripts for Prisma generation, lint, typecheck, tests, and build, matching the CI workflow's expected commands.

**Remaining check:** Validate `npm ci` and the complete CI sequence in a clean checkout. The presence of local `node_modules` alone does not establish reproducibility. No commands were run as part of this report update.

**Action:** No code change required if both manifest and lockfile are committed. Run the clean-checkout CI sequence before release.

#### A2. Subscription sweeper drops the old-provider subscription without disabling it

**Severity:** High — billing correctness / financial risk  
**Evidence:** `src/modules/subscriptions/sweep.ts` describes “SWAP RETRY” behavior, but for each `swapPending` subscription it only calls `subscription.update` and clears `swapPending`, `legacyPaystackSubscriptionCode`, and `legacyPaystackPlanCode`. No Paystack provider is called there. The subscription webhook comments describe the legacy code/plan pair as the guard for old-plan renewals after an upgrade.

**Impact:** A failed or uncertain old-subscription disable can be treated as complete locally while Paystack continues charging the merchant. Clearing the legacy pair also removes the local correlation needed to identify an old-plan charge as an orphan/double charge.

**Action:** Keep the legacy identifiers and pending flag until Paystack confirms disablement; call the provider from the sweep with bounded retries and observable failures; make the operation idempotent; alert/support on persistent failure. Add integration coverage for provider failure, repeated sweep, and a late renewal after upgrade.

### Medium priority

#### A3. Rate limiting is per-process and retains IP buckets indefinitely

**Severity:** Medium — abuse resistance / availability  
**Evidence:** `src/middleware/rateLimit.ts` stores buckets in a module-level `Map`, keyed by limiter and `req.ip`. Expired entries are replaced only when that same key is requested again; there is no global eviction. The application comments already note that a shared store is needed after horizontal scaling.

**Impact:** Requests spread across many source IPs can grow the map for the lifetime of the process. With multiple API instances, each instance enforces an independent quota, so a client can multiply the effective limit by targeting or reaching different instances. In-memory state also resets on restart.

**Action:** Use a shared limiter store (for example Redis) for production and add expiry/eviction for local fallback. Confirm the deployed proxy topology and `TRUST_PROXY` setting so client IPs cannot be spoofed or collapsed to one proxy address.

#### A4. Subscription reference suffixes use `Math.random`

**Severity:** Medium — payment correlation / defense in depth  
**Evidence:** `src/modules/subscriptions/billing.service.ts` builds provider references using `Math.random`, unlike refresh and verification token generation elsewhere, which use `node:crypto` random bytes. Database uniqueness catches collisions but does not make the value unpredictable.

**Impact:** Payment references are correlation identifiers and should not rely on a non-cryptographic PRNG. A collision can also fail a billing operation at the unique constraint boundary.

**Action:** Generate the suffix with `randomBytes` or `randomUUID`, retain the unique constraint, and handle a collision with bounded regeneration.

#### A5. Subscription plan caps are checked with separate read-then-write operations

**Severity:** Medium — plan enforcement correctness  
**Evidence:** `src/modules/subscriptions/service.ts` counts products, locations, or orders and then allows the caller to proceed. The visible cap checks do not themselves reserve capacity or lock a per-store quota row.

**Impact:** Concurrent requests near a finite plan cap may both observe available capacity and exceed the configured cap. This matters only for tiers with finite caps and simultaneous writes.

**Action:** Verify every capped write transaction includes the check and mutation, then serialize per-store cap consumption or use a database-enforced reservation/counter strategy where strict limits are required. Add a concurrency test at the cap boundary.

### Lower priority / maintainability

#### A6. CORS apex derivation assumes a two-label public suffix

**Severity:** Low to medium — deployment correctness  
**Evidence:** `src/lib/cors.ts` derives the apex from the last two hostname labels. The source comment acknowledges that this fails for domains such as `example.co.uk` and recommends configuring the frontend URL at the apex.

**Impact:** A deployment on a multi-label public suffix can allow or reject the wrong sibling origins. CORS is not authentication, but incorrect origin policy can break browser clients and widen the browser-accessible surface.

**Action:** Configure and test the actual production domain shape; use an explicit allowed-host strategy or public-suffix-aware parsing rather than a last-two-label heuristic.

#### A7. Backend README status text is stale

**Severity:** Low — onboarding / operations  
**Evidence:** `oja-backend/README.md` says the project is at “Phase 1” with auth and feature modules still to come, while the current tree contains 34 modules and extensive migrations/tests.

**Impact:** Maintainers may follow outdated assumptions about implemented functionality and setup state.

**Action:** Update the status section and align documented scripts/environment requirements with the recovered package manifest and current deployment process.

## Control review

| Area | Observed implementation | Assessment |
|---|---|---|
| Tenant isolation | `resolveTenant` reloads membership from the database; tenant IDs are derived from owner/staff membership rather than request input. | Strong design; still requires ongoing cross-tenant integration tests for every new route. |
| Route trust boundaries | `app.ts` groups public, dashboard, webhook, and admin routes with explicit middleware stacks and a final error handler. | Clear and auditable structure. Review each route mount as features change. |
| Authentication | Bearer JWT verification pins HS256; refresh tokens are opaque and represented by database rows; password hashing uses bcrypt cost 12. | Good foundations. Operational secret rotation, revocation behavior, and session policy need deployment verification. |
| Authorization | Owner and staff permissions are resolved centrally; owner-only routes use `requireOwner`; route mounts state required permissions. | Good centralization. Confirm staff permission matrices match business intent for all write endpoints. |
| Request validation | Zod schemas are used across feature modules and centralized validation/error formatting exists. | Positive. Confirm all route params, query strings, and provider payloads stay validated. |
| HTTP hardening | Helmet, HSTS, CORS allowlisting, disabled `x-powered-by`, and `no-store` on dashboard/admin paths are present. | Positive. CORS hostname heuristic and proxy configuration need environment-specific validation. |
| Webhooks | Raw request bytes are captured; merchant order events use decrypted merchant credentials; subscription billing uses platform credentials; event IDs are unique and processing is transaction-aware. | Strong design patterns. Verify provider retry behavior and non-transactional side effects under outages. |
| Payment secrets | Merchant secret keys are AES-GCM encrypted at rest; masked views are returned. | Positive. Rotation/backup of `PAYMENT_ENCRYPTION_KEY` is an operational dependency and was not verified. |
| Data integrity | 54 migrations; schema comments and tests indicate database triggers for append-only stock/admin audit records and constraints for order integrity. | Strong intent. Migration application and trigger presence in the live database were not verified. |
| Logging | Request logger avoids bodies, headers, query strings, and tokens; error handler returns generic 500 responses. | Positive. Verify log retention/access controls and ensure provider/internal errors do not include secrets. |
| Tests and CI | 110 test files, sequential Vitest configuration for shared DB, CI defines PostgreSQL 16 and lint/typecheck/test/build stages; package manifest and lockfile are now present locally. | Broad apparent test coverage; clean-checkout reproducibility and test results remain unverified. No test execution was performed during this audit. |
| Background tasks | Several periodic sweeps are started in-process and use intervals. | Requires one-instance or distributed-lock assumptions, graceful shutdown, and alerting to be explicit. Subscription sweep finding A2 is a concrete correctness gap. |
| Business features | Modules exist for products, POS/orders, storefront, customers, staff, locations/branches, wallets, invoices, expenses, reports, campaigns/discounts, suppliers/purchase orders, templates, and admin. | Feature code presence is verified; end-to-end production behavior and the advertised “unlimited” plan promises require business/product acceptance checks. |

## Coverage against the stated product claims

The code tree contains modules consistent with the stated offerings: storefront and templates, checkout and POS orders, products, staff, locations/branches, customers, invoices, wallet and payouts, expenses, reports, and subscriptions. This establishes implementation presence only; it does not prove every user journey is complete, deployed, or available on the free tier.

“Unlimited staff, locations, products, and orders” must be checked against the live plan configuration and `src/modules/subscriptions/plan.ts`; plan caps are data-driven and the code supports finite caps. No live subscription settings or product-level contract were available to validate that public promise.

## Verification limits and operational checks

This was a static source audit only. The following remain unverified:

- CI status and installability from a clean checkout.
- TypeScript, lint, test, and production build results.
- Live database schema/migration state, backups, restore drills, indexes, and trigger installation.
- Production secrets, key rotation/backup, database TLS/pooling, and least-privilege credentials.
- Paystack, Resend, Cloudinary, and Google OAuth production account configuration and webhook delivery/retry settings.
- Deployment replica count, proxy trust settings, background sweep coordination, graceful shutdown, health probes, alerting, and log retention.
- Authorization/business acceptance for all staff roles and public checkout/storefront journeys.
- Privacy, retention, deletion, and regulatory obligations for merchant/customer data and financial records.

## Recommended remediation order

1. Prove clean-checkout CI install/build.
2. Correct the subscription swap sweep so it confirms provider-side disablement before clearing legacy protection; add failure and late-webhook integration cases.
3. Move production rate limiting to a shared store and bound local bucket memory.
4. Replace subscription references generated with `Math.random` by cryptographic identifiers.
5. Test concurrency around finite plan caps and fix strict-limit races if reproducible.
6. Validate production CORS/domain and proxy configuration; refresh backend setup/status documentation.
7. Complete operational validation: production database migration/backup checks, provider configuration, background job coordination, and monitoring.
