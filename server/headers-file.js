// Applies a Cloudflare-style _headers file (path patterns with * wildcards, indented
// "Name: value" lines). Used by the self-hosted server and the local test stand-in so
// they send the same headers as Cloudflare.
export function parseHeaders(text) {
  const rules = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { cur = { pattern: line.trim(), headers: {} }; rules.push(cur); continue; }
    const i = line.indexOf(':');
    if (cur && i > 0) cur.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return rules.map((r) => ({ ...r, re: new RegExp('^' + r.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$') }));
}

export function headersFor(rules, pathname) {
  const out = {};
  for (const r of rules) if (r.re.test(pathname)) Object.assign(out, r.headers);
  return out;
}
