# Test report

Run on 31 Oct 2026 in headless Chromium (Playwright), phone-sized window 400 x 860. Tally is the **simulator** in every test; nothing here verifies a live TallyPrime.

## BRD acceptance criteria (demo mode, `tests/e2e.mjs`)

| AC | Check | Result | Detail |
| --- | --- | --- | --- |
| 1 | Invoice saved offline | Pass | total AED 810.08, status Pending |
| 1 | Receipt saved offline | Pass |  |
| 2 | Records survive an app restart while offline | Pass | 2 rows, 2 pending |
| 3 | Pending transactions sync automatically when back online | Pass |  |
| 4 | Repeated syncs create no duplicate vouchers | Pass | Tally vouchers: 2 then 2 |
| 5 | Editing a synced invoice updates the same Tally voucher | Pass | voucher ID 24 -> 24, amount 810.08 -> 1251.08; Tally voucher SI-DEMO-0001 (ID 24) · version 2 of 2 |
| 6 | Renaming a customer in Tally updates the same app record | Pass | customer list: Gulf Star Electronics LLC |
| 7 | Later master syncs send only changes | Pass | latest: 2:11:19 PMtally->cloud masters (ledgers +0/~1, items +0/~0); first: 2:11:12 PMtally->cloud masters (ledgers +16/~0, items +0/~0) |
| 8 | Recent transactions can be viewed and edited on the device (offline) | Pass | receipt in Tally now 1750.00 |
| 9 | PDF export, print and WhatsApp share (share works offline) | Pass | PDF SI-DEMO-0001.pdf, 8121 bytes; shared SI-DEMO-0001.pdf |
| 10 | Customer and item search stays fast with 5,000 customers and 10,000 items | Pass | worst search 2.7 ms; 5,006 on this device customers; 10,007 on this device items |
| - | No JavaScript errors | Pass |  |

Search timings with 5,006 customers and 10,007 items on the device:

| Query | Search time (ms) |
| --- | --- |
| falcon | 0.6 |
| falcon hardware | 1.0 |
| sharjah 12 | 0.9 |
| zzz | 0.6 |
| led bulb | 1.8 |
| cable 4mm | 2.2 |
| model 9876 | 2.7 |

## Production path (`tests/e2e-live.mjs`)

Browser in live mode, Cloudflare Pages Function run locally, Postgres 16 with `relay/supabase/schema.sql`, connector process, simulated Tally on HTTP: 8 of 8 checks passed (sign-in and master download, offline invoice, upload when online, posting to Tally, edit alters the same voucher, wrong keys refused, lines table, no JS errors).

## Sync scenarios (`npm test`)

10 scenarios run on both the in-memory relay and Postgres (21 tests in total including the HTTP stack test), all passing: full first sync with code assignment, changes-only master sync, rename by code, no duplicates on repeated upload and sync, no duplicate after a lost Tally reply, edit alters the same voucher, conflict held for the office, failure with Tally's reason and retry, Tally closed, deleted master marked inactive.

Screenshots are in this folder.
