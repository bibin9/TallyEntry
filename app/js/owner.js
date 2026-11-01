// Owner page: create client companies, their admins and connector keys, without SQL.
// The owner key is kept only for this browser tab (sessionStorage) and checked by the server
// against the OWNER_KEY secret.
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { key: sessionStorage.getItem('qe-owner') || '', open: null, shown: null };

async function call(method, path, body) {
  const r = await fetch(path, { method, cache: 'no-store', headers: { Authorization: 'Bearer ' + S.key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'Server error ' + r.status); e.status = r.status; throw e; }
  return d;
}
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 3500); }
const msgFor = (name, key) => `QuickEntry sign-in for ${name}\nOpen this link on your phone, then tap "Use live mode":\n${location.origin}/#connect=${key}\nKeep this message private.`;

function keyCard() {
  const k = S.shown; S.shown = null;
  if (!k) return '';
  return `<div class="card keycard"><div class="sec">${esc(k.title)}</div><p class="small">Shown only now. Copy them somewhere safe or send them now.</p>
    ${k.items.map((i) => `<label>${esc(i.label)}</label><code class="key">${esc(i.key)}</code>
      <div class="btns"><button class="btn sm" data-copy="${esc(i.key)}">Copy</button>${i.person ? `<a class="btn sm wa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msgFor(i.person, i.key))}">Send by WhatsApp</a>` : ''}</div>`).join('')}</div>`;
}

async function render() {
  $('#signout').hidden = !S.key;
  if (!S.key) {
    $('#view').innerHTML = `<main class="form"><div class="card"><div class="sec">Owner sign-in</div>
      <p class="small muted">Enter the owner key (the OWNER_KEY secret in Cloudflare). It is kept only until you close this tab.</p>
      <label for="ok">Owner key</label><input id="ok" type="password" autocomplete="off"><button class="btn full" data-act="signin">Open</button></div></main>`;
    return;
  }
  let tenants;
  try { tenants = await call('GET', '/api/owner/tenants'); } catch (e) {
    if (e.status === 401) { S.key = ''; sessionStorage.removeItem('qe-owner'); toast('Wrong owner key'); return render(); }
    $('#view').innerHTML = `<main><div class="card err">${esc(e.message)}</div></main>`; return;
  }
  let usersHtml = '';
  if (S.open) {
    const users = await call('GET', '/api/owner/users?tenant=' + encodeURIComponent(S.open));
    usersHtml = users.map((u) => `<div class="urow ${u.active ? '' : 'off'}"><b>${esc(u.name)}</b> <span class="small muted">${esc(u.code)} · ${u.role}${u.active ? '' : ' · off'}</span>
      <div class="btns"><button class="btn sm ghost" data-act="ukey" data-id="${esc(u.id)}" data-name="${esc(u.name)}">New key</button>
      <button class="btn sm ghost" data-act="utoggle" data-id="${esc(u.id)}" data-on="${u.active ? 0 : 1}">${u.active ? 'Switch off' : 'Switch on'}</button></div></div>`).join('');
  }
  $('#view').innerHTML = `<main class="form">${keyCard()}
    <div class="card"><div class="sec">Client companies (${tenants.length})</div>
      ${tenants.map((t) => `<div class="urow"><b>${esc(t.name)}</b> <span class="small muted">${esc(t.id)} · ${t.users} active user(s) · connector ${t.connectorLastSeen ? 'last seen ' + new Date(t.connectorLastSeen).toLocaleString() : 'never connected'}</span>
        <div class="btns"><button class="btn sm ghost" data-act="open" data-id="${esc(t.id)}">${S.open === t.id ? 'Hide users' : 'Users'}</button>
        <button class="btn sm ghost" data-act="ckey" data-id="${esc(t.id)}" data-name="${esc(t.name)}">New connector key</button></div>
        ${S.open === t.id ? `<div class="card" style="margin:6px 0">${usersHtml || '<p class="muted">No users</p>'}
          <label>Add a person</label><div class="inline"><input id="au-name" placeholder="Name"><input id="au-code" placeholder="Code" maxlength="6" style="max-width:90px">
          <select id="au-role" aria-label="Role"><option value="sales">Sales</option><option value="admin">Admin</option></select><button class="btn sm" data-act="uadd">Add</button></div></div>` : ''}</div>`).join('') || '<p class="muted">No companies yet.</p>'}
    </div>
    <div class="card"><div class="sec">New client company</div>
      <label for="nc-name">Company name (as on invoices)</label><input id="nc-name" placeholder="Al Noor Trading LLC">
      <label for="nc-id">Company ID (short, lowercase, for example al-noor)</label><input id="nc-id" autocapitalize="none">
      <label for="nc-admin">First office admin's name</label><input id="nc-admin">
      <label for="nc-code">Admin code (2 to 6 letters)</label><input id="nc-code" maxlength="6">
      <button class="btn full" data-act="create">Create company</button>
      <p class="small muted">Creates the company with default UAE VAT settings, its first admin and the office connector key. The admin then adds salespeople in the app under More &gt; Users.</p></div></main>`;
}

