// Final review F13 round 2 (E-1, E-2) end to end: a teammate pushes a board tip whose held/ passes fetch.fsckObjects and the
// plain §3.1 sum but that no reader may expand — a held/ tree bomb behind directory modes of more than 17 octal digits (git
// keeps the low 32 bits: a tree; a whole-string JS parse saw none), and a held/ whose tree paths are longer than any valid
// held path (100 levels of 4,000-byte names over 1,500 blobs: under the sum, but an `ls-tree -r` of it is ~600 MB and threw
// ERR_STRING_TOO_LONG from mirrorSync's heldOfTip, which ended runLoop). The other peer must refuse the tip as a board_shape
// incident (board_too_large), never throw, and stay so on the next fetch. makeCores({n: 2}); real git on file:// clones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_SUBJECT, boardTrailers } from '../../src/board/boardCommit.js';
import { newEpoch, newPeerId } from '../../src/board/ids.js';
import { prepareIteration } from '../../src/engine/core.js';
import { RELEASE_NAMESPACE, refNames } from '../../src/engine/refs.js';
import { fetchRefs } from '../../src/git/fetch.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { pushSpec, runPush } from '../../src/git/push.js';
import type { GitRepo, MktreeEntry } from '../../src/git/repo.js';
import { seededRandom } from '../../src/ports/random.js';
import type { CoreFixture, PeerFixture } from '../helpers/coreFixture.js';
import { buf, withCores } from '../helpers/publishHelpers.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const FILES: Record<string, Buffer> = { 'README.md': buf('# board caps\n'), 'src/a.txt': buf('a\n') };
const ulid = (i: number): string => `01J9ZQ3C5X${String(i).padStart(16, '0')}`;

