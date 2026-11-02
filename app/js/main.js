// QuickEntry for Tally: user interface. Data access goes through db.js (local) and the
// sync engine; this file only renders screens and handles input.

import { db, requestPersistence } from './db.js';
import { HttpApi, NetworkError } from './api.js';
import { SyncEngine } from './sync.js';
import { TYPES, TYPE_ORDER } from '../core/types.js';
import { calcDoc, rateFor } from '../core/vat.js';
import { defaultSettings } from '../core/defaults.js';
import { docModel, docHtml, docPdf, sharePdf, printDoc, downloadBlob, fileName, money, fdate } from './docs.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayIso = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`; return new Date(iso).toLocaleString();
};

const STATUS = {
  pending: { label: 'Pending', hint: 'Saved on this device, waiting for internet' },
  sent: { label: 'Waiting for Tally', hint: 'Received by the server, waiting for the office Tally PC' },
  synced: { label: 'Synced', hint: 'Posted in Tally' },
  failed: { label: 'Failed', hint: 'Tally did not accept it; see the reason' },
  conflict: { label: 'Conflict', hint: 'Changed in Tally and in the app; the office must decide' },
};

const S = {
  view: 'home', params: {}, api: null, sync: null, me: null, settings: defaultSettings(),
  ledgers: [], items: [], ledgerByCode: new Map(), itemByCode: new Map(), txns: [], draft: null, mode: 'demo',
};

// ------------------------------------------------------------------ boot
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  requestPersistence();
  S.mode = (await db.meta('mode')) || 'demo';
  if (S.mode === 'live') {
    const conn = (await db.meta('connection')) || {};
    S.api = new HttpApi(conn.url, conn.token);
  } else {
    const { DemoBackend } = await import('./demo-backend.js');
    S.api = await DemoBackend.create();
    S.api.onChange(() => S.sync.syncNow());
  }
  S.me = (await db.meta('me')) || { name: S.mode === 'demo' ? 'Demo Salesperson' : 'Not signed in', code: S.mode === 'demo' ? 'DEMO' : 'USER', role: S.mode === 'demo' ? 'admin' : 'sales' };
  S.settings = (await db.meta('settings')) || S.settings;
  S.sync = new SyncEngine(S.api, () => { loadTxns().then(renderChrome); });
  await S.sync.init();
  await loadMasters();
  await loadTxns();
  // A sign-in link sent by the admin (#connect=KEY): fill in the key on the Connection card and
  // take the key out of the address bar and history.
  if (location.hash.startsWith('#connect=')) {
    S.prefillToken = decodeURIComponent(location.hash.slice('#connect='.length));
    history.replaceState(null, '', location.pathname + '#more');
    setTimeout(() => toast('Sign-in key filled in. Tap "Use live mode".'), 300);
    S.prefillToken && (S.keyOpen = true);
  }
  // First time on this phone: start at the sign-in screen (the demo is one tap away).
  if (!(await db.meta('mode')) && !location.hash.replace('#', '')) history.replaceState(null, '', location.pathname + '#signin');
  window.addEventListener('hashchange', route);
  route();
  S.sync.start();
  // First run in demo mode: fetch masters and the signed-in user immediately.
  S.api.me().then((me) => { S.me = me; db.meta('me', me); }).catch(() => {});
}

async function loadMasters() {
  const allL = await db.all('ledgers'), allI = await db.all('items');
  const ledgers = allL.filter((l) => l.active !== false), items = allI.filter((i) => i.active !== false);
  // Search index: lowercase haystack per master, built once per master sync.
  for (const l of ledgers) l._h = `${l.name} ${l.code} ${l.phone || ''} ${l.trn || ''}`.toLowerCase();
  for (const i of items) i._h = `${i.name} ${i.code} ${i.partNo || ''}`.toLowerCase();
  // Swap in all at once so a search running meanwhile never sees half-built data.
  Object.assign(S, { ledgers, items, ledgerByCode: new Map(allL.map((l) => [l.code, l])), itemByCode: new Map(allI.map((i) => [i.code, i])), mastersCount: allL.length + allI.length });
}

async function loadTxns() {
  S.txns = (await db.all('txns')).sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
  const s = await db.meta('settings');
  if (s) S.settings = s;
  const lastCursor = await db.meta('mastersCursor');
  if (lastCursor !== S.mastersCursor) { S.mastersCursor = lastCursor; await loadMasters(); }
}

function ctx() { return { settings: S.settings, ledgerByCode: S.ledgerByCode, itemByCode: S.itemByCode }; }

function route() {
  const [view, ...rest] = (location.hash.slice(1) || 'home').split('/');
  S.view = view; S.params = rest;
  render();
}
const go = (h) => { if (location.hash === '#' + h) route(); else location.hash = h; };

// ------------------------------------------------------------------ chrome
async function renderChrome() {
  const c = await S.sync.counts();
  const online = navigator.onLine && !S.sync.offline;
  const waiting = c.pending + c.sent;
  const pill = $('#syncpill');
  pill.className = 'pill ' + (S.sync.running ? 'busy' : c.failed || c.conflict ? 'bad' : !online ? 'off' : waiting ? 'wait' : 'ok');
  pill.innerHTML = S.sync.running ? 'Syncing…' : !online ? `Offline${waiting ? ` · ${waiting} waiting` : ''}` : c.failed || c.conflict ? `${c.failed + c.conflict} need attention` : waiting ? `${waiting} waiting` : 'All synced';
  $('#modebar').innerHTML = S.mode === 'demo'
    ? `<b>DEMO</b> Sample data and a simulated Tally in this browser. Not connected to a real Tally. <a href="#more">Settings</a>`
    : '';
  const signedOut = S.mode === 'live' && /sign in again/i.test(S.sync.lastError || '');
  if (signedOut) $('#modebar').innerHTML = `<b>Signed out</b> Your password or key was changed. <a href="#signin">Sign in again</a>`;
  $('#modebar').hidden = (S.mode !== 'demo' && !signedOut) || S.view === 'signin';
  if (['home', 'list', 'detail', 'sync'].includes(S.view) && !document.activeElement?.matches('input,select,textarea')) render(true);
}

function header(title, back) {
  return `<div class="bar">${back ? `<button class="back" data-go="${back}" aria-label="Back">‹</button>` : ''}<h1>${esc(title)}</h1></div>`;
}

function badge(t) { return `<span class="badge b-${t.status}" title="${esc(STATUS[t.status]?.hint || '')}">${STATUS[t.status]?.label || t.status}</span>`; }

function txnRow(t) {
  const ty = TYPES[t.type];
  const party = S.ledgerByCode.get(t.partyCode)?.name || t.partyCode;
  const total = ty.kind === 'items' ? calcDoc(t.lines, S.settings.tax).total : Number(t.amount) || 0;
  return `<button class="row" data-go="detail/${t.id}"><span class="tag t-${t.type}">${ty.icon}</span>
    <span class="main"><span class="p">${esc(party)}</span><span class="s">${esc(t.number)} · ${fdate(t.date)}</span></span>
    <span class="a">${money(total, S.settings.tax.currency)}<br>${badge(t)}</span></button>`;
}

// ------------------------------------------------------------------ views
const VIEWS = {};

