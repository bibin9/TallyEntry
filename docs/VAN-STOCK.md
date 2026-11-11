# Van stock: user guide

Each salesperson's van is its own store. The office store and every van have their own stock.

| When | Who | In the app | Office store | Van | In Tally |
| --- | --- | --- | --- | --- | --- |
| Morning | Office admin | Home > **Issue to Van** | goes down | goes up | Stock Journal: office godown → van godown |
| During the day | Salesperson | **New Invoice** (as usual) | no change | goes down | Sales voucher from the van godown |
| End of day | Office admin | Home > **Return from Van** > **Return everything in the van** | goes up | back to 0 | Stock Journal: van godown → office godown |

Example: the office has 1,500. It issues 300 to Ajay, 200 to Ben and 500 to Chris, so the office store shows 500. Ajay sells 250 from the van, so Ajay's van shows 50 and the office store still shows 500. In the evening Ajay returns 50, so the van shows 0 and the office store shows 550.

## One-time setup

1. **TallyPrime:** F11 Features > Inventory > **Maintain multiple godowns: Yes**. Create a godown for each van (Gateway of Tally > Create > Godown), for example `Van 1`, `Van 2`. The office store is Tally's **Main Location** unless you use another godown for it.
2. **Office PC:** the connector must be version **0.3.0** or later (office setup package v1.3). Run `check.cmd` to see the version. See SETUP.md, "Upgrading".
3. **App (office admin):** More > **Van stock**:
    * tick **Use van stock**;
    * **Office store godown in Tally**: usually `Main Location`;
    * **+ Add van** for each van: a name (for example `Van 1 (A 12345)`), the **godown name exactly as in Tally**, and the **salesperson**;
    * **Save for all users**. Phones get it at their next sync.

A salesperson sells from one van. To give a van to someone else (leave, new joiner), change its salesperson; the stock stays with the van. A van with stock in it cannot be removed; return its stock first.

## Daily use

**Morning (office):** Home > **Issue to Van** > choose the van > **+ Add item** for each item and enter the quantity > **Save**. Each line shows the office store stock. Print or share the issue note for the driver to sign.

**During the day (salesperson):** make invoices as usual. The home screen says "You sell from Van 1". Each item shows how many are in the van. The app does not save an invoice for more than the van holds. If the office has just loaded the van, tap **Sync now** first so the phone knows.

**End of day (office):** Home > **Return from Van** > choose the van > **Return everything in the van** (fills in all items left) > correct any quantity that did not come back (damaged or missing) > **Save**.

Every van must be returned at the end of the day. A van that still has stock from an earlier day is flagged on the home screen and on **Van stock**.

## Van stock screen

Home > **Van stock** (office admin) shows each van's items and the **office store**. A salesperson sees **My van stock**.

Office store = Tally's total stock − stock in vans − van sales not yet posted in Tally. Tally's figures are as of the last sync.

## Office sales

When the office admin makes an invoice, **Sell from** chooses **Office store** (the default) or a van.

## If something fails

* "Godown 'Van 1' does not exist" in the sync check: the godown name in More > Van stock does not match Tally, or the godown was not created. Fix the name or create the godown, then tap **Retry now** on the entry.
* Van entries **Failed** right after switching on: the office PC still runs an older connector. Install office setup v1.3, then retry.
