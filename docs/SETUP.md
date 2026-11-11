# Setup guide

Production uses three pieces: **Supabase** (database), **Cloudflare** (app and API, as a Worker or Pages), and the **QuickEntry connector** on the office PC that runs TallyPrime. Do steps 1 to 3 once; step 4 for each client company; steps 5 and 6 at the client.

## 1. Supabase (database)

1. Create a project at supabase.com. Pick the region closest to the client (there is no UAE region; Mumbai or Frankfurt are the nearest options, see BRD Q9).
2. Open **SQL Editor**, paste all of `relay/supabase/schema.sql`, and run it. It is safe to run again after updates.
3. Copy the **Project URL** (Project Settings > Data API) and a **secret key** (Project Settings > API Keys > Secret keys, `sb_secret_...`; the legacy **service_role** key also works). Treat this key like a password: it goes only into Cloudflare's secret settings.

The schema turns on row-level security with no public policies, so Supabase's public API exposes nothing. All access goes through the `qe_api` database function, which only the service role can call.

## 2. Cloudflare (app and API)

The repository works both as a Cloudflare **Worker** (the default in the current dashboard) and as a **Pages** project. Use one of them.

**Worker (recommended)**

1. Cloudflare dashboard > **Workers & Pages > Create > Import a repository**, choose the repository.
2. Project name **`tallyentry`**. It must match `name` in `wrangler.jsonc`; if you pick another name, change it there too. Build command: **empty**. Deploy command: **`npx wrangler deploy`** (the default).
3. Deploy. `wrangler.jsonc` tells Cloudflare to serve the `app` folder and run `worker/index.js` for `/api/*`.
4. Worker > **Settings > Variables and secrets**, add as type **Secret**: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Secrets added here are kept across deploys.
5. The app is at `https://tallyentry.<your-account>.workers.dev`. Add a custom domain under **Settings > Domains & Routes** if wanted.

Check: open `https://<address>/api/settings`. "Please sign in again" means the API runs. "Server not configured" means a secret is missing.

**Pages (alternative)**

Create > Pages > Connect to Git. Framework **None**, build command **empty**, output directory **`app`**. Cloudflare picks up `functions/api/[[path]].js` as the API. Add the same two secrets under Settings > Variables and secrets.

Every push to the main branch redeploys either way.

Demo only: dragging the `app` folder into **Create > Pages > Upload assets** publishes the demo without an API.

## 3. Office PC with TallyPrime

**TallyPrime settings** (use a test company first):

| Setting | Where | Value |
| --- | --- | --- |
| XML/HTTP interface | F1 Help > Settings > Connectivity > Client/Server configuration | TallyPrime acts as: **Both**; Port: **9000** |
| Order processing | F11 Features > Inventory | Enable: Yes (for Sales Orders) |
| VAT | F11 Features > Taxation | Enable VAT, set TRN and rates |
| Add-on | F1 Help > TDLs & Add-ons > F4 Manage Local TDLs | Load on startup: Yes; add the path of `tdl/QuickEntry.tdl`; restart Tally |
| Ledgers | Create if missing | Sales and purchase ledgers, Output VAT and Input VAT, Round Off, Cash and bank ledgers |

Check the XML port: on the Tally PC, open `http://localhost:9000` in a browser. It should say TallyPrime Server is running.

**Connector** (Windows 10 or 11, or Windows Server 2016 or later)

1. Download the project from GitHub (**Code > Download ZIP**) or the connector package, and unzip it anywhere on the Tally PC.
2. Open `connector\windows` and double-click **install.cmd**. Windows asks for administrator rights.
3. Answer the questions:
   - **Company name exactly as shown in TallyPrime**
   - **App address**, for example `https://quickentry.pages.dev`
   - **Connector key** from step 4. It is not shown as you paste it, and it is never put on the command line.
4. If Node.js is missing, the installer offers to install Node.js LTS with winget. Without winget, install it from nodejs.org and run install.cmd again.
5. The installer tests the connection and prints one line per check:
   - TallyPrime answers on port 9000.
   - The company is open in Tally.
   - The cloud accepts the key.

   A `FAIL` line says what to fix. The connector is installed anyway and keeps retrying.

What it sets up:

| Item | Where |
| --- | --- |
| Program | `C:\Program Files\QuickEntry` |
| Settings, key, log | `C:\ProgramData\QuickEntry` (`config.json`, `connector.key`, `connector.log`). Only SYSTEM and Administrators can read this folder. |
| Background task | Task Scheduler > **QuickEntry Connector**. Runs as SYSTEM when Windows starts, with no one signed in. It is re-checked every 5 minutes and starts again if it stopped. |

Daily use:

