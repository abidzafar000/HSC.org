# HSC on Vercel

Hamsun Phase 1 runs as a standard Next.js application with a Neon Postgres database provisioned through Vercel Marketplace.

- Live application: [HSC](https://hsc-bice.vercel.app)
- Source repository: [abidzafar000/HSC.org](https://github.com/abidzafar000/HSC.org)
- Production source branch: `main`, deployed through Vercel Git integration.

- Vercel team: Zafar (`zafar10`)
- Vercel project: `hsc`
- Database resource: **HSC**, Free plan, Singapore region
- Database connection: server-only `DATABASE_URL`, managed by the Marketplace integration. Use its exact URL; the resource label and provider-managed SQL catalog name are separate.

The workspace starts with one Super Admin and no sample products, suppliers, stock, documents or staff accounts. Configured locations are Central Warehouse, Hamsun FSL, DHA, Hamsun Clifon and Hamsun Extension. The existing Super Admin login is retained for this deployment.

## Development

Use Node.js 22 and pnpm 11.25. Link only to the `zafar10/hsc` Vercel project, verify that target, and pull its environment variables into ignored `.env.local` before running database commands.

```text
pnpm install --frozen-lockfile
node --env-file=.env.local scripts/migrate-postgres.mjs
pnpm dev
```

The migration creates missing tables and initializes only an empty workspace. It does not replace existing business records. Keep `.env.local` and `.vercel` private; both are excluded from source uploads.

For a new, empty database, set server-only `HSC_INITIAL_ADMIN_PASSWORD` in the private environment before the first migration. Use a unique password of 10–256 characters. There is no built-in password. After initialization, remove the bootstrap variable. Existing initialized databases do not require it, and neither the migration nor normal requests reset the owner's password or business records.

## Validation

```text
pnpm test
pnpm build
```

The suite includes stock/costing/workflow checks and real PostgreSQL semantics through disposable PGlite databases. Those tests do not modify the HSC cloud database. The adapter preserves atomic revisions, account audit writes, sessions and scoped permissions while translating the shared API’s SQL dialect.

Phase 2 consumption tracking remains excluded.