document.addEventListener('input', (e) => {
  if (e.target.id === 'nc-name' && !$('#nc-id').dataset.touched) $('#nc-id').value = e.target.value.toLowerCase().replace(/\b(llc|l\.l\.c|fze|fzc|fzco|trading|est|co)\b\.?/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (e.target.id === 'nc-id') e.target.dataset.touched = '1';
});

document.addEventListener('click', async (e) => {
  const c = e.target.closest('[data-copy]');
  if (c) return navigator.clipboard.writeText(c.dataset.copy).then(() => toast('Copied'), () => toast('Select the key and copy it'));
  if (e.target.id === 'signout') { S.key = ''; sessionStorage.removeItem('qe-owner'); return render(); }
  const a = e.target.closest('[data-act]');
  if (!a) return;
  try {
    const act = a.dataset.act;
    if (act === 'signin') { S.key = $('#ok').value.trim(); sessionStorage.setItem('qe-owner', S.key); }
    else if (act === 'create') {
      const r = await call('POST', '/api/owner/tenants', { name: $('#nc-name').value.trim(), id: $('#nc-id').value.trim(), adminName: $('#nc-admin').value.trim(), adminCode: $('#nc-code').value.trim() });
      S.shown = { title: `${r.name} created`, items: [
        { label: `Sign-in key for ${r.admin.name} (office admin, for the app)`, key: r.admin.key, person: r.admin.name },
        { label: 'Office connector key (only for install.cmd on the Tally PC)', key: r.connectorKey },
      ] };
      S.open = r.id;
    } else if (act === 'open') S.open = S.open === a.dataset.id ? null : a.dataset.id;
    else if (act === 'ckey') {
      if (!confirm(`New connector key for ${a.dataset.name}? The Tally PC stops syncing until install.cmd is run again with -NewKey.`)) return;
      const r = await call('POST', '/api/owner/connectorkey', { tenant: a.dataset.id });
      S.shown = { title: `New connector key for ${a.dataset.name}`, items: [{ label: 'Office connector key', key: r.connectorKey }] };
    } else if (act === 'ukey') {
      if (!confirm(`New sign-in key for ${a.dataset.name}? The old one stops working at once.`)) return;
      const r = await call('POST', '/api/owner/users/resetkey', { tenant: S.open, id: a.dataset.id });
      S.shown = { title: `New key for ${a.dataset.name}`, items: [{ label: 'Sign-in key', key: r.key, person: a.dataset.name }] };
    } else if (act === 'utoggle') await call('POST', '/api/owner/users/update', { tenant: S.open, id: a.dataset.id, active: a.dataset.on === '1' });
    else if (act === 'uadd') {
      const r = await call('POST', '/api/owner/users', { tenant: S.open, name: $('#au-name').value.trim(), code: $('#au-code').value.trim(), role: $('#au-role').value });
      S.shown = { title: `${r.name} added`, items: [{ label: 'Sign-in key', key: r.key, person: r.name }] };
    }
    await render();
  } catch (err) { toast(err.message); }
});

render();
