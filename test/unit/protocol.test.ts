import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genesisProtocol, PROTO, readProtocol, serializeProtocol, type ProtocolJson } from '../../src/board/protocol.js';

test('genesisProtocol bytes for budgets 6, 12, 24 and 7 are exactly the T-PRO-24 values on every OS', () => {
  assert.equal(PROTO, 1);
  const want: Array<[number, string]> = [
    [6, '{"G_s":10,"S_s":3,"budget":6,"proto":1,"regionSpec":"rs-1"}'],
    [12, '{"G_s":5,"S_s":1.5,"budget":12,"proto":1,"regionSpec":"rs-1"}'],
    [24, '{"G_s":2.5,"S_s":0.75,"budget":24,"proto":1,"regionSpec":"rs-1"}'],
    [7, '{"G_s":8.572,"S_s":2.572,"budget":7,"proto":1,"regionSpec":"rs-1"}'],
  ];
  for (const [budget, text] of want) {
    const p = genesisProtocol(budget, 'rs-1');
    assert.deepEqual(p, JSON.parse(text));
    const bytes = serializeProtocol(p);
    assert.ok(Buffer.isBuffer(bytes));
    // Byte for byte: no BOM, no CR, no trailing newline, no whitespace — nothing that depends on the OS.
    assert.equal(bytes.toString('hex'), Buffer.from(text, 'utf8').toString('hex'), `budget ${budget}`);
    assert.deepEqual(readProtocol(bytes), p);
  }
  // Every budget in 6–24 derives G_s = ceil(60000/B)/1000 and S_s = ceil(18000/B)/1000 (rounded up, the stricter side).
  for (let b = 6; b <= 24; b++) {
    const p = genesisProtocol(b, 'x');
    assert.equal(p.G_s, Math.ceil(60_000 / b) / 1_000);
    assert.equal(p.S_s, Math.ceil(18_000 / b) / 1_000);
    assert.ok(p.G_s * b >= 60 && p.S_s * b >= 18, `budget ${b} rounds up`);
  }
  for (const bad of [0, -6, 7.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => genesisProtocol(bad, 'rs'), RangeError, String(bad));
  }
});

test('readProtocol reads a missing or malformed budget, G_s, S_s as 6, 10, 3 and a missing proto as 0', () => {
  const FALLBACK = { budget: 6, G_s: 10, S_s: 3 };
  const read = (v: unknown): ProtocolJson => readProtocol(Buffer.from(JSON.stringify(v), 'utf8'));
  const good = { proto: 1, regionSpec: 'rs', budget: 12, G_s: 5, S_s: 1.5 };
  assert.deepEqual(read(good), good);

  // No file, an unreadable file, a non-object: every field falls back, proto reads as 0 (≠ 1 → VERSION).
  const nothing = { proto: 0, regionSpec: '', ...FALLBACK };
  assert.deepEqual(readProtocol(null), nothing);
  for (const raw of ['', '{', 'null', '[]', '"x"', '12', `\u{feff}${JSON.stringify(good)}`, '\u0000\u0001garbage']) {
    assert.deepEqual(readProtocol(Buffer.from(raw, 'utf8')), nothing, JSON.stringify(raw));
  }
  assert.deepEqual(read({}), nothing);

  // A missing field reads as its fallback value; the others are kept.
  for (const field of ['budget', 'G_s', 'S_s'] as const) {
    const o: Record<string, unknown> = { ...good };
    delete o[field];
    assert.deepEqual(read(o), { ...good, [field]: FALLBACK[field] }, `missing ${field}`);
  }
  // A malformed field (not a positive finite number) reads as its fallback value.
  for (const v of [0, -12, '12', null, true, [12], {}]) {
    for (const field of ['budget', 'G_s', 'S_s'] as const) {
      assert.deepEqual(read({ ...good, [field]: v }), { ...good, [field]: FALLBACK[field] }, `${field} = ${JSON.stringify(v)}`);
    }
  }
  // 1e999 parses to Infinity: not finite.
  assert.deepEqual(readProtocol(Buffer.from('{"proto":1,"regionSpec":"rs","budget":1e999,"G_s":5,"S_s":1.5}')), { ...good, budget: 6 });
  // A positive value below the defaults is kept: the governor takes the stricter of board and local values.
  assert.deepEqual(read({ ...good, budget: 3 }), { ...good, budget: 3 });
  assert.deepEqual(read({ ...good, budget: 7.5, G_s: 60 }), { ...good, budget: 7.5, G_s: 60 });

  // proto: missing or not a non-negative integer → 0; another integer is kept (VERSION decides).
  const noProto: Record<string, unknown> = { ...good };
  delete noProto['proto'];
  assert.deepEqual(read(noProto), { ...good, proto: 0 });
  for (const v of ['1', 1.5, -1, null, true]) assert.deepEqual(read({ ...good, proto: v }), { ...good, proto: 0 }, `proto ${JSON.stringify(v)}`);
  assert.deepEqual(read({ ...good, proto: 2 }), { ...good, proto: 2 });
  // regionSpec: a non-string reads as ''.
  assert.deepEqual(read({ ...good, regionSpec: 7 }), { ...good, regionSpec: '' });
  // Unknown fields are ignored.
  assert.deepEqual(read({ ...good, future: 'x' }), good);
});
