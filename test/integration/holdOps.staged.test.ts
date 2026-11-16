// Plan 3 Task 5, the staged and attributed side of the hold operators (01-engine §3.8 (c), §3.11, ENG-37; glossary §26.1 W1,
// W6; HLD-26 (b); rulings R3-34, R3-36, R3-60; D-24, D-26, P-DAT-05 operator slice; 05 B4): materialization for hold-record
// occasions, the attributed recording of every operator write, the record-before-displacement order, and the git argv the
// operators spawn. Real git on file:// clones; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { prepareIteration, type IterationCtx } from '../../src/engine/core.js';
import { collisionTake, markersPark, park as park_, restore } from '../../src/engine/holdOps.js';
import { restart } from '../../src/engine/restart.js';
import { ABSENT, type OidOrAbsent } from '../../src/git/oid.js';
import { gitCallsOf, makeCores, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { blob, nr, pair, prepIt, stages, withPeers } from '../helpers/holdOpsFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { restartCore } from '../helpers/startFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const P = 'src/t9.txt';
const U = 'src/u9.txt';
const M = 'src/m9.txt';
const ENV = '.env';
const FILES: Record<string, Buffer> = { 'README.md': Buffer.from('# hold ops\n', 'utf8'), [P]: Buffer.from(T9, 'utf8'), 'src/other.txt': Buffer.from('other\n', 'utf8') };

let n = 0;

async function withPeer(label: string, fn: (fx: CoreFixture, p: PeerFixture) => Promise<void>): Promise<void> {
  const fx = await makeCores(label, { n: 1, files: FILES });
  try {
    await fx.bootstrap();
    await fn(fx, fx.peers[0]!);
  } finally {
    await fx.cleanup();
  }
}

async function prepHold(p: PeerFixture, holdPaths?: ReadonlySet<string>): Promise<IterationCtx> {
  const r = await prepareIteration(p.core, ++n, { materialize: 'auto', forceFetch: false, ...(holdPaths !== undefined ? { holdPaths } : {}) });
  assert.ok(r.ok, JSON.stringify(r));
  return r.it;
}

async function looseCount(p: PeerFixture): Promise<number> {
  const out = (await p.core.repo.run(['count-objects', '-v'])).stdout.toString('utf8');
  return Number(/^count: (\d+)$/m.exec(out)![1]);
}

test('holdPaths materializes exactly those paths and a detection tick writes no object', T10, async () => {
  await withPeer('hold-paths', async (fx, p) => {
    await writeWork(p, P, t9([2, 'two']));
    await writeWork(p, 'src/other.txt', 'other, edited\n');
    const it = await prepHold(p, new Set([P]));
    assert.ok(it.mat !== null, 'a hold-record occasion materializes (W6 (c))');
    const e = it.mat.sDiskMap.get(P);
    assert.ok(e !== undefined && (await p.core.repo.hasObject(e.oid, 'blob')), 'S_disk[p] is an object');
    assert.equal((await p.core.repo.readBlob(e.oid)).toString('utf8'), t9([2, 'two']));
    const other = it.mat.sDiskMap.get('src/other.txt');
    assert.equal((await p.core.repo.readBlob(other!.oid)).toString('utf8'), 'other\n', 'only the hold paths were materialized');
    // A later iteration without holdPaths and nothing due: a detection tick, no object.
    await writeWork(p, P, t9([2, 'two'], [6, 'six']));
    const before = await looseCount(p);
    fx.advance(2_500);
    const it2 = await prepHold(p);
    assert.equal(it2.mat, null, 'nothing due: no materialization');
    assert.ok(it2.tick !== null && it2.tick.dirty.has(P));
    assert.equal(await looseCount(p), before, 'a detection tick writes no object');
  });
});

/** The operators' fixture: P with a held row 2 and a human row 6, a K4-restorable U, an ignored .env colliding with TIP's. */
const OPS_FILES: Record<string, Buffer> = {
  'README.md': Buffer.from('# hold ops\n', 'utf8'), '.gitignore': Buffer.from('.env\n', 'utf8'),
  [P]: Buffer.from(T9, 'utf8'), [U]: Buffer.from(T9, 'utf8'), [M]: Buffer.from(T9, 'utf8'),
};
const ROWS = '1\n<<<<<<< cowork:disk\nTWO\n||||||| cowork:base\n2\n=======\ntwo\n>>>>>>> cowork:held\n3\n4\n5\n6\n7\n8\n9\n';

interface Ops { park: string; markers: string; restore: string; take: string; collision: string; }

/**
 * The four operator writes on one peer, each in an iteration that materializes its paths: a PARK of an ACTIVE PATCH over P, a
 * markers park over M, a RESTORE of an OFF_DISK PATCH over U and the collision take of .env. `around` wraps each operator call.
 */
async function runOperators(fx: CoreFixture, p: PeerFixture, around: <T>(what: keyof Ops, fn: () => Promise<T>) => Promise<T>): Promise<{ ids: Ops; written: Record<string, OidOrAbsent> }> {
  await writeWork(p, P, t9([2, 'two'], [6, 'six']));
  await writeWork(p, M, ROWS);
  await writeWork(p, ENV, 'SECRET=local\n');
  await fx.pushTeamChange({ [ENV]: Buffer.from('SECRET=team\n', 'utf8') });
  const it = await prepIt(p, { holdPaths: [P, M, U], forceFetch: true });
  // An earlier transition took this S_disk into state:snap (as an apply's or a capture's update does), so a park's write changes it.
  await p.core.commit({ snap: it.mat!.sDisk });
  const t = it.A.get(P)!.oid;
  const park = await p.core.holds.hold(nr({ blobs: pair(t, await blob(p, t9([2, 'two']))) }));
  const markers = await p.core.holds.hold(nr({ paths: [M], guard: 'markers', origin: 'daemon', blobs: stages(t, await blob(p, t9([2, 'two'])), await blob(p, t9([2, 'team'])), M) }));
  const restoreId = await p.core.holds.hold(nr({ paths: [U], residence: 'OFF_DISK', state: 'PARKED', blobs: pair(t, await blob(p, t9([4, 'four'])), U) }));
  const collision = await p.core.holds.hold(nr({ kind: 'INCOMING', paths: [ENV], guard: 'collision', origin: 'daemon', blobs: pair(ABSENT, it.tipMap.get(ENV)!.oid, ENV) }));
  assert.deepEqual(await around('park', () => park_(p.core, it, park, { humanEvidence: false, displacedBy: null, refreshMustBeDurable: false })), { kind: 'PARKED', companion: null });
  assert.equal((await around('markers', () => markersPark(p.core, it, markers, { humanEvidence: false, displacedBy: null }))).kind, 'PARKED');
  assert.deepEqual(await around('restore', () => restore(p.core, it, restoreId, { humanEvidence: false, actor: 'human' })), { kind: 'RESTORED', markers: false });
  assert.equal(await around('take', () => collisionTake(p.core, it, collision)), 'WRITTEN');
  return {
    ids: { park, markers, restore: restoreId, take: collision, collision },
    written: { [P]: await blob(p, t9([6, 'six'])), [M]: t, [U]: await blob(p, t9([4, 'four'])), [ENV]: it.tipMap.get(ENV)!.oid },
  };
}

test('every operator write is recorded as attributed, and a park\'s also survives a restart', T10, async () => {
  await withPeers('ops-attributed', { files: OPS_FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const order: string[] = [];
    // Every state transition's keys, in order (the writer's intent journal and clear, and the snap-only transition).
    const transitions: string[] = [];
    const commit = p.core.commit.bind(p.core);
    p.core.commit = (t) => {
      transitions.push(Object.keys(t).sort().join('+'));
      return commit(t);
    };
    const { written } = await runOperators(fx, p, async (what, fn) => {
      const from = gitCallsOf(p).length;
      const t0 = transitions.length;
      const out = await fn();
      if (what === 'park' || what === 'markers') {
        // R3-60: one snap-only state commit, after the write and before the registry's final commit (EF2 fix round 1, F3: it also
        // journals the written entries in journal/keep/op_snap, so its keys are keep+snap).
        const keys = transitions.slice(t0);
        let k = 0;
        const cas = gitCallsOf(p).slice(from).filter((c) => c.args[0] === 'update-ref')
          .map((c) => (c.args.includes(p.core.refs.holds) ? 'holds' : c.args.includes(p.core.refs.state) ? `state(${keys[k++] ?? '?'})` : 'other'));
        order.push(`${what}:${cas.join(',')}`);
      }
      return out;
    });
    assert.deepEqual(order, [
      'park:holds,state(intent+keep),state(intent+keep),state(keep+snap),holds',
      'markers:holds,state(intent+keep),state(intent+keep),state(keep+snap),holds',
    ]);
    const parked = [P, M];
    // Final review F1: every write is recorded as observed (R3-36); a park's and a markers park's are forgotten once their private-index
    // entry holds them (parkWritten) — never a materialized delta, so a lingering entry would let a later stale save of the same blob pass
    // as observed. The restore's and the take's stay until their delta materializes (revertStep consumes them).
    for (const [path, oid] of Object.entries(written)) {
      assert.equal(p.core.observed.peek(path, oid), !parked.includes(path), `${path}: ${parked.includes(path) ? 'no lingering observed entry (F1)' : 'an observed write'}`);
    }
    const index = await p.core.repo.listIndex(join(p.deps.paths.coworkDir, `${p.core.refs.e}.index`));
    const snap = await p.core.repo.readTreeMap(p.core.view!.snap);
    for (const path of parked) {
      assert.equal(index.get(path)?.oid, written[path], `${path}: the private-index entry is the written blob`);
      assert.equal(snap.get(path)?.oid, written[path], `${path}: state:snap's entry is the written blob`);
    }
    fx.advance(2_500);
    const it = await prepIt(p, { materialize: false });
    for (const path of parked) {
      assert.equal(it.tick?.changed.has(path), false, `${path}: not changed at the next tick`);
      assert.equal(it.tick?.dirty.has(path), false, `${path}: not dirty`);
    }
    // After a restart on a fresh core: ObservedWrites is empty and the private index is reseeded from state:snap.
    await restartCore(p);
    await restart(p.core);
    for (const path of parked) assert.equal(p.core.observed.peek(path, written[path]!), false, 'a fresh core observed nothing');
    fx.advance(2_500);
    const it2 = await prepIt(p, { materialize: false });
    for (const path of parked) {
      assert.equal(it2.tick?.changed.has(path), false, `${path}: not changed after the restart`);
      assert.equal(it2.tick?.dirty.has(path), false, `${path}: not dirty after the restart`);
    }
  });
});

test('05 B4: no git process names a working file during RESTORE, the markers park or a collision capture', T10, async () => {
  await withPeers('ops-b4', { files: OPS_FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const work = p.deps.paths.workTree;
    const stageRoot = join(p.deps.paths.coworkDir, 'tmp', 'stage');
    const checked: string[] = [];
    await runOperators(fx, p, async (what, fn) => {
      const from = gitCallsOf(p).length;
      const out = await fn();
      if (what === 'park') return out;
      checked.push(what);
      for (const c of gitCallsOf(p).slice(from)) {
        const args = c.args;
        for (const [i, a] of args.entries()) {
          const lower = a.toLowerCase();
          for (const path of [P, M, U, ENV]) {
            const abs = join(work, ...path.split('/')).toLowerCase();
            assert.ok(!lower.includes(abs), `${what}: git ${args[0]} names the work-tree file ${path}: ${JSON.stringify(args)}`);
          }
          if (a.startsWith('--path=')) assert.equal(args[0], 'hash-object', `${what}: --path only on hash-object: ${JSON.stringify(args)}`);
          if (args[0] === 'hash-object' && args[i - 1] === '--') assert.ok(a.startsWith(stageRoot), `${what}: hash-object reads a stage copy: ${a}`);
        }
        if (c.opts.workTree !== undefined) assert.equal(c.opts.workTree, stageRoot, `${what}: a work tree is only tmp/stage: ${JSON.stringify(args)}`);
      }
      return out;
    });
    assert.deepEqual(checked, ['markers', 'restore', 'take']);
  });
});

test('every Plan 3 disk write goes through writeLocal with its operator\'s origin', T10, async () => {
  await withPeers('ops-origins', { files: OPS_FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const w = p.core.writer;
    const inner = w.writeLocalGroup.bind(w);
    const origins: string[] = [];
    const windows: Array<[number, number]> = [];
    w.writeLocalGroup = async (entries, origin, humanEvidence) => {
      origins.push(origin);
      const from = p.fs.calls.length;
      try {
        return await inner(entries, origin, humanEvidence);
      } finally {
        windows.push([from, p.fs.calls.length]);
      }
    };
    const spans: Array<[number, number]> = [];
    const { ids } = await runOperators(fx, p, async (_what, fn) => {
      const from = p.fs.calls.length;
      const out = await fn();
      spans.push([from, p.fs.calls.length]);
      return out;
    });
    const capture = p.core.holds.all().find((h) => h.paths.includes(ENV) && h.kind === 'PATCH')!;
    assert.deepEqual(origins, [`park:${ids.park}`, `markers_park:${ids.markers}`, `restore:${ids.restore}`, `take:${capture.id}`]);
    const work = p.deps.paths.workTree;
    const gitDir = p.deps.paths.gitDir;
    const WRITES = /^(writeFile|rename|link|unlink|writeFileExclusive|rmdir|appendFile|chmod) /;
    for (const [from, to] of spans) {
      p.fs.calls.slice(from, to).forEach((c, k) => {
        if (!WRITES.test(c)) return;
        const target = c.replace(WRITES, '');
        const underWork = target.startsWith(work) && !target.startsWith(gitDir);
        if (!underWork) return;
        const at = from + k;
        assert.ok(windows.some(([a, b]) => at >= a && at < b), `a work-tree write outside writeLocal: ${c}`);
      });
    }
  });
});
