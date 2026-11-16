// ENG-41 (k), the live-blob half of DAT-46's marker backstop (ruling R3-FF2-B1; 03-data DAT-46, INV-DAT-NOMARKER; 01-engine
// ENG-41): no blob of diff(TIP, OUT) carries a restore-marker row ('<<<<<<< cowork:', '||||||| cowork:', '>>>>>>> cowork:', LF or
// CRLF, row 1's BOM ignored) unless that blob is already a blob of tree(TIP). Fail closed, independent of P: letter (e) passes
// whenever P[p] carries the rows, which is exactly the shape of a missed masking site (a journaled pair whose R holds the rows of a
// conflicted RESTORE). Final review r3 B3-1 (ruling R3-FF3-B1; DAT-46 has no text-only qualifier): whatever the DAT-04 binary sniff
// of the blob, as (j) — R3-18 sniffs only a RESTORE's input sides, and a conflicted merge of three text sides can put its NUL in the
// first 8,000 bytes (the merge-shifted-NUL cell). (k) is the last letter and reuses (e)'s read of each OUT blob (no extra read).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasRestoreMarkerRow, isBinaryBytes } from '../../src/data/rows.js';
import { prePushAsserts, type PrePushInput } from '../../src/engine/assertions.js';
import type { ScopeClass } from '../../src/data/scope.js';
import { parseOid, type Oid } from '../../src/git/oid.js';
import type { TreeEntry, TreeMap } from '../../src/git/repo.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const o = (n: number): Oid => parseOid(n.toString(16).padStart(40, '0'));
const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

const A_BASE = o(0xa0);
const A_LOCAL = o(0xa1);
const B_BASE = o(0xb0);
const B_TEAM = o(0xb1);
const RESTORE = o(0xe1);
const RESTORE_CRLF = o(0xe2);
const RESTORE_BOM = o(0xe3);
const BINARY = o(0xe4);
const MID_ROW = o(0xe5);
const BOTH = o(0xe6);
const SHIFTED = o(0xe7);
const T = o(1);
const TIP = o(2);
const C = o(3);
const OUT_TREE = o(20);
const EMPTY_TREE = o(99);

const ROWS = '<<<<<<< cowork:disk\nrow_10 = ten\n||||||| cowork:base\nrow_10 = 10\n=======\nrow_10 = 10\nTEAM = 1\n>>>>>>> cowork:held\n';

/**
 * The merge-shifted NUL (re-review r2 B probe zz_rr2_kbinary): three sides that are text by DAT-04 — base's NUL at byte 9,003, disk's
 * and held's at 8,003 — so a RESTORE runs merge-file on them (R3-18 sniffs only these inputs). Both sides delete different rows
 * before the NUL and change the same tail row, so `git merge-file -p --diff3 -L cowork:disk -L cowork:base -L cowork:held disk base
 * held` exits 1 with `merged` (byte for byte what git wrote in that probe): its NUL at 7,003, binary by DAT-04, restore-marker rows.
 */
const SIDE_ROW = (i: number): string => `line${String(i).padStart(4, '0')}`.padEnd(49, '.') + '\n';
const HEAD = [...Array(180).keys()].map(SIDE_ROW);
const NUL_ROW = 'bin\u0000row\n';
const MERGE = {
  base: [...HEAD, NUL_ROW, 'tail-a\n', 'tail-base\n', 'tail-c\n'].join(''),
  disk: [...HEAD.slice(0, 10), ...HEAD.slice(30), NUL_ROW, 'tail-a\n', 'tail-disk\n', 'tail-c\n'].join(''),
  held: [...HEAD.slice(0, 100), ...HEAD.slice(120), NUL_ROW, 'tail-a\n', 'tail-held\n', 'tail-c\n'].join(''),
  merged: [
    ...HEAD.slice(0, 10), ...HEAD.slice(30, 100), ...HEAD.slice(120), NUL_ROW, 'tail-a\n',
    '<<<<<<< cowork:disk\n', 'tail-disk\n', '||||||| cowork:base\n', 'tail-base\n', '=======\n', 'tail-held\n', '>>>>>>> cowork:held\n', 'tail-c\n',
  ].join(''),
};

const BLOBS = new Map<string, Buffer>([
  [A_BASE, buf('export const a = 1;\n')],
  [A_LOCAL, buf('export const a = 2;\n')],
  [B_BASE, buf('export const b = 1;\n')],
  [B_TEAM, buf('export const b = 2;\n')],
  [RESTORE, buf(`export const a = 2;\n${ROWS}`)],
  [RESTORE_CRLF, buf('export const a = 2;\r\n||||||| cowork:base\r\nrow\r\n')],
  [RESTORE_BOM, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf(`>>>>>>> cowork:held\nexport const a = 2;\n`)])],
  [BINARY, Buffer.concat([Buffer.from([0, 1, 2, 3]), buf(`\n${ROWS}`)])],
  [MID_ROW, buf('export const a = 2; // <<<<<<< cowork:disk is how a restore marks a row\n')],
  [BOTH, buf(`export const a = 2;\n${ROWS}<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n`)],
  [SHIFTED, Buffer.from(MERGE.merged, 'latin1')],
]);

