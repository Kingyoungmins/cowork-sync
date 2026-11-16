// The SIM reference model of edit markers (Plan 3 Task 13; TST-08, 11-testing §2 *marker*, glossary §21 INV-NOLOSS's accounting
// input, rulings R3-48 and R3-64): minting, safe placement in LF, CRLF, BOM, cp949 and binary files, the byte-order scan, and the
// live / retired / discarded / exempt / late-write bookkeeping the INV-NOLOSS oracle reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMarkers, MarkerModel, markerRun } from '../sim/markers.js';

const b = (s: string): Buffer => Buffer.from(s, 'utf8');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

test('mint numbers markers per run across authors: CWM_r7_1_p0, CWM_r7_2_p1, CWM_r7_3_team; markerRun(\'holds-12\') is \'holds12\'', () => {
  const m = new MarkerModel('r7');
  assert.deepEqual([m.mint('p0'), m.mint('p1'), m.mint('team')], ['CWM_r7_1_p0', 'CWM_r7_2_p1', 'CWM_r7_3_team']);
  assert.equal(markerRun('holds-12'), 'holds12');
  assert.equal(markerRun('holds-crash-smoke-3'), 'holdscrashsmoke3');
  // A second model of another run numbers from 1 again: the counter is per run (per model), never a random draw.
  assert.equal(new MarkerModel('x').mint('p2'), 'CWM_x_1_p2');
  assert.throws(() => new MarkerModel('a-b'), /run/);
  assert.throws(() => m.mint('p-1'), /peer/);
});

test('place: line mode inserts \'<marker><EOL>\' before row at, suffix mode inserts \' <marker>\' before row at\'s EOL, in the file\'s dominant EOL', () => {
  const model = new MarkerModel('r');
  const m = 'CWM_r_1_p0';
  assert.equal(model.place(b('a\nb\nc\n'), m, 1, 'line').toString('utf8'), `a\n${m}\nb\nc\n`);
  assert.equal(model.place(b('a\r\nb\r\n'), m, 1, 'line').toString('utf8'), `a\r\n${m}\r\nb\r\n`);
  assert.equal(model.place(b('a\nb\nc\n'), m, 1, 'suffix').toString('utf8'), `a\nb ${m}\nc\n`);
  assert.equal(model.place(b('a\r\nb\r\nc\r\n'), m, 2, 'suffix').toString('utf8'), `a\r\nb\r\nc ${m}\r\n`);
  // row 0
  assert.equal(model.place(b('a\nb\n'), m, 0, 'line').toString('utf8'), `${m}\na\nb\n`);
  // at >= row count: line appends a final row, suffix suffixes the last row
  assert.equal(model.place(b('a\nb\nc\n'), m, 3, 'line').toString('utf8'), `a\nb\nc\n${m}\n`);
  assert.equal(model.place(b('a\nb\nc\n'), m, 99, 'line').toString('utf8'), `a\nb\nc\n${m}\n`);
  assert.equal(model.place(b('a\nb\nc\n'), m, 3, 'suffix').toString('utf8'), `a\nb\nc ${m}\n`);
  assert.equal(model.place(b('a\r\nb\r\n'), m, 7, 'suffix').toString('utf8'), `a\r\nb ${m}\r\n`);
  assert.equal(model.place(b('a\r\nb\r\n'), m, 7, 'line').toString('utf8'), `a\r\nb\r\n${m}\r\n`);
  // dominant EOL: two CRLF rows and one LF row write CRLF
  assert.equal(model.place(b('a\r\nb\r\nc\n'), m, 3, 'line').toString('utf8'), `a\r\nb\r\nc\n${m}\r\n`);
  // an empty file gets one LF row in either mode
  assert.equal(model.place(Buffer.alloc(0), m, 0, 'line').toString('utf8'), `${m}\n`);
  assert.equal(model.place(Buffer.alloc(0), m, 0, 'suffix').toString('utf8'), `${m}\n`);
});

