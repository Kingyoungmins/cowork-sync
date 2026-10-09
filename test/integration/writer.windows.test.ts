// Glossary §26.1 W4 on a real Windows volume: a share-all reader (Node's fs.open: libuv opens with
// FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE) holding the target does not stop the two-phase writer
// (rename target -> .old, link .new -> target), and the reader keeps seeing the complete old bytes, never a partial
// file. Skips off Windows (the FaultFs share-read lock emulation covers the Excel-like holder on every OS).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { humanOnlyAttribution } from '../../src/engine/deps.js';
import { DiskEq } from '../../src/engine/diskEq.js';
import { Snapshotter } from '../../src/engine/snapshot.js';
import { RING_KEEP_MS, Writer, type WriteGroup } from '../../src/engine/writer.js';
import type { FilterSet } from '../../src/data/filters.js';
import { realFs } from '../../src/ports/fs.js';
import { nullLog } from '../../src/ports/log.js';
import { noTrace } from '../../src/ports/trace.js';
import { makeSnapFixture } from '../helpers/snapFixture.js';

const PEER = '0123456789abcdef0123456789abcdef';
const NO_FILTERS: FilterSet = { drivers: [], fingerprint: {}, overCap: null };

test('a share-all reader holding the target does not stop the two-phase write', {
  skip: process.platform === 'win32' ? false : 'Windows only (glossary §26.1 W4)',
}, async () => {
  const original = Buffer.from(`${'row of the shared file\r\n'.repeat(2_000)}`, 'utf8');
  const s = await makeSnapFixture('w-shareall', { files: { 'shared.txt': original, 'README.md': Buffer.from('r\n') } });
  try {
    const privateIndex = join(s.f.paths.coworkDir, 'main.index');
    const snap = new Snapshotter({
      repo: s.repo, fs: realFs, clock: s.clock, trace: noTrace, peer: PEER, privateIndex,
      scratch: { detect: join(s.tmp, 'detect.index'), canon: join(s.tmp, 'canon.index') },
      stage: s.stage, statCache: s.statCache, attribution: humanOnlyAttribution, filters: NO_FILTERS,
    });
    await snap.reseed((await s.repo.readCommit(s.head)).tree);
    const diskEq = new DiskEq({
      repo: s.repo, fs: realFs, stage: s.stage, statCache: s.statCache, cmpIndex: join(s.tmp, 'cmp.index'), addIndex: join(s.tmp, 'add.index'),
      isFiltered: () => false, isText: () => true, mutants: new Set(), filters: NO_FILTERS, isCarried: (p) => snap.isCarried(p),
    });
    assert.equal(await Writer.probeMode(realFs, s.tmp, s.f.paths.workTree), 'link', 'NTFS has hard links');
    const writer = new Writer({
      repo: s.repo, fs: realFs, clock: s.clock, scheduler: { schedule: () => {}, yieldPoint: async () => {} }, trace: noTrace, log: nullLog, peer: PEER,
      workTree: s.f.paths.workTree, tmpDir: s.tmp, privateIndex, stage: s.stage, statCache: s.statCache, diskEq, snapshot: snap, mode: 'link',
      isFiltered: () => false, isText: () => true,
      journal: async () => {}, frozen: () => false, onPhantom: async () => {}, onLateWrite: async () => {},
    });
    let current = s.A.get('shared.txt')!;
    for (let i = 1; i <= 3; i++) {
      const bytes = Buffer.concat([original, Buffer.from(`apply ${i}\r\n`, 'utf8')]);
      const target = { path: 'shared.txt', mode: '100644' as const, oid: await s.repo.hashBytes(bytes, true) };
      const g: WriteGroup = { n: 0, entries: [{ path: 'shared.txt', kind: 'modify', slot: 0, target, sRaw: current, sDisk: current }] };
      const before = await fsp.readFile(s.abs('shared.txt'));
      const reader = await fsp.open(s.abs('shared.txt'), 'r');
      try {
        const [r] = await writer.applyGroups([g], async () => null);
        assert.deepEqual([r?.outcome, r?.reason], ['written', null], `apply ${i} with a share-all reader`);
        // The reader's handle still reads the complete old file (now the .old in the ring).
        const seen = Buffer.alloc(before.length);
        const { bytesRead } = await reader.read(seen, 0, seen.length, 0);
        assert.equal(bytesRead, before.length);
        assert.ok(seen.equals(before), 'the held handle sees the whole old file, never a partial one');
      } finally {
        await reader.close();
      }
      assert.ok((await fsp.readFile(s.abs('shared.txt'))).equals(bytes), `apply ${i} is on disk`);
      current = target;
    }
    s.clock.advance(RING_KEEP_MS);
    await writer.sweepRing();
    assert.deepEqual((await fsp.readdir(s.tmp)).filter((n) => /\.(old|new|redo)$/.test(n)), [], 'the ring deleted every .old once the reader closed');
  } finally {
    await s.cleanup();
  }
});
