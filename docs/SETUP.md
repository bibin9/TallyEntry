# Setup guide

Production uses three pieces: **Supabase** (database), **Cloudflare Pages** (app and API), and the **QuickEntry connector** on the office PC that runs TallyPrime. Do steps 1 to 3 once; step 4 for each client company; steps 5 and 6 at the client.

## 1. Supabase (database)

1. Create a project at supabase.com. Pick the region closest to the client (there is no UAE region; Mumbai or Frankfurt are the nearest options, see BRD Q9).
2. Open **SQL Editor**, paste all of `relay/supabase/schema.sql`, and run it. It is safe to run again after updates.
3. From **Project Settings > API**, copy the **Project URL** and the **service_role** key. Treat the service_role key like a password: it goes only into Cloudflare's secret settings.

The schema turns on row-level security with no public policies, so Supabase's public API exposes nothing. All access goes through the `qe_api` database function, which only the service role can call.

## 2. Cloudflare Pages (app and API)

1. Put this project in a GitHub repository.
2. Cloudflare dashboard > **Workers & Pages > Create > Pages > Connect to Git**, choose the repository.
3. Build settings: Framework preset **None**, Build command **empty**, Build output directory **`app`**, Root directory **`/`**. Cloudflare picks up `functions/api/[[path]].js` automatically as the API.
4. **Settings > Variables and secrets**, add as *Secret*: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
5. Deploy. The app is then at `https://<project>.pages.dev`; add a custom domain under **Custom domains** if wanted.

Every push to the main branch redeploys. Use a second branch for the staging environment (Cloudflare gives each branch its own preview address).

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

## 4. Add a client company and its users

```
node relay/supabase/new-tenant.mjs --id al-noor --name "Al Noor Trading LLC" --user "Office Admin:ADM:admin" --user "Ahmed:AHM:sales"
```

It prints SQL to run in Supabase and the keys: one connector key (for step 3) and one sign-in key per user. Only hashes are stored; if a key is lost, create a new one.

Match the ledger names in Tally (SQL editor, one line per name that differs):

```
update tenants set settings = jsonb_set(settings, '{ledgerMap,salesLedger}', '"Sales Local"') where id = 'al-noor';
```

Keys in `ledgerMap`: `salesLedger`, `purchaseLedger`, `outputTaxLedger`, `inputTaxLedger`, `roundOffLedger`, `cashLedger`. Company name, address and TRN for documents are under `settings.company`. VAT rates can be changed by an admin in the app (More > VAT settings).

## 5. Phones, tablets and PCs

1. Open the app address in Safari (iPhone) or Chrome (Android, PC).
2. **Install it**: iPhone: Share > Add to Home Screen. Android/PC: Install app. On iPhone this matters: iOS can clear storage of web apps that are not installed.
3. More > Connection: leave the server address empty, enter the user's sign-in key, tap **Use live mode**.
4. Wait for the first sync (customers and items download), then the app works offline.

## 6. First live test on a real TallyPrime (do this before go-live)

Use a copy of the client's company. Each line checks one point marked `VERIFY` in the code.

1. Connector `--once` with the add-on loaded: every ledger and item in Tally should get a QE Code (visible in the master alteration screen). If import of codes fails, check the UDF tag layout in `setMasterCodeRequest` (`app/core/tally-xml.js`).
2. Create an invoice in the app, sync. Check in Day Book: correct party, items, quantities, VAT and total; voucher type Sales in invoice mode.
3. Press Sync now several times and re-run the connector: still one voucher.
4. Edit the invoice in the app, sync: the same voucher (same number and Master ID) changes. If Tally creates a second voucher instead, the alter-by-MasterID header in `voucherRequest` needs adjusting for that Tally release.
5. Rename the customer in Tally, sync: the app shows the new name; old invoices still link to it.
6. Receipt with cheque, Sales Order, and Purchase: check each voucher in Tally.
7. Change a synced voucher in Tally, then edit it in the app: the app shows Conflict.

Record the TallyPrime release tested and any changes, then mark the integration as verified in the README.

## Self-hosted alternative

`relay/dev-server.js` serves the app and the same API from one Node process with JSON-file storage, using `relay/config.json` (created on first run with random keys). It suits development or a small pilot on one server; production should use Supabase for backups and scale.