test('place keeps a leading UTF-8 BOM first, a CRLF file\'s endings and a missing final EOL', () => {
  const model = new MarkerModel('r');
  const m = 'CWM_r_2_p1';
  const bom = model.place(Buffer.concat([BOM, b('x\r\n')]), m, 0, 'line');
  assert.deepEqual(bom, Buffer.concat([BOM, b(`${m}\r\n`), b('x\r\n')]));
  assert.deepEqual(model.place(Buffer.concat([BOM, b('x\r\ny\r\n')]), m, 0, 'suffix'), Buffer.concat([BOM, b(`x ${m}\r\ny\r\n`)]));
  // F-PATH-2: no EOL is added to a file without a final one
  assert.equal(model.place(b('a\nb'), m, 1, 'suffix').toString('utf8'), `a\nb ${m}`);
  assert.equal(model.place(b('a\nb'), m, 5, 'line').toString('utf8'), `a\nb\n${m}`);
  assert.equal(model.place(b('a\r\nb'), m, 1, 'line').toString('utf8'), `a\r\n${m}\r\nb`);
  // a BOM-only file: the marker row follows the BOM
  assert.deepEqual(model.place(BOM, m, 0, 'line'), Buffer.concat([BOM, b(`${m}\n`)]));
});

test('place on a cp949 row keeps every Hangul byte pair: \'row 1 \' C7 D1 B1 DB \'\\n\' suffix at 0 gives \'row 1 \' C7 D1 B1 DB \' \' m \'\\n\', which TextDecoder(\'euc-kr\', {fatal: true}) decodes', () => {
  const model = new MarkerModel('r');
  const m = 'CWM_r_3_p2';
  const hangul = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]);
  const row = Buffer.concat([b('row 1 '), hangul, b('\n')]);
  const out = model.place(row, m, 0, 'suffix');
  assert.deepEqual(out, Buffer.concat([b('row 1 '), hangul, b(` ${m}\n`)]));
  assert.equal(new TextDecoder('euc-kr', { fatal: true }).decode(out), `row 1 \u{d55c}\u{ae00} ${m}\n`);
  // line mode before a second cp949 row keeps both rows' pairs
  const two = Buffer.concat([row, b('row 2 '), hangul, b('\n')]);
  const lined = model.place(two, m, 1, 'line');
  assert.deepEqual(lined, Buffer.concat([row, b(`${m}\n`), b('row 2 '), hangul, b('\n')]));
  assert.doesNotThrow(() => new TextDecoder('euc-kr', { fatal: true }).decode(lined));
  assert.deepEqual(findMarkers(lined), [m]);
});

test('place on a binary buffer (a NUL in the first 8,000 bytes) appends \'<marker>\\n\' after the last byte and leaves the first 4,096 bytes unchanged', () => {
  const model = new MarkerModel('r');
  const m = 'CWM_r_4_p0';
  const bin = Buffer.alloc(4_096);
  for (let i = 0; i < bin.length; i++) bin[i] = (i * 37 + 11) & 0xff;
  bin[0] = 0x00;
  bin[100] = 0x0a;   // an LF byte inside the binary: still no row handling
  for (const mode of ['line', 'suffix'] as const) {
    for (const at of [0, 1, 50]) {
      const out = model.place(bin, m, at, mode);
      assert.equal(out.length, 4_096 + m.length + 1);
      assert.deepEqual(out.subarray(0, 4_096), bin, `${mode} at ${at}: the first 4,096 bytes are unchanged`);
      assert.equal(out.subarray(4_096).toString('latin1'), `${m}\n`);
    }
  }
  // a NUL past the first 8,000 bytes is text by DAT-04: row placement applies
  const late = Buffer.concat([b('a\nb\n'), Buffer.alloc(8_000, 0x20), Buffer.from([0x00]), b('\n')]);
  assert.equal(model.place(late, m, 1, 'line').subarray(0, 2 + m.length + 1).toString('latin1'), `a\n${m}\n`);
});

test('findMarkers returns markers in byte order and ignores incomplete ones: \'x CWM_r_1_p0\\nCWM_r_2_team y\\nCWM_r_x_p0\\n\' → [\'CWM_r_1_p0\', \'CWM_r_2_team\']', () => {
  assert.deepEqual(findMarkers(b('x CWM_r_1_p0\nCWM_r_2_team y\nCWM_r_x_p0\n')), ['CWM_r_1_p0', 'CWM_r_2_team']);
  assert.deepEqual(findMarkers(b('')), []);
  assert.deepEqual(findMarkers(b('CWM_holds12_10_p1 CWM_holds12_9_p0\n')), ['CWM_holds12_10_p1', 'CWM_holds12_9_p0']);
  // binary and non-UTF-8 neighbours do not hide a marker (latin1 scan)
  assert.deepEqual(findMarkers(Buffer.concat([Buffer.from([0x00, 0xc7, 0xd1]), b(' CWM_r_5_p2'), Buffer.from([0xff])])), ['CWM_r_5_p2']);
  assert.deepEqual(findMarkers(b('CWM__1_p0 CWM_r_1_ CWM_r__p0')), []);
});

