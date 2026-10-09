import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalBytes, canonicalJson, MAX_JSON_DEPTH, type Json } from '../../src/board/canonicalJson.js';

// Escapes are written as \u{...} or built from BS below, so the JSON texts keep their \uXXXX escapes verbatim.
const BS = String.fromCharCode(92);
const u = (hex: string): string => `${BS}u${hex}`;

test('canonicalJson follows RFC 8785', () => {
  // RFC 8785 §3.2.4 (the complete example: numbers, string escapes, literals, key order, no whitespace).
  const inputText = '{ "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], '
    + `"string": "${u('20ac')}$${u('000F')}${u('000a')}A'${u('0042')}${u('0022')}${u('005c')}${BS}${BS}${BS}"${BS}/", `
    + '"literals": [null, true, false] }';
  const input = JSON.parse(inputText) as Json;
  assert.equal((input as { string: string }).string, `\u{20ac}$\u{f}\nA'B"${BS}${BS}"/`);
  assert.equal(
    canonicalJson(input),
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],'
      + `"string":"\u{20ac}$${u('000f')}${BS}nA'B${BS}"${BS}${BS}${BS}${BS}${BS}"/"}`,
  );

  // RFC 8785 §3.2.3: keys sorted by UTF-16 code units (U+1F600 as D83D DE00 sorts before U+FB33).
  const sorted: Json = {
    '\u{20ac}': 'Euro Sign',
    '\r': 'Carriage Return',
    '\u{fb33}': 'Hebrew Letter Dalet With Dagesh',
    '1': 'One',
    '\u{1f600}': 'Emoji: Grinning Face',
    '\u{80}': 'Control',
    '\u{f6}': 'Latin Small Letter O With Diaeresis',
  };
  assert.equal(
    canonicalJson(sorted),
    `{"${BS}r":"Carriage Return","1":"One","\u{80}":"Control","\u{f6}":"Latin Small Letter O With Diaeresis",`
      + '"\u{20ac}":"Euro Sign","\u{1f600}":"Emoji: Grinning Face","\u{fb33}":"Hebrew Letter Dalet With Dagesh"}',
  );
  // Code-point order would put U+1D4B3 after U+FFFF; UTF-16 unit order puts it first.
  assert.equal(canonicalJson({ '\u{ffff}': 1, '\u{1d4b3}': 2 }), '{"\u{1d4b3}":2,"\u{ffff}":1}');
  // Upper case sorts before lower case (the protocol.json key order).
  assert.equal(canonicalJson({ proto: 1, budget: 12, S_s: 1.5, G_s: 5, regionSpec: 'r' }), '{"G_s":5,"S_s":1.5,"budget":12,"proto":1,"regionSpec":"r"}');
  // Nested objects are sorted too; arrays keep their order.
  assert.equal(canonicalJson({ b: [3, { z: 1, a: [] }, 1], a: {} }), '{"a":{},"b":[3,{"a":[],"z":1},1]}');

  // ES number form.
  const numbers: Array<[number, string]> = [
    [0, '0'], [-0, '0'], [1, '1'], [-1, '-1'], [1.5, '1.5'], [2.572, '2.572'], [8.572, '8.572'], [0.75, '0.75'],
    [1e21, '1e+21'], [1e20, '100000000000000000000'], [1e-7, '1e-7'], [-1.5e-7, '-1.5e-7'], [0.000001, '0.000001'],
    [123e-20, '1.23e-18'], [0.1 + 0.2, '0.30000000000000004'], [5e-324, '5e-324'],
    [Number.MAX_SAFE_INTEGER, '9007199254740991'], [9007199254740992, '9007199254740992'], [1.7976931348623157e308, '1.7976931348623157e+308'],
  ];
  for (const [n, want] of numbers) assert.equal(canonicalJson(n), want, String(n));

  // String escapes: only " \ and controls below U+0020 (short forms where JSON has them, else lowercase \u00XX);
  // DEL, U+2028/U+2029 and non-ASCII are written as is.
  const raw = `"${BS}/\b\f\n\r\t\u{0}\u{1f}\u{7f}\u{2028}\u{2029}\u{e9}\u{d55c}`;
  const escaped = `"${BS}"${BS}${BS}/${BS}b${BS}f${BS}n${BS}r${BS}t${u('0000')}${u('001f')}\u{7f}\u{2028}\u{2029}\u{e9}\u{d55c}"`;
  assert.equal(canonicalJson(raw), escaped);
  // Outside I-JSON: a lone surrogate is written as a lowercase \u escape, never as invalid UTF-8.
  assert.equal(canonicalJson(`${String.fromCharCode(0xd800)}x`), `"${u('d800')}x"`);

  // Literals and whitespace.
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson([true, false, null, 'x', []]), '[true,false,null,"x",[]]');
  assert.equal(canonicalJson({ 'a b': ' ' }), '{"a b":" "}');

  // A non-finite number throws, wherever it is.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => canonicalJson(bad));
    assert.throws(() => canonicalJson([1, bad]));
    assert.throws(() => canonicalJson({ a: { b: bad } }));
    assert.throws(() => canonicalBytes({ a: bad }));
  }
  // Values outside the Json type throw; an undefined object member is omitted (as JSON.stringify does).
  for (const bad of [undefined, () => 1, Symbol('s'), 1n, new Date(0), new Map(), Buffer.from('x')]) {
    assert.throws(() => canonicalJson(bad as unknown as Json), TypeError, String(typeof bad));
  }
  assert.throws(() => canonicalJson([undefined] as unknown as Json), TypeError);
  assert.equal(canonicalJson({ a: 1, b: undefined } as unknown as Json), '{"a":1}');
  const cyclic: { [k: string]: Json } = {};
  cyclic['self'] = cyclic;
  assert.throws(() => canonicalJson(cyclic), TypeError);
  // A shared (non-cyclic) value may appear twice.
  const shared = { x: 1 };
  assert.equal(canonicalJson([shared, shared]), '[{"x":1},{"x":1}]');

  // canonicalBytes: the same text as UTF-8 without a BOM.
  const bytes = canonicalBytes({ b: '\u{e9}', a: '\u{d55c}' });
  assert.ok(Buffer.isBuffer(bytes));
  assert.deepEqual(bytes, Buffer.from([...Buffer.from('{"a":"'), 0xed, 0x95, 0x9c, ...Buffer.from('","b":"'), 0xc3, 0xa9, ...Buffer.from('"}')]));
  assert.notDeepEqual(bytes.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
});