function map(entries: Record<string, Oid>): TreeMap {
  const m = new Map<string, TreeEntry>();
  for (const [path, oid] of Object.entries(entries)) m.set(path, { path, mode: '100644', oid });
  return m;
}

/**
 * A code publish of a.ts as `blob` (P[a.ts] = `blob` too, so (e) knows its rows: the missed-masking-site shape) beside b.ts taken
 * from the teammate's TIP; `reads` records every readBlob.
 */
function publishing(blob: Oid, reads: string[] = [], over: Partial<PrePushInput> = {}): PrePushInput {
  return {
    T, tip: TIP,
    tipMap: map({ 'a.ts': A_BASE, 'b.ts': B_TEAM }),
    A: map({ 'a.ts': A_BASE, 'b.ts': B_BASE }),
    P: map({ 'a.ts': blob, 'b.ts': B_BASE }),
    out: map({ 'a.ts': blob, 'b.ts': B_TEAM }),
    outTree: OUT_TREE, emptyTree: EMPTY_TREE,
    bnewParents: [T, C], liveCode: C, cParents: [TIP],
    scope: (): ScopeClass => 'LIVE', masked: () => false,
    heldAdded: [],
    readBlob: async (oid) => {
      reads.push(oid);
      const b = BLOBS.get(oid);
      if (b === undefined) throw new Error(`no blob ${oid}`);
      return b;
    },
    ...over,
  };
}

test('ENG-41 (k): a new live blob carrying a restore-marker row fails even when P carries the rows ((e) passes there)', T10, async () => {
  assert.deepEqual(await prePushAsserts(publishing(A_LOCAL)), { ok: true }, 'the clean publish passes');
  assert.deepEqual(await prePushAsserts(publishing(RESTORE)), { ok: false, letter: 'k', path: 'a.ts' }, 'LF restore-marker rows');
  assert.deepEqual(await prePushAsserts(publishing(RESTORE_CRLF)), { ok: false, letter: 'k', path: 'a.ts' }, 'a CRLF restore-marker row');
  assert.deepEqual(await prePushAsserts(publishing(RESTORE_BOM)), { ok: false, letter: 'k', path: 'a.ts' }, 'a restore-marker row 1 after the BOM');
  // A new path (a copy published by P) is scanned as well.
  const copy = publishing(RESTORE, [], {
    tipMap: map({ 'a.ts': A_BASE, 'b.ts': B_TEAM }), P: map({ 'a.ts': A_BASE, 'b.ts': B_BASE, 'c.ts': RESTORE }),
    out: map({ 'a.ts': A_BASE, 'b.ts': B_TEAM, 'c.ts': RESTORE }),
  });
  assert.deepEqual(await prePushAsserts(copy), { ok: false, letter: 'k', path: 'c.ts' }, 'a new path');
});

test('final review r3 B3-1 (R3-FF3-B1): ENG-41 (k) refuses restore-marker rows whatever the DAT-04 binary sniff, as (j) does', T10, async () => {
  assert.equal(isBinaryBytes(BLOBS.get(BINARY)!), true, 'BINARY is binary by DAT-04');
  assert.deepEqual(await prePushAsserts(publishing(BINARY)), { ok: false, letter: 'k', path: 'a.ts' }, 'a binary-sniffed blob with restore-marker rows');
  // The merge-shifted NUL: a conflicted RESTORE of three text sides whose result is binary by DAT-04 (restore() adds `markers` from
  // hasRestoreMarkerRow(result) with no binary gate); the missed-masking-site shape, P[a.ts] = OUT[a.ts] = that result.
  assert.deepEqual([MERGE.base, MERGE.disk, MERGE.held].map((s) => isBinaryBytes(Buffer.from(s, 'latin1'))), [false, false, false], 'every side is text: merge-file runs');
  const shifted = BLOBS.get(SHIFTED)!;
  assert.deepEqual([isBinaryBytes(shifted), hasRestoreMarkerRow(shifted), shifted.indexOf(0)], [true, true, 7003], 'the result is binary by DAT-04 and carries the rows');
  assert.deepEqual(await prePushAsserts(publishing(SHIFTED)), { ok: false, letter: 'k', path: 'a.ts' }, 'the merge-shifted-NUL RESTORE result');
  // The same bytes under held/ are (j)'s (no binary gate there either): both halves of DAT-46 agree.
  const held = { holdId: '01J9ZQ3C5X00000000000000AA', path: 'a.ts', stage: 'h1' as const, oid: SHIFTED, localOnly: false, live: true };
  assert.deepEqual(await prePushAsserts(publishing(A_LOCAL, [], { heldAdded: [held] })), { ok: false, letter: 'j', path: 'a.ts' }, '(j) refuses the same bytes');
  // Still exempt when the blob is already one of tree(TIP).
  const known = publishing(SHIFTED, [], {
    tipMap: map({ 'a.ts': A_BASE, 'b.ts': B_TEAM, 'old.ts': SHIFTED }), A: map({ 'a.ts': A_BASE, 'b.ts': B_BASE, 'old.ts': SHIFTED }),
    P: map({ 'a.ts': SHIFTED, 'b.ts': B_BASE, 'old.ts': SHIFTED }),
  });
  known.out = map({ 'a.ts': SHIFTED, 'b.ts': B_TEAM, 'old.ts': SHIFTED });
  assert.deepEqual(await prePushAsserts(known), { ok: true }, 'a binary blob of tree(TIP)');
});

