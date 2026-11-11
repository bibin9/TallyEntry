// QuickEntry for Tally: user interface. Data access goes through db.js (local) and the
// sync engine; this file only renders screens and handles input.

import { db, requestPersistence } from './db.js';
import { HttpApi, NetworkError } from './api.js';
import { SyncEngine } from './sync.js';
import { TYPES, TYPE_ORDER, VAN_TYPES, vanConfig, vanForUser, vanMoves } from '../core/types.js';
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
  if ('serviceWorker' in navigator) {
    // When a new version of the app is installed, switch to it at once (unless someone is mid-entry).
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloadingForUpdate) return;
      if (['new', 'edit'].includes(S.view)) { toast('A new version of the app is ready. It loads when you finish this entry.'); pendingUpdate = true; return; }
      reloadingForUpdate = true; location.reload();
    });
    navigator.serviceWorker.register('./sw.js').then((r) => r.update()).catch(() => {});
  }
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
  S.sync = new SyncEngine(S.api, () => {
    loadTxns().then((mastersChanged) => {
      renderChrome();
      // New customers or balances arrived: refresh list screens, but never a form or a search being typed.
      if (mastersChanged && ['home', 'parties'].includes(S.view) && !document.activeElement?.matches('input, textarea, select')) render(true);
    });
  });
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
  window.addEventListener('hashchange', () => { if (!$('#sheet').hidden) closeSheet(); route(); });
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
  if (lastCursor !== S.mastersCursor) { S.mastersCursor = lastCursor; await loadMasters(); return true; }
  return false;
}

function ctx() { return { settings: S.settings, ledgerByCode: S.ledgerByCode, itemByCode: S.itemByCode }; }

// ------------------------------------------------------------------ van stock
const vans = () => vanConfig(S.settings);
const vanName = (id) => vans().vans.find((v) => v.id === id)?.name || id || '';
const isTransfer = (type) => TYPES[type]?.kind === 'transfer';
const r3 = (x) => Math.round(x * 1000) / 1000;

/** Van stock from the server (last sync) plus this phone's entries the server has not seen yet. */
async function vanStockNow() {
  const base = structuredClone((await db.meta('vanStock')) || { vans: {}, pending: {} });
  base.vans ||= {}; base.pending ||= {};
  for (const t of S.txns) {
    if (t.pushedVersion) continue; // the server already counts it (an unsent edit is counted at its sent version)
    for (const m of vanMoves(t)) {
      const v = (base.vans[m.van] ||= { items: {}, lastIssue: null, lastReturn: null });
      v.items[m.itemCode] = r3((Number(v.items[m.itemCode]) || 0) + m.qty);
      if (t.type === 'si') base.pending[m.itemCode] = r3((Number(base.pending[m.itemCode]) || 0) - m.qty);
    }
    const v = t.van && base.vans[t.van];
    if (v && t.type === 'vi' && !t.cancelled && (!v.lastIssue || t.date > v.lastIssue)) v.lastIssue = t.date;
    if (v && t.type === 'vr' && !t.cancelled && (!v.lastReturn || t.date > v.lastReturn)) v.lastReturn = t.date;
  }
  return base;
}
const vanQty = (vs, van, code) => Number(vs.vans[van]?.items?.[code]) || 0;
/** Office store = Tally's total stock - everything in vans - van sales Tally has not got yet. */
function officeQty(vs, code) {
  const it = S.itemByCode.get(code);
  if (it?.stock == null) return null;
  let q = Number(it.stock) - (Number(vs.pending[code]) || 0);
  for (const v of Object.values(vs.vans)) q -= Number(v.items?.[code]) || 0;
  return r3(q);
}
/** A van still holding stock from an earlier day (not returned at end of day). */
function vanOverdue(vs, id) {
  const v = vs.vans[id];
  if (!v || !Object.values(v.items || {}).some((q) => Number(q) > 0)) return null;
  const since = v.lastIssue || v.lastReturn;
  return since && since < todayIso() ? since : null;
}

/** How much of each item this draft may take from its van: the van's stock plus what the saved
 *  version of this same entry already took (an edit can reuse it). */
function availableFor(d, vs) {
  const out = {};
  if (!d.van) return out;
  for (const [code, q] of Object.entries(vs.vans[d.van]?.items || {})) out[code] = Number(q) || 0;
  const saved = d.id && S.txns.find((t) => t.id === d.id);
  if (saved) for (const m of vanMoves(saved)) if (m.van === d.van) out[m.itemCode] = r3((out[m.itemCode] || 0) - m.qty);
  return out;
}

let reloadingForUpdate = false, pendingUpdate = false;
function route() {
  const [view, ...rest] = (location.hash.slice(1) || 'home').split('/');
  if (pendingUpdate && !['new', 'edit'].includes(view)) { reloadingForUpdate = true; return location.reload(); }
  if (view !== 'vansettings') S.vanEdit = null;
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
  $('#topsignout').hidden = S.mode !== 'live' || S.view === 'signin';
  if (['home', 'list', 'detail', 'sync'].includes(S.view) && !document.activeElement?.matches('input,select,textarea')) render(true);
}

function header(title, back) {
  return `<div class="bar">${back ? `<button class="back" data-go="${back}" aria-label="Back">‹</button>` : ''}<h1>${esc(title)}</h1></div>`;
}

function badge(t) {
  if (t.cancelled && t.status === 'synced') return '<span class="badge b-cancelled" title="Cancelled in the app and in Tally">Cancelled</span>';
  if (t.cancelled && ['pending', 'sent'].includes(t.status)) return '<span class="badge b-cancelled" title="Cancelled in the app; cancelling in Tally">Cancelling…</span>';
  return `<span class="badge b-${t.status}" title="${esc(STATUS[t.status]?.hint || '')}">${STATUS[t.status]?.label || t.status}</span>`;
}

