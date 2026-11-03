// Text encoding for the TallyPrime XML port.
// TallyPrime does not always answer in UTF-8: names with characters outside plain ASCII (a
// non-breaking space, an accented letter) can come back as single Windows-1252 bytes, and
// reading those as UTF-8 turns them into U+FFFD, so the name no longer matches in Tally.
// decode() reads UTF-16 (BOM or NUL bytes), then strict UTF-8, then Windows-1252.
// encode() writes requests the same way the last answer came, so names round-trip.
// VERIFY on a real Tally which encoding it answers with; both cases are handled.

const W1252 = new Map(); // code point -> byte, for 0x80-0x9F where Windows-1252 differs from Latin-1
const SPECIAL = '€�‚ƒ„…†‡ˆ‰Š‹Œ�Ž��‘’“”•–—˜™š›œ�žŸ';
for (let i = 0; i < 32; i++) if (SPECIAL[i] !== '�') W1252.set(SPECIAL.charCodeAt(i), 0x80 + i);

export function decodeWin1252(buf) {
  let s = '';
  for (const b of buf) s += b >= 0x80 && b <= 0x9F && SPECIAL[b - 0x80] !== '�' ? SPECIAL[b - 0x80] : String.fromCharCode(b);
  return s;
}

export function encodeWin1252(str) {
  const out = Buffer.alloc(str.length);
  let n = 0;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    out[n++] = c < 0x80 || (c >= 0xA0 && c <= 0xFF) ? c : W1252.get(c) ?? 0x3F; // '?' if not representable
  }
  return out.subarray(0, n);
}

/** Decode a Tally answer. Returns { text, charset: 'utf-16le' | 'utf-8' | 'windows-1252' }. */
export function decodeTally(buf) {
  buf = Buffer.from(buf);
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return { text: buf.subarray(2).toString('utf16le'), charset: 'utf-16le' };
  // UTF-16 without a BOM: '<' followed by a NUL byte.
  if (buf.length >= 2 && buf[0] === 0x3C && buf[1] === 0x00) return { text: buf.toString('utf16le'), charset: 'utf-16le' };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text: text.replace(/^﻿/, ''), charset: 'utf-8' };
  } catch {
    return { text: decodeWin1252(buf), charset: 'windows-1252' };
  }
}

/** Encode a request for Tally in the given charset (the one its last answer used). */
export function encodeTally(xml, charset = 'utf-8') {
  if (charset === 'windows-1252') return encodeWin1252(xml);
  return Buffer.from(xml, 'utf8');
}
