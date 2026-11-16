// The undo view, revertView (Plan 3 Task 17; 05-holds Algorithm REV in view mode, §8 Q17 (a); FEAT-F10-10, CCI-68, INV-UX-READONLY;
// 11-testing TC-F10-12 data half): Plan 5's RevertView shape — -U3 diffs of stored forms computed in-process, human kinds, kept and
// skip rows, CHANGED_NOW — and a view that writes nothing. Real clones; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { revertView, type RevertHost } from '../../src/holds/revertCs.js';
import { gitCallsOf, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { buf, lines, prep, remoteBoard, remoteCode, withCores } from '../helpers/publishHelpers.js';
import { announce, applyNow, csTrailer, humanCs, pushAs, T10 } from '../helpers/revertFixture.js';
import { testRunner } from '../helpers/tmp.js';

const E2 = 'e2'.repeat(16);
const SEAT = '6'.repeat(32);

/** a.txt of TC-F10-02 (see revertCs.inverse): 40 rows, row 12 `x = <v>`, and (add30) the row the CS added after row 29. */
function a40(v: string, add30: boolean): string {
  const out: string[] = [];
  for (let i = 1; i <= 40; i++) {
    out.push(i === 12 ? `x = ${v}` : `row ${i} of a.txt`);
    if (add30 && i === 29) out.push('line 30 the CS added');
  }
  return out.map((r) => `${r}\n`).join('');
}

const FILES: Record<string, Buffer> = {
  'a.txt': buf(a40('1', false)), 'o.txt': buf(lines(10, (i) => `o.txt keeps row ${i}`)), 'd.txt': buf(lines(8, (i) => `d ${i}`)),
  'flt.txt': buf(lines(6, (i) => `flt ${i}`)), 'late.bin': Buffer.from([1, 0, 2, 0, 3]), 'img.bin': Buffer.from([0x89, 0x50, 0x00, 0x01]),
  'm.sh': buf('#!/bin/sh\necho m\n'),
};

async function looseCount(p: PeerFixture): Promise<number> {
  const r = await testRunner().run(['count-objects', '-v'], { class: 'local', cwd: p.deps.paths.workTree });
  return Number(/^count: (\d+)$/m.exec(r.stdout.toString('utf8'))![1]);
}

/** Every file under a directory, relative (recursively); [] when it is missing. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, rel: string): Promise<void> => {
    let names: import('node:fs').Dirent[];
    try {
      names = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      if (n.isDirectory()) await walk(join(d, n.name), `${rel}${n.name}/`);
      else out.push(`${rel}${n.name}`);
    }
  };
  await walk(dir, '');
  return out.sort();
}

test('revertView returns Plan 5\'s RevertView shape: -U3 stored-form diffs for in-file text changes, human kinds for created, deleted, binary, mode-changed and filtered paths, kept rows and skip reasons, and CHANGED_NOW for a path changed since the last materialization', T10, async () => {
  await withCores('rev-view', { n: 2, files: FILES }, async (fx) => {
    const [p, q] = [fx.peers[0]!, fx.peers[1]!];
    const cs = await humanCs(fx, p, {
      'a.txt': a40('2', true), 'n.txt': lines(4, (i) => `n.txt created row ${i}`), 'o.txt': null, 'img.bin': Buffer.from([0x89, 0x50, 0x00, 0x02]),
      'late.bin': Buffer.from([1, 0, 2, 0, 4]), 'd.txt': lines(8, (i) => `d ${i}${i === 2 ? ' CS' : ''}`), 'flt.txt': lines(6, (i) => `flt ${i}${i === 5 ? ' CS' : ''}`),
    });
    // The teammate sets row 12 to x = 3 (a kept region) and changes late.bin (a binary changed later).
    await announce(q);
    await applyNow(fx, q);
    await humanCs(fx, q, { 'a.txt': a40('3', true), 'late.bin': Buffer.from([1, 0, 2, 0, 5]) });
    await applyNow(fx, p);
    await prep(p, true);
    // d.txt is edited on disk after the last materialization: CHANGED_NOW, no diff.
    await writeWork(p, 'd.txt', lines(8, (i) => `d ${i}${i === 2 ? ' CS' : ''}${i === 7 ? ' later' : ''}`));
    // flt.txt stands for a filtered path (the fixture's clones carry no filter driver): the host reports its attribute.
    const host: RevertHost = {
      ...p.core,
      revertPaths: async (ps) => {
        const f = await p.core.revertPaths(ps);
        return (x) => (x === 'flt.txt' ? { ...f(x), filtered: true } : f(x));
      },
    };
    const v = await revertView(host, cs.csId);
    assert.equal(v.kind, 'view');
    assert.deepEqual(v.summary, { cs: cs.csId, commits: 1, paths: 5, kept: 1, skipped: 2 });
    assert.deepEqual(v.paths, [
      {
        path: 'a.txt', diff: '@@ -27,7 +27,6 @@\n row 27 of a.txt\n row 28 of a.txt\n row 29 of a.txt\n-line 30 the CS added\n row 30 of a.txt\n row 31 of a.txt\n row 32 of a.txt\n',
      },
      { path: 'd.txt', skip: 'CHANGED_NOW' },
      { path: 'flt.txt', human: 'filtered' },
      { path: 'img.bin', human: 'binary' },
      { path: 'late.bin', skip: 'FILE_CHANGED_LATER' },
      { path: 'n.txt', human: 'created' },
      { path: 'o.txt', human: 'deleted' },
    ]);
    assert.deepEqual(v.kept, [{ path: 'a.txt', line: 12 }]);
    assert.equal(v.candidates, undefined);

    // A mode-only change of another CS (crafted under a retired epoch of this peer): one `mode` row, never a diff.
    const mcs = `${SEAT}/1`;
    await pushAs(fx, p, { epoch: E2, seq: 1, cs: [csTrailer(mcs, 1)], csPaths: new Map([[mcs, ['m.sh']]]), changes: { 'm.sh': FILES['m.sh']! }, modes: { 'm.sh': '100755' } });
    await applyNow(fx, p);
    await prep(p, true);
    const m = await revertView(p.core, mcs);
    assert.equal(m.kind, 'view', JSON.stringify(m));
    assert.deepEqual(m.paths, [{ path: 'm.sh', human: 'mode' }]);
  });
});

test('a teammate\'s CS gives kind notown with only the summary, an ambiguous id gives candidates, and a view writes no object, no file, no last_check and no registry, state or board change', T10, async () => {
  await withCores('rev-view-ro', { n: 2, files: FILES }, async (fx) => {
    const [p, q] = [fx.peers[0]!, fx.peers[1]!];
    const own = await humanCs(fx, p, { 'a.txt': a40('2', true), 'n.txt': 'created\n' });
    await announce(q);
    const team = await humanCs(fx, q, { 'd.txt': lines(8, (i) => `d ${i}${i === 6 ? ' TEAM' : ''}`) });
    await applyNow(fx, p);
    await prep(p, true);
    assert.deepEqual(await revertView(p.core, team.csId), { kind: 'notown', summary: { cs: team.csId, writer: 'Peer p2' }, paths: [], kept: [] });
    assert.deepEqual(await revertView(p.core, `${p.core.peerId}/human/99`), { kind: 'unknown', summary: { cs: `${p.core.peerId}/human/99` }, paths: [], kept: [] });

    // Nothing written by a view: objects, files (the work tree, the cowork directory, tmp/stage), last_check, the registry, the state, the board.
    const coworkFiles = await filesUnder(p.deps.paths.coworkDir);
    const work = await filesUnder(p.deps.paths.workTree);
    const objects = await looseCount(p);
    const registry = p.core.holds.head();
    const state = await p.core.repo.readRef(p.core.refs.state);
    const view = p.core.view;
    const [board, code] = [await remoteBoard(fx, p), await remoteCode(fx, p)];
    const fsBefore = p.fs.calls.length;
    const gitBefore = gitCallsOf(p).length;
    const v = await revertView(p.core, own.csId);
    assert.equal(v.kind, 'view', JSON.stringify(v));
    assert.deepEqual(v.paths.map((x) => x.path), ['a.txt', 'n.txt']);
    assert.deepEqual(p.fs.calls.slice(fsBefore).filter((c) => /^(writeFile|writeFileExclusive|rename|link|unlink|appendFile|mkdirp|chmod|rmdir) /.test(c)), [], 'no file write');
    assert.ok(!gitCallsOf(p).slice(gitBefore).some((c) => ['hash-object', 'write-tree', 'mktree', 'commit-tree', 'update-index', 'update-ref', 'read-tree', 'add', 'push', 'fetch'].includes(c.args[0]!)),
      JSON.stringify(gitCallsOf(p).slice(gitBefore).map((c) => c.args.slice(0, 2))));
    assert.equal(await looseCount(p), objects, 'no loose object');
    assert.deepEqual(await filesUnder(p.deps.paths.coworkDir), coworkFiles, 'no file under the cowork directory (tmp/stage included)');
    assert.deepEqual(await filesUnder(p.deps.paths.workTree), work);
    assert.equal(p.core.cs.lastCheck.get(own.csId), null, 'no last_check');
    assert.equal(p.core.holds.head(), registry, 'no registry commit');
    assert.equal(await p.core.repo.readRef(p.core.refs.state), state, 'no state commit');
    assert.equal(p.core.view, view);
    assert.deepEqual([await remoteBoard(fx, p), await remoteCode(fx, p)], [board, code], 'no board change');

    // An ambiguous id: candidates, qualified (the same id under a retired epoch of this peer).
    await pushAs(fx, p, { epoch: E2, seq: 1, cs: [csTrailer(own.csId, 1)], csPaths: new Map([[own.csId, ['o.txt']]]), changes: { 'o.txt': 'E2\n' } });
    await applyNow(fx, p);
    const amb = await revertView(p.core, own.csId);
    assert.equal(amb.kind, 'ambiguous');
    assert.deepEqual([...amb.candidates!].sort(), [`${own.csId}@${p.core.view!.meta.epoch.slice(0, 8)}`, `${own.csId}@${E2.slice(0, 8)}`].sort());
    assert.deepEqual(amb.paths, []);
  });
});