- **`C:\Program Files\QuickEntry\check.cmd`** tests the connection again and shows whether the task is running and the last log lines. Use it first when something does not reach Tally.
- **Upgrade:** unzip the new version and run install.cmd again. Settings and key are kept. Add `-NewKey` to replace the key.
- **Remove:** `C:\Program Files\QuickEntry\uninstall.cmd` (add `-RemoveData` to also delete settings, key and log). Nothing in Tally or the cloud is changed.

TallyPrime must be open with the company loaded for entries to post; while it is closed, entries wait in the cloud and nothing is lost. The connector needs only outbound HTTPS. Keep inbound port 9000 closed in Windows Defender Firewall unless another office PC needs it.

Manual run (for troubleshooting, from an administrator prompt): `node "C:\Program Files\QuickEntry\connector\index.js" --config "C:\ProgramData\QuickEntry\config.json" --once`

## 4. Add a client company and its users (no SQL)

**One-time: owner key.** Make a long random key, for example with a password manager (at least 24 characters). Add it to the Worker under **Settings > Variables and secrets** as a **Secret** named `OWNER_KEY`. Keep it private: it can create companies and reset any key.

**New client company.** Open `https://<your-app-address>/owner.html` and enter the owner key. Then fill in **New client company**:
- company name,
- company ID (suggested from the name),
- first office admin's name, code and password (one is suggested).

Click **Create company**. Shown once:
- the **admin's sign-in details** (Company ID, user code, password), with **Send by WhatsApp**,
- the **office connector key** for `install.cmd` on the client's Tally PC.

Tick **Remember on this device** when signing in to the owner page on your own phone or laptop; **Lock** forgets the key.

**Salespeople.** The client's office admin opens the app and goes to **More > Users and passwords**. For each person they enter the name, a 2 to 6 letter code (used in document numbers, for example SI-AHM-0001), a role and a password (one is suggested):
- **Sales**: creates entries.
- **Office admin**: also manages settings, users, conflicts, the archive and the Tally sync check.

The sign-in details are shown once, with **Send by WhatsApp**. On the phone the person opens the app and signs in with **Company ID, user code and password**. Five wrong passwords lock that person for 15 minutes. Passwords are stored as bcrypt hashes.

A sign-in key with a one-tap WhatsApp link (**New key**) still works, under **Other ways to sign in**.

| To do this | Use |
| --- | --- |
| Forgotten password or locked out | **Reset password** (also unlocks) |
| Lost phone or a person leaves | **Reset password** and **New key** (signs them out of every phone at once), or **Switch off** |
| Admin forgot their own password | Owner page > the company > **Users** > **Reset password** |
| Tally PC replaced or connector key exposed | Owner page > **New connector key**, then run `install.cmd -NewKey` on the Tally PC |

Safety rules: an admin cannot switch themselves off or demote themselves, and every company keeps at least one active admin. Keys are stored only as SHA-256 hashes.

Tally ledger names, company details, logo and VAT are set by the office admin in the app under **More**.

**Data kept on the server.** Each company's admin sets this under **More > Company and documents**: entries already in Tally stay active for 7 days, are then archived for 30 days (admins can search them under **More > Archive**), then deleted. Phones keep 2 days. Anything not yet in Tally is never archived or deleted. The cleanup runs by itself about once an hour while the office connector is running.

**Is everything in Tally?** Admins open **More > Tally sync check**: counts of entries waiting, failed or in conflict, the oldest one waiting, and whether the office PC is talking to Tally.

**After updating the code:** run `relay/supabase/schema.sql` again in the Supabase SQL editor. It's safe to re-run, and it adds new database functions.

Command-line alternative: `node relay/supabase/new-tenant.mjs --id al-noor --name "Al Noor Trading LLC" --user "Office Admin:ADM:admin"` prints SQL and keys.

## 5. Phones, tablets and PCs

1. Open the app address in Safari (iPhone) or Chrome (Android, PC).
2. **Install it**: iPhone: Share > Add to Home Screen. Android/PC: Install app. On iPhone this matters: iOS can clear storage of web apps that are not installed.
3. The app opens on the sign-in screen: enter the Company ID, user code and password from the office admin, tap **Sign in**.
4. Wait for the first sync (customers and items download), then the app works offline.

## 5a. Van stock (optional: salespeople selling from their own van)

Use this when each salesperson takes stock out in a van and sells from it.

