// ENG-41 pre-push asserts (01-engine §3.12 step 5; letter (f) is SEC-07's scan, out per ruling R-06): each letter on its
// planted violation, and a clean input (a code publish and a board-only publish) passing every letter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prePushAsserts, type AssertLetter, type PrePushInput } from '../../src/engine/assertions.js';
import type { ScopeClass } from '../../src/data/scope.js';
import { parseOid, type Oid } from '../../src/git/oid.js';
import type { FileMode, TreeEntry, TreeMap } from '../../src/git/repo.js';

const o = (n: number): Oid => parseOid(n.toString(16).padStart(40, '0'));
const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

function map(entries: Record<string, Oid | [Oid, FileMode]>): TreeMap {
  const m = new Map<string, TreeEntry>();
  for (const [path, v] of Object.entries(entries)) {
    const [oid, mode] = Array.isArray(v) ? v : [v, '100644' as FileMode];
    m.set(path, { path, mode, oid });
  }
  return m;
}

// Blob ids of the clean input: a.ts base / local, b.ts base / teammate; the marker and content blobs of the planted cases.
const A_BASE = o(0xa0);
const A_LOCAL = o(0xa1);
const B_BASE = o(0xb0);
const B_TEAM = o(0xb1);
const MARKED = o(0xe0);
const T = o(1);
const TIP = o(2);
const C = o(3);
const OUT_TREE = o(20);
const EMPTY_TREE = o(99);

const BLOBS = new Map<string, Buffer>([
  [A_BASE, buf('export const a = 1;\n')],
  [A_LOCAL, buf('export const a = 2;\n')],
  [B_BASE, buf('export const b = 1;\n')],
  [B_TEAM, buf('export const b = 2;\n')],
  [MARKED, buf('export const a = 2;\n<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n')],
]);

/** A clean code publish: a.ts published from P, b.ts taken from the teammate's TIP. */
function clean(): PrePushInput {
  return {
    T, tip: TIP,
    tipMap: map({ 'a.ts': A_BASE, 'b.ts': B_TEAM }),
    A: map({ 'a.ts': A_BASE, 'b.ts': B_BASE }),
    P: map({ 'a.ts': A_LOCAL, 'b.ts': B_BASE }),
    out: map({ 'a.ts': A_LOCAL, 'b.ts': B_TEAM }),
    outTree: OUT_TREE, emptyTree: EMPTY_TREE,
    bnewParents: [T, C], liveCode: C, cParents: [TIP],
    scope: (): ScopeClass => 'LIVE', masked: () => false,
    heldEntriesAdded: 0,
    readBlob: async (oid) => {
      const b = BLOBS.get(oid);
      if (b === undefined) throw new Error(`no blob ${oid}`);
      return b;
    },
  };
}

async function letterOf(inp: PrePushInput): Promise<AssertLetter | null> {
  const r = await prePushAsserts(inp);
  return r.ok ? null : r.letter;
}