function txnRow(t) {
  const ty = TYPES[t.type];
  if (ty.kind === 'transfer') {
    const qty = r3((t.lines || []).reduce((a, l) => a + (Number(l.qty) || 0), 0));
    const what = `${qty} unit${qty === 1 ? '' : 's'}, ${(t.lines || []).length} item${(t.lines || []).length === 1 ? '' : 's'}`;
    return `<button class="row" data-go="detail/${t.id}"><span class="tag t-${t.type}">${ty.icon}</span>
    <span class="main"><span class="p">${esc(ty.dir === 'out' ? 'To ' : 'From ')}${esc(vanName(t.van))}</span><span class="s">${esc(t.number)} · ${fdate(t.date)}</span></span>
    <span class="a">${t.cancelled ? `<s>${what}</s>` : what}<br>${badge(t)}</span></button>`;
  }
  const party = S.ledgerByCode.get(t.partyCode)?.name || t.partyCode;
  const total = ty.kind === 'items' ? calcDoc(t.lines, S.settings.tax).total : Number(t.amount) || 0;
  return `<button class="row" data-go="detail/${t.id}"><span class="tag t-${t.type}">${ty.icon}</span>
    <span class="main"><span class="p">${esc(party)}</span><span class="s">${esc(t.number)} · ${fdate(t.date)}${t.van ? ' · ' + esc(vanName(t.van)) : ''}</span></span>
    <span class="a">${t.cancelled ? `<s>${money(total, S.settings.tax.currency)}</s>` : money(total, S.settings.tax.currency)}<br>${badge(t)}</span></button>`;
}

// ------------------------------------------------------------------ views
const VIEWS = {};

VIEWS.home = async () => {
  const c = await S.sync.counts();
  const today = todayIso();
  const tToday = S.txns.filter((t) => t.date === today && !t.cancelled);
  const sum = (type) => tToday.filter((t) => t.type === type).reduce((s, t) => s + (TYPES[t.type].kind === 'items' ? calcDoc(t.lines, S.settings.tax).total : Number(t.amount) || 0), 0);
  const cur = S.settings.tax.currency;
  const noMasters = !S.ledgers.length;
  const vc = vans(), admin = S.me.role === 'admin', myVan = vanForUser(S.settings, S.me.code);
  let vanHtml = '';
  if (vc.enabled) {
    const vs = await vanStockNow();
    const late = vc.vans.filter((v) => (admin || v.id === myVan?.id) && vanOverdue(vs, v.id));
    vanHtml = `${late.map((v) => `<div class="card warn">⚠ <b>${esc(v.name)}</b> still has stock from ${fdate(vanOverdue(vs, v.id))}. Every van should be returned to the office store at the end of the day.${admin ? ` <button class="link" data-go="new/vr/${esc(v.id)}">Make the return</button>` : ''}</div>`).join('')}
    <div class="tiles">${admin ? VAN_TYPES.map((k) => `<button class="tile" data-go="new/${k}"><span class="tag t-${k}">${TYPES[k].icon}</span>${esc(TYPES[k].name)}</button>`).join('') : ''}
      ${admin || myVan ? `<button class="tile" data-go="vans"><span class="tag t-vs">VS</span>${admin ? 'Van stock' : 'My van stock'}</button>` : ''}</div>
    ${myVan ? `<p class="small muted">You sell from <b>${esc(myVan.name)}</b>. Invoices take stock from your van.</p>` : ''}`;
  }
  return `${header(S.settings.company.name || 'QuickEntry')}
  <main>
    ${noMasters ? `<div class="card warn">No customers or items on this device yet. Connect to the internet and tap <b>Sync now</b> once to download them from Tally.</div>` : ''}
    <div class="tiles">${TYPE_ORDER.map((k) => `<button class="tile" data-go="new/${k}"><span class="tag t-${k}">${TYPES[k].icon}</span>New ${esc(TYPES[k].short)}</button>`).join('')}</div>
    ${vanHtml}
    <div class="card"><div class="sec">Today</div>
      <div class="kpis"><div><div class="lab">Sales</div><div class="val">${money(sum('si'), cur, 0)}</div></div>
      <div><div class="lab">Receipts</div><div class="val">${money(sum('rc'), cur, 0)}</div></div>
      <div><div class="lab">Orders</div><div class="val">${money(sum('so'), cur, 0)}</div></div></div></div>
    <div class="card"><div class="sec">Sync with Tally</div>
      <div class="counts">${['pending', 'sent', 'synced', 'failed', 'conflict'].map((k) => `<button class="cnt c-${k}" data-go="list/${k}"><b>${c[k] || 0}</b>${STATUS[k].label}</button>`).join('')}</div>
      <p class="muted">Last sync ${ago(S.sync.lastSync)}${S.sync.lastError ? ` · <span class="err">${esc(S.sync.lastError)}</span>` : ''}${isOffline() ? ' · You are offline. Work is saved on this device.' : ''}</p>
      <button class="btn full" data-act="syncnow">${S.sync.running ? 'Syncing…' : 'Sync now'}</button></div>
    <div class="sec">Recent</div><div class="card list">${S.txns.slice(0, 6).map(txnRow).join('') || '<p class="muted">No transactions yet.</p>'}</div>
  </main>`;
};

VIEWS.list = async () => {
  const f = S.params[0] || 'all';
  const q = (S.listQ || '').toLowerCase();
  let list = S.txns.filter((t) => f === 'all' || t.status === f || t.type === f);
  if (q) list = list.filter((t) => `${t.number} ${S.ledgerByCode.get(t.partyCode)?.name || ''} ${t.van ? vanName(t.van) : ''}`.toLowerCase().includes(q));
  const chips = [['all', 'All'], ['pending', 'Pending'], ['sent', 'Waiting for Tally'], ['failed', 'Failed'], ['conflict', 'Conflict'], ['synced', 'Synced'], ...TYPE_ORDER.map((k) => [k, TYPES[k].short]),
    ...(vans().enabled || S.txns.some((t) => isTransfer(t.type)) ? VAN_TYPES.map((k) => [k, TYPES[k].short]) : [])];
  return `${header('Transactions')}<main>
    <input class="search" id="listq" placeholder="Search number or customer" value="${esc(S.listQ || '')}" autocomplete="off">
    <div class="chips">${chips.map(([k, l]) => `<button class="chip ${k === f ? 'on' : ''}" data-go="list/${k}">${l}</button>`).join('')}</div>
    <div class="card list">${list.map(txnRow).join('') || '<p class="muted">Nothing here.</p>'}</div>
    <p class="muted small">This device keeps the last ${S.settings.retentionDays} days of synced transactions, and every unsynced one regardless of age.</p></main>`;
};

