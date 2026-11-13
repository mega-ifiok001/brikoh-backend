# Brikoh Backend

Multi-tenant e-commerce/business management SaaS API. Node.js + Express 5 + Prisma 7 + PostgreSQL (local dev; Postgres service container in CI).

## Stack

- **TypeScript** — strict mode, no `any` (see `tsconfig.json`)
- **Express 5** — feature modules under `src/modules/<name>/`
- **Prisma 7** — `prisma-client` generator + `@prisma/adapter-pg` driver adapter
- **zod** — runtime validation of all external input, types derived via `z.infer`
- **Vitest + supertest** — unit tests (service layer, Prisma mocked) and integration tests (routes against a real test database)
- **ESLint (typescript-eslint) + Prettier** — zero warnings required
- **Husky + lint-staged** — pre-commit lint/format on staged files

## Getting started

```bash
npm install
npx prisma generate   # generates the client into generated/prisma (gitignored)
```

### Environment variables

Copy `.env.example` to `.env` and fill in real values (never commit `.env`):

| Variable                 | Purpose                                                                   |
| ------------------------ | ------------------------------------------------------------------------- |
| `NODE_ENV`               | `development` \| `test` \| `production`                                   |
| `PORT`                   | HTTP port (default 4000)                                                  |
| `DATABASE_URL`           | Local PostgreSQL connection string (dev database, e.g. `brikoh_dev`)      |
| `TEST_DATABASE_URL`      | Local PostgreSQL connection string (test database, e.g. `brikoh_test`)    |
| `JWT_SECRET`             | Access-token JWT signing secret, >= 16 chars (`openssl rand -base64 48`)  |
| `JWT_REFRESH_SECRET`     | Refresh-token JWT signing secret, >= 16 chars (`openssl rand -base64 48`) |
| `JWT_ACCESS_EXPIRES_IN`  | Access-token lifetime, duration string (`30s`, `15m`, `24h`, `7d`)        |
| `JWT_REFRESH_EXPIRES_IN` | Refresh-token lifetime, duration string                                   |

All variables are validated at boot by `src/config/env.ts` (zod) — the process
throws immediately if anything is missing or malformed. Integration tests use
`.env.test`; keep its values separate from your dev database. The role needs
the `CREATEDB` privilege so Prisma can auto-create its temporary shadow
database during `migrate dev`.

### Run the dev server

### Database

```bash
npm run db:migrate:dev   # apply pending migrations to the dev database (migrate deploy)
npm run db:seed          # seed the demo store (idempotent)
npm run db:check         # verifies the real dev database connection
```

`prisma migrate deploy` is used for applying migrations. `prisma migrate dev`
is only for generating new migrations; it creates and drops a temporary
shadow database automatically (the DB role needs `CREATEDB`) — never run it
while the test suite is running.

### Tests

```bash
npm test             # full suite (unit + integration)
npm run test:watch   # watch mode
```

Every backend slice ships both unit tests (service layer with Prisma
mocked/stubbed) and integration tests (supertest against a real test
database). Every suite covers the happy path, sad/error paths, and edge
cases. Integration tests read `TEST_DATABASE_URL` from `.env.test`.

### Quality gates

```bash
npm run lint       # ESLint — must pass with zero warnings
npm run typecheck  # tsc --noEmit
npm run format     # Prettier write
npm run build      # tsc -> dist/
```

CI runs lint, typecheck, test, and build on every push/PR (see
`.github/workflows/ci.yml` at the repo root). The workflow runs its own
Postgres 16 service container, so it needs only the `JWT_SECRET` and
`JWT_REFRESH_SECRET` secrets configured.

## Architecture

Feature modules under `src/modules/<name>/`, each owning:

```
src/modules/<name>/
  routes.ts        <- Express router, endpoints only
  controller.ts    <- thin HTTP layer: parse request, call service, respond
  service.ts       <- ALL business logic and ALL Prisma calls
  *.test.ts        <- colocated tests (unit + integration)
```

Cross-cutting concerns live once, imported by every module:

```
src/middleware/    <- resolveTenant, authenticate, authorize, errorHandler
src/lib/           <- AppError, prisma client factory, shared utilities
src/config/        <- env.ts (zod-validated, fails fast at boot)
src/types/         <- Express request augmentation (req.tenant, req.auth)
```

`app.ts` is the **map of the trust surface** — module routers are mounted
under exactly one route group (`/api/public`, `/api/dashboard`,
`/api/webhooks`, `/api/admin`) with an explicit line, and the global error
handler is mounted last. The error handler is the only place that formats
error responses; every thrown error uses the shared `AppError` shape.

Tenant-scoped Prisma models carry a `storeId` column (Prisma 7 keeps
camelCase columns; the RULES.md `store_id` wording refers to this
tenant-scoping column); the tenant always comes from `req.tenant.storeId`
(set by `resolveTenant`), never from client-supplied input. All timestamps
are `timestamptz` (UTC). Money is `Decimal(10,2)`.

## API contracts

Request/response shapes are agreed with the frontend in
`docs/api-contracts/` at the repo root. Write the contract **before**
implementing an endpoint; contract changes are their own `docs:` commit.

## Current status

Phase 1: full core Prisma schema (Account, Store, Owner, StaffMember,
InviteToken, Product, StockLedgerEntry, Customer, Order, OrderLineItem,
Invoice, InvoiceLineItem, Subscription, WebhookEvent) with DB-enforced
integrity (append-only ledger, order line-item rules), migration applied to
local Postgres, seed script, and integrity tests. Phase 0 scaffolding
remains: health-check module, error-handling pipeline, CI and pre-commit
hooks. Auth, tenant resolution, and feature modules come in later phases.