test('each ENG-41 letter fails on its planted violation and passes on a clean input', async () => {
  assert.deepEqual(await prePushAsserts(clean()), { ok: true }, 'a clean code publish passes every letter');
  // A clean board-only publish: last parent TIP, P == A, OUT == tree(TIP).
  const boardOnly: PrePushInput = {
    ...clean(), P: map({ 'a.ts': A_BASE, 'b.ts': B_BASE }), out: map({ 'a.ts': A_BASE, 'b.ts': B_TEAM }),
    bnewParents: [T, TIP], liveCode: TIP, cParents: null,
  };
  assert.deepEqual(await prePushAsserts(boardOnly), { ok: true }, 'a clean board-only publish passes');

  // (a) wrong first parent; also a C whose parent is not TIP, and a board-only last parent other than TIP.
  assert.equal(await letterOf({ ...clean(), bnewParents: [o(7), C] }), 'a');
  assert.equal(await letterOf({ ...clean(), cParents: [o(8)] }), 'a');
  assert.equal(await letterOf({ ...boardOnly, bnewParents: [T, o(9)], liveCode: o(9) }), 'a');
  // (b) a path outside diff(A, P) differs between TIP and OUT (P ≠ A elsewhere).
  const b = clean();
  assert.deepEqual(await prePushAsserts({ ...b, out: map({ 'a.ts': A_LOCAL, 'b.ts': B_BASE }) }), { ok: false, letter: 'b', path: 'b.ts' });
  // (c) OUT ≠ TIP where P == A (nothing of P differs from A).
  assert.deepEqual(await prePushAsserts({ ...boardOnly, out: map({ 'a.ts': A_LOCAL, 'b.ts': B_TEAM }) }), { ok: false, letter: 'c', path: 'a.ts' });
  // (d) an empty OUT over a non-empty TIP (each condition alone: the next test).
  assert.equal(await letterOf({ ...clean(), out: new Map(), outTree: EMPTY_TREE }), 'd');
  // (e) a new conflict-marker row in a blob of diff(TIP, OUT), absent from P[p] and TIP[p].
  assert.deepEqual(await prePushAsserts({ ...clean(), out: map({ 'a.ts': MARKED, 'b.ts': B_TEAM }) }), { ok: false, letter: 'e', path: 'a.ts' });
  // A marker row already in P[p] is not new.
  const markedP = { ...clean(), P: map({ 'a.ts': MARKED, 'b.ts': B_BASE }), out: map({ 'a.ts': MARKED, 'b.ts': B_TEAM }) };
  assert.deepEqual(await prePushAsserts(markedP), { ok: true });
  // (g) a changed 160000 entry.
  const g = clean();
  assert.deepEqual(await prePushAsserts({
    ...g,
    A: map({ ...Object.fromEntries([...g.A].map(([p, e]) => [p, e.oid])), sub: [o(0x40), '160000'] }),
    P: map({ ...Object.fromEntries([...g.P].map(([p, e]) => [p, e.oid])), sub: [o(0x41), '160000'] }),
    tipMap: map({ ...Object.fromEntries([...g.tipMap].map(([p, e]) => [p, e.oid])), sub: [o(0x40), '160000'] }),
    out: map({ ...Object.fromEntries([...g.out].map(([p, e]) => [p, e.oid])), sub: [o(0x41), '160000'] }),
  }), { ok: false, letter: 'g', path: 'sub' });
  // (h) a changed quarantined path (and a save-only one).
  assert.deepEqual(await prePushAsserts({ ...clean(), scope: (p) => (p === 'a.ts' ? 'QUARANTINED' : 'LIVE') }), { ok: false, letter: 'h', path: 'a.ts' });
  assert.deepEqual(await prePushAsserts({ ...clean(), scope: (p) => (p === 'a.ts' ? 'SAVE_ONLY' : 'LIVE') }), { ok: false, letter: 'h', path: 'a.ts' });
  // (i) a masked (held) path differing from A in P; OUT keeps TIP there, so no other letter fires.
  assert.deepEqual(await prePushAsserts({ ...clean(), out: map({ 'a.ts': A_BASE, 'b.ts': B_TEAM }), masked: (p) => p === 'a.ts' }), { ok: false, letter: 'i', path: 'a.ts' });
  // INV-MASK (HLD-19): a path-class (QUARANTINED / SAVE_ONLY / UNMANAGED) path differing from A in P while OUT keeps TIP.
  assert.deepEqual(await prePushAsserts({ ...clean(), out: map({ 'a.ts': A_BASE, 'b.ts': B_TEAM }), scope: (p) => (p === 'a.ts' ? 'UNMANAGED' : 'LIVE') }), { ok: false, letter: 'INV-MASK', path: 'a.ts' });
  // (j) an added held/ entry (Plan 2 adds none).
  assert.deepEqual(await prePushAsserts({ ...clean(), heldEntriesAdded: 1 }), { ok: false, letter: 'j', path: null });
});

test('ENG-41 (d): an invalid OUT oid, the empty tree over a non-empty TIP and an empty OUT map each fail alone; an empty OUT over an empty TIP passes', async () => {
  assert.deepEqual(await prePushAsserts({ ...clean(), outTree: 'not-an-oid' as Oid }), { ok: false, letter: 'd', path: null }, 'an OUT oid that is not an oid');
  assert.deepEqual(await prePushAsserts({ ...clean(), outTree: EMPTY_TREE }), { ok: false, letter: 'd', path: null }, 'the empty tree (OUT map intact)');
  assert.deepEqual(await prePushAsserts({ ...clean(), out: new Map() }), { ok: false, letter: 'd', path: null }, 'an empty OUT map (OUT oid not the empty tree)');
  const emptyTip: PrePushInput = {
    ...clean(), tipMap: new Map(), A: new Map(), P: new Map(), out: new Map(), outTree: EMPTY_TREE,
    bnewParents: [T, TIP], liveCode: TIP, cParents: null,
  };
  assert.deepEqual(await prePushAsserts(emptyTip), { ok: true }, 'an empty TIP may stay empty');
});