/** `depth` nested arrays, built without recursion: depth 1 is [], a scalar has depth 0. */
function nestArrays(depth: number, leaf: Json = 0): Json {
  let v: Json = depth > 0 ? [leaf] : leaf;
  for (let i = 1; i < depth; i++) v = [v];
  return v;
}
/** `depth` nested objects {"a": ...}. */
function nestObjects(depth: number): Json {
  let v: Json = {};
  for (let i = 1; i < depth; i++) v = { a: v };
  return v;
}

test('canonicalJson refuses nesting deeper than MAX_JSON_DEPTH with a TypeError, never a stack overflow (ruling P2-DEPTH)', () => {
  assert.equal(MAX_JSON_DEPTH, 64);
  // At the cap: written in full. A scalar is depth 0, each array or object adds one level.
  assert.equal(canonicalJson(nestArrays(MAX_JSON_DEPTH)), `${'['.repeat(MAX_JSON_DEPTH)}0${']'.repeat(MAX_JSON_DEPTH)}`);
  assert.equal(canonicalJson(nestObjects(MAX_JSON_DEPTH)), `${'{"a":'.repeat(MAX_JSON_DEPTH - 1)}{}${'}'.repeat(MAX_JSON_DEPTH - 1)}`);
  assert.equal(canonicalJson({ x: nestArrays(MAX_JSON_DEPTH - 1) }), `{"x":${'['.repeat(MAX_JSON_DEPTH - 1)}0${']'.repeat(MAX_JSON_DEPTH - 1)}}`);
  // One level past the cap, in either container kind or mixed, throws TypeError.
  for (const deep of [nestArrays(MAX_JSON_DEPTH + 1), nestObjects(MAX_JSON_DEPTH + 1), { x: nestArrays(MAX_JSON_DEPTH) }, [nestObjects(MAX_JSON_DEPTH)]]) {
    assert.throws(() => canonicalJson(deep), TypeError);
    assert.throws(() => canonicalBytes(deep), TypeError);
  }
  // Far past the cap: the same TypeError, not the native stack's RangeError, whatever the stack and the JIT state.
  for (let round = 0; round < 2; round++) {
    assert.throws(() => canonicalJson(nestArrays(100_000)), TypeError, `round ${round}`);
    assert.throws(() => canonicalJson(nestObjects(100_000)), TypeError, `round ${round}`);
    for (let i = 0; i < 2_000; i++) canonicalJson({ b: [1, { c: 'x' }], a: null });
  }
});

test('canonicalJson throws TypeError on a sparse array hole instead of dropping it or writing invalid JSON', () => {
  // Array literals with elisions: [1, <hole>, 3], [<hole>, 1], [1, <hole>].
  const holes: unknown[] = [[1, , 3], [, 1], [1, ,], new Array(2), { a: [0, , 2] }];
  for (const v of holes) assert.throws(() => canonicalJson(v as Json), TypeError, JSON.stringify(v));
  // Explicit undefined elements were already refused; dense arrays are unchanged.
  assert.throws(() => canonicalJson([1, undefined, 3] as unknown as Json), TypeError);
  assert.equal(canonicalJson([1, null, 3]), '[1,null,3]');
  assert.equal(canonicalJson(Array.from({ length: 2 }, () => 0)), '[0,0]');
});
