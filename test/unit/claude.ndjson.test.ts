// Plan 5 Task 1: the wire tier's canonical JSON line and NDJSON reader (A1-3, SEC-22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { canonicalJsonLine, encodeFrame, FrameTooLarge, LineReader, MAX_DEPTH } from '../../src/claude/wire/ndjson.js';
import { canonicalBytes, MAX_JSON_DEPTH, type Json } from '../../src/board/canonicalJson.js';
import type { WireJson } from '../../src/claude/wire/frames.js';

const NL = Buffer.from('\n');

test('encodeFrame is canonical and byte-equal to Plan 2\'s canonicalBytes', () => {
  fc.assert(
    fc.property(fc.jsonValue({ maxDepth: 8 }), (v) => {
      const w = v as WireJson;
      assert.ok(encodeFrame(w as object).equals(Buffer.concat([canonicalBytes(w as Json), NL])));
    }),
    { numRuns: 500 },
  );
  // Plan 2's depth bound is the same (a 64-deep array is accepted, a 65-deep one throws in both); the wire tier's one copy of it is
  // ndjson's exported MAX_DEPTH, which schema.ts uses too (fix round 1, finding 1).
  assert.equal(MAX_DEPTH, MAX_JSON_DEPTH);
  let deep: WireJson = 0;
  for (let i = 0; i < MAX_JSON_DEPTH; i++) deep = [deep];
  assert.equal(canonicalJsonLine(deep), canonicalBytes(deep as Json).toString('utf8'));
  assert.throws(() => canonicalJsonLine([deep]), TypeError);
  assert.throws(() => canonicalBytes([deep] as Json), TypeError);

  assert.equal(encodeFrame({ b: 1, a: [2, { d: 3, c: 4 }] }).toString('utf8'), '{"a":[2,{"c":4,"d":3}],"b":1}\n');
  assert.equal(canonicalJsonLine({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  // -0 is written 0; strings are escaped as JSON.stringify does (a lone surrogate included).
  assert.equal(canonicalJsonLine([-0, 'a"b', '\u{D800}', '\u{D55C}']), `[0,${JSON.stringify('a"b')},${JSON.stringify('\u{D800}')},"\u{D55C}"]`);
  // Non-finite numbers and undefined throw TypeError (Plan 2 throws RangeError for a non-finite number: only values both accept are compared).
  assert.throws(() => encodeFrame({ x: NaN }), TypeError);
  assert.throws(() => canonicalJsonLine(NaN), TypeError);
  assert.throws(() => canonicalJsonLine(Infinity), TypeError);
  assert.throws(() => canonicalJsonLine(undefined as unknown as WireJson), TypeError);
  assert.throws(() => canonicalJsonLine([1, undefined] as unknown as WireJson), TypeError);
  // An object member whose value is undefined is omitted, as Plan 2's canonicalBytes and JSON.stringify do (optional fields).
  assert.equal(canonicalJsonLine({ a: 1, b: undefined } as unknown as WireJson), '{"a":1}');
  assert.equal(canonicalJsonLine({ a: 1, b: undefined } as unknown as WireJson), canonicalBytes({ a: 1, b: undefined } as unknown as Json).toString('utf8'));
  // Not JSON: a cycle, a class instance, a function.
  const cyc: Record<string, unknown> = {};
  cyc['self'] = cyc;
  assert.throws(() => canonicalJsonLine(cyc as WireJson), TypeError);
  assert.throws(() => canonicalJsonLine(new Map() as unknown as WireJson), TypeError);
  assert.throws(() => canonicalJsonLine({ f: (() => 1) as unknown as WireJson }), TypeError);
  // UTF-16 code unit key order (U+1D4B3 sorts before U+FFFF).
  assert.equal(canonicalJsonLine({ '\u{ffff}': 1, '\u{1d4b3}': 2 }), '{"\u{1d4b3}":2,"\u{ffff}":1}');
});

test('LineReader reassembles a frame split over three pushes at arbitrary byte offsets, inside a UTF-8 multibyte sequence too', () => {
  const frame = encodeFrame({ k: '\u{D55C}', n: [1, 2] });
  const want = canonicalJsonLine({ k: '\u{D55C}', n: [1, 2] });
  for (let i = 0; i <= frame.length; i++) {
    for (let j = i; j <= frame.length; j++) {
      const r = new LineReader();
      const got = [...r.push(frame.subarray(0, i)), ...r.push(frame.subarray(i, j)), ...r.push(frame.subarray(j))];
      assert.deepEqual(got, [want], `${i} ${j}`);
    }
  }
  // Several frames in one chunk, and a trailing partial one completed later.
  const r = new LineReader();
  const two = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 2 }), Buffer.from('{"c"')]);
  assert.deepEqual(r.push(two), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(r.push(Buffer.from(':3}\n')), ['{"c":3}']);
  assert.deepEqual(r.push(Buffer.alloc(0)), []);
  assert.ok(new FrameTooLarge('x') instanceof Error);
});
