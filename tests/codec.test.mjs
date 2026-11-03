import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTally, encodeTally } from '../app/core/tally-codec.js';

const name = 'M/S Jasmine Airconditioning Systems LLC';

test('UTF-8 answer is read as UTF-8', () => {
  const r = decodeTally(Buffer.from(`<N>${name}</N>`, 'utf8'));
  assert.equal(r.charset, 'utf-8'); assert.equal(r.text, `<N>${name}</N>`);
});

test('Windows-1252 answer keeps the special space (no U+FFFD)', () => {
  const r = decodeTally(Buffer.from(`<N>${name} €</N>`, 'latin1').map((b) => (b === 0xAC ? 0x80 : b)));
  assert.equal(r.charset, 'windows-1252');
  assert.ok(!r.text.includes('�'));
  assert.ok(r.text.includes('Systems LLC'));
});

test('UTF-16 answer (BOM and no BOM)', () => {
  const body = Buffer.from(`<N>${name}</N>`, 'utf16le');
  assert.equal(decodeTally(Buffer.concat([Buffer.from([0xFF, 0xFE]), body])).text, `<N>${name}</N>`);
  assert.equal(decodeTally(body).charset, 'utf-16le');
});

test('a name read as Windows-1252 is written back with the same bytes', () => {
  const raw = Buffer.from(`<N>${name}</N>`, 'latin1');
  const { text, charset } = decodeTally(raw);
  assert.deepEqual(encodeTally(text, charset), raw);
  assert.deepEqual(encodeTally('€', 'windows-1252'), Buffer.from([0x80]));
  assert.deepEqual(encodeTally('a', 'utf-8'), Buffer.from('a'));
});