test('ENG-41 (a): every parent shape other than [T, liveCode] with liveCode TIP or a C whose sole parent is TIP fails', async () => {
  const fails: Array<[string, Partial<PrePushInput>]> = [
    ['no board tip T', { T: 'ABSENT' }],
    ['no board tip T, even with a first parent that reads ABSENT', { T: 'ABSENT', bnewParents: ['ABSENT' as Oid, C] }],
    ['one parent', { bnewParents: [T] }],
    ['three parents', { bnewParents: [T, C, TIP] }],
    ['a last parent other than liveCode', { bnewParents: [T, o(77)] }],
    ['C with two parents', { cParents: [TIP, o(78)] }],
    ['C with no parent', { cParents: [] }],
    ['a C claimed while liveCode is TIP', { bnewParents: [T, TIP], liveCode: TIP, cParents: [TIP] }],
  ];
  for (const [what, over] of fails) assert.equal(await letterOf({ ...clean(), ...over }), 'a', what);
});

test('ENG-41 (e): a deleted path and marker rows already in TIP[p] are not new; a new marker row is', async () => {
  const MARKED_TIP = o(0xe1);
  const MARKED_OUT = o(0xe2);
  const rows = '<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n';
  const blobs = new Map<string, Buffer>([
    ...BLOBS, [MARKED_TIP, buf(`export const a = 1;\n${rows}`)], [MARKED_OUT, buf(`export const a = 2;\n${rows}`)],
  ]);
  const readBlob = async (oid: Oid): Promise<Buffer> => {
    const b = blobs.get(oid);
    if (b === undefined) throw new Error(`no blob ${oid}`);
    return b;
  };
  // TIP[a] already holds the marker rows; OUT[a] keeps them with the local change.
  const known: PrePushInput = {
    ...clean(), readBlob, tipMap: map({ 'a.ts': MARKED_TIP, 'b.ts': B_TEAM }), A: map({ 'a.ts': MARKED_TIP, 'b.ts': B_BASE }),
    P: map({ 'a.ts': MARKED_OUT, 'b.ts': B_BASE }), out: map({ 'a.ts': MARKED_OUT, 'b.ts': B_TEAM }),
  };
  assert.deepEqual(await prePushAsserts(known), { ok: true }, 'rows already in TIP[p] are not new');
  // The same OUT blob with TIP[a] and P[a] free of markers: new rows.
  assert.deepEqual(await prePushAsserts({ ...known, tipMap: map({ 'a.ts': A_BASE, 'b.ts': B_TEAM }), A: map({ 'a.ts': A_BASE, 'b.ts': B_BASE }), P: map({ 'a.ts': A_LOCAL, 'b.ts': B_BASE }) }),
    { ok: false, letter: 'e', path: 'a.ts' });
  // A deletion published by P: OUT has no blob at a.ts, nothing to scan.
  const deleted: PrePushInput = { ...clean(), P: map({ 'b.ts': B_BASE }), out: map({ 'b.ts': B_TEAM }) };
  assert.deepEqual(await prePushAsserts(deleted), { ok: true });
  // Without a marker row in OUT[p], P[p] and TIP[p] are never read: one read per changed OUT blob (a.ts only).
  const reads: string[] = [];
  const counted: PrePushInput = { ...clean(), readBlob: async (oid) => (reads.push(oid), BLOBS.get(oid)!) };
  assert.deepEqual(await prePushAsserts(counted), { ok: true });
  assert.deepEqual(reads, [A_LOCAL], 'only OUT[a.ts] is read (OUT[b.ts] is TIP[b.ts])');
});

test('ENG-41 (g): a symlink or gitlink on either side of diff(TIP, OUT) fails', async () => {
  const LINK_A = o(0x50);
  const PLAIN = o(0x51);
  const blobs = new Map<string, Buffer>([...BLOBS, [PLAIN, buf('a plain file now\n')]]);
  const readBlob = async (oid: Oid): Promise<Buffer> => {
    const b = blobs.get(oid);
    if (b === undefined) throw new Error(`no blob ${oid}`);
    return b;
  };
  const base = clean();
  const withPath = (m: TreeMap, e: [Oid, FileMode] | null): TreeMap => {
    const out = new Map(m);
    if (e !== null) out.set('link', { path: 'link', mode: e[1], oid: e[0] });
    return out;
  };
  // TIP's symlink replaced by a regular file in OUT (the special side is TIP only).
  assert.deepEqual(await prePushAsserts({
    ...base, readBlob,
    A: withPath(base.A, [LINK_A, '120000']), tipMap: withPath(base.tipMap, [LINK_A, '120000']),
    P: withPath(base.P, [PLAIN, '100644']), out: withPath(base.out, [PLAIN, '100644']),
  }), { ok: false, letter: 'g', path: 'link' }, 'a symlink in TIP');
  // A new symlink in OUT (the special side is OUT only).
  assert.deepEqual(await prePushAsserts({
    ...base, readBlob, P: withPath(base.P, [LINK_A, '120000']), out: withPath(base.out, [LINK_A, '120000']),
  }), { ok: false, letter: 'g', path: 'link' }, 'a symlink in OUT');
});
