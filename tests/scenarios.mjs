// Backend-independent acceptance scenarios (BRD criteria 3-7 and failure handling).
// Run against the in-memory relay (memory.test.mjs) and the Supabase/Postgres relay (sql.test.mjs).
// Tally is the SIMULATOR here: these tests do not verify a live TallyPrime.
import assert from 'node:assert/strict';
import { TallySim } from '../app/core/tally-sim.js';
import { Connector } from '../app/core/connector-core.js';
import { uuid } from '../app/core/types.js';

const today = new Date().toISOString().slice(0, 10);

export function scenarios(test, makeBackend) {
  async function setup() {
    const b = await makeBackend();
    const sim = new TallySim();
    const conn = new Connector({ tally: async (x) => sim.handle(x), relay: b.relay, company: sim.company });
    const ctx = { ...b, sim, conn };
    const r = await conn.runOnce();
    assert.equal(r.error, null);
    ctx.m = await b.device.masters(0);
    return ctx;
  }
  const status = async (ctx, id) => (await ctx.device.statuses([id]))[0];
  const inv = (ctx, over = {}) => {
    const cust = ctx.m.ledgers.find((l) => l.role === 'customer');
    return { id: uuid(), version: 1, type: 'si', number: 'SI-T-' + Math.floor(Math.random() * 1e6), date: today, partyCode: cust.code,
      lines: [{ itemCode: ctx.m.items[0].code, qty: 10, rate: 42, discPct: 0, taxCode: 'SR' }, { itemCode: ctx.m.items[1].code, qty: 2, rate: 185, discPct: 5, taxCode: 'SR' }], ...over };
  };

  test('first sync is full and every master gets a stable code', async (t) => {
    const ctx = await setup(); t.after(ctx.cleanup);
    assert.equal(ctx.m.ledgers.length, Object.keys(ctx.sim.s.ledgers).length);
    assert.equal(ctx.m.items.length, Object.keys(ctx.sim.s.items).length);
    for (const l of Object.values(ctx.sim.s.ledgers)) assert.match(l.qeCode, /^[CSAL]\d{6}$/);
    assert.equal(ctx.m.ledgers.find((l) => l.code === 'C000001').name, 'Al Madina Supermarket');
  });

  test('an empty <LEDGER/> or <STOCKITEM/> from a real TallyPrime is ignored, not saved as a blank master', async (t) => {
    const ctx = await setup(); t.after(ctx.cleanup);
    // Real TallyPrime answered "nothing changed" with an empty object; reproduce that.
    const tally = async (x) => {
      const out = await ctx.sim.handle(x);
      return String(out).replace(/<\/COLLECTION>/, '<LEDGER NAME="" RESERVEDNAME=""></LEDGER><STOCKITEM></STOCKITEM></COLLECTION>');
    };
    const conn = new Connector({ tally, relay: ctx.relay, company: ctx.sim.company });
    for (let i = 0; i < 3; i++) assert.equal((await conn.runOnce()).error, null);
    const m = await ctx.device.masters(0);
    assert.equal(m.ledgers.filter((l) => !l.name).length, 0);
    assert.equal(m.items.filter((l) => !l.name).length, 0);
    assert.equal(m.ledgers.length, ctx.m.ledgers.length);
    assert.equal(m.items.length, ctx.m.items.length);
  });

  test('AC7: later master syncs transfer only additions and changes', async (t) => {
    const ctx = await setup(); t.after(ctx.cleanup);
    const r2 = await ctx.conn.runOnce();
    assert.equal(r2.masters.ledgers.fetched + r2.masters.items.fetched, 0);
    ctx.sim.addItem({ name: 'New Item X', unit: 'Pcs', rate: 9 });
    ctx.sim.changeItemRate('MCB 32A', 25);
    const r3 = await ctx.conn.runOnce();
    assert.deepEqual([r3.masters.items.fetched, r3.masters.items.added, r3.masters.items.updated, r3.masters.ledgers.fetched], [2, 1, 1, 0]);
    const delta = await ctx.device.masters(ctx.m.cursor);
    assert.equal(delta.items.length, 2); assert.equal(delta.ledgers.length, 0);
  });

  test('AC6: a rename in Tally updates the same record by code; later posts use the new name', async (t) => {
    const ctx = await setup(); t.after(ctx.cleanup);
    const code = ctx.sim.s.ledgers['Gulf Star Electronics'].qeCode;
    const x = inv(ctx, { partyCode: code });
    await ctx.device.push([x]); await ctx.conn.runOnce();
    ctx.sim.renameLedger('Gulf Star Electronics', 'Gulf Star Electronics LLC');
    await ctx.conn.runOnce();
    const delta = await ctx.device.masters(ctx.m.cursor);
    assert.equal(delta.ledgers.length, 1);
    assert.equal(delta.ledgers[0].code, code);
    assert.equal(delta.ledgers[0].name, 'Gulf Star Electronics LLC');
    const all = await ctx.device.masters(0);
    assert.equal(all.ledgers.length, ctx.m.ledgers.length, 'no new record');
    await ctx.device.push([{ ...x, version: 2, narration: 'after rename' }]);
    await ctx.conn.runOnce();
    assert.equal((await status(ctx, x.id)).status, 'synced');
    assert.equal(ctx.sim.s.vouchers[0].party, 'Gulf Star Electronics LLC');
  });

  test('AC3+AC4: posts once; repeated uploads and syncs create no duplicates', async (t) => {
    const ctx = await setup(); t.after(ctx.cleanup);
    const x = inv(ctx);
    const acct = ctx.m.ledgers.find((l) => l.role === 'account');
    const rc = { id: uuid(), version: 1, type: 'rc', number: 'RV-T-1', date: today, partyCode: x.partyCode, amount: 500, mode: 'Cheque', accountCode: acct.code, reference: 'CHQ 1' };
    for (let i = 0; i < 3; i++) await ctx.device.push([x, rc]);
    for (let i = 0; i < 4; i++) await ctx.conn.runOnce();
    assert.equal(ctx.sim.s.vouchers.length, 2);
    assert.deepEqual((await ctx.device.statuses([x.id, rc.id])).map((s) => s.status), ['synced', 'synced']);
  });

  test('AC4: a lost Tally reply does not create a duplicate on retry', async (t) => {
    const ctx = await setup(); t.after(ctx.cleanup);
    const x = inv(ctx);
    await ctx.device.push([x]);
    const real = ctx.conn.tally;
    ctx.conn.tally = async (xml) => { const out = real(xml); if (xml.includes('ACTION="Create"')) throw new Error('socket hang up'); return out; };
    await ctx.conn.runOnce();
    assert.equal(ctx.sim.s.vouchers.length, 1);
    assert.equal((await status(ctx, x.id)).status, 'queued');
    ctx.conn.tally = real;
    await ctx.conn.runOnce();
    assert.equal(ctx.sim.s.vouchers.length, 1);
    assert.equal((await status(ctx, x.id)).status, 'synced');
  });

  test('AC5: editing a synced transaction alters the same Tally voucher', async (t) => {
    const ctx = await setup(); t.after(ctx.cleanup);
    const x = inv(ctx);
    await ctx.device.push([x]); await ctx.conn.runOnce();
    const { masterId, amount } = ctx.sim.s.vouchers[0];
    await ctx.device.push([{ ...x, version: 2, lines: [{ ...x.lines[0], qty: 20 }, x.lines[1]] }]);
    await ctx.conn.runOnce();
    assert.equal(ctx.sim.s.vouchers.length, 1);
    assert.equal(ctx.sim.s.vouchers[0].masterId, masterId);
    assert.ok(ctx.sim.s.vouchers[0].amount > amount);
    const s = await status(ctx, x.id);
    assert.equal(s.status, 'synced'); assert.equal(s.syncedVersion, 2); assert.equal(Number(s.tally.masterId), masterId);
  });

  test('cancel: a synced entry cancelled in the app is cancelled in Tally, keeping the same voucher and number', async (t) => {
    const ctx = await setup(); t.after(ctx.cleanup);
    const x = inv(ctx);
    await ctx.device.push([x]); await ctx.conn.runOnce();
    const { masterId, number } = ctx.sim.s.vouchers[0];
    await ctx.device.push([{ ...x, version: 2, cancelled: true, cancelReason: 'wrong customer' }]);
    await ctx.conn.runOnce();
    assert.equal(ctx.sim.s.vouchers.length, 1, 'no new voucher');
    const v = ctx.sim.s.vouchers[0];
    assert.equal(v.masterId, masterId); assert.equal(v.number, number);
    assert.equal(v.cancelled, true); assert.equal(v.amount, 0);
    assert.match(v.narration, /wrong customer/);
    const s = await status(ctx, x.id);
    assert.equal(s.status, 'synced'); assert.equal(s.syncedVersion, 2);
    await ctx.conn.runOnce();
    assert.equal(ctx.sim.s.vouchers.length, 1, 'a later sync does nothing more');
  });

  test('cancel: an entry cancelled before it reached Tally never creates a voucher', async (t) => {
    const ctx = await setup(); t.after(ctx.cleanup);
    const x = inv(ctx);
    await ctx.device.push([{ ...x, version: 2, cancelled: true }]);
    await ctx.conn.runOnce();
    assert.equal(ctx.sim.s.vouchers.length, 0);
    assert.equal((await status(ctx, x.id)).status, 'synced');
  });

  test('conflict: a voucher changed in Tally waits for the office decision', async (t) => {
    const ctx = await setup(); t.after(ctx.cleanup);
    const x = inv(ctx);
    await ctx.device.push([x]); await ctx.conn.runOnce();
    ctx.sim.editVoucherInTally(ctx.sim.s.vouchers[0].masterId, 'Changed by accountant');
    await ctx.device.push([{ ...x, version: 2, narration: 'changed by salesman' }]);
    await ctx.conn.runOnce();
    assert.equal((await status(ctx, x.id)).status, 'conflict');
    assert.equal(ctx.sim.s.vouchers[0].narration, 'Changed by accountant');
    await ctx.device.resolve(x.id, 'app');
    await ctx.conn.runOnce();
    assert.equal((await status(ctx, x.id)).status, 'synced');
    assert.equal(ctx.sim.s.vouchers[0].narration, 'changed by salesman');
    assert.equal(ctx.sim.s.vouchers.length, 1);
  });

  test('failure carries Tally\'s reason; retry succeeds after the fix', async (t) => {
    const ctx = await setup(); t.after(ctx.cleanup);
    const x = inv(ctx);
    ctx.sim.renameLedger('Output VAT', 'VAT Output 5%');
    await ctx.device.push([x]); await ctx.conn.runOnce();
    const s = await status(ctx, x.id);
    assert.equal(s.status, 'failed'); assert.match(s.error, /Output VAT/);
    ctx.sim.renameLedger('VAT Output 5%', 'Output VAT');
    await ctx.device.retry([x.id]); await ctx.conn.runOnce();
    assert.equal((await status(ctx, x.id)).status, 'synced');
    const log = await ctx.device.log();
    assert.ok(log.some((e) => e.result === 'failed') && log.some((e) => e.result === 'created'));
  });

  test('Tally closed: nothing lost, posts when Tally opens', async (t) => {
    const ctx = await setup(); t.after(ctx.cleanup);
    const x = inv(ctx);
    await ctx.device.push([x]);
    ctx.sim.s.open = false;
    assert.match((await ctx.conn.runOnce()).error, /not reachable/);
    assert.equal((await status(ctx, x.id)).status, 'queued');
    ctx.sim.s.open = true;
    await ctx.conn.runOnce();
    assert.equal((await status(ctx, x.id)).status, 'synced');
  });

  test('deleted master in Tally becomes inactive on the key check', async (t) => {
    const ctx = await setup(); t.after(ctx.cleanup);
    const code = ctx.sim.s.ledgers['Palm Line Interiors'].qeCode;
    ctx.sim.deleteLedger('Palm Line Interiors');
    ctx.conn.keysCheckHours = -1; // force the daily key check now
    await ctx.conn.runOnce();
    const delta = await ctx.device.masters(ctx.m.cursor);
    assert.equal(delta.ledgers.find((l) => l.code === code).active, false);
  });

  test('balances, overdue, credit terms and price levels come from Tally', async (t) => {
    const ctx = await setup(); t.after(ctx.cleanup);
    const c1 = ctx.m.ledgers.find((l) => l.name === 'Al Madina Supermarket');
    assert.equal(c1.balance, 4700);
    assert.equal(c1.creditLimit, 20000);
    assert.equal(c1.creditDays, 30);
    assert.equal(c1.overdue, 3200);          // OB-101 is 45 days old on 30-day terms
    assert.equal(c1.overdueDays, 15);
    const c2 = ctx.m.ledgers.find((l) => l.name === 'Gulf Star Electronics');
    assert.equal(c2.priceLevel, 'Wholesale');
    assert.equal(c2.overdue, 0);
    const led = ctx.m.items.find((i) => i.name === 'LED Panel Light 18W');
    assert.deepEqual(led.priceLevels, { Wholesale: { rate: 37.8, disc: 0 } });
  });

  test('a sale or receipt refreshes balance and stock on the next sync, without a master edit', async (t) => {
    const ctx = await setup(); t.after(ctx.cleanup);
    const cust = ctx.m.ledgers.find((l) => l.name === 'Al Madina Supermarket');
    const item = ctx.m.items[0];
    const stock0 = item.stock;
    const x = inv(ctx, { partyCode: cust.code, lines: [{ itemCode: item.code, qty: 10, rate: 100, discPct: 0, taxCode: 'SR' }] });
    await ctx.device.push([x]);
    await ctx.conn.runOnce();   // posts the invoice
    await ctx.conn.runOnce();   // next cycle reads the new balance and stock
    let delta = await ctx.device.masters(ctx.m.cursor);
    assert.equal(delta.ledgers.find((l) => l.code === cust.code).balance, 4700 + 1050);
    assert.equal(delta.items.find((i) => i.code === item.code).stock, stock0 - 10);
    // A receipt clears the oldest bill first, so the overdue amount goes.
    const rc = { id: uuid(), version: 1, type: 'rc', number: 'RV-T-1', date: today, partyCode: cust.code, amount: 3200, mode: 'cash', accountCode: ctx.m.ledgers.find((l) => l.role === 'account').code };
    await ctx.device.push([rc]);
    await ctx.conn.runOnce(); await ctx.conn.runOnce();
    const all = await ctx.device.masters(0);
    const after = all.ledgers.find((l) => l.code === cust.code);
    assert.equal(after.balance, 4700 + 1050 - 3200);
    assert.equal(after.overdue, 0);
    // Nothing changed in Tally: no master is sent again.
    const before = all.cursor;
    await ctx.conn.runOnce();
    delta = await ctx.device.masters(before);
    assert.equal(delta.ledgers.length + delta.items.length, 0);
  });

  test('balance refresh changes only balance fields and ignores unknown codes', async (t) => {
    const ctx = await setup(); t.after(ctx.cleanup);
    const cust = ctx.m.ledgers.find((l) => l.role === 'customer');
    const r = await ctx.relay.pushBalances({ ledgers: [{ code: cust.code, balance: 99, name: 'Hacked', creditLimit: 1 }, { code: 'NOPE', balance: 1 }], items: [{ code: ctx.m.items[0].code, stock: 'x' }] });
    assert.equal(r.ledgers, 1);
    assert.equal(r.items, 0);
    const m = (await ctx.device.masters(0)).ledgers.find((l) => l.code === cust.code);
    assert.equal(m.balance, 99);
    assert.equal(m.name, cust.name);
    assert.equal(m.creditLimit, cust.creditLimit);
  });

  test('a server without the balance refresh does not stop vouchers from posting', async (t) => {
    const ctx = await setup(); t.after(ctx.cleanup);
    const relay = { ...ctx.relay, pushBalances: async () => { throw new Error('Unknown operation connector.balances'); } };
    const conn = new Connector({ tally: async (x) => ctx.sim.handle(x), relay, company: ctx.sim.company });
    const x = inv(ctx);
    await ctx.device.push([x]);
    const r = await conn.runOnce();
    assert.equal(r.error, null);
    assert.equal((await status(ctx, x.id)).status, 'synced');
  });
}
