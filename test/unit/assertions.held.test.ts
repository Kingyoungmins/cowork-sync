// ENG-41 (j) over the real held/ additions (Plan 3 Task 4; 01-engine ENG-41 (j), 03-data DAT-46, D-18; Review Focus 5):
// every held/ entry Bnew adds belongs to a non-local_only record and a LIVE path, and no new held/ blob carries a
// restore-marker row (LF or CRLF) unless that blob is already a blob of tree(TIP).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prePushAsserts, type PrePushInput } from '../../src/engine/assertions.js';
import type { ScopeClass } from '../../src/data/scope.js';
import { parseOid, type Oid } from '../../src/git/oid.js';
import type { TreeEntry, TreeMap } from '../../src/git/repo.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const o = (n: number): Oid => parseOid(n.toString(16).padStart(40, '0'));
const buf = (s: string): Buffer => Buffer.from(s, 'utf8');
const ID = '01J9ZQ3C5X00000000000000AA';

const BASE = o(0xa0);
const CLEAN = o(0xa1);
const DISK_MARKER = o(0xe1);
const CRLF_MARKER = o(0xe2);
const T = o(1);
const TIP = o(2);
const OUT_TREE = o(20);
const EMPTY_TREE = o(99);

const BLOBS = new Map<string, Buffer>([
  [BASE, buf('one\ntwo\n')],
  [CLEAN, buf('one\ntwo held\n')],
  [DISK_MARKER, buf('one\n<<<<<<< cowork:disk\ntwo\n=======\ntwo held\n>>>>>>> cowork:held\n')],
  [CRLF_MARKER, buf('one\r\n||||||| cowork:base\r\ntwo\r\n')],
]);

function map(entries: Record<string, Oid>): TreeMap {
  const m = new Map<string, TreeEntry>();
  for (const [path, oid] of Object.entries(entries)) m.set(path, { path, mode: '100644', oid });
  return m;
}

/** A clean board-only publish (P == A, OUT == TIP) whose Bnew adds the given held/ entries. */
function boardOnly(heldAdded: PrePushInput['heldAdded'], tipEntries: Record<string, Oid> = { 'a.txt': BASE }, scope: (p: string) => ScopeClass = () => 'LIVE'): PrePushInput {
  const tip = map(tipEntries);
  return {
    T, tip: TIP, tipMap: tip, A: map({ 'a.txt': BASE }), P: map({ 'a.txt': BASE }), out: tip, outTree: OUT_TREE, emptyTree: EMPTY_TREE,
    bnewParents: [T, TIP], liveCode: TIP, cParents: null, scope, masked: () => false, heldAdded,
    readBlob: async (oid) => {
      const b = BLOBS.get(oid);
      if (b === undefined) throw new Error(`no blob ${oid}`);
      return b;
    },
  };
}

const entry = (over: Partial<PrePushInput['heldAdded'][number]> = {}): PrePushInput['heldAdded'][number] => (
  { holdId: ID, path: 'a.txt', stage: 'h1', oid: CLEAN, localOnly: false, live: true, ...over }
);

test('ENG-41 (j) checks the real held/ additions', T10, async () => {
  // Clean entries (and none) pass.
  assert.deepEqual(await prePushAsserts(boardOnly([])), { ok: true });
  assert.deepEqual(await prePushAsserts(boardOnly([entry({ stage: 'h0', oid: BASE }), entry()])), { ok: true });
  // An entry of a local_only record.
  assert.deepEqual(await prePushAsserts(boardOnly([entry({ localOnly: true })])), { ok: false, letter: 'j', path: 'a.txt' });
  // An entry on a path whose scope is not LIVE.
  assert.deepEqual(await prePushAsserts(boardOnly([entry({ path: '.gitignore', live: false })])), { ok: false, letter: 'j', path: '.gitignore' });
  // A blob with a `<<<<<<< cowork:disk` row that is no blob of tree(TIP).
  assert.deepEqual(await prePushAsserts(boardOnly([entry({ oid: DISK_MARKER })])), { ok: false, letter: 'j', path: 'a.txt' });
  // A blob whose restore-marker row ends in CRLF (Review Focus 5).
  assert.deepEqual(await prePushAsserts(boardOnly([entry({ stage: 'h0', oid: CRLF_MARKER })])), { ok: false, letter: 'j', path: 'a.txt' });
  // The same blobs already in tree(TIP) (under any path): not new, they pass (DAT-46).
  const tipHas = { 'a.txt': BASE, 'docs/m.txt': DISK_MARKER, 'docs/n.txt': CRLF_MARKER };
  assert.deepEqual(await prePushAsserts(boardOnly([entry({ oid: DISK_MARKER }), entry({ stage: 'h0', oid: CRLF_MARKER })], tipHas)), { ok: true });
  // The first failing entry is reported.
  assert.deepEqual(await prePushAsserts(boardOnly([entry(), entry({ path: 'b.txt', oid: DISK_MARKER }), entry({ path: 'c.txt', localOnly: true })])), { ok: false, letter: 'j', path: 'b.txt' });
});