VIEWS.home = async () => {
  const c = await S.sync.counts();
  const today = todayIso();
  const tToday = S.txns.filter((t) => t.date === today);
  const sum = (type) => tToday.filter((t) => t.type === type).reduce((s, t) => s + (TYPES[t.type].kind === 'items' ? calcDoc(t.lines, S.settings.tax).total : Number(t.amount) || 0), 0);
  const cur = S.settings.tax.currency;
  const noMasters = !S.ledgers.length;
  return `${header(S.settings.company.name || 'QuickEntry')}
  <main>
    ${noMasters ? `<div class="card warn">No customers or items on this device yet. Connect to the internet and tap <b>Sync now</b> once to download them from Tally.</div>` : ''}
    <div class="tiles">${TYPE_ORDER.map((k) => `<button class="tile" data-go="new/${k}"><span class="tag t-${k}">${TYPES[k].icon}</span>New ${esc(TYPES[k].short)}</button>`).join('')}</div>
    <div class="card"><div class="sec">Today</div>
      <div class="kpis"><div><div class="lab">Sales</div><div class="val">${money(sum('si'), cur, 0)}</div></div>
      <div><div class="lab">Receipts</div><div class="val">${money(sum('rc'), cur, 0)}</div></div>
      <div><div class="lab">Orders</div><div class="val">${money(sum('so'), cur, 0)}</div></div></div></div>
    <div class="card"><div class="sec">Sync with Tally</div>
      <div class="counts">${['pending', 'sent', 'synced', 'failed', 'conflict'].map((k) => `<button class="cnt c-${k}" data-go="list/${k}"><b>${c[k] || 0}</b>${STATUS[k].label}</button>`).join('')}</div>
      <p class="muted">Last sync ${ago(S.sync.lastSync)}${S.sync.lastError ? ` · <span class="err">${esc(S.sync.lastError)}</span>` : ''}${!navigator.onLine || S.sync.offline ? ' · You are offline. Work is saved on this device.' : ''}</p>
      <button class="btn full" data-act="syncnow">${S.sync.running ? 'Syncing…' : 'Sync now'}</button></div>
    <div class="sec">Recent</div><div class="card list">${S.txns.slice(0, 6).map(txnRow).join('') || '<p class="muted">No transactions yet.</p>'}</div>
  </main>`;
};

VIEWS.list = async () => {
  const f = S.params[0] || 'all';
  const q = (S.listQ || '').toLowerCase();
  let list = S.txns.filter((t) => f === 'all' || t.status === f || t.type === f);
  if (q) list = list.filter((t) => `${t.number} ${S.ledgerByCode.get(t.partyCode)?.name || ''}`.toLowerCase().includes(q));
  const chips = [['all', 'All'], ['pending', 'Pending'], ['sent', 'Waiting for Tally'], ['failed', 'Failed'], ['conflict', 'Conflict'], ['synced', 'Synced'], ...TYPE_ORDER.map((k) => [k, TYPES[k].short])];
  return `${header('Transactions')}<main>
    <input class="search" id="listq" placeholder="Search number or customer" value="${esc(S.listQ || '')}" autocomplete="off">
    <div class="chips">${chips.map(([k, l]) => `<button class="chip ${k === f ? 'on' : ''}" data-go="list/${k}">${l}</button>`).join('')}</div>
    <div class="card list">${list.map(txnRow).join('') || '<p class="muted">Nothing here.</p>'}</div>
    <p class="muted small">This device keeps the last ${S.settings.retentionDays} days of synced transactions, and every unsynced one regardless of age.</p></main>`;
};

// ---------------- transaction form
function blankDraft(type) {
  const t = TYPES[type];
  const d = { type, date: todayIso(), partyCode: S.params[1] || '', narration: '' };
  if (t.kind === 'items') d.lines = [];
  if (type === 'rc') Object.assign(d, { amount: '', mode: S.settings.receiptModes[0], accountCode: S.ledgers.find((l) => l.role === 'account')?.code || '', reference: '', against: '' });
  if (type === 'so') d.dueDate = '';
  if (type === 'pi') d.supplierInvNo = '';
  return d;
}

VIEWS.new = async () => {
  if (!S.draft || S.draft._for !== location.hash) S.draft = { ...blankDraft(S.params[0]), _for: location.hash };
  return formHtml();
};
VIEWS.edit = async () => {
  if (!S.draft || S.draft._for !== location.hash) {
    const t = await db.get('txns', S.params[0]);
    if (!t) return `${header('Not found', 'list')}<main><p>This transaction is no longer on this device.</p></main>`;
    S.draft = { ...structuredClone(t), _for: location.hash };
  }
  return formHtml();
};

