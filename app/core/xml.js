// Minimal XML parser/builder, enough for TallyPrime's XML interface.
// Runs unchanged in browsers and Node (no DOM, no dependencies).

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unesc(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      // Tally emits &#4; and other control characters in some fields; drop them.
      return code < 32 && code !== 9 && code !== 10 && code !== 13 ? '' : String.fromCodePoint(code);
    }
    return ENT[e];
  });
}

function parseAttrs(s) {
  const attrs = {};
  if (!s) return attrs;
  const re = /([^\s=\/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) attrs[m[1]] = unesc(m[3] ?? m[4] ?? '');
  return attrs;
}

/** Parse XML into {name, attrs, children, text}. Tolerant of Tally quirks. */
export function parseXml(str) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s\/>!?]+)((?:\s+[^\s=\/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(String(str)))) {
    const cur = stack[stack.length - 1];
    if (m[1] !== undefined) cur.text += m[1];
    else if (m[2]) {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === m[2]) { stack.length = k; break; }
      }
    } else if (m[3]) {
      const node = { name: m[3], attrs: parseAttrs(m[4]), children: [], text: '' };
      cur.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) cur.text += unesc(m[6]);
  }
  return root;
}

/** Strip the "UDF:" prefix Tally puts on user-defined fields. */
export const bare = (name) => name.replace(/^UDF:/, '');

export function find(node, name) {
  if (!node) return null;
  for (const c of node.children) if (bare(c.name) === name) return c;
  return null;
}
export function findAll(node, name) {
  return node ? node.children.filter((c) => bare(c.name) === name) : [];
}
/** Depth-first search for the first descendant with this name. */
export function deep(node, name) {
  if (!node) return null;
  for (const c of node.children) {
    if (bare(c.name) === name) return c;
    const d = deep(c, name);
    if (d) return d;
  }
  return null;
}
export function deepAll(node, name, out = []) {
  if (!node) return out;
  for (const c of node.children) {
    if (bare(c.name) === name) out.push(c);
    else deepAll(c, name, out);
  }
  return out;
}
export const text = (node) => (node ? node.text.trim() : '');
export const childText = (node, name) => text(find(node, name));
