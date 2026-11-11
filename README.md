# QuickEntry for Tally

An offline-capable field sales app for businesses on **TallyPrime**. Salespeople create sales invoices, receipts, sales orders and purchases on a phone, tablet or PC, with or without internet; the entries reach TallyPrime without duplicates. Tally stays the accounting system and the source of all customer, supplier and item masters.

The business requirements, architecture, hosting plan, costs and open questions are in the BRD (`BRD-QuickEntry-for-Tally.pdf`).

## What is verified and what is not

| Part | Status |
| --- | --- |
| App (PWA): offline entry, local storage, sync engine, PDF, print, share | Built and tested in Chromium (demo and live mode) |
| Cloud API: Cloudflare Pages Function + Supabase/Postgres (`schema.sql`) | Built and tested against a local Postgres 16 and a local stand-in for Cloudflare. **Not yet deployed** to a real Cloudflare or Supabase account |
| Office connector (Node.js) | Built and tested over HTTP against the **Tally simulator** |
| Windows installer (`connector/windows`) | Written for Windows PowerShell 5.1; **not yet run on a Windows PC** |
| TallyPrime XML requests, UDF layout, voucher alter by MasterID, TDL add-on | **Not verified on a live TallyPrime.** Written to Tally's documented XML interface; places to check are marked `VERIFY` in `app/core/tally-xml.js` and `tdl/QuickEntry.tdl` |
| Demo mode | Uses a **simulated Tally** in the browser. Labelled "DEMO" on every screen |

## Try the demo (no Tally, no accounts needed)

Needs Node.js 18 or later. No `npm install` is required to run it.

```
node relay/dev-server.js        # then open http://localhost:8787
```

The app starts in demo mode with sample data: a simulated Tally company, 6 customers, 2 suppliers, 7 items. Under **More** you can switch the phone's internet and the office Tally PC off and on, rename a customer in the simulated Tally, add an item, load 5,000 customers and 10,000 items, edit a voucher "in Tally" to see a conflict, and view the simulated Tally day book.

The `app/` folder is a static site. It can also be uploaded as-is to Cloudflare Pages to share the demo.

## Layout

```
app/                    The PWA (static files, no build step) - deploy this folder
  core/                 Shared logic, runs in browser and Node
    tally-xml.js        TallyPrime XML request builders and parsers  (VERIFY markers)
    connector-core.js   Office connector logic: masters, codes, voucher posting, conflicts
    relay-core.js       Reference cloud sync logic (used by demo, dev server, tests)
    tally-sim.js        SIMULATED TallyPrime for demo and tests
    vat.js, types.js    Configurable tax maths; transaction type definitions
  js/                   UI (main.js), IndexedDB (db.js), sync engine (sync.js), documents (docs.js)
  sw.js                 Service worker: app opens with no internet
server/api.js           The production sync API (Cloudflare): hashes the key, calls qe_api in Supabase
worker/index.js         Cloudflare Worker entry (wrangler.jsonc): /api/* to the API, the rest from app/
functions/api/          Same API as a Cloudflare Pages Function (if deployed as Pages)
relay/supabase/         schema.sql (tables, row-level security, qe_api), new-tenant.mjs (keys)
relay/dev-server.js     Self-hosted alternative: app + API + JSON-file storage in one Node process
connector/              Office connector for the Tally PC (Node.js, no dependencies)
  windows/              install.cmd: Windows setup (background task, protected key file), check.cmd, uninstall.cmd
mock-tally/             Simulated Tally on port 9000 for testing the connector
tdl/QuickEntry.tdl      Tally add-on: QE Code and QE Txn ID fields
docs/SETUP.md           Setup: Supabase, Cloudflare Pages, office PC, devices, live verification, upgrading
docs/VAN-STOCK.md       Van stock user guide (office and salespeople)
tests/                  Automated tests (see below)
```

The layers stay separate: the UI only talks to local storage and the sync engine; the sync engine only talks to the cloud API; only the connector talks to Tally.

## Tests

```
npm test                                   # sync scenarios on the in-memory relay + HTTP stack (node:test)
QE_PG_URL=postgres://... npm test          # also runs the same scenarios on Postgres (schema.sql)
node relay/dev-server.js & node tests/e2e.mjs            # browser test of all 10 BRD acceptance criteria (demo mode)
QE_PG_URL=postgres://... node tests/e2e-live.mjs         # browser -> Pages Function -> Postgres -> connector -> Tally simulator
```

The browser tests need Playwright with Chromium. `npm i -D pg` is needed only for the Postgres tests.

## Working on another PC

1. Install **Git** and **Node.js 18 or later** (nodejs.org, LTS). Nothing else is needed to run the app.
2. Get the code:
   ```
   git clone https://github.com/bibin9/TallyEntry.git
   cd TallyEntry
   git checkout main            # or a feature branch, e.g. claude/project-thread-8pefyz (van stock) until it is merged
   git pull
   ```
3. Run the demo: `node relay/dev-server.js`, then open http://localhost:8787. Under **More > Van stock** tick **Use van stock** to try van stock with the simulated Tally.
4. Run the tests: `npm test`. For the Postgres and browser tests:
   ```
   npm install                  # installs pg (dev dependency)
   npm i --no-save playwright && npx playwright install chromium
   # Postgres 15+ running locally, with an empty database "qe":
   psql postgres://postgres:PASSWORD@localhost:5432/qe -f relay/supabase/schema.sql
   QE_PG_URL=postgres://postgres:PASSWORD@localhost:5432/qe npm test
   node relay/dev-server.js --port 8787 &   then   node tests/e2e.mjs  and  node tests/e2e-vans.mjs
   ```
5. Deploying: a push or merge to `main` makes Cloudflare Workers Builds deploy https://tallyentry.quickentry.workers.dev; every other branch gets its own preview address (shown on the pull request). After a change to `relay/supabase/schema.sql`, run the whole file again in the Supabase SQL editor (safe to re-run). After a change to `app/core/` or `connector/`, give office PCs the new office setup package (see docs/SETUP.md, "Upgrading").

## Versions

| Version | Office package | Connector | What changed |
| --- | --- | --- | --- |
| 0.4 (app) | QuickEntry-Office-Setup v1.3 | 0.3.0 | Van stock: issue to van, van sales from the van's godown, end-of-day return (Stock Journals). Needs the updated `schema.sql`. |
| 0.3 (app) | v1.2 | 0.2.2 | Balances, overdue, credit terms, price levels and live stock from Tally. |

## Key design points

- **Stable codes.** Masters are matched by a code stored in Tally (QE Code field), never by name. The connector assigns codes to masters that have none and writes them back to Tally. Tally's GUID is stored as a cross-check.
- **Changes only.** Masters are fetched by Tally AlterID; devices fetch masters by a server sequence number.
- **No duplicates.** Every transaction has a UUID made on the device and a version number. The server ignores versions it already has. Before creating a voucher, the connector looks for the UUID in Tally (QE Txn ID), so a lost reply cannot cause a second voucher. Edits alter the mapped voucher.
- **Conflicts.** If the voucher's AlterID in Tally changed since the last sync, the app's edit is held as Conflict until the office chooses (BRD Q6; default "Tally wins").
- **Nothing lost.** Everything is written to IndexedDB first. Unsynced entries are never removed; synced ones are kept for 2 days (configurable).
- **Van stock.** Optional: each salesperson's van is a Tally godown. Issue to van and end-of-day return post as Stock Journals; a salesperson's invoices take stock from their van. See docs/VAN-STOCK.md and docs/SETUP.md, section 5a.
- **Configurable tax.** Rates, labels, currency, inclusive pricing and rounding are settings.