// ---------------- transaction form
function blankDraft(type) {
  const t = TYPES[type];
  if (t.kind === 'transfer') return { type, date: todayIso(), van: S.params[1] || (vans().vans.length === 1 ? vans().vans[0].id : ''), lines: [], narration: '' };
  const d = { type, date: todayIso(), partyCode: S.params[1] || '', narration: '' };
  if (t.kind === 'items') d.lines = [];
  // A salesperson with a van sells from it; the office sells from the office store unless it picks a van.
  if (type === 'si') { const v = vanForUser(S.settings, S.me.code); if (v) d.van = v.id; }
  if (type === 'rc') Object.assign(d, { amount: '', mode: S.settings.receiptModes[0], accountCode: S.ledgers.find((l) => l.role === 'account')?.code || '', reference: '', against: '' });
  if (type === 'so') d.dueDate = '';
  if (type === 'pi') d.supplierInvNo = '';
  return d;
}

VIEWS.new = async () => {
  if (!TYPES[S.params[0]]) return `${header('Not found', 'home')}<main><p class="muted">Unknown entry type.</p></main>`;
  if (!S.draft || S.draft._for !== location.hash) S.draft = { ...blankDraft(S.params[0]), _for: location.hash };
  S.vs = await vanStockNow();
  return formHtml();
};
VIEWS.edit = async () => {
  if (!S.draft || S.draft._for !== location.hash) {
    const t = await db.get('txns', S.params[0]);
    if (!t) return `${header('Not found', 'list')}<main><p>This transaction is no longer on this device.</p></main>`;
    if (t.cancelled) return `${header(t.number, 'detail/' + t.id)}<main><p>This entry is cancelled and cannot be edited. Make a new entry instead.</p></main>`;
    S.draft = { ...structuredClone(t), _for: location.hash };
  }
  S.vs = await vanStockNow();
  return formHtml();
};

/** Stock note for an item line: van stock for van sales and returns, office store otherwise. */
function stockNote(d, code, qty) {
  const vc = vans(), it = S.itemByCode.get(code);
  if (d.type === 'pi' || d.type === 'so') return it?.stock != null ? { text: `Stock ${it.stock}`, short: false } : null;
  if (vc.enabled && S.vs) {
    if (d.van && d.type !== 'vi') {
      const avail = availableFor(d, S.vs)[code] || 0;
      const want = (d.lines || []).filter((l) => l.itemCode === code).reduce((a, l) => a + (Number(l.qty) || 0), 0);
      return { text: `In ${vanName(d.van)}: ${avail}${want > avail ? ' (not enough)' : ''}`, short: want > avail };
    }
    const off = officeQty(S.vs, code);
    if (off == null) return null;
    const inVan = d.type === 'vi' && d.van ? ` · in van ${vanQty(S.vs, d.van, code)}` : '';
    return { text: `Office store ${off}${Number(qty) > off ? ' (not enough)' : ''}${inVan}`, short: Number(qty) > off };
  }
  if (it?.stock == null) return null;
  const short = Number(qty) > it.stock;
  return { text: `Stock ${it.stock}${short ? ' (not enough)' : ''}`, short };
}

function transferFormHtml() {
  const d = S.draft, t = TYPES[d.type], vc = vans();
  const editing = !!d.id;
  const vanItems = d.van ? Object.entries(availableFor(d, S.vs)).filter(([, q]) => q > 0) : [];
  const total = r3(d.lines.reduce((a, l) => a + (Number(l.qty) || 0), 0));
  const body = `<label>Date</label><input type="date" data-f="date" value="${esc(d.date)}">
    <label>${t.dir === 'out' ? 'Issue to van' : 'Return from van'}</label>
    <select data-f="van"><option value="">Choose a van</option>${vc.vans.map((v) => `<option value="${esc(v.id)}" ${v.id === d.van ? 'selected' : ''}>${esc(v.name)}${v.user ? ' · ' + esc(v.user) : ''}</option>`).join('')}</select>
    ${!vc.vans.length ? '<div class="err small">No vans are set up yet. Add them in More &gt; Van stock.</div>' : ''}
    <p class="small muted">${t.dir === 'out' ? 'Moves stock from the office store into the van. Office stock goes down now; the salesperson then sells from the van.' : 'Moves what is left in the van back into the office store. Do this at the end of every day.'}</p>
    ${t.dir === 'in' && d.van ? `<button class="btn ghost full" data-act="returnall">Return everything in ${esc(vanName(d.van))} (${vanItems.length} item${vanItems.length === 1 ? '' : 's'})</button>` : ''}
    <div class="sec">Items</div>${d.lines.map((l, i) => {
      const it = S.itemByCode.get(l.itemCode) || { name: l.itemCode, unit: '' };
      const note = stockNote(d, l.itemCode, l.qty);
      const bad = qtyProblem(l.qty);
      return `<div class="line" data-line="${i}"><div class="lh"><b>${esc(it.name)}</b>${note ? `<span class="stk ${note.short ? 'low' : ''}">${esc(note.text)}</span>` : ''}<button class="x" data-act="delline" data-i="${i}" aria-label="Remove">✕</button></div>
        <div class="grid4"><div><label>Qty (${esc(it.unit)})</label><input inputmode="decimal" data-l="qty" data-i="${i}" value="${esc(l.qty)}"></div></div>
        <div class="lt">${bad ? `<span class="err">${esc(bad)}</span>` : ''}</div></div>`;
    }).join('')}
    <button class="btn ghost full" data-act="additem">+ Add item</button>
    <div class="totals"><div class="grand"><span>Total quantity</span><span id="t-qty">${total}</span></div></div>
    <label>Note (optional)</label><textarea data-f="narration" rows="2">${esc(d.narration || '')}</textarea>`;
  return `${header((editing ? 'Edit ' : '') + t.name, editing ? 'detail/' + d.id : 'home')}<main class="form">
    ${editing && d.syncedVersion ? `<div class="card info small">Already in Tally. Saving will update the same Stock Journal at the next sync.</div>` : ''}
    <div class="card">${body}</div><div id="formerr" class="err"></div>
    <div class="savebar"><button class="btn full" data-act="save">Save${isOffline() ? ' (offline)' : ''}</button></div></main>`;
}