function formHtml() {
  const d = S.draft, t = TYPES[d.type];
  const party = S.ledgerByCode.get(d.partyCode);
  const tax = S.settings.tax, cur = tax.currency;
  const editing = !!d.id;
  let body = `<label>Date</label><input type="date" data-f="date" value="${esc(d.date)}">
    <label>${t.party === 'supplier' ? 'Supplier' : 'Customer'}</label>
    <button class="picker ${party ? '' : 'empty'}" data-act="pickparty">${party ? `<b>${esc(party.name)}</b><span class="s">${esc(party.code)}${party.phone ? ' · ' + esc(party.phone) : ''}${party.trn ? ` · ${tax.taxIdLabel} ${esc(party.trn)}` : ''}</span>` : `Tap to choose ${t.party}`}</button>`;
  if (d.type === 'so') body += `<label>Delivery date</label><input type="date" data-f="dueDate" value="${esc(d.dueDate || '')}">`;
  if (d.type === 'pi') body += `<label>Supplier invoice no.</label><input data-f="supplierInvNo" value="${esc(d.supplierInvNo || '')}" placeholder="As printed on the supplier's invoice">`;
  if (t.kind === 'items') {
    const c = calcDoc(d.lines, tax);
    body += `<div class="sec">Items</div>` + c.lines.map((l, i) => {
      const it = S.itemByCode.get(l.itemCode) || { name: l.itemCode, unit: '' };
      return `<div class="line" data-line="${i}"><div class="lh"><b>${esc(it.name)}</b><button class="x" data-act="delline" data-i="${i}" aria-label="Remove">✕</button></div>
        <div class="grid4"><div><label>Qty (${esc(it.unit)})</label><input inputmode="decimal" data-l="qty" data-i="${i}" value="${esc(l.qty)}"></div>
        <div><label>Rate</label><input inputmode="decimal" data-l="rate" data-i="${i}" value="${esc(l.rate)}" ${S.settings.allowRateEdit ? '' : 'readonly'}></div>
        <div><label>Disc %</label><input inputmode="decimal" data-l="discPct" data-i="${i}" value="${esc(l.discPct || '')}"></div>
        <div><label>${esc(tax.taxLabel)}</label><select data-l="taxCode" data-i="${i}">${tax.rates.map((r) => `<option value="${esc(r.code)}" ${r.code === l.taxCode ? 'selected' : ''} title="${esc(r.label)}">${esc(r.code)} ${esc(r.rate)}%</option>`).join('')}</select></div></div>
        <div class="lt">${esc(tax.taxLabel)} ${money(l.tax, cur)} · <b>${money(l.amount, cur)}</b></div></div>`;
    }).join('') + `<button class="btn ghost full" data-act="additem">+ Add item</button>
      <div class="totals"><div><span>Before ${esc(tax.taxLabel)}</span><span id="t-taxable">${money(c.taxable, cur)}</span></div>
      <div><span>${esc(tax.taxLabel)}</span><span id="t-tax">${money(c.tax, cur)}</span></div>
      <div class="grand"><span>Total</span><span id="t-total">${money(c.total, cur)}</span></div></div>`;
  } else {
    const accounts = S.ledgers.filter((l) => l.role === 'account');
    const invoices = S.txns.filter((x) => x.type === 'si' && x.partyCode === d.partyCode);
    body += `<label>Amount (${esc(cur)})</label><input inputmode="decimal" data-f="amount" value="${esc(d.amount)}" class="big">
      <label>Mode</label><select data-f="mode">${S.settings.receiptModes.map((m) => `<option ${m === d.mode ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
      <label>Deposit to</label><select data-f="accountCode">${accounts.map((a) => `<option value="${esc(a.code)}" ${a.code === d.accountCode ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
      <label>Cheque / reference no.</label><input data-f="reference" value="${esc(d.reference || '')}">
      <label>Against invoice (optional)</label><input data-f="against" list="invlist" value="${esc(d.against || '')}" placeholder="Leave empty for on account">
      <datalist id="invlist">${invoices.map((x) => `<option value="${esc(x.number)}">`).join('')}</datalist>`;
  }
  body += `<label>Note (optional)</label><textarea data-f="narration" rows="2">${esc(d.narration || '')}</textarea>`;
  return `${header((editing ? 'Edit ' : 'New ') + t.name, editing ? 'detail/' + d.id : 'home')}<main class="form">
    ${t.note ? `<div class="card warn small">${esc(t.note)}</div>` : ''}
    ${editing && d.syncedVersion ? `<div class="card info small">Already in Tally. Saving will update the same Tally voucher at the next sync.</div>` : ''}
    <div class="card">${body}</div><div id="formerr" class="err"></div>
    <div class="savebar"><button class="btn full" data-act="save">Save${navigator.onLine ? '' : ' (offline)'}</button></div></main>`;
}

function updateTotals() {
  const c = calcDoc(S.draft.lines, S.settings.tax), cur = S.settings.tax.currency;
  if (!$('#t-total')) return;
  $('#t-taxable').textContent = money(c.taxable, cur); $('#t-tax').textContent = money(c.tax, cur); $('#t-total').textContent = money(c.total, cur);
  c.lines.forEach((l, i) => { const el = $(`[data-line="${i}"] .lt`); if (el) el.innerHTML = `${esc(S.settings.tax.taxLabel)} ${money(l.tax, cur)} · <b>${money(l.amount, cur)}</b>`; });
}

function validate(d) {
  const t = TYPES[d.type];
  if (!d.date) return 'Enter the date.';
  if (!d.partyCode || !S.ledgerByCode.get(d.partyCode)) return `Choose a ${t.party}.`;
  if (t.kind === 'items') {
    if (!d.lines.length) return 'Add at least one item.';
    for (const l of d.lines) {
      if (!(Number(l.qty) > 0)) return 'Every item needs a quantity above zero.';
      if (!(Number(l.rate) >= 0) || l.rate === '') return 'Every item needs a rate.';
      if (Number(l.discPct) < 0 || Number(l.discPct) > 100) return 'Discount must be between 0 and 100%.';
    }
  } else {
    if (!(Number(d.amount) > 0)) return 'Enter the amount received.';
    if (!d.accountCode) return 'Choose the cash or bank account.';
    if (['Cheque', 'PDC'].includes(d.mode) && !d.reference) return 'Enter the cheque number.';
  }
  if (d.type === 'pi' && !d.supplierInvNo) return "Enter the supplier's invoice number.";
  return null;
}

async function nextNumber(type) {
  const key = 'seq-' + type;
  const n = ((await db.meta(key)) || 0) + 1;
  await db.meta(key, n);
  return `${TYPES[type].prefix}-${S.me.code || 'APP'}-${String(n).padStart(4, '0')}`;
}

async function saveDraft() {
  const d = S.draft;
  const msg = validate(d);
  if (msg) { $('#formerr').textContent = msg; return; }
  const { _for, ...data } = d;
  if (TYPES[d.type].kind === 'items') data.lines = d.lines.map((l) => ({ itemCode: l.itemCode, qty: Number(l.qty), rate: Number(l.rate), discPct: Number(l.discPct) || 0, taxCode: l.taxCode }));
  else data.amount = Number(d.amount);
  if (!data.number) data.number = await nextNumber(d.type);
  data.kind = TYPES[d.type].kind;
  const saved = await S.sync.saveTransaction(data);
  S.draft = null;
  await loadTxns();
  toast(navigator.onLine ? 'Saved. Sending to Tally…' : 'Saved on this device. It will sync when you are online.');
  go('detail/' + saved.id);
}

// ---------------- picker (customers, suppliers, items)
function openPicker(kind, onPick) {
  const role = kind;
  const src = kind === 'item' ? S.items : S.ledgers.filter((l) => l.role === role);
  const el = $('#sheet');
  el.innerHTML = `<div class="sheet"><div class="bar"><button class="back" data-close>‹</button><input id="pq" class="search" aria-label="Search" placeholder="Search ${kind === 'item' ? 'item name or code' : 'name, code, phone or TRN'}" autocomplete="off"></div>
    <div id="pres" class="list"></div><p class="muted small center" id="pcount"></p></div>`;
  el.hidden = false;
  const res = $('#pres');
  const draw = () => {
    const t0 = performance.now();
    const q = $('#pq').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const m of src) {
      if (q.every((w) => m._h.includes(w))) { out.push(m); if (out.length >= 60) break; }
    }
    res.innerHTML = out.map((m) => `<button class="row" data-pick="${esc(m.code)}"><span class="main"><span class="p">${esc(m.name)}</span>
      <span class="s">${esc(m.code)}${kind === 'item' ? ` · ${esc(m.unit)} · ${money(m.rate, S.settings.tax.currency)}${m.stock != null ? ` · stock ${m.stock}` : ''}` : `${m.phone ? ' · ' + esc(m.phone) : ''}${m.trn ? ' · TRN ' + esc(m.trn) : ''}`}</span></span></button>`).join('')
      || `<p class="muted center">No match. ${kind === 'item' ? 'Items' : 'Customers'} are created in Tally and appear here after the next sync.</p>`;
    const ms = performance.now() - t0;
    $('#pcount').textContent = `${src.length.toLocaleString()} on this device · search took ${ms.toFixed(1)} ms`;
    res.dataset.ms = ms.toFixed(2);
  };
  $('#pq').addEventListener('input', draw);
  res.addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (b) { closeSheet(); onPick(b.dataset.pick); } });
  el.querySelector('[data-close]').onclick = closeSheet;
  draw();
  setTimeout(() => $('#pq').focus(), 50);
}
function closeSheet() { const el = $('#sheet'); el.hidden = true; el.innerHTML = ''; }

// ---------------- detail
VIEWS.detail = async () => {
  const t = await db.get('txns', S.params[0]);
  if (!t) return `${header('Not found', 'list')}<main><p class="muted">This transaction is no longer on this device (synced transactions older than ${S.settings.retentionDays} days are removed from the phone; they remain in Tally).</p></main>`;
  const m = docModel(t, ctx());
  const st = STATUS[t.status];
  const admin = S.me.role === 'admin';
  return `${header(t.number, 'list')}<main>
    <div class="card status s-${t.status}"><div>${badge(t)} <span class="muted">${esc(st.hint)}</span></div>
      ${t.tally?.voucherNo ? `<div class="small">Tally voucher ${esc(t.tally.voucherNo)} (ID ${esc(t.tally.masterId)}) · version ${t.syncedVersion} of ${t.version}</div>` : `<div class="small muted">Version ${t.version} · ID ${esc(t.id)}</div>`}
      ${t.error ? `<div class="err">Tally said: ${esc(t.error)}</div><button class="btn sm" data-act="retry" data-id="${t.id}">Retry now</button>` : ''}
      ${t.conflict ? `<div class="err">${esc(t.conflict)}</div>${admin ? `<div class="btns"><button class="btn sm" data-act="resolve" data-choice="app" data-id="${t.id}">Overwrite Tally with this version</button><button class="btn sm ghost" data-act="resolve" data-choice="tally" data-id="${t.id}">Keep Tally's version</button></div>` : '<div class="small">Ask the office to resolve it.</div>'}` : ''}
    </div>
    <div class="btns sticky"><button class="btn" data-act="edit" data-id="${t.id}">Edit</button><button class="btn ghost" data-act="pdf" data-id="${t.id}">PDF</button>
      <button class="btn ghost" data-act="print" data-id="${t.id}">Print</button><button class="btn wa" data-act="share" data-id="${t.id}">WhatsApp / Share</button></div>
    <div class="paper">${docHtml(m)}</div>
    ${S.mode === 'demo' && t.tally?.masterId ? `<div class="card demo small"><b>Demo:</b> <button class="link" data-act="demo-edit-tally" data-id="${t.id}">Simulate an accountant editing this voucher in Tally</button> (then edit it here to see a conflict).</div>` : ''}
  </main>`;
};