test('ENG-41 (k): a blob already in tree(TIP), a mid-row marker text and a deletion pass', T10, async () => {
  // The same marker blob is already a blob of tree(TIP) (at another path): the push adds nothing the remote lacks.
  const known = publishing(RESTORE, [], {
    tipMap: map({ 'a.ts': A_BASE, 'b.ts': B_TEAM, 'old.ts': RESTORE }), A: map({ 'a.ts': A_BASE, 'b.ts': B_BASE, 'old.ts': RESTORE }),
    P: map({ 'a.ts': RESTORE, 'b.ts': B_BASE, 'old.ts': RESTORE }),
  });
  known.out = map({ 'a.ts': RESTORE, 'b.ts': B_TEAM, 'old.ts': RESTORE });
  assert.deepEqual(await prePushAsserts(known), { ok: true }, 'a blob of tree(TIP)');
  assert.deepEqual(await prePushAsserts(publishing(MID_ROW)), { ok: true }, 'the marker text not at the start of a row');
  const deleted = publishing(A_LOCAL, [], { P: map({ 'b.ts': B_BASE }), out: map({ 'b.ts': B_TEAM }) });
  assert.deepEqual(await prePushAsserts(deleted), { ok: true }, 'a deletion adds no blob');
  // A board-only publish (OUT == TIP) adds no live blob, whatever TIP holds.
  const boardOnly = publishing(RESTORE, [], {
    tipMap: map({ 'a.ts': RESTORE, 'b.ts': B_TEAM }), A: map({ 'a.ts': RESTORE, 'b.ts': B_BASE }), P: map({ 'a.ts': RESTORE, 'b.ts': B_BASE }),
    out: map({ 'a.ts': RESTORE, 'b.ts': B_TEAM }), bnewParents: [T, TIP], liveCode: TIP, cParents: null,
  });
  assert.deepEqual(await prePushAsserts(boardOnly), { ok: true }, 'a board-only publish');
});

test('ENG-41 (k) is the last letter and reads no blob (e) has not read', T10, async () => {
  // (e) first: a git conflict-marker row absent from P and TIP beside the restore rows.
  const both = publishing(BOTH, [], { P: map({ 'a.ts': A_LOCAL, 'b.ts': B_BASE }) });
  assert.deepEqual(await prePushAsserts(both), { ok: false, letter: 'e', path: 'a.ts' });
  // (h), (i) and (j) are reported before (k).
  assert.deepEqual(await prePushAsserts(publishing(RESTORE, [], { scope: (p) => (p === 'a.ts' ? 'QUARANTINED' : 'LIVE') })), { ok: false, letter: 'h', path: 'a.ts' });
  assert.deepEqual(await prePushAsserts(publishing(RESTORE, [], { masked: (p) => p === 'a.ts' })), { ok: false, letter: 'i', path: 'a.ts' });
  const held = { holdId: '01J9ZQ3C5X00000000000000AA', path: 'b.ts', stage: 'h1' as const, oid: B_BASE, localOnly: true, live: true };
  assert.deepEqual(await prePushAsserts(publishing(RESTORE, [], { heldAdded: [held] })), { ok: false, letter: 'j', path: 'b.ts' });
  // One read of OUT[a.ts] (plus (e)'s P[a.ts] and TIP[a.ts], read because OUT[a.ts] has marker rows); OUT[a.ts] is not read twice.
  const reads: string[] = [];
  assert.deepEqual(await prePushAsserts(publishing(RESTORE, reads)), { ok: false, letter: 'k', path: 'a.ts' });
  assert.deepEqual(reads.filter((x) => x === RESTORE).length, 2, `OUT[a.ts] once and P[a.ts] once: ${JSON.stringify(reads)}`);
  assert.deepEqual(reads, [RESTORE, RESTORE, A_BASE], 'OUT[a.ts], then (e)\'s P[a.ts] and TIP[a.ts]');
});
