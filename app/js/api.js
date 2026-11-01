// Connection to the cloud relay (live mode). The demo backend implements the same methods.

export class NetworkError extends Error {}

export class HttpApi {
  constructor(baseUrl, token) {
    this.base = (baseUrl || '').replace(/\/$/, '');
    this.token = token;
    this.mode = 'live';
  }
  async _call(method, path, body) {
    if (!navigator.onLine) throw new NetworkError('No internet connection');
    let r;
    try {
      r = await fetch(this.base + path, {
        method, cache: 'no-store',
        headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) { throw new NetworkError('Cannot reach the QuickEntry server'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || `Server error ${r.status}`); e.status = r.status; throw e; }
    return data;
  }
  me() { return this._call('GET', '/api/me'); }
  settings() { return this._call('GET', '/api/settings'); }
  saveSettings(s) { return this._call('PUT', '/api/settings', s); }
  masters(since) { return this._call('GET', '/api/masters?since=' + (since || 0)); }
  push(txns) { return this._call('POST', '/api/txns', { txns }); }
  statuses(ids) { return this._call('POST', '/api/txns/status', { ids }); }
  retry(ids) { return this._call('POST', '/api/txns/retry', { ids }); }
  resolve(id, choice) { return this._call('POST', '/api/txns/resolve', { id, choice }); }
  log() { return this._call('GET', '/api/log'); }
  connectorStatus() { return this._call('GET', '/api/connector-status'); }
  users() { return this._call('GET', '/api/users'); }
  addUser(u) { return this._call('POST', '/api/users', u); }
  updateUser(u) { return this._call('POST', '/api/users/update', u); }
  resetUserKey(id) { return this._call('POST', '/api/users/resetkey', { id }); }
}
