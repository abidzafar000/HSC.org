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

## Branch portal and user permissions

Super Admin can select **Allowed areas** for each user in **Access & roles**. These selections narrow the user's role and branch scope; they cannot grant authority outside that role. Permission changes are audited and close the affected user's sessions so their next sign-in receives the new access.

Branch users start with **Dispatch orders**, **Branch returns** and **Branch demands**. They see only their assigned branch's issued deliveries, returns and demands, with monetary information removed. They do not receive warehouse drafts, other branches' records, reports, master-data screens or administration screens. Unselected modules are hidden in navigation and blocked by the server.

A branch can submit item quantities and units as a demand. The central team reviews the request, approves or rejects it, and can turn an approved demand into a linked gate-pass draft. Existing approval, dispatch and receipt controls still apply. A demand itself does not move stock. Received deliveries also offer a return action, subject to the branch's return permission, received quantities and available stock.

While the portal is open, authorized central administrators and warehouse reviewers receive an in-app popup for submitted branch demands. A small read-only inbox refreshes every ten seconds while the page is visible and checks again on focus or reconnection. The popup identifies the branch, reference and item count, and opens the current demand for review. Drafts and the reviewer's own requests do not notify. Dismissed submissions stay acknowledged for that user in the same browser, including across tabs; resubmitting a rejected request creates a new alert. Unseen pending requests also appear after sign-in. The popup does not require browser notification permission and does not send alerts when the portal is closed.

After upgrading an existing deployment, run the idempotent database migration before releasing the new code. The nullable `users.permissions` column preserves role defaults for existing users and does not recreate accounts or reset credentials.

## Name-only catalogue imports

Authorized product administrators can import a list of item names without importing monthly balances. The batch removes repeated names, skips existing catalogue names and records an import fingerprint and audit entry. Imported names start as inactive **Setup needed** drafts with no invented unit, category, rate or opening quantity. Configure the required fields and enable an item before using it in a transaction. Draft imports and their private metadata are hidden from operational and branch users.

Reference purchase rates are optional and separate from stock costing. A blank reference rate remains unknown; an explicit zero remains zero. Actual receipt and stock-addition rates continue to determine inventory cost.

Purchase GRNs also accept **New product** lines when an invoice includes an item outside the catalogue. Enter its name, category, stock unit, quantity and rate in the same form. Saving a valid GRN creates an active product with a unique item code; approval posts the receipt and landed cost to Central Warehouse once. Existing catalogue names, including setup drafts, must be selected or completed instead of duplicated. Purchasing users can introduce an item through their GRN permission without receiving general product-master editing access. Invalid GRNs do not leave partial products behind.

Product setup also offers an explicit **Central Warehouse quantity** field. It represents the total physical count, and saves the difference through an audited stock adjustment. Super Admin changes post immediately; ordinary administrator changes require independent approval. Repeatedly saving the same count does not add stock again, and pending counts cannot post after their original warehouse balance has changed. The optional low-stock alert level is separate from quantity.
