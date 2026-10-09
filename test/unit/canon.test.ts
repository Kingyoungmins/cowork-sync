import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import * as fc from 'fast-check';
import { canon, type CanonResult } from '../../src/data/canon.js';
import { BOM, form, rows, stripEnding, type Eol } from '../../src/data/rows.js';
import { seededRandom } from '../../src/ports/random.js';
import { generateBigBomCrlf } from '../sim/fixtures/bigBomCrlf.js';

const b = (s: string): Buffer => Buffer.from(s, 'latin1');
const withBom = (x: Buffer): Buffer => Buffer.concat([BOM, x]);

function ok(r: CanonResult): Buffer {
  assert.equal(r.ok, true, `canon refused: ${JSON.stringify(r)}`);
  return (r as { ok: true; out: Buffer }).out;
}

/** Row contents with the ending and the BOM ignored: the BOM is removed from the blob before the rows are taken. */
function contents(x: Buffer): string[] {
  const body = x.length >= 3 && x[0] === 0xef && x[1] === 0xbb && x[2] === 0xbf ? x.subarray(3) : x;
  return rows(body).map((r) => stripEnding(r).toString('latin1'));
}

// Row content tokens: ASCII, a lone CR inside a row, cp949 bytes (0xB0 0xA1), marker-like text, '='.
// "Valid" content never ends with CR, so "CR + CRLF" (which an LF stored form cannot hold
// without changing the row) does not occur.
const token = fc.constantFrom('a', 'b', ' ', 'x\ry', '°¡', '<<<<<<< m', '=');
const validContent = fc.array(token, { maxLength: 4 }).map((ts) => ts.join(''));
const anyContent = fc.array(fc.constantFrom('a', ' ', '\r', 'x\ry', '°¡'), { maxLength: 4 }).map((ts) => ts.join(''));

/** Text from rows of content + an ending of the given style; the last row may be unterminated; optional BOM. */
function textOf(content: fc.Arbitrary<string>, endings: fc.Arbitrary<string>, minRows = 0): fc.Arbitrary<Buffer> {
  return fc
    .tuple(fc.array(fc.tuple(content, endings), { minLength: minRows, maxLength: 12 }), fc.boolean(), fc.option(content), fc.boolean())
    .map(([rs, bom, tail, tailTerminated]) => {
      let s = rs.map(([c, e]) => c + e).join('');
      if (tail !== null && !tailTerminated) s += tail;
      const body = b(s);
      return bom ? withBom(body) : body;
    });
}

const anyEnding = fc.constantFrom('\n', '\r\n');
const validText = textOf(validContent, anyEnding);
const anyText = fc.oneof(textOf(anyContent, anyEnding), textOf(validContent, anyEnding)).chain((x) =>
  fc.constantFrom(x, withBom(withBom(x))), // also a doubled BOM
);

/** A reference blob of exactly the given form (MIXED has both endings, NONE has no LF at all). */
function refOf(eol: Eol): fc.Arbitrary<Buffer> {
  const bomArb = fc.boolean();
  if (eol === 'NONE') {
    return fc.tuple(validContent, bomArb).map(([c, bom]) => (bom ? withBom(b(c)) : b(c)));
  }
  const rowsArb = fc.array(fc.tuple(validContent, eol === 'LF' ? fc.constant('\n') : eol === 'CRLF' ? fc.constant('\r\n') : anyEnding), {
    minLength: eol === 'MIXED' ? 0 : 1,
    maxLength: 10,
  });
  return fc.tuple(rowsArb, bomArb, validContent).map(([rs, bom, extra]) => {
    let s = rs.map(([c, e]) => c + e).join('');
    if (eol === 'MIXED') s += `${extra}\r\n${extra}\n`;
    return bom ? withBom(b(s)) : b(s);
  });
}

const anyRef = fc.oneof(refOf('LF'), refOf('CRLF'), refOf('NONE'), refOf('MIXED'));