function qtyProblem(v) {
  const q = v === '' || v == null ? NaN : Number(v);
  if (Number.isNaN(q)) return 'Enter a quantity.';
  if (!(q > 0)) return 'Quantity must be more than zero.';
  return null;
}

function formHtml() {
  const d = S.draft, t = TYPES[d.type];
  if (t.kind === 'transfer') return transferFormHtml();
  const party = S.ledgerByCode.get(d.partyCode);
  const tax = S.settings.tax, cur = tax.currency;
  const editing = !!d.id;
  let body = `<label>Date</label><input type="date" data-f="date" value="${esc(d.date)}">
    <label>${t.party === 'supplier' ? 'Supplier' : 'Customer'}</label>
    <button class="picker ${party ? '' : 'empty'}" data-act="pickparty">${party ? `<b>${esc(party.name)}</b><span class="s">${esc(party.code)}${party.phone ? ' · ' + esc(party.phone) : ''}${party.trn ? ` · ${tax.taxIdLabel} ${esc(party.trn)}` : ''}</span>` : `Tap to choose ${t.party}`}</button>
    ${party ? partyInfoHtml(party, d) : ''}`;
  if (d.type === 'si' && vans().enabled) {
    const mine = vanForUser(S.settings, S.me.code);
    body += S.me.role === 'admin'
      ? `<label>Sell from</label><select data-f="van"><option value="">Office store</option>${vans().vans.map((v) => `<option value="${esc(v.id)}" ${v.id === d.van ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>`
      : `<label>Sell from</label><div class="small"><b>${esc(d.van ? vanName(d.van) : 'Office store')}</b>${mine && d.van !== mine.id ? ' (made from a different van)' : ''}</div>`;
  }
  if (d.type === 'so') body += `<label>Delivery date</label><input type="date" data-f="dueDate" value="${esc(d.dueDate || '')}">`;
  if (d.type === 'pi') body += `<label>Supplier invoice no.</label><input data-f="supplierInvNo" value="${esc(d.supplierInvNo || '')}" placeholder="As printed on the supplier's invoice">`;
  if (t.kind === 'items') {
    const c = calcDoc(d.lines, tax);
    body += `<div class="sec">Items</div>` + c.lines.map((l, i) => {
      const it = S.itemByCode.get(l.itemCode) || { name: l.itemCode, unit: '' };
      const note = stockNote(d, l.itemCode, l.qty);
      return `<div class="line" data-line="${i}"><div class="lh"><b>${esc(it.name)}</b>${note ? `<span class="stk ${note.short ? 'low' : ''}">${esc(note.text)}</span>` : ''}<button class="x" data-act="delline" data-i="${i}" aria-label="Remove">✕</button></div>
        <div class="grid4"><div><label>Qty (${esc(it.unit)})</label><input inputmode="decimal" data-l="qty" data-i="${i}" value="${esc(l.qty)}"></div>
        <div><label>Rate</label><input inputmode="decimal" data-l="rate" data-i="${i}" value="${esc(l.rate)}" ${S.settings.allowRateEdit ? '' : 'readonly'}></div>
        <div><label>Disc %</label><input inputmode="decimal" data-l="discPct" data-i="${i}" value="${esc(l.discPct || '')}"></div>
        <div><label>${esc(tax.taxLabel)}</label><select data-l="taxCode" data-i="${i}">${tax.rates.map((r) => `<option value="${esc(r.code)}" ${r.code === l.taxCode ? 'selected' : ''} title="${esc(r.label)}">${esc(r.code)} ${esc(r.rate)}%</option>`).join('')}</select></div></div>
        <div class="lt">${lineTotalHtml(l, cur)}</div></div>`;
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
    <div class="savebar"><button class="btn full" data-act="save">Save${isOffline() ? ' (offline)' : ''}</button></div></main>`;
}

/** Balance, credit limit and overdue amount from Tally (as of the last sync), with warnings. */
function partyInfoHtml(p, d) {
  const cur = S.settings.tax.currency;
  if (p.balance == null && !p.creditLimit) return '';
  const bal = Number(p.balance) || 0;
  const sup = p.role === 'supplier';
  const owes = sup ? (bal < 0 ? `You owe ${money(-bal, cur)}` : bal > 0 ? `Advance ${money(bal, cur)}` : 'Nothing outstanding')
    : (bal > 0 ? `Owes ${money(bal, cur)}` : bal < 0 ? `Advance ${money(-bal, cur)}` : 'Nothing outstanding');
  const bits = [`<b>${owes}</b>`];
  if (p.creditLimit) bits.push(`limit ${money(p.creditLimit, cur)}`);
  if (p.creditDays) bits.push(`${p.creditDays} days credit`);
  if (p.priceLevel) bits.push(`${esc(p.priceLevel)} prices`);
  const warn = [];
  if (!sup && p.overdue > 0) warn.push(`${money(p.overdue, cur)} overdue${p.overdueDays ? ` (oldest ${p.overdueDays} days past due)` : ''}.`);
  if (!sup && p.creditLimit && ['si', 'so'].includes(d.type)) {
    // An invoice already in Tally is already in the balance.
    const total = d.lines?.length && !d.syncedVersion ? calcDoc(d.lines, S.settings.tax).total : 0;
    if (bal + total > p.creditLimit) warn.push(`This ${d.type === 'so' ? 'order' : 'invoice'} takes the balance to ${money(bal + total, cur)}, over the credit limit of ${money(p.creditLimit, cur)}.`);
  }
  return `<div class="partyinfo ${warn.length ? 'warn' : ''}" id="partyinfo" title="From Tally at the last sync">${bits.join(' · ')}${warn.map((w) => `<div class="pw">⚠ ${w}</div>`).join('')}</div>`;
}

/** Rate and discount for an item, using the customer's price level when Tally has one for it. */
function priceFor(it, party, type) {
  if (type === 'pi') return { rate: it.cost || it.rate, discPct: 0 };
  const pl = party?.priceLevel && it.priceLevels?.[party.priceLevel];
  return pl ? { rate: pl.rate, discPct: pl.disc || 0 } : { rate: it.rate, discPct: 0 };
}

/** True when this phone has no internet, real or simulated in the demo. */
function isOffline() {
  return !navigator.onLine || !!S.sync?.offline || (S.api?.flags ? S.api.flags.internet === false : false);
}

/** A problem with one item line, worded for the salesperson, or null. */
function lineProblem(l) {
  const num = (v) => (v === '' || v == null ? NaN : Number(v));
  const qty = num(l.qty), rate = num(l.rate), disc = l.discPct === '' || l.discPct == null ? 0 : Number(l.discPct);
  if (Number.isNaN(qty) || l.qty === '') return 'Enter a quantity.';
  if (!(qty > 0)) return 'Quantity must be more than zero.';
  if (Number.isNaN(rate)) return 'Enter a rate (0 or more).';
  if (rate < 0) return 'Rate cannot be negative. Enter 0 or more.';
  if (Number.isNaN(disc) || disc < 0 || disc > 100) return 'Discount must be between 0 and 100%.';
  return null;
}

function lineTotalHtml(l, cur) {
  const p = lineProblem(l);
  return p ? `<span class="err">${esc(p)}</span>` : `${esc(S.settings.tax.taxLabel)} ${money(l.tax, cur)} · <b>${money(l.amount, cur)}</b>`;
}

function updateTotals() {
  if (isTransfer(S.draft.type)) {
    const q = $('#t-qty'); if (q) q.textContent = r3(S.draft.lines.reduce((a, l) => a + (Number(l.qty) || 0), 0));
    S.draft.lines.forEach((l, i) => {
      const lt = $(`[data-line="${i}"] .lt`), p = qtyProblem(l.qty); if (lt) lt.innerHTML = p ? `<span class="err">${esc(p)}</span>` : '';
    });
    refreshStockNotes();
    return;
  }
  const c = calcDoc(S.draft.lines, S.settings.tax), cur = S.settings.tax.currency;
  if (!$('#t-total')) return;
  const bad = S.draft.lines.some(lineProblem);
  $('#t-taxable').textContent = bad ? '–' : money(c.taxable, cur); $('#t-tax').textContent = bad ? '–' : money(c.tax, cur); $('#t-total').textContent = bad ? '–' : money(c.total, cur);
  c.lines.forEach((l, i) => {
    const el = $(`[data-line="${i}"] .lt`); if (el) el.innerHTML = lineTotalHtml(l, cur);
  });
  refreshStockNotes();
  const party = S.ledgerByCode.get(S.draft.partyCode), pi = $('#partyinfo');
  if (party && pi) pi.outerHTML = partyInfoHtml(party, S.draft) || '<div id="partyinfo"></div>';
}

function refreshStockNotes() {
  S.draft.lines.forEach((l, i) => {
    const stk = $(`[data-line="${i}"] .stk`), note = stockNote(S.draft, l.itemCode, l.qty);
    if (stk && note) { stk.classList.toggle('low', note.short); stk.textContent = note.text; }
  });
}

/** Van sales and returns cannot take more than the van holds (as of the last sync plus this phone's entries). */
function vanShortage(d) {
  if (!vans().enabled || !d.van || !['si', 'vr'].includes(d.type) || !S.vs) return null;
  const avail = availableFor(d, S.vs), want = {};
  for (const l of d.lines) want[l.itemCode] = (want[l.itemCode] || 0) + (Number(l.qty) || 0);
  for (const [code, q] of Object.entries(want)) {
    const have = avail[code] || 0;
    if (q > have + 1e-9) {
      const name = S.itemByCode.get(code)?.name || code;
      return `${vanName(d.van)} has only ${have} of ${name}${d.type === 'si' ? '' : ' to return'}.${S.vs.at ? ` Van stock as of ${ago(S.vs.at)}; if the office just loaded the van, tap Sync now on the home screen first.` : ''}`;
    }
  }
  return null;
}

function validate(d) {
  if (isTransfer(d.type)) {
    if (!d.date) return 'Enter the date.';
    if (!d.van || !vans().vans.some((v) => v.id === d.van)) return 'Choose a van.';
    if (!d.lines.length) return 'Add at least one item.';
    for (const [i, l] of d.lines.entries()) { const p = qtyProblem(l.qty); if (p) return d.lines.length > 1 ? `Item ${i + 1}: ${p}` : p; }
    return vanShortage(d);
  }
  const t = TYPES[d.type];
  if (!d.date) return 'Enter the date.';
  if (!d.partyCode || !S.ledgerByCode.get(d.partyCode)) return `Choose a ${t.party}.`;
  if (t.kind === 'items') {
    if (!d.lines.length) return 'Add at least one item.';
    for (const [i, l] of d.lines.entries()) {
      const p = lineProblem(l);
      if (p) return d.lines.length > 1 ? `Item ${i + 1}: ${p}` : p;
    }
  } else {
    if (!(Number(d.amount) > 0)) return 'Enter the amount received.';
    if (!d.accountCode) return 'Choose the cash or bank account.';
    if (['Cheque', 'PDC'].includes(d.mode) && !d.reference) return 'Enter the cheque number.';
  }
  if (d.type === 'pi' && !d.supplierInvNo) return "Enter the supplier's invoice number.";
  return vanShortage(d);
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
  else if (isTransfer(d.type)) data.lines = d.lines.map((l) => ({ itemCode: l.itemCode, qty: Number(l.qty) }));
  else data.amount = Number(d.amount);
  if (d.type === 'si' && !data.van) delete data.van;
  if (!data.number) data.number = await nextNumber(d.type);
  data.kind = TYPES[d.type].kind;
  const saved = await S.sync.saveTransaction(data);
  S.draft = null;
  await loadTxns();
  toast(isOffline() ? 'Saved on this device. It will send when you are back online.' : 'Saved. Sending to Tally…');
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
      <span class="s">${esc(m.code)}${kind === 'item' ? ` · ${esc(m.unit)} · ${money(m.rate, S.settings.tax.currency)}${m.stock != null ? ` · stock ${m.stock}` : ''}` : `${m.phone ? ' · ' + esc(m.phone) : ''}${m.trn ? ' · TRN ' + esc(m.trn) : ''}${m.balance ? ` · ${m.role === 'supplier' ? 'bal.' : 'owes'} ${money(Math.abs(m.balance), S.settings.tax.currency)}` : ''}${m.overdue > 0 ? ' · <b class="od">overdue</b>' : ''}`}</span></span></button>`).join('')
      || `<p class="muted center">No match. ${kind === 'item' ? 'Items' : 'Customers'} are created in Tally and appear here after the next sync.</p>`;
    const ms = performance.now() - t0;
    $('#pcount').textContent = `${src.length.toLocaleString()} on this device · search took ${ms.toFixed(1)} ms`;
    res.dataset.ms = ms.toFixed(2);
  };
  $('#pq').addEventListener('input', draw);
  res.addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (b) { closeSheet(); onPick(b.dataset.pick); } });
  el.querySelector('[data-close]').onclick = closeSheet;
  draw();
  setTimeout(() => $('#pq')?.focus(), 50);
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
      ${t.cancelled ? `<div class="cancelnote"><b>Cancelled</b>${t.cancelledBy ? ' by ' + esc(t.cancelledBy) : ''}${t.cancelledAt ? ' on ' + fdate(t.cancelledAt.slice(0, 10)) : ''}${t.cancelReason ? ': ' + esc(t.cancelReason) : ''}.
        ${t.status === 'synced' ? (t.tally?.voucherNo ? 'The Tally voucher is cancelled too (number kept).' : 'It never reached Tally, so nothing was posted.') : 'It will be cancelled in Tally at the next sync.'}</div>` : ''}
      ${t.error ? `<div class="err">Tally said: ${esc(t.error)}</div><button class="btn sm" data-act="retry" data-id="${t.id}">Retry now</button>` : ''}
      ${t.conflict ? `<div class="err">${esc(t.conflict)}</div>${admin ? `<div class="btns"><button class="btn sm" data-act="resolve" data-choice="app" data-id="${t.id}">Overwrite Tally with this version</button><button class="btn sm ghost" data-act="resolve" data-choice="tally" data-id="${t.id}">Keep Tally's version</button></div>` : '<div class="small">Ask the office to resolve it.</div>'}` : ''}
    </div>
    ${t.cancelled ? '' : `<div class="btns sticky"><button class="btn" data-act="edit" data-id="${t.id}">Edit</button><button class="btn ghost" data-act="pdf" data-id="${t.id}">PDF</button>
      <button class="btn ghost" data-act="print" data-id="${t.id}">Print</button><button class="btn wa" data-act="share" data-id="${t.id}">WhatsApp / Share</button></div>`}
    <div class="paper${t.cancelled ? ' cancelled' : ''}">${docHtml(m)}</div>
    ${t.cancelled ? '' : `<button class="btn danger full" data-act="cancelentry" data-id="${t.id}">Cancel this entry</button>
    <p class="small muted center">Cancels it here and in Tally. The number is kept, so numbering stays complete for VAT.</p>`}
    ${S.mode === 'demo' && t.tally?.masterId ? `<div class="card demo small"><b>Demo:</b> <button class="link" data-act="demo-edit-tally" data-id="${t.id}">Simulate an accountant editing this voucher in Tally</button> (then edit it here to see a conflict).</div>` : ''}
  </main>`;
};

// ---------------- parties
VIEWS.parties = async () => {
  const q = (S.partyQ || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = [];
  for (const l of S.ledgers) if (l.role === 'customer' && q.every((w) => l._h.includes(w))) { list.push(l); if (list.length >= 80) break; }
  return `${header('Customers')}<main><input class="search" id="partyq" placeholder="Search name, code, phone or TRN" value="${esc(S.partyQ || '')}" autocomplete="off">
    <div class="card list">${list.map((l) => `<div class="row static"><span class="main"><span class="p">${esc(l.name)}</span><span class="s">${esc(l.code)}${l.phone ? ' · ' + esc(l.phone) : ''}${l.trn ? ' · TRN ' + esc(l.trn) : ''}</span>${l.balance ? `<span class="s"><b>${l.balance > 0 ? 'Owes' : 'Advance'} ${money(Math.abs(l.balance), S.settings.tax.currency)}</b>${l.overdue > 0 ? ` · <b class="od">${money(l.overdue, S.settings.tax.currency)} overdue</b>` : ''}</span>` : ''}</span>
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
      ${S.me.role === 'admin' ? `<div class="btns"><button class="btn ghost" data-go="taxsettings">${esc(tax.taxLabel)} settings</button><button class="btn ghost" data-go="company">Company and documents</button><button class="btn ghost" data-go="ledgermap">Tally ledger names</button><button class="btn ghost" data-go="users">Users and passwords</button><button class="btn ghost" data-go="vansettings">Van stock</button><button class="btn ghost" data-go="archive">Archive</button></div>
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
    ${v.map((x) => `<tr><td>${x.masterId}</td><td>${esc(x.vchType)}</td><td>${esc(x.number)}</td><td>${esc(x.party)}${x.cancelled ? ' <span class="badge b-cancelled">Cancelled</span>' : ''}</td><td class="r">${x.amount.toFixed(2)}</td><td>${x.alterId}</td></tr>`).join('')}</table>
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

// ---------------- van stock
VIEWS.vans = async () => {
  const vc = vans(), admin = S.me.role === 'admin', mine = vanForUser(S.settings, S.me.code);
  if (!vc.enabled) return `${header('Van stock', 'home')}<main><p class="muted">Van stock is not switched on.${admin ? ' Switch it on in More &gt; Van stock.' : ''}</p></main>`;
  const vs = await vanStockNow();
  const shown = admin ? vc.vans : vc.vans.filter((v) => v.id === mine?.id);
  const q = (S.vanQ || '').toLowerCase();
  const name = (code) => S.itemByCode.get(code)?.name || code;
  const unit = (code) => S.itemByCode.get(code)?.unit || '';
  const vanCard = (v) => {
    const rows = Object.entries(vs.vans[v.id]?.items || {}).filter(([c, n]) => Number(n) && (!q || name(c).toLowerCase().includes(q)))
      .sort((a, b) => name(a[0]).localeCompare(name(b[0])));
    const late = vanOverdue(vs, v.id);
    return `<div class="card" data-van="${esc(v.id)}"><div class="sec">${esc(v.name)}${v.user ? ` <span class="muted small">· ${esc(v.user)}</span>` : ''}</div>
      ${late ? `<div class="err small">Not returned since ${fdate(late)}. Return what is left to the office store at the end of every day.</div>` : ''}
      ${rows.length ? `<table class="tbl"><tr><th>Item</th><th class="r">In van</th></tr>${rows.map(([c, n]) => `<tr><td>${esc(name(c))}</td><td class="r"><b>${esc(n)}</b> ${esc(unit(c))}</td></tr>`).join('')}</table>` : '<p class="muted small">Empty.</p>'}
      ${admin ? `<div class="btns"><button class="btn sm" data-go="new/vi/${esc(v.id)}">Issue to van</button>${rows.length ? `<button class="btn sm ghost" data-go="new/vr/${esc(v.id)}">End-of-day return</button>` : ''}</div>` : ''}</div>`;
  };
  let office = '';
  if (admin) {
    const codes = new Set([...S.items.map((i) => i.code)]);
    const list = [...codes].map((c) => [c, officeQty(vs, c), vc.vans.reduce((a, v) => a + vanQty(vs, v.id, c), 0)])
      .filter(([c, o, inv]) => (inv || (o != null && o !== 0)) && (!q || name(c).toLowerCase().includes(q))).sort((a, b) => name(a[0]).localeCompare(name(b[0]))).slice(0, 200);
    office = `<div class="card"><div class="sec">Office store (${esc(vc.officeGodown)})</div>
      <table class="tbl"><tr><th>Item</th><th class="r">Office</th><th class="r">In vans</th></tr>${list.map(([c, o, inv]) => `<tr><td>${esc(name(c))}</td><td class="r"><b>${o ?? '–'}</b></td><td class="r">${r3(inv) || ''}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No stock.</td></tr>'}</table>
      <p class="small muted">Office = Tally's total stock − stock in vans − van sales not yet in Tally. Tally stock as of the last sync.</p></div>`;
  }
  return `${header(admin ? 'Van stock' : 'My van stock', 'home')}<main>
    <input class="search" id="vanq" placeholder="Search item" value="${esc(S.vanQ || '')}" autocomplete="off">
    ${shown.length ? shown.map(vanCard).join('') : `<p class="muted">${admin ? 'No vans set up yet. Add them in More &gt; Van stock.' : 'No van is assigned to you. Ask the office.'}</p>`}
    ${office}
    <p class="small muted">Van stock as of ${vs.at ? ago(vs.at) : 'never'} (issues, returns and van sales from every phone), plus entries on this phone not sent yet.</p></main>`;
};

VIEWS.vansettings = async () => {
  if (S.me.role !== 'admin') return `${header('Van stock', 'more')}<main><p class="muted">Only an office admin can change this.</p></main>`;
  const vc = S.vanEdit || (S.vanEdit = structuredClone(vans()));
  let users = null;
  try { users = (await S.api.users()).filter((u) => u.active); } catch { /* offline: type the user code */ }
  const userSel = (v, i) => users
    ? `<select data-vs="user" data-i="${i}"><option value="">Not assigned</option>${users.map((u) => `<option value="${esc(u.code)}" ${u.code === v.user ? 'selected' : ''}>${esc(u.name)} (${esc(u.code)})</option>`).join('')}</select>`
    : `<input data-vs="user" data-i="${i}" value="${esc(v.user || '')}" placeholder="User code, e.g. AHM" autocapitalize="characters">`;
  return `${header('Van stock', 'more')}<main class="form"><div class="card">
    <p class="small muted">Each salesperson's van is its own store. The office issues stock to a van in the morning (office stock goes down), the salesperson's invoices take stock from their van, and what is left is returned to the office store at the end of the day. In Tally each store is a godown (switch on "Maintain multiple godowns" and create one godown per van); issues and returns post as Stock Journals.</p>
    <label class="tg"><input type="checkbox" id="vs-on" ${vc.enabled ? 'checked' : ''}> Use van stock</label>
    <label>Office store godown in Tally</label><input id="vs-office" value="${esc(vc.officeGodown)}" placeholder="Main Location">
    <div class="sec" style="margin-top:14px">Vans</div>
    ${vc.vans.map((v, i) => `<div class="line"><div class="lh"><b>Van ${i + 1}</b><button class="x" data-act="vandel" data-i="${i}" aria-label="Remove van">✕</button></div>
      <label>Name</label><input data-vs="name" data-i="${i}" value="${esc(v.name)}" placeholder="e.g. Van 1 (A 12345)">
      <label>Godown name in Tally</label><input data-vs="godown" data-i="${i}" value="${esc(v.godown)}" placeholder="Exactly as in Tally">
      <label>Salesperson</label>${userSel(v, i)}</div>`).join('') || '<p class="muted small">No vans yet.</p>'}
    <button class="btn ghost full" data-act="vanadd">+ Add van</button>
    <p class="small muted">To give a van to someone else (for example when a salesperson is on leave), change its salesperson. The stock stays with the van.</p>
  </div><div id="formerr" class="err"></div><button class="btn full" data-act="savevans">Save for all users</button></main>`;
};

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
    if (act === 'syncnow') { const r = await S.sync.syncNow({ manual: true }); toast(r?.error ? (isOffline() ? 'You are offline. Everything is saved on this device.' : 'Sync problem: ' + r.error) : 'Synced with the server'); await loadMasters(); render(true); }
    else if (act === 'pickparty') openPicker(TYPES[S.draft.type].party, (code) => {
      const before = S.ledgerByCode.get(S.draft.partyCode);
      S.draft.partyCode = code;
      // Lines still at the old customer's price move to the new customer's price level.
      const party = S.ledgerByCode.get(code);
      for (const l of S.draft.lines || []) {
        const it = S.itemByCode.get(l.itemCode);
        if (!it) continue;
        const old = priceFor(it, before, S.draft.type);
        if (Number(l.rate) === old.rate && (Number(l.discPct) || 0) === old.discPct) Object.assign(l, priceFor(it, party, S.draft.type));
      }
      render(true);
    });
    else if (act === 'additem' && isTransfer(S.draft.type)) openPicker('item', (code) => {
      const ex = S.draft.lines.find((l) => l.itemCode === code);
      if (!ex) S.draft.lines.push({ itemCode: code, qty: S.draft.type === 'vr' ? (availableFor(S.draft, S.vs)[code] || 1) : 1 });
      render(true).then(() => { const i = S.draft.lines.findIndex((l) => l.itemCode === code); const el = document.querySelectorAll('[data-l="qty"]')[i]; el?.focus(); el?.select(); });
    });
    else if (act === 'returnall') {
      const avail = Object.entries(availableFor(S.draft, S.vs)).filter(([, q]) => q > 0);
      if (!avail.length) return toast(`${vanName(S.draft.van)} has nothing to return.`);
      S.draft.lines = avail.map(([itemCode, qty]) => ({ itemCode, qty }));
      render(true);
    }
    else if (act === 'additem') openPicker('item', (code) => {
      const it = S.itemByCode.get(code);
      const taxCode = S.settings.tax.rates.some((r) => r.code === it.taxCode) ? it.taxCode : S.settings.tax.defaultRateCode;
      S.draft.lines.push({ itemCode: code, qty: 1, ...priceFor(it, S.ledgerByCode.get(S.draft.partyCode), S.draft.type), taxCode });
      render(true).then(() => { const q = document.querySelectorAll('[data-l="qty"]'); const el = q[q.length - 1]; el?.focus(); el?.select(); });
    });
    else if (act === 'delline') { S.draft.lines.splice(Number(a.dataset.i), 1); render(true); }
    else if (act === 'save') await saveDraft();
    else if (act === 'edit') { S.draft = null; go('edit/' + a.dataset.id); }
    else if (act === 'cancelentry') {
      const t = await db.get('txns', a.dataset.id);
      if (!t || t.cancelled) return;
      const reason = prompt(`Cancel ${t.number}?\n\nIt is cancelled here and in Tally (the number is kept). This cannot be undone.\n\nReason (optional):`, '');
      if (reason === null) return;
      await S.sync.saveTransaction({ id: t.id, cancelled: true, cancelReason: reason.trim().slice(0, 200), cancelledAt: new Date().toISOString(), cancelledBy: S.me?.name || '' });
      await loadTxns();
      toast(isOffline() ? `${t.number} cancelled on this device. Tally is updated when you are back online.` : `${t.number} cancelled. Cancelling it in Tally…`);
      render();
    }
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
    else if (act === 'vanadd') { Object.assign(S.vanEdit, { enabled: $('#vs-on').checked, officeGodown: $('#vs-office').value }); const n = S.vanEdit.vans.length + 1; let id = 'V' + n; while (S.vanEdit.vans.some((v) => v.id === id)) id = 'V' + (Number(id.slice(1)) + 1); S.vanEdit.vans.push({ id, name: 'Van ' + n, godown: 'Van ' + n, user: '' }); render(true); }
    else if (act === 'vandel') {
      const v = S.vanEdit.vans[Number(a.dataset.i)];
      const vs = await vanStockNow();
      if (Object.values(vs.vans[v.id]?.items || {}).some((q) => Number(q))) return toast(`${v.name} still has stock. Return it to the office store first.`);
      Object.assign(S.vanEdit, { enabled: $('#vs-on').checked, officeGodown: $('#vs-office').value });
      S.vanEdit.vans.splice(Number(a.dataset.i), 1); render(true);
    }
    else if (act === 'savevans') await saveVans();
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
  if (el.dataset.vs && S.vanEdit) { S.vanEdit.vans[el.dataset.i][el.dataset.vs] = el.value; return; }
  if (el.matches('[data-l="taxCode"]')) { S.draft.lines[el.dataset.i].taxCode = el.value; updateTotals(); }
  if (el.matches('select[data-f]')) { S.draft[el.dataset.f] = el.value; if (el.dataset.f === 'van') render(true); }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'archq') { S.archQ = el.value; clearTimeout(S._aq); S._aq = setTimeout(async () => { const pos = el.selectionStart; await render(true); const n = $('#archq'); n?.focus(); n?.setSelectionRange(pos, pos); }, 300); return; }
  if (el.dataset.vs && S.vanEdit) { S.vanEdit.vans[el.dataset.i][el.dataset.vs] = el.value; return; }
  if (el.id === 'vanq') { S.vanQ = el.value; clearTimeout(S._vq); S._vq = setTimeout(async () => { const pos = el.selectionStart; await render(true); const n = $('#vanq'); n?.focus(); n?.setSelectionRange(pos, pos); }, 150); return; }
  if (el.id === 'listq') { S.listQ = el.value; clearTimeout(S._lq); S._lq = setTimeout(async () => { const pos = el.selectionStart; await render(true); const n = $('#listq'); n?.focus(); n?.setSelectionRange(pos, pos); }, 150); return; }
  if (el.id === 'partyq') { S.partyQ = el.value; clearTimeout(S._pq); S._pq = setTimeout(async () => { const pos = el.selectionStart; await render(true); const n = $('#partyq'); n?.focus(); n?.setSelectionRange(pos, pos); }, 120); return; }
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

async function saveVans() {
  const e = S.vanEdit, err = (m) => { $('#formerr').textContent = m; };
  e.enabled = $('#vs-on').checked;
  e.officeGodown = $('#vs-office').value.trim();
  if (e.enabled && !e.officeGodown) return err('Enter the office store godown name.');
  for (const v of e.vans) {
    v.name = v.name.trim(); v.godown = v.godown.trim(); v.user = (v.user || '').trim().toUpperCase();
    if (!v.name || !v.godown) return err('Every van needs a name and a Tally godown.');
    if (v.godown === e.officeGodown) return err(`${v.name} cannot use the office store godown.`);
  }
  const dup = (k) => e.vans.find((v, i) => v[k] && e.vans.findIndex((x) => x[k] === v[k]) !== i);
  if (dup('godown')) return err(`Two vans use the godown ${dup('godown').godown}.`);
  if (dup('user')) return err(`${dup('user').user} is assigned to two vans. A salesperson sells from one van.`);
  const s = structuredClone(S.settings);
  s.vanStock = { enabled: e.enabled, officeGodown: e.officeGodown, vans: e.vans };
  S.vanEdit = null;
  await saveSettings(s, 'Saved. Phones get the van setup at their next sync.');
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