/** A tree object written verbatim (`hash-object -t tree --literally`), so each entry keeps the exact mode bytes given. */
async function rawTree(repo: GitRepo, entries: ReadonlyArray<{ mode: string; name: string; oid: Oid }>): Promise<Oid> {
  const sorted = [...entries].sort((a, c) => Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(c.name, 'utf8')));
  const body = Buffer.concat(sorted.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`, 'latin1'), Buffer.from(e.oid, 'hex')]));
  return (await repo.run(['hash-object', '-w', '-t', 'tree', '--literally', '--stdin'], { stdin: body })).stdout.toString('utf8').trim() as Oid;
}

/** Peer p forges one board commit on the fetched tip whose held/ is `mkHeld`'s tree (everything else carried) and pushes it. */
async function pushHeldTip(fx: CoreFixture, p: PeerFixture, mkHeld: (repo: GitRepo) => Promise<Oid>): Promise<Oid> {
  const repo = p.core.repo;
  const refs = refNames('main', RELEASE_NAMESPACE);
  const f = await fetchRefs(repo, fx.remote.url, refs.fetchSpecs);
  const T = f.values.get(refs.remoteBoard);
  assert.ok(T !== undefined && T !== ABSENT, 'the board tip is fetched');
  const commit = await repo.readCommit(T);
  const liveTip = commit.parents[commit.parents.length - 1]!;
  const held = await mkHeld(repo);
  const recs = (await repo.run(['ls-tree', '-z', commit.tree])).stdout.toString('utf8').split('\0').filter((s) => s.length > 0);
  const top = recs.map((rec): MktreeEntry => {
    const tab = rec.indexOf('\t');
    const [mode = '', type = '', oid = ''] = rec.slice(0, tab).split(' ');
    return { name: rec.slice(tab + 1), mode: mode as MktreeEntry['mode'], type: type as MktreeEntry['type'], oid: oid as Oid };
  }).filter((e) => e.name !== 'held');
  const tree = await repo.mktree([...top, { name: 'held', mode: '040000', type: 'tree', oid: held }]);
  const rnd = seededRandom('caps-forger');
  const board = await repo.commitTree({ tree, parents: [T, liveTip], subject: BOARD_SUBJECT, trailers: boardTrailers({ peer: newPeerId(rnd), epoch: newEpoch(rnd), seq: 4 }, [], new Map()) });
  const out = await runPush(repo, fx.remote.url, [pushSpec(board, refs.remoteBoard, T)], []);
  assert.equal(out.statuses.get(refs.remoteBoard), 'ok', 'the forged board pushed (fetch.fsckObjects admits it)');
  return board;
}

const SHAPES: Record<string, (repo: GitRepo) => Promise<Oid>> = {
  /** 50 ULID edges with mode 8^25 + 0o40000 over one h0 → 100 dirs → 100 blobs: 500,000 entries, a §3.1 sum over the cap. */
  'overflowing directory mode': async (repo) => {
    const x = await repo.hashBytes(buf('x\n'), true);
    const t3 = await repo.mktree(Array.from({ length: 100 }, (_, i) => ({ name: `f${String(i).padStart(5, '0')}`, mode: '100644', type: 'blob', oid: x } as MktreeEntry)));
    const t2 = await repo.mktree(Array.from({ length: 100 }, (_, i) => ({ name: `d${String(i).padStart(5, '0')}`, mode: '040000', type: 'tree', oid: t3 } as MktreeEntry)));
    const t1 = await repo.mktree([{ name: 'h0', mode: '040000', type: 'tree', oid: t2 }]);
    return rawTree(repo, Array.from({ length: 50 }, (_, i) => ({ mode: '10000000000000000000040000', name: ulid(i), oid: t1 })));
  },
  // (A held/ deeper than git's own core.maxTreeDepth cannot even be pushed here: the forger's push of a 2,101-level held/ is
  // rejected, so the depth caps are covered on the read side in boardCommit.held.test.ts, E-2.)
  /** 100 levels of 4,000-byte names over 1,500 blobs under held/<id>/h0: ~450 KB of tree objects, 400 KB tree paths. */
  'tree paths past the longest valid held path': async (repo) => {
    const x = await repo.hashBytes(buf('x\n'), true);
    let t = await repo.mktree(Array.from({ length: 1_500 }, (_, i) => ({ name: `f${String(i).padStart(5, '0')}`, mode: '100644', type: 'blob', oid: x } as MktreeEntry)));
    for (let d = 0; d < 100; d++) t = await repo.mktree([{ name: String(d % 10).repeat(4_000), mode: '040000', type: 'tree', oid: t }]);
    const t1 = await repo.mktree([{ name: 'h0', mode: '040000', type: 'tree', oid: t }]);
    return repo.mktree([{ name: ulid(0), mode: '040000', type: 'tree', oid: t1 }]);
  },
};

for (const [shape, mkHeld] of Object.entries(SHAPES)) {
  test(`E-1 end-to-end (${shape}): the other peer refuses the tip as a board_shape incident, never throws, and stays so on the next fetch`, T10, async () => {
    await withCores(`caps-${shape.split(' ')[0]}`, { n: 2, files: FILES }, async (fx) => {
      const tip = await pushHeldTip(fx, fx.peers[0]!, mkHeld);
      const q = fx.peers[1]!;
      for (const n of [1, 2]) {
        let threw: unknown = null;
        let r: Awaited<ReturnType<typeof prepareIteration>> | undefined;
        try {
          r = await prepareIteration(q.core, n, { materialize: 'auto', forceFetch: true });
        } catch (e) {
          threw = e;
        }
        assert.equal(threw, null, `iteration ${n}: preparing it never throws`);
        assert.ok(r !== undefined && !r.ok && r.why === 'incident', `iteration ${n}: an incident, not a fold: ${JSON.stringify(r).slice(0, 300)}`);
        assert.equal(r.verdict.why, 'board_shape', `iteration ${n}: the held/ the readers refuse reads as board_shape`);
        assert.equal(r.T, tip, `iteration ${n}: observed the forged tip`);
      }
    });
  });
}