// ---------------- parties
VIEWS.parties = async () => {
  const q = (S.partyQ || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = [];
  for (const l of S.ledgers) if (l.role === 'customer' && q.every((w) => l._h.includes(w))) { list.push(l); if (list.length >= 80) break; }
  return `${header('Customers')}<main><input class="search" id="partyq" placeholder="Search name, code, phone or TRN" value="${esc(S.partyQ || '')}" autocomplete="off">
    <div class="card list">${list.map((l) => `<div class="row static"><span class="main"><span class="p">${esc(l.name)}</span><span class="s">${esc(l.code)}${l.phone ? ' · ' + esc(l.phone) : ''}${l.trn ? ' · TRN ' + esc(l.trn) : ''}</span></span>
      <span class="a"><button class="btn sm" data-go="new/si/${esc(l.code)}">Invoice</button> <button class="btn sm ghost" data-go="new/rc/${esc(l.code)}">Receipt</button></span></div>`).join('') || '<p class="muted">No customers on this device yet.</p>'}</div>
    <p class="muted small">Customers and items are maintained in Tally. Codes stay the same when a name changes in Tally.</p></main>`;
};

// ---------------- more / settings
VIEWS.more = async () => {
  const conn = (await db.meta('connection')) || {};
  const cs = await S.api.connectorStatus().catch(() => null);
  const tax = S.settings.tax;
  return `${header('More')}<main>
    <div class="card"><div class="sec">Signed in</div><p>${esc(S.me.name)} (${esc(S.me.role)}) · ${S.mode === 'demo' ? 'Demo mode' : 'Live mode'}</p>
      <p class="small muted">Office connector: ${cs?.lastSeen ? `last seen ${ago(cs.lastSeen)}${cs.tallyOk === false ? ', Tally not reachable' : ''}` : 'not seen yet'}</p>
      <button class="btn ghost full" data-go="log">Sync log</button></div>
    ${S.mode === 'demo' ? await demoPanel() : ''}
    ${await signInCard(conn)}
    <div class="card"><div class="sec">${esc(tax.taxLabel)} and documents</div>
      <p class="small">Rates: ${tax.rates.map((r) => `${esc(r.label)}`).join(', ')} · Prices ${tax.pricesIncludeTax ? 'include' : 'exclude'} ${esc(tax.taxLabel)} · Rounding per ${tax.rounding === 'line' ? 'line' : 'document'} · ${esc(tax.currency)}</p>
      ${S.me.role === 'admin' ? `<div class="btns"><button class="btn ghost" data-go="taxsettings">${esc(tax.taxLabel)} settings</button><button class="btn ghost" data-go="company">Company and documents</button><button class="btn ghost" data-go="ledgermap">Tally ledger names</button><button class="btn ghost" data-go="users">Users and passwords</button><button class="btn ghost" data-go="archive">Archive</button></div>
      <button class="btn full" data-go="synccheck" style="margin-top:8px">Tally sync check</button>` : '<p class="small muted">Set by the office admin.</p>'}</div>
    <div class="card small muted">QuickEntry for Tally 0.1. Data on this device: ${S.ledgers.length.toLocaleString()} ledgers, ${S.items.length.toLocaleString()} items, ${S.txns.length} transactions.</div>
  </main>`;
};

/** Company ID + user code + password, with the older sign-in key under "more options". */
async function signInCard(conn = {}, full = false) {
  const last = (await db.meta('lastLogin')) || {};
  if (S.mode === 'live' && !full) {
    return `<div class="card"><div class="sec">Account</div>
      <p>Company ID <b>${esc(S.me.tenant || '')}</b> · User code <b>${esc(S.me.code)}</b></p>
      <div class="btns"><button class="btn ghost" data-act="signout">Sign out</button></div>
      <p class="small muted">Signing out removes this company's data from this phone, after checking nothing is waiting to sync.</p></div>`;
  }
  return `<div class="card signin"><div class="sec">Sign in</div>
    <p class="small">Your office admin gives you these three details.</p>
    <label>Company ID</label><input id="li-co" value="${esc(last.company || '')}" autocapitalize="none" autocomplete="organization" spellcheck="false" placeholder="for example al-noor">
    <label>User code</label><input id="li-code" value="${esc(last.code || '')}" autocapitalize="characters" autocomplete="username" spellcheck="false" placeholder="for example AHM">
    <label>Password</label><div class="inline"><input id="li-pw" type="password" autocomplete="current-password"><button class="btn sm ghost" data-act="showpw" aria-label="Show password">Show</button></div>
    <div id="lierr" class="err" role="alert"></div>
    <button class="btn full" data-act="signin">Sign in</button>
    <details ${S.keyOpen ? 'open' : ''}><summary class="small">Other ways to sign in</summary>
      <label>Sign-in key (from a WhatsApp link)</label><input id="c-token" type="password" value="${esc(S.prefillToken || conn.token || '')}" autocomplete="off">
      <label>Server address</label><input id="c-url" value="${esc(conn.url || '')}" placeholder="Leave empty if the app is opened from your QuickEntry address">
      <div class="btns"><button class="btn ghost" data-act="golive">Use live mode</button></div>
    </details>
    ${S.mode === 'demo' ? '' : '<div class="btns"><button class="btn ghost" data-act="godemo">Switch to demo</button></div>'}</div>`;
}

VIEWS.signin = async () => {
  const conn = (await db.meta('connection')) || {};
  return `<main class="form signin-page"><div class="brand"><h1>QuickEntry</h1><p class="muted">Sales entry for TallyPrime</p></div>
    ${await signInCard(conn, true)}
    ${S.mode === 'demo' ? `<p class="center small"><button class="link" data-act="trydemo">Just looking? Try the demo with sample data</button></p>` : ''}</main>`;
};

VIEWS.synccheck = async () => {
  if (S.me.role !== 'admin') return `${header('Tally sync check', 'more')}<main><p class="muted">Only an office admin can open this.</p></main>`;
  let r, problem = '';
  try { r = await S.api.syncCheck(); } catch (e) { problem = e instanceof NetworkError ? 'The sync check needs an internet connection.' : e.message; }
  if (problem) return `${header('Tally sync check', 'more')}<main><div class="card bad">${esc(problem)}</div></main>`;
  const c = r.counts, seen = r.connector.lastSeen ? Date.now() - Date.parse(r.connector.lastSeen) : Infinity;
  const pcOk = seen < 5 * 60000 && r.connector.tallyOk !== false;
  const stuck = r.oldestWaiting && Date.now() - Date.parse(r.oldestWaiting) > 3600000;
  const allGood = pcOk && !c.queued && !c.failed && !c.conflict;
  const title = !pcOk ? 'The office PC is not sending to Tally.' : c.failed || c.conflict ? 'Some entries need attention.' : stuck ? 'Entries have been waiting for over an hour.' : 'Entries are on their way to Tally.';
  const verdict = allGood ? `<div class="card good" id="verdict"><b>Everything is in Tally.</b> No entries are waiting, failed or in conflict.</div>`
    : `<div class="card ${c.failed || c.conflict || stuck || !pcOk ? 'bad' : 'warn'}" id="verdict"><b>${title}</b>
      ${!pcOk ? `<p class="small">${r.connector.lastSeen ? `Last seen ${ago(r.connector.lastSeen)}` : 'Never seen'}${r.connector.tallyOk === false ? ', and it could not reach TallyPrime' : ''}. Check the office PC is on, connected to the internet, and TallyPrime is open with the company loaded.</p>` : ''}</div>`;
  const row = (x) => `<div class="row static"><span class="main"><span class="p">${esc(x.number || '')} · ${esc(x.party || x.partyCode || '')}</span>
    <span class="s">${badge({ status: x.status === 'queued' ? 'sent' : x.status })} by ${esc(x.createdBy || '?')} · received ${ago(x.receivedAt)}${x.error ? ' · ' + esc(x.error) : ''}${x.conflict ? ' · ' + esc(x.conflict) : ''}</span></span></div>`;
  return `${header('Tally sync check', 'more')}<main>${verdict}
    <div class="card"><table class="tbl"><tr><td>Waiting for Tally</td><td class="r"><b>${c.queued}</b></td></tr><tr><td>Failed</td><td class="r"><b>${c.failed}</b></td></tr>
      <tr><td>Conflict</td><td class="r"><b>${c.conflict}</b></td></tr><tr><td>In Tally (not archived yet)</td><td class="r">${c.synced}</td></tr><tr><td>Archived</td><td class="r">${c.archived}</td></tr></table>
      <p class="small muted">Office PC: ${r.connector.lastSeen ? 'last seen ' + ago(r.connector.lastSeen) : 'not seen yet'}${r.oldestWaiting ? ` · oldest waiting entry received ${ago(r.oldestWaiting)}` : ''}. An entry made on a phone with no internet shows here once that phone syncs; the phone itself shows it as Pending.</p></div>
    ${r.attention.length ? `<div class="card list"><div class="sec">Needs attention</div>${r.attention.map(row).join('')}</div>` : ''}
    <div class="btns"><button class="btn ghost" data-act="refreshcheck">Check again</button></div></main>`;
};

VIEWS.archive = async () => {
  if (S.me.role !== 'admin') return `${header('Archive', 'more')}<main><p class="muted">Only an office admin can open the archive.</p></main>`;
  let list, problem = '';
  try { list = await S.api.archive(S.archQ || ''); } catch (e) { problem = e instanceof NetworkError ? 'The archive needs an internet connection.' : e.message; }
  const s = S.settings;
  return `${header('Archive', 'more')}<main>
    <p class="small muted">Entries already in Tally move here after ${esc(s.serverActiveDays ?? 7)} days and are deleted ${esc(s.archiveDays ?? 30)} days later. Change this in Company and documents.</p>
    <input class="search" id="archq" placeholder="Search number or customer" value="${esc(S.archQ || '')}" autocomplete="off">
    ${problem ? `<div class="card err">${esc(problem)}</div>` : `<div class="card list">${(list || []).map((x) => `<div class="row static"><span class="tag t-${esc(x.type)}">${TYPES[x.type]?.icon || ''}</span>
      <span class="main"><span class="p">${esc(x.party || x.partyCode || '')}</span><span class="s">${esc(x.number || '')} · ${fdate(x.date)}${x.voucherNo ? ' · Tally ' + esc(x.voucherNo) : ''} · deleted on ${fdate(x.deleteOn)}</span></span>
      <span class="a">${money(Number(x.total) || 0, s.tax.currency)}</span></div>`).join('') || '<p class="muted">Nothing in the archive yet.</p>'}</div>
      ${list?.length >= 200 ? '<p class="small muted">Showing the newest 200. Search to find older ones.</p>' : ''}`}</main>`;
};

async function demoPanel() {
  const b = S.api;
  const vouchers = b.dayBook();
  const customers = b.tallyLedgers('Sundry Debtors').slice(0, 300);
  return `<div class="card demo"><div class="sec">Demo controls (simulated Tally)</div>
    <div class="toggles"><label class="tg"><input type="checkbox" data-act="flag" data-k="internet" ${b.flags.internet ? 'checked' : ''}> Internet on this phone</label>
    <label class="tg"><input type="checkbox" data-act="flag" data-k="tallyOn" ${b.flags.tallyOn ? 'checked' : ''}> Office Tally PC running</label></div>
    <p class="small">Simulated Tally day book: <b>${vouchers.length}</b> vouchers. <button class="link" data-go="daybook">View</button></p>
    <label>Rename a customer in Tally</label><div class="inline"><select id="d-old">${customers.map((l) => `<option>${esc(l.name)}</option>`).join('')}</select>
      <input id="d-new" placeholder="New name"><button class="btn sm" data-act="demo-rename">Rename</button></div>
    <label>Add an item in Tally</label><div class="inline"><input id="d-item" placeholder="Item name"><input id="d-rate" inputmode="decimal" placeholder="Rate" style="max-width:90px"><button class="btn sm" data-act="demo-additem">Add</button></div>
    <div class="btns"><button class="btn sm ghost" data-act="demo-bulk">Load 5,000 customers and 10,000 items</button><button class="btn sm ghost" data-act="demo-reset">Reset demo</button></div></div>`;
}

VIEWS.daybook = async () => {
  if (S.mode !== 'demo') return `${header('Day book', 'more')}<main><p>Only available in demo mode.</p></main>`;
  const v = S.api.dayBook();
  return `${header('Simulated Tally day book', 'more')}<main><div class="card warn small">This is the simulator's data, not your Tally.</div>
    <div class="card"><table class="tbl"><tr><th>ID</th><th>Type</th><th>No.</th><th>Party</th><th class="r">Amount</th><th>Alter</th></tr>
    ${v.map((x) => `<tr><td>${x.masterId}</td><td>${esc(x.vchType)}</td><td>${esc(x.number)}</td><td>${esc(x.party)}</td><td class="r">${x.amount.toFixed(2)}</td><td>${x.alterId}</td></tr>`).join('')}</table>
    <p class="small muted">${v.length} vouchers. Each app transaction appears once, however many times it is synced.</p></div></main>`;
};

VIEWS.log = async () => {
  const log = await S.api.log().catch(() => null);
  return `${header('Sync log', 'more')}<main><div class="card">${log ? `<table class="tbl"><tr><th>When</th><th>Direction</th><th>What</th><th>Result</th></tr>${log.slice(0, 150).map((e) => `<tr><td>${new Date(e.at).toLocaleTimeString()}</td><td>${esc(e.dir)}</td><td>${esc(e.number || '')}${e.version ? ' v' + e.version : ''}</td>
    <td>${esc(e.result)}${e.counts ? ` (ledgers +${e.counts.ledgers.added}/~${e.counts.ledgers.updated}, items +${e.counts.items.added}/~${e.counts.items.updated})` : ''}${e.message ? ': ' + esc(e.message) : ''}</td></tr>`).join('')}</table>` : '<p class="muted">The log needs a connection to the server.</p>'}</div></main>`;
};

VIEWS.company = async () => {
  const c = S.settings.company;
  return `${header('Company and documents', 'more')}<main class="form"><div class="card">
    <p class="small muted">Printed at the top of every invoice and receipt. Changes reach all users at their next sync.</p>
    <label>Company name</label><input id="co-name" value="${esc(c.name)}">
    <label>Address</label><textarea id="co-addr" rows="2">${esc(c.address)}</textarea>
    <label>${esc(S.settings.tax.taxIdLabel)}</label><input id="co-trn" value="${esc(c.trn)}" inputmode="numeric">
    <label>Phone</label><input id="co-phone" value="${esc(c.phone)}" inputmode="tel"><label>Email</label><input id="co-email" value="${esc(c.email)}" inputmode="email">
    <label>Logo (PNG or JPG)</label><div class="logo-row">${c.logo ? `<img src="${c.logo}" alt="Current logo" class="logo-prev">` : '<span class="muted small">No logo</span>'}
      <input type="file" id="co-logo" accept="image/png,image/jpeg">${c.logo ? '<button class="btn sm ghost" data-act="dellogo">Remove</button>' : ''}</div>
    <label>Footer note on documents (optional)</label><input id="co-foot" value="${esc(c.footer || '')}" placeholder="For example bank details or terms">
    <div class="sec" style="margin-top:18px">On the devices</div>
    <label>Keep synced transactions on phones for (days)</label><input id="co-ret" inputmode="numeric" value="${esc(S.settings.retentionDays)}">
    <div class="sec" style="margin-top:18px">Keeping data on the server</div>
    <p class="small muted">Only entries already in Tally are archived or deleted. Anything still waiting, failed or in conflict is always kept.</p>
    <label>Keep entries active for (days)</label><input id="co-active" inputmode="numeric" value="${esc(S.settings.serverActiveDays ?? 7)}">
    <label>Then keep them in the archive for (days, 0 = delete straight away)</label><input id="co-arch" inputmode="numeric" value="${esc(S.settings.archiveDays ?? 30)}">
    <label class="tg"><input type="checkbox" id="co-rate" ${S.settings.allowRateEdit ? 'checked' : ''}> Salespeople may change item rates</label>
    <label>Receipt modes (one per line)</label><textarea id="co-modes" rows="4">${esc(S.settings.receiptModes.join('\n'))}</textarea>
  </div><div id="formerr" class="err"></div><button class="btn full" data-act="savecompany">Save for all users</button></main>`;
};

const LEDGER_FIELDS = [
  ['salesLedger', 'Sales ledger', 'Credited for sales invoices'], ['purchaseLedger', 'Purchase ledger', 'Debited for purchases'],
  ['outputTaxLedger', 'Output VAT ledger', 'VAT on sales'], ['inputTaxLedger', 'Input VAT ledger', 'VAT on purchases'],
  ['roundOffLedger', 'Round-off ledger', 'Small rounding differences'], ['cashLedger', 'Default cash ledger', 'Used when a receipt has no account'],
];
VIEWS.ledgermap = async () => {
  const m = S.settings.ledgerMap || {};
  const names = new Set(S.ledgers.map((l) => l.name));
  return `${header('Tally ledger names', 'more')}<main class="form"><div class="card">
    <p class="small muted">The connector posts to these ledgers in Tally. Names must match Tally exactly; pick from the list synced from Tally.</p>
    <datalist id="tally-ledgers">${S.ledgers.filter((l) => l.role === 'other' || l.role === 'account').map((l) => `<option value="${esc(l.name)}">`).join('')}</datalist>
    ${LEDGER_FIELDS.map(([k, label, hint]) => `<label>${label} <span class="muted">· ${hint}</span></label><input data-lm="${k}" list="tally-ledgers" value="${esc(m[k] || '')}">
      ${m[k] && !names.has(m[k]) ? `<div class="err small">Not found in the ledgers synced from Tally</div>` : ''}`).join('')}
  </div><div id="formerr" class="err"></div><button class="btn full" data-act="saveledgers">Save for all users</button></main>`;
};

VIEWS.users = async () => {
  let list, problem = '';
  try { list = await S.api.users(); } catch (e) { problem = e instanceof NetworkError ? 'Managing users needs an internet connection.' : e.message; }
  const k = S.newKey, lg = S.newLogin;
  S.newKey = null; S.newLogin = null; // shown once
  const keyCard = k ? `<div class="card keycard"><div class="sec">Sign-in key for ${esc(k.name)}</div>
      <p class="small">Shown only now. Send it to ${esc(k.name)} privately. On their phone: open the link, then tap <b>Use live mode</b>.</p>
      <code class="key" id="newkey">${esc(k.key)}</code>
      <div class="btns"><button class="btn sm" data-act="copykey" data-k="${esc(k.key)}">Copy key</button>
      <a class="btn sm wa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(keyMessage(k))}">Send by WhatsApp</a></div></div>` : '';
  const loginCard = lg ? `<div class="card keycard"><div class="sec">Sign-in details for ${esc(lg.name)}</div>
      <p class="small">Shown only now. Send them to ${esc(lg.name)} privately.</p>
      <table class="tbl logindet"><tr><td>Company ID</td><td><b>${esc(lg.company)}</b></td></tr><tr><td>User code</td><td><b>${esc(lg.code)}</b></td></tr><tr><td>Password</td><td><b>${esc(lg.password)}</b></td></tr></table>
      <div class="btns"><button class="btn sm" data-act="copykey" data-k="${esc(loginMessage(lg))}">Copy</button>
      <a class="btn sm wa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(loginMessage(lg))}">Send by WhatsApp</a></div></div>` : '';
  const rows = (list || []).map((u) => {
    const self = u.id === S.me.id;
    return `<div class="urow ${u.active ? '' : 'off'}"><div><b>${esc(u.name)}</b> <span class="muted small">${esc(u.code)} · ${u.role === 'admin' ? 'Office admin' : 'Sales'}${u.hasPassword ? ' · password set' : ' · no password yet'}${u.active ? '' : ' · switched off'}${self ? ' · you' : ''}</span></div>
      <div class="btns"><button class="btn sm" data-act="userpw" data-id="${esc(u.id)}" data-name="${esc(u.name)}" data-code="${esc(u.code)}">${u.hasPassword ? 'Reset password' : 'Set password'}</button>
      <button class="btn sm ghost" data-act="userkey" data-id="${esc(u.id)}" data-name="${esc(u.name)}">New key</button>
      ${self ? '' : `<button class="btn sm ghost" data-act="userrole" data-id="${esc(u.id)}" data-role="${u.role === 'admin' ? 'sales' : 'admin'}">Make ${u.role === 'admin' ? 'sales' : 'admin'}</button>
      <button class="btn sm ghost" data-act="usertoggle" data-id="${esc(u.id)}" data-on="${u.active ? 0 : 1}">${u.active ? 'Switch off' : 'Switch on'}</button>`}</div></div>`;
  }).join('');
  return `${header('Users and passwords', 'more')}<main class="form">${loginCard}${keyCard}
    ${problem ? `<div class="card err">${esc(problem)}</div>` : `<div class="card"><div class="sec">People in ${esc(S.settings.company.name)}</div>
      ${S.me.tenant ? `<p class="small">Company ID: <b>${esc(S.me.tenant)}</b></p>` : ''}${rows || '<p class="muted">No users.</p>'}
      <p class="small muted">People sign in with the Company ID, their user code and a password. "Reset password" or "New key" signs the person out of every phone at once, for a lost phone or a leaver. "Switch off" blocks sign-in until switched on.</p></div>
    <div class="card"><div class="sec">Add a person</div>
      <label>Name</label><input id="nu-name" autocomplete="off">
      <label>Code (2 to 6 letters, used in document numbers, for example SI-AHM-0001)</label><input id="nu-code" maxlength="6" autocapitalize="characters" autocomplete="off">
      <label>Role</label><select id="nu-role"><option value="sales">Sales: create entries</option><option value="admin">Office admin: also settings, users and conflicts</option></select>
      <label>Password (at least 6 characters)</label><div class="inline"><input id="nu-pw" autocomplete="new-password" value="${esc(suggestPassword())}"><button class="btn sm ghost" data-act="newpw">New</button></div>
      <div id="formerr" class="err"></div><button class="btn full" data-act="useradd">Add person</button></div>`}</main>`;
};

/** Easy to read out and type on a phone: no 0/O or 1/l/I. */
function suggestPassword() {
  const a = 'abcdefghjkmnpqrstuvwxyz', d = '23456789', r = crypto.getRandomValues(new Uint32Array(8));
  return [...r].map((x, i) => (i < 5 ? a : d)[x % (i < 5 ? a : d).length]).join('');
}

function loginMessage(lg) {
  return `QuickEntry sign-in for ${lg.name}\nOpen ${location.origin} on your phone and sign in with:\nCompany ID: ${lg.company}\nUser code: ${lg.code}\nPassword: ${lg.password}\nKeep this message private.`;
}

function keyMessage(k) {
  return `QuickEntry sign-in for ${k.name}\nOpen this link on your phone, then tap "Use live mode":\n${location.origin}/#connect=${k.key}\nKeep this message private.`;
}

VIEWS.taxsettings = async () => {
  const tax = S.settings.tax;
  return `${header(tax.taxLabel + ' settings', 'more')}<main class="form"><div class="card">
    <label>Tax label</label><input id="tx-label" value="${esc(tax.taxLabel)}"><label>Tax number label</label><input id="tx-idlabel" value="${esc(tax.taxIdLabel)}">
    <label>Currency</label><input id="tx-cur" value="${esc(tax.currency)}">
    <label>Rates (one per line: code, label, percent)</label><textarea id="tx-rates" rows="4">${tax.rates.map((r) => `${r.code}, ${r.label}, ${r.rate}`).join('\n')}</textarea>
    <label class="tg"><input type="checkbox" id="tx-incl" ${tax.pricesIncludeTax ? 'checked' : ''}> Rates are entered including tax</label>
    <label>Rounding</label><select id="tx-round"><option value="line" ${tax.rounding === 'line' ? 'selected' : ''}>Round tax on each line</option><option value="total" ${tax.rounding !== 'line' ? 'selected' : ''}>Round tax once per document</option></select>
    </div><div id="formerr" class="err"></div><button class="btn full" data-act="savetax">Save for all users</button></main>`;
};

// ------------------------------------------------------------------ render + events
let renderSeq = 0;
async function render(soft) {
  const seq = ++renderSeq;
  const fn = VIEWS[S.view] || VIEWS.home;
  const scroll = window.scrollY;
  const html = await fn();
  if (seq !== renderSeq) return;
  $('#view').innerHTML = html;
  linkLabels($('#view'));
  $('nav.tabs').hidden = S.view === 'signin';
  if (S.view === 'signin') $('#modebar').hidden = true;
  document.querySelectorAll('nav.tabs a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + S.view));
  if (soft) window.scrollTo(0, scroll);
  else window.scrollTo(0, 0);
  if (!soft) renderChrome();
}

/** Tie each <label> to the field after it, so screen readers announce field names. */
let fieldSeq = 0;
function linkLabels(root) {
  for (const lab of root.querySelectorAll('label:not([for])')) {
    if (lab.querySelector('input,select,textarea')) continue;
    const next = lab.nextElementSibling;
    const ctrl = next?.matches('input,select,textarea') ? next : next?.querySelector('input,select,textarea');
    if (!ctrl) continue;
    if (!ctrl.id) ctrl.id = 'f' + (++fieldSeq);
    lab.htmlFor = ctrl.id;
  }
  for (const el of root.querySelectorAll('input[placeholder]:not([aria-label])')) if (!el.labels?.length) el.setAttribute('aria-label', el.placeholder);
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 3200);
}

document.addEventListener('click', async (e) => {
  const g = e.target.closest('[data-go]');
  if (g) { e.preventDefault(); return go(g.dataset.go); }
  const a = e.target.closest('[data-act]');
  if (!a || a.matches('input[type=checkbox]')) return;
  const act = a.dataset.act;
  try {
    if (act === 'syncnow') { const r = await S.sync.syncNow({ manual: true }); toast(r?.error ? (navigator.onLine ? 'Sync problem: ' + r.error : 'You are offline. Everything is saved on this device.') : 'Synced with the server'); await loadMasters(); render(true); }
    else if (act === 'pickparty') openPicker(TYPES[S.draft.type].party, (code) => { S.draft.partyCode = code; render(true); });
    else if (act === 'additem') openPicker('item', (code) => {
      const it = S.itemByCode.get(code);
      const taxCode = S.settings.tax.rates.some((r) => r.code === it.taxCode) ? it.taxCode : S.settings.tax.defaultRateCode;
      S.draft.lines.push({ itemCode: code, qty: 1, rate: S.draft.type === 'pi' ? it.cost || it.rate : it.rate, discPct: 0, taxCode });
      render(true).then(() => { const q = document.querySelectorAll('[data-l="qty"]'); const el = q[q.length - 1]; el?.focus(); el?.select(); });
    });
    else if (act === 'delline') { S.draft.lines.splice(Number(a.dataset.i), 1); render(true); }
    else if (act === 'save') await saveDraft();
    else if (act === 'edit') { S.draft = null; go('edit/' + a.dataset.id); }
    else if (['pdf', 'print', 'share'].includes(act)) {
      const t = await db.get('txns', a.dataset.id);
      const m = docModel(t, ctx());
      if (act === 'pdf') downloadBlob(docPdf(m), fileName(m));
      if (act === 'print') printDoc(m);
      if (act === 'share') { const how = await sharePdf(m).catch((err) => (err.name === 'AbortError' ? 'cancel' : Promise.reject(err))); if (how === 'fallback') toast('PDF downloaded. Attach it in the WhatsApp chat that opened.'); }
    } else if (act === 'retry') {
      const t = await db.get('txns', a.dataset.id);
      await S.api.retry([t.id]); t.status = 'sent'; t.error = null; await db.put('txns', t);
      toast('Sent for retry'); S.sync.syncNow(); render(true);
    } else if (act === 'resolve') {
      await S.api.resolve(a.dataset.id, a.dataset.choice);
      const t = await db.get('txns', a.dataset.id); t.status = 'sent'; t.conflict = null; await db.put('txns', t);
      toast('Decision sent'); setTimeout(() => S.sync.syncNow(), 600); render(true);
    } else if (act === 'golive' || act === 'godemo') await switchMode(act === 'golive' ? 'live' : 'demo');
    else if (act === 'signin') await signIn(a);
    else if (act === 'showpw') { const i = $('#li-pw'); i.type = i.type === 'password' ? 'text' : 'password'; a.textContent = i.type === 'password' ? 'Show' : 'Hide'; }
    else if (act === 'trydemo') { await db.meta('mode', 'demo'); go('home'); }
    else if (act === 'signout') {
      const unsynced = (await db.all('txns')).filter((t) => t.status === 'pending');
      if (unsynced.length) return toast(`${unsynced.length} entr${unsynced.length === 1 ? 'y has' : 'ies have'} not reached the server yet. Connect to the internet and sync first.`);
      if (!confirm('Sign out of this phone?')) return;
      await S.api.logout?.().catch(() => {});
      await resetDevice('demo', { connection: null });
    } else if (act === 'refreshcheck') render(true);
    else if (act === 'newpw') $('#nu-pw').value = suggestPassword();
    else if (act === 'userpw') {
      const pw = prompt(`New password for ${a.dataset.name} (at least 6 characters). They are signed out of every phone and sign in again with it.`, suggestPassword());
      if (pw === null) return;
      const r = await S.api.setPassword(a.dataset.id, pw.trim());
      S.newLogin = { name: a.dataset.name, company: r.company || S.me.tenant, code: a.dataset.code, password: pw.trim() };
      if (a.dataset.id === S.me.id && (await db.meta('connection'))?.session) toast('Your own password changed: sign in again on this phone with it.');
      render();
    } else if (act === 'useradd') {
      const pw = $('#nu-pw').value.trim();
      if (pw.length < 6) { $('#formerr').textContent = 'Password must be at least 6 characters.'; return; }
      const r = await S.api.addUser({ name: $('#nu-name').value, code: $('#nu-code').value, role: $('#nu-role').value });
      const p = await S.api.setPassword(r.id, pw).catch((err) => { toast(err.message); return null; });
      if (p) S.newLogin = { name: r.name, company: p.company || S.me.tenant, code: r.code, password: pw };
      else S.newKey = { name: r.name, key: r.key };
      render();
    } else if (act === 'userkey') {
      if (!confirm(`Create a new sign-in key for ${a.dataset.name}? Their current key stops working at once.`)) return;
      const r = await S.api.resetUserKey(a.dataset.id);
      if (r.id === S.me.id) { const c = await db.meta('connection'); if (c) { c.token = r.key; await db.meta('connection', c); } if (S.api.token !== undefined) S.api.token = r.key; }
      S.newKey = { name: a.dataset.name, key: r.key }; render();
    } else if (act === 'usertoggle') { await S.api.updateUser({ id: a.dataset.id, active: a.dataset.on === '1' }); toast(a.dataset.on === '1' ? 'Switched on' : 'Switched off. That key no longer signs in.'); render(true); }
    else if (act === 'userrole') { await S.api.updateUser({ id: a.dataset.id, role: a.dataset.role }); toast('Role changed'); render(true); }
    else if (act === 'copykey') { await navigator.clipboard.writeText(a.dataset.k).then(() => toast('Key copied'), () => toast('Select the key and copy it')); }
    else if (act === 'savetax') await saveTax();
    else if (act === 'savecompany') await saveCompany();
    else if (act === 'saveledgers') await saveLedgers();
    else if (act === 'dellogo') { S.pendingLogo = ''; a.closest('.logo-row').querySelector('.logo-prev')?.remove(); a.remove(); }
    else if (act === 'demo-rename') { S.api.renameLedgerInTally($('#d-old').value, $('#d-new').value.trim()); toast('Renamed in the simulated Tally. Syncing…'); await S.api.tick(); await S.sync.syncNow(); await loadMasters(); render(true); }
    else if (act === 'demo-additem') { S.api.addItemInTally($('#d-item').value.trim(), $('#d-rate').value); toast('Item added in the simulated Tally. Syncing…'); await S.api.tick(); await S.sync.syncNow(); await loadMasters(); render(true); }
    else if (act === 'demo-edit-tally') { S.api.editVoucherInTally(a.dataset.id); toast('Voucher changed in the simulated Tally. Now edit it here and save.'); }
    else if (act === 'demo-bulk') { a.textContent = 'Loading…'; S.api.loadBulk(); await S.api.tick(); await S.sync.syncNow(); await loadMasters(); toast(`Loaded. ${S.ledgers.length.toLocaleString()} ledgers and ${S.items.length.toLocaleString()} items on this device.`); render(true); }
    else if (act === 'demo-reset') { if (confirm('Reset the demo? All demo data on this device is deleted.')) { await S.api.reset(); for (const s of ['ledgers', 'items', 'txns', 'meta']) await db.clear(s); location.hash = ''; location.reload(); } }
  } catch (err) {
    console.error(err);
    toast(err.message);
  }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.matches('[data-act="flag"]')) { await S.api.setFlag(el.dataset.k, el.checked); toast(el.dataset.k === 'internet' ? (el.checked ? 'Internet on (simulated)' : 'Internet off (simulated)') : (el.checked ? 'Tally PC on (simulated)' : 'Tally PC off (simulated)')); S.sync.syncNow(); }
  if (el.matches('[data-l="taxCode"]')) { S.draft.lines[el.dataset.i].taxCode = el.value; updateTotals(); }
  if (el.matches('select[data-f]')) S.draft[el.dataset.f] = el.value;
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'archq') { S.archQ = el.value; clearTimeout(S._aq); S._aq = setTimeout(async () => { const pos = el.selectionStart; await render(true); const n = $('#archq'); n.focus(); n.setSelectionRange(pos, pos); }, 300); return; }
  if (el.id === 'listq') { S.listQ = el.value; clearTimeout(S._lq); S._lq = setTimeout(async () => { const pos = el.selectionStart; await render(true); const n = $('#listq'); n.focus(); n.setSelectionRange(pos, pos); }, 150); return; }
  if (el.id === 'partyq') { S.partyQ = el.value; clearTimeout(S._pq); S._pq = setTimeout(async () => { const pos = el.selectionStart; await render(true); const n = $('#partyq'); n.focus(); n.setSelectionRange(pos, pos); }, 120); return; }
  if (!S.draft) return;
  if (el.dataset.f) S.draft[el.dataset.f] = el.value;
  if (el.dataset.l) { S.draft.lines[el.dataset.i][el.dataset.l] = el.value; updateTotals(); }
});