test('noteEdit retires a marker only on an informed removal by a peer whose A or disk held it', () => {
  const model = new MarkerModel('r');
  const m = model.mint('p0');
  model.noteEdit('p0', 'a.txt', [m], [], true, () => false);
  assert.deepEqual(model.live().get(m), { peer: 'p0', path: 'a.txt' });
  model.noteEdit('p1', 'a.txt', [], [m], false, () => true);   // stale: not informed
  assert.deepEqual(model.live().get(m), { peer: 'p0', path: 'a.txt' });
  assert.equal(model.retired().has(m), false);
  model.noteEdit('p1', 'a.txt', [], [m], true, () => false);   // informed, but p1 never had it
  assert.deepEqual(model.live().get(m), { peer: 'p0', path: 'a.txt' });
  model.noteEdit('p1', 'a.txt', [], [m], true, (x) => x === m);
  assert.equal(model.live().has(m), false);
  assert.equal(model.retired().has(m), true);
  // an informed removal at another path than the marker's live path (a move's old name) retires nothing
  const n = model.mint('p2');
  model.noteEdit('p2', 'c.txt', [n], [], true, () => true);
  model.noteEdit('p2', 'old/c.txt', [], [n], true, () => true);
  assert.deepEqual(model.live().get(n), { peer: 'p2', path: 'c.txt' });
});

test('noteEdit of an already-live marker moves it to the new path, and re-adding a retired marker makes it live for the re-adding peer', () => {
  const model = new MarkerModel('r');
  const m = model.mint('p0');
  model.noteEdit('p0', 'a.txt', [m], [], true, () => false);
  model.noteEdit('p0', 'b.txt', [m], [], true, () => false);
  assert.deepEqual(model.live().get(m), { peer: 'p0', path: 'b.txt' });
  model.noteEdit('p1', 'b.txt', [], [m], true, () => true);
  assert.equal(model.retired().has(m), true);
  model.noteEdit('p2', 'b.txt', [m], [], false, () => false);
  assert.deepEqual(model.live().get(m), { peer: 'p2', path: 'b.txt' });
  assert.equal(model.retired().has(m), false);
  // synced false registers an added marker as exempt, not as an obligation (R3-48); a later move to a synced path makes it one
  const e = model.mint('p0');
  model.noteEdit('p0', 'own/x.pem', [e], [], true, () => false, false);
  assert.deepEqual(model.exempt().get(e), { peer: 'p0', path: 'own/x.pem' });
  assert.equal(model.live().has(e), false);
  model.noteEdit('p0', 'np/fixed-1.txt', [e], [], true, () => true);
  model.noteEdit('p0', 'own/x.pem', [], [e], true, () => true, false);
  assert.deepEqual(model.live().get(e), { peer: 'p0', path: 'np/fixed-1.txt' });
  assert.equal(model.exempt().has(e), false);
  assert.equal(model.retired().has(e), false);
});

test('noteDiscard removes the listed live markers into discarded() with the hold id and ignores markers that are not live; noteLateWrite marks a marker in lateWrites()', () => {
  const model = new MarkerModel('r');
  const [a, c, d] = [model.mint('p0'), model.mint('p1'), model.mint('p0')];
  model.noteEdit('p0', 'a.txt', [a], [], true, () => false);
  model.noteEdit('p1', 'a.txt', [c], [], true, () => false);
  model.noteEdit('p0', 'a.txt', [d], [], true, () => false);
  model.noteEdit('p1', 'a.txt', [], [d], true, () => true);   // d retired
  const HID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
  model.noteDiscard(HID, [a, d, 'CWM_r_99_p9']);
  assert.deepEqual([...model.discarded()], [[a, HID]]);
  assert.equal(model.live().has(a), false);
  assert.deepEqual(model.live().get(c), { peer: 'p1', path: 'a.txt' });
  assert.equal(model.retired().has(d), true, 'a retired marker stays retired');
  assert.equal(model.discarded().has(d), false);
  assert.deepEqual([...model.lateWrites()], []);
  model.noteLateWrite(c);
  assert.deepEqual([...model.lateWrites()], [c]);
  assert.deepEqual(model.live().get(c), { peer: 'p1', path: 'a.txt' }, 'a late write stays live');
});
