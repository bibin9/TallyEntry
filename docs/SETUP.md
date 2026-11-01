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

**Connector**

1. Install Node.js 20 LTS (nodejs.org).
2. Copy the project to `C:\QuickEntry` (the connector needs the `connector` and `app\core` folders).
3. Copy `connector\config.example.json` to `connector\config.json` and set `tallyCompany` (exact company name in Tally) and `relayUrl` (your `https://<project>.pages.dev`). Leave `connectorKey` out.
4. Set the connector key as a system environment variable, so it is not in a file: `setx /M QE_CONNECTOR_KEY "<key from step 4>"` in an administrator Command Prompt.
5. Test once: `node C:\QuickEntry\connector\index.js --once`. It should log masters fetched and exit with no error.
6. Run it as a Windows service with NSSM (nssm.cc), from an administrator prompt:
   ```
   nssm install QuickEntryConnector "C:\Program Files\nodejs\node.exe" "C:\QuickEntry\connector\index.js"
   nssm set QuickEntryConnector AppDirectory C:\QuickEntry
   nssm set QuickEntryConnector Start SERVICE_AUTO_START
   nssm start QuickEntryConnector
   ```
7. Windows Defender Firewall: make sure **inbound** port 9000 is not open to other machines unless another office PC needs it. The connector only needs outbound HTTPS.

The connector logs to `connector\connector.log`. It retries every 30 seconds; if Tally is closed, nothing is lost.

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