async function switchMode(mode) {
  if (!(await confirmUnsynced())) return;
  if (mode === 'live') {
    const url = $('#c-url').value.trim() || location.origin, token = $('#c-token').value.trim();
    if (!token) return toast('Enter your sign-in key.');
    const api = new HttpApi(url, token);
    const me = await api.me();
    await resetDevice('live', { connection: { url, token }, me });
  } else await resetDevice('demo', {});
}

async function confirmUnsynced() {
  const unsynced = (await db.all('txns')).filter((t) => t.status !== 'synced');
  return !unsynced.length || confirm(`${unsynced.length} transaction(s) on this device are not synced and will be lost. Continue?`);
}

/** Start this device afresh in a mode: masters, transactions and settings come again from the server. */
async function resetDevice(mode, { connection, me = null }) {
  if (connection !== undefined) await db.meta('connection', connection);
  await db.meta('me', me);
  for (const s of ['ledgers', 'items', 'txns']) await db.clear(s);
  await db.meta('mastersCursor', 0); await db.meta('settings', null); await db.meta('mode', mode);
  location.hash = mode === 'live' ? '' : 'signin'; location.reload();
}

async function signIn(btn) {
  const company = $('#li-co').value.trim().toLowerCase(), code = $('#li-code').value.trim().toUpperCase(), password = $('#li-pw').value;
  const err = (m) => { $('#lierr').textContent = m; };
  if (!company || !code || !password) return err('Enter your company ID, user code and password.');
  const url = $('#c-url')?.value.trim() || location.origin;
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const r = await HttpApi.login(url, company, code, password);
    await db.meta('lastLogin', { company, code });
    // Signing in again as the same person keeps unsynced work; anyone else starts afresh.
    const prev = (await db.meta('me')) || {};
    if (S.mode === 'live' && prev.id === r.user.id) {
      await db.meta('connection', { url, token: r.key, session: true }); await db.meta('me', r.user);
      location.hash = ''; return location.reload();
    }
    if (!(await confirmUnsynced())) return;
    await resetDevice('live', { connection: { url, token: r.key, session: true }, me: r.user });
  } catch (e) {
    err(e instanceof NetworkError ? 'No connection to the server. Check the internet and try again.' : e.message);
  } finally { btn.disabled = false; btn.textContent = 'Sign in'; }
}

