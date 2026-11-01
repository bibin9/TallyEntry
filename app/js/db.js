// Local storage on the device (IndexedDB). Survives app close, restart and failed syncs.

const DB_NAME = 'quickentry';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('ledgers', { keyPath: 'code' });
      db.createObjectStore('items', { keyPath: 'code' });
      const tx = db.createObjectStore('txns', { keyPath: 'id' });
      tx.createIndex('status', 'status');
      db.createObjectStore('meta', { keyPath: 'key' });
      db.createObjectStore('demo', { keyPath: 'key' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const db = {
  async all(name) { return req((await store(name)).getAll()); },
  async get(name, key) { return req((await store(name)).get(key)); },
  async put(name, value) {
    const db_ = await open();
    return new Promise((res, rej) => {
      const t = db_.transaction(name, 'readwrite');
      t.objectStore(name).put(value);
      t.oncomplete = () => res(value);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('aborted'));
    });
  },
  async putMany(name, values) {
    const db_ = await open();
    return new Promise((res, rej) => {
      const t = db_.transaction(name, 'readwrite');
      const s = t.objectStore(name);
      for (const v of values) s.put(v);
      t.oncomplete = () => res(values.length);
      t.onerror = () => rej(t.error);
    });
  },
  async del(name, key) {
    const db_ = await open();
    return new Promise((res, rej) => {
      const t = db_.transaction(name, 'readwrite');
      t.objectStore(name).delete(key);
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
  },
  async clear(name) {
    const db_ = await open();
    return new Promise((res) => { const t = db_.transaction(name, 'readwrite'); t.objectStore(name).clear(); t.oncomplete = () => res(); });
  },
  async meta(key, value) {
    if (value === undefined) return (await this.get('meta', key))?.value;
    return this.put('meta', { key, value });
  },
};

/** Ask the browser not to evict our data (important on iPhone/Android). */
export async function requestPersistence() {
  try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; }
}
