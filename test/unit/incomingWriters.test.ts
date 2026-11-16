// mergeIncomingWriters (Plan 3 Task 18's FlowMemory.incoming; audit #25, PC-2 Task 18 review Important 1): an apply's trailer read is
// merged into the writers earlier reads kept instead of replacing them, since the read covers (base, TIP] and a pending not-applicable
// path's commit lies below every later read's base. Pure maps; no git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeIncomingWriters, type IncomingWriter } from '../../src/engine/core.js';
import { ABSENT, parseOid, type Oid, type OidOrAbsent } from '../../src/git/oid.js';
import type { TreeEntry, TreeMap } from '../../src/git/repo.js';

const oid = (n: number): Oid => parseOid(n.toString(16).padStart(40, '0'));
const tree = (entries: Record<string, number>): TreeMap =>
  new Map(Object.entries(entries).map(([path, n]): [string, TreeEntry] => [path, { path, mode: '100644', oid: oid(n) }]));
const w = (writer: string, blob: OidOrAbsent): IncomingWriter => ({ writer, name: `name of ${writer}`, blob });

test('mergeIncomingWriters keeps a kept writer the read does not name while its path still has A ≠ TIP at the same TIP blob, and an empty read keeps every such entry', () => {
  // con.py: not applicable (A lacks it, TIP has blob 2), read at an earlier apply; README.md: this read's unrelated commit.
  const A = tree({ 'README.md': 1 });
  const TIP = tree({ 'README.md': 3, 'con.py': 2 });
  const kept = new Map([['con.py', w('p1', oid(2))]]);
  const out = mergeIncomingWriters(kept, new Map([['README.md', w('p2', oid(3))]]), A, TIP);
  assert.deepEqual([...out].sort(), [['README.md', w('p2', oid(3))], ['con.py', w('p1', oid(2))]]);
  assert.deepEqual([...mergeIncomingWriters(kept, new Map(), A, TIP)], [['con.py', w('p1', oid(2))]], 'an empty read (LA_C === TIP) drops nothing');
  assert.deepEqual([...kept], [['con.py', w('p1', oid(2))]], 'the kept map is not changed in place');
});

test('mergeIncomingWriters takes the read\'s writer over a kept one, drops a kept writer when the read\'s newest commit for the path carries no valid Cowork-Writer, and drops an entry whose blob is no longer TIP[p]', () => {
  const A = tree({ 'a.txt': 1, 'b.txt': 1, 'c.txt': 1 });
  const TIP = tree({ 'a.txt': 5, 'b.txt': 6, 'c.txt': 7 });
  const kept = new Map([['a.txt', w('old', oid(4))], ['b.txt', w('old', oid(6))], ['c.txt', w('old', oid(9))]]);
  // a.txt: a newer commit by p2 (inside the read); b.txt: the read's newest commit for it has no valid writer (null) — the older
  // writer must not stand in, even though TIP[b.txt] is the blob it saw; c.txt: TIP moved past the kept blob without this read naming it.
  const out = mergeIncomingWriters(kept, new Map<string, IncomingWriter | null>([['a.txt', w('p2', oid(5))], ['b.txt', null]]), A, TIP);
  assert.deepEqual([...out], [['a.txt', w('p2', oid(5))]]);
});

test('mergeIncomingWriters drops every entry whose path has A === TIP (applied, or deleted on both sides), so the map holds only the A ≠ TIP paths and the last read', () => {
  const A = tree({ 'applied.txt': 2, 'pending.txt': 1 });
  const TIP = tree({ 'applied.txt': 2, 'pending.txt': 3 });
  const kept = new Map([['applied.txt', w('p1', oid(2))], ['pending.txt', w('p1', oid(3))], ['gone.txt', w('p1', ABSENT)]]);
  const out = mergeIncomingWriters(kept, new Map([['also-applied.txt', w('p2', ABSENT)]]), A, TIP);
  assert.deepEqual([...out], [['pending.txt', w('p1', oid(3))]], 'gone.txt and also-applied.txt: absent on both sides; applied.txt: A === TIP');
});