async function saveSettings(s, msg = 'Saved for all users') {
  await S.api.saveSettings(s);
  await db.meta('settings', s); S.settings = s;
  toast(msg); go('more');
}

/** Shrink a logo to at most 400 x 160 px so it stays small in settings and PDFs. */
function readLogo(file) {
  return new Promise((resolve, reject) => {
    if (file.size > 3e6) return reject(new Error('Logo file is too large (max 3 MB).'));
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 400 / img.width, 160 / img.height);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('That file is not a readable image.'));
    img.src = URL.createObjectURL(file);
  });
}

async function saveCompany() {
  const s = structuredClone(S.settings);
  const name = $('#co-name').value.trim();
  if (!name) { $('#formerr').textContent = 'Enter the company name.'; return; }
  const days = Number($('#co-ret').value);
  if (!(days >= 1 && days <= 30)) { $('#formerr').textContent = 'Keep transactions for 1 to 30 days.'; return; }
  const active = Number($('#co-active').value), arch = Number($('#co-arch').value);
  if (!(Number.isInteger(active) && active >= 1 && active <= 365)) { $('#formerr').textContent = 'Keep entries active on the server for 1 to 365 days.'; return; }
  if (!(Number.isInteger(arch) && arch >= 0 && arch <= 365)) { $('#formerr').textContent = 'Keep the archive for 0 to 365 days.'; return; }
  const modes = $('#co-modes').value.split('\n').map((x) => x.trim()).filter(Boolean);
  if (!modes.length) { $('#formerr').textContent = 'Add at least one receipt mode.'; return; }
  let logo = s.company.logo || '';
  const f = $('#co-logo').files[0];
  if (f) logo = await readLogo(f); else if (S.pendingLogo === '') logo = '';
  S.pendingLogo = undefined;
  Object.assign(s.company, { name, address: $('#co-addr').value.trim(), trn: $('#co-trn').value.trim(), phone: $('#co-phone').value.trim(), email: $('#co-email').value.trim(), footer: $('#co-foot').value.trim(), logo });
  Object.assign(s, { retentionDays: days, serverActiveDays: active, archiveDays: arch, allowRateEdit: $('#co-rate').checked, receiptModes: modes });
  await saveSettings(s);
}