test('canon is idempotent', () => {
  // Sanity: the ref generators produce exactly their forms.
  fc.assert(fc.property(refOf('LF'), (r) => form(r).eol === 'LF'), { numRuns: 50, seed: 1 });
  fc.assert(fc.property(refOf('CRLF'), (r) => form(r).eol === 'CRLF'), { numRuns: 50, seed: 2 });
  fc.assert(fc.property(refOf('NONE'), (r) => form(r).eol === 'NONE'), { numRuns: 50, seed: 3 });
  fc.assert(fc.property(refOf('MIXED'), (r) => form(r).eol === 'MIXED'), { numRuns: 50, seed: 4 });

  fc.assert(
    fc.property(anyText, anyRef, (x, ref) => {
      const first = canon(x, ref, false);
      if (!first.ok) return;
      const second = canon(first.out, ref, false);
      assert.equal(second.ok, true, 'canon of a canon output never refuses');
      assert.ok((second as { ok: true; out: Buffer }).out.equals(first.out), 'canon(canon(x, r), r) == canon(x, r)');
    }),
    { numRuns: 2_000, seed: 20261006 },
  );
  // Fixed cases, including the refusal of CR + CRLF under an LF ref (the row "a\r" cannot be stored LF).
  assert.ok(ok(canon(b('a\r\nb\r\n'), b('x\n'), false)).equals(b('a\nb\n')));
  assert.deepEqual(canon(b('a\r\r\n'), b('x\n'), false), { ok: false, refuse: 'eol-bom' });
  const crlfOut = ok(canon(b('a\r\r\nb\n'), b('x\r\n'), false));
  assert.ok(crlfOut.equals(b('a\r\r\nb\r\n')));
  assert.ok(ok(canon(crlfOut, b('x\r\n'), false)).equals(crlfOut));
});

test('for LF, CRLF and NONE refs form(canon(x, ref)) == form(ref)', () => {
  // Domain (03-data D1 "when x is text"): for LF and CRLF refs x has at least one LF (a blob without
  // any LF has eol NONE whatever its ref); for a NONE ref, whose rule is "no change", x has no LF.
  const withLf = validText.filter((x) => x.includes(0x0a));
  const withoutLf = textOf(validContent, fc.constant(''), 0).filter((x) => !x.includes(0x0a));
  fc.assert(
    fc.property(fc.oneof(refOf('LF'), refOf('CRLF')), withLf, (ref, x) => {
      assert.deepEqual(form(ok(canon(x, ref, false))), form(ref));
    }),
    { numRuns: 1_500, seed: 11 },
  );
  fc.assert(
    fc.property(refOf('NONE'), withoutLf, (ref, x) => {
      assert.deepEqual(form(ok(canon(x, ref, false))), form(ref));
    }),
    { numRuns: 500, seed: 12 },
  );
  // Fixed cases: BOM added and stripped together with the ending conversion.
  assert.ok(ok(canon(b('a\nb'), withBom(b('x\r\ny\r\n')), false)).equals(withBom(b('a\r\nb'))));
  assert.ok(ok(canon(withBom(b('a\r\nb\r\n')), b('x\n'), false)).equals(b('a\nb\n')));
  assert.ok(ok(canon(b(''), withBom(b('x')), false)).equals(BOM));
  assert.ok(ok(canon(withBom(b('only')), b('x'), false)).equals(b('only')));
});

test('canon never changes row content ignoring endings and BOM', () => {
  // Valid input (no row content ending in CR, at most one BOM): the tripwire never fires for LF,
  // CRLF and NONE refs, and every accepted output keeps the rows of the input.
  fc.assert(
    fc.property(fc.oneof(refOf('LF'), refOf('CRLF'), refOf('NONE')), validText, (ref, x) => {
      const out = ok(canon(x, ref, false));
      assert.deepEqual(contents(out), contents(x));
    }),
    { numRuns: 2_000, seed: 21 },
  );
  fc.assert(
    fc.property(anyRef, anyText, (ref, x) => {
      const r = canon(x, ref, false);
      if (r.ok) assert.deepEqual(contents(r.out), contents(x));
    }),
    { numRuns: 2_000, seed: 22 },
  );
});

test('MIXED ref: a changed ending on a matched row refuses eol-bom; a new row with either ending passes', () => {
  const ref = b('a\r\nb\nc\r\n');
  assert.equal(form(ref).eol, 'MIXED');
  const refused = { ok: false, refuse: 'eol-bom' };
  // A matched row whose ending changed.
  assert.deepEqual(canon(b('a\r\nb\r\nc\r\n'), ref, false), refused);
  assert.deepEqual(canon(b('a\nb\nc\r\n'), ref, false), refused);
  // The whole file normalised to one style (what an editor that rewrites every ending does).
  assert.deepEqual(canon(b('a\nb\nc\n'), ref, false), refused);
  // New rows with either ending, anywhere.
  for (const next of ['a\r\nb\nnew\nc\r\n', 'a\r\nb\nnew\r\nc\r\n', 'new\na\r\nb\nc\r\n', 'a\r\nb\nc\r\nnew\r\n', 'a\r\nb\nc\r\nnew']) {
    assert.ok(ok(canon(b(next), ref, false)).equals(b(next)), JSON.stringify(next));
  }
  // A replaced row (content changed) is not a matched row, whatever its ending.
  assert.ok(ok(canon(b('a\r\nB\r\nc\r\n'), ref, false)).equals(b('a\r\nB\r\nc\r\n')));
  // Removed rows change no ending.
  assert.ok(ok(canon(b('a\r\nc\r\n'), ref, false)).equals(b('a\r\nc\r\n')));
  // The presence of a terminator on the last row is not an ending change.
  assert.ok(ok(canon(b('a\r\nb\nc'), ref, false)).equals(b('a\r\nb\nc')));
  const unterminatedRef = b('a\r\nb\nc');
  assert.ok(ok(canon(b('a\r\nb\nc\nd\n'), unterminatedRef, false)).equals(b('a\r\nb\nc\nd\n')));
  assert.ok(ok(canon(b('a\r\nb\nc\r\nd\r\n'), unterminatedRef, false)).equals(b('a\r\nb\nc\r\nd\r\n')));
  // The BOM rule still applies before the check; endings are compared after it.
  assert.ok(ok(canon(b('a\r\nb\nnew\n'), withBom(b('a\r\nb\n')), false)).equals(withBom(b('a\r\nb\nnew\n'))));
  assert.deepEqual(canon(b('a\nb\n'), withBom(b('a\r\nb\n')), false), refused);
});