1. **In TallyPrime:** F11 Features > Inventory > switch on **Maintain multiple godowns**. Create one godown for the office store (Tally's default is **Main Location**) and one godown per van, for example **Van 1**, **Van 2**. Tally must also have the **Stock Journal** voucher type (it does by default).
2. **In the app (office admin):** More > **Van stock**. Tick **Use van stock**, check the office godown name, add each van with its Tally godown name, and pick the salesperson for each van. Save. Phones pick it up at their next sync.
3. **Daily routine:**
   * Morning: Home > **Issue to Van**. Office stock goes down at once; the van's stock goes up. Posts a Stock Journal (office godown to van godown).
   * During the day: the salesperson's invoices take stock from their van (the invoice is posted from the van godown). The app does not let them sell more than the van holds.
   * Evening: Home > **Return from Van** > **Return everything in the van**, change any quantity that is short, save. Posts a Stock Journal back to the office godown. A van not returned by the next day is flagged on the home screen and on **Van stock**.
4. **Van stock** (Home) shows what is in every van and the office store. Office store = Tally's total stock − stock in vans − van sales not in Tally yet.

To give a van to someone else (leave, new joiner), change its salesperson in More > Van stock; the stock stays with the van. The full user guide is in docs/VAN-STOCK.md.

Database: run the updated `relay/supabase/schema.sql` once (it adds the `van_moves` table and the `stock.vans` operation; re-running is safe).

## 6. First live test on a real TallyPrime (do this before go-live)

Use a copy of the client's company. Each line checks one point marked `VERIFY` in the code.

1. Connector `--once` with the add-on loaded: every ledger and item in Tally should get a QE Code (visible in the master alteration screen). If import of codes fails, check the UDF tag layout in `setMasterCodeRequest` (`app/core/tally-xml.js`).
2. Create an invoice in the app, sync. Check in Day Book: correct party, items, quantities, VAT and total; voucher type Sales in invoice mode.
3. Press Sync now several times and re-run the connector: still one voucher.
4. Edit the invoice in the app, sync: the same voucher (same number and Master ID) changes. If Tally creates a second voucher instead, the alter-by-MasterID header in `voucherRequest` needs adjusting for that Tally release.
5. Rename the customer in Tally, sync: the app shows the new name; old invoices still link to it.
6. Receipt with cheque, Sales Order, and Purchase: check each voucher in Tally.
7. Change a synced voucher in Tally, then edit it in the app: the app shows Conflict.
8. Cancel a synced invoice in the app, sync: Day Book shows the same voucher number as cancelled.
9. Customer balances: pick a customer with bill-wise outstanding in the app. The balance should match the ledger's closing balance in Tally, and the overdue amount should match Tally's Ledger Outstandings (bills past their credit period). If overdue shows nothing and the connector log says it could not read outstanding bills, the `Bills` collection in `billsRequest` needs adjusting.
10. Credit limit, credit days and price level set on a customer in Tally appear in the app after a sync. An item with a price list for that price level fills its rate in the app.
11. Post a sale in Tally itself: within one sync the app shows the customer's new balance and the item's new stock.

Record the TallyPrime release tested and any changes, then mark the integration as verified in the README.

## Upgrading an existing installation (for example to van stock, connector 0.3.0)

Do these in order. Each step is safe to repeat.

1. **Database (Supabase):** SQL Editor, paste all of the new `relay/supabase/schema.sql`, run. It only adds what is missing (for van stock: the `van_moves` table and the `stock.vans` operation); existing data stays.
2. **App and API (Cloudflare):** merge the change to `main`. Workers Builds deploys it in about a minute. Phones pick up the new app the next time it is opened (an entry being typed is not interrupted).
3. **Office PC:** copy the new office setup package (`QuickEntry-Office-Setup-v1.3.zip`) to the PC, unzip it, open `connector\windows` and double-click `install.cmd`. It upgrades the program files and keeps the company name, address and connector key. Then run `check.cmd`: the first line must say **version 0.3.0** and every line **OK**.
4. **New features that need switching on** (van stock): set up Tally first (section 5a), then switch the feature on in the app.

An older connector cannot post van issues or returns: they show as **Failed** in the sync check. Update the office PC before switching van stock on. Failed entries are retried automatically for a few hours; after that, open the entry and tap **Retry now**.

### Moving the connector to a different office PC

1. On the old PC: `C:\Program Files\QuickEntry\uninstall.cmd` (stops the background task).
2. On the new PC: install TallyPrime with the same company, load `tdl\QuickEntry.tdl` (section 3), then run `install.cmd` from the latest office package. Enter the same company name and app address. For the key, use the company's connector key; if it is not at hand, create a new one in the owner screen (`/owner.html` > the company > **New connector key**), which also stops the old PC's key.
3. Run `check.cmd`. Nothing is lost by the move: entries wait on the server until the new PC posts them, and the connector's sync position is stored on the server, not on the PC.

## Self-hosted alternative

`relay/dev-server.js` serves the app and the same API from one Node process with JSON-file storage, using `relay/config.json` (created on first run with random keys). It suits development or a small pilot on one server; production should use Supabase for backups and scale.