async function saveLedgers() {
  const s = structuredClone(S.settings);
  s.ledgerMap = { ...(s.ledgerMap || {}) };
  for (const el of document.querySelectorAll('[data-lm]')) {
    const v = el.value.trim();
    if (!v) { $('#formerr').textContent = 'Every ledger name is needed.'; return; }
    s.ledgerMap[el.dataset.lm] = v;
  }
  await saveSettings(s, 'Saved. The office connector uses the new names from its next run.');
}

async function saveTax() {
  const rates = $('#tx-rates').value.split('\n').map((l) => l.split(',').map((x) => x.trim())).filter((p) => p[0]).map(([code, label, rate]) => ({ code, label: label || code, rate: Number(rate) || 0 }));
  if (!rates.length) { $('#formerr').textContent = 'Add at least one rate.'; return; }
  const s = structuredClone(S.settings);
  Object.assign(s.tax, { taxLabel: $('#tx-label').value.trim() || 'VAT', taxIdLabel: $('#tx-idlabel').value.trim() || 'TRN', currency: $('#tx-cur').value.trim() || 'AED', rates, pricesIncludeTax: $('#tx-incl').checked, rounding: $('#tx-round').value });
  if (!rates.some((r) => r.code === s.tax.defaultRateCode)) s.tax.defaultRateCode = rates[0].code;
  await saveSettings(s);
}

boot();