test('binary, filtered and new paths come back unchanged', () => {
  const lfRef = b('x\ny\n');
  const crlfText = b('a\r\nb\r\n');
  // New path (no ref).
  assert.ok(ok(canon(crlfText, null, false)).equals(crlfText));
  assert.ok(ok(canon(withBom(b('a\nb\r\n')), null, false)).equals(withBom(b('a\nb\r\n'))));
  // Binary or filtered at EPOCH_BASE (skip).
  assert.ok(ok(canon(crlfText, lfRef, true)).equals(crlfText));
  assert.ok(ok(canon(b('a\nb\n'), withBom(b('x\r\n')), true)).equals(b('a\nb\n')));
  // `new` is binary (a NUL in its first 8,000 bytes): no BOM or ending change.
  const bin = Buffer.concat([b('a\r\n'), Buffer.from([0x00]), b('b\r\n')]);
  assert.ok(ok(canon(bin, lfRef, false)).equals(bin));
  const late = Buffer.concat([Buffer.alloc(8_000, 0x61), b('\r\n'), Buffer.from([0x00])]);
  assert.ok(!ok(canon(late, lfRef, false)).equals(late), 'a NUL after 8,000 bytes is text');
  // The path is binary by its blob (DAT-04): a ref with a NUL in its first 8,000 bytes passes a text
  // `next` through byte for byte, although the ref's bytes would read as an LF (or BOM) form.
  const binRef = Buffer.concat([b('x\ny\n'), Buffer.from([0x00]), b('z\n')]);
  assert.equal(form(binRef).eol, 'LF');
  assert.ok(ok(canon(crlfText, binRef, false)).equals(crlfText), 'CRLF next under a binary LF-looking ref');
  const binBomRef = Buffer.concat([BOM, b('x\r\n'), Buffer.from([0x00])]);
  assert.ok(ok(canon(b('a\nb\n'), binBomRef, false)).equals(b('a\nb\n')), 'no BOM added, no CRLF conversion');
  const lateRef = Buffer.concat([Buffer.alloc(8_000, 0x61), b('\n'), Buffer.from([0x00])]);
  assert.ok(ok(canon(crlfText, lateRef, false)).equals(b('a\nb\n')), 'a NUL after 8,000 bytes of ref is a text ref');
});

test('an LF-edited copy of the 1.3 MB BOM+CRLF fixture canonicalises to the CRLF edit byte for byte', () => {
  const ref = generateBigBomCrlf(26_436, seededRandom('canon-big-fixture'));
  assert.ok(ref.length > 1_200_000, `fixture size ${ref.length}`);
  assert.deepEqual(form(ref), { bom: true, eol: 'CRLF' });
  // The CRLF edit: one row changed, one row inserted, one row appended.
  const text = ref.subarray(3).toString('utf8');
  const lines = text.split('\r\n');
  lines[1_000] = 'x = 1  # 편집';
  lines.splice(20_000, 0, 'inserted = True');
  lines.splice(lines.length - 1, 0, 'appended = "end"');
  const crlfEdit = withBom(Buffer.from(lines.join('\r\n'), 'utf8'));
  // What an editor that saves LF writes: every ending LF, with and without the BOM.
  const lfBody = Buffer.from(lines.join('\n'), 'utf8');
  const started = process.hrtime.bigint();
  assert.ok(ok(canon(lfBody, ref, false)).equals(crlfEdit), 'LF copy without BOM');
  assert.ok(ok(canon(withBom(lfBody), ref, false)).equals(crlfEdit), 'LF copy with BOM');
  assert.ok(ok(canon(crlfEdit, ref, false)).equals(crlfEdit), 'the CRLF edit is already canonical');
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 5_000, `three canon calls on the fixture took ${ms} ms`);
});
