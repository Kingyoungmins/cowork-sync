// The O-STATE plant and the board-rewind plants of the resurrection checks and of INV-NOLOSS's pre-mirror window (Plan 3 Task 16 and its
// fix round 1; 11-testing §3.4, TST-06; INV-ENG-STATE; INV-NOLOSS's R3-64 clause and registry location; the crash matrix's
// MATRIX-DELETION; F-BR-3). Real git against file:// bare remotes; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RELEASE_NAMESPACE } from '../../src/engine/refs.js';
import type { Oid } from '../../src/git/oid.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { has, holdsOf, live, play, SIM_TIMEOUT, until, type Step } from '../helpers/holdsScript.js';
import { dropScratch, g, judge, liveRewritten, REFS, scratchRemote, traceView, viewOf, withoutRow } from '../helpers/nolossPlants.js';
import { dropArtifacts } from '../helpers/simOps.js';
import { deletionOracle, revertSetup, type RowDeletion } from '../sim/crashMatrix.js';
import { holdsSetup } from '../sim/generators.js';
import { runSim, type Oracle, type SimContext } from '../sim/harness.js';
import { readBlob } from '../sim/holdsView.js';
import { findMarkers, MarkerModel } from '../sim/markers.js';
import { locateMarker, oracleNoloss, type NolossOracle } from '../sim/oracleNoloss.js';
import { oracleState } from '../sim/oracles.js';

// ---- O-STATE's plant -------------------------------------------------------------------------------------------------------------------

test('oracleState fails on a planted update-ref that moves a peer\'s state ref to a commit whose LA_C is not on the previous LA_C\'s first-parent chain, and on a reflog entry whose old value is not the previous new value', { timeout: 60 * 60_000 }, async () => {
  const s = holdsSetup('holds-ostate', { script: [] });
  const facts = new Map<string, string | null>();
  // The run's own oracleState judges every step before the plants (the plants are judged by fresh instances).
  let planting = false;
  const own = oracleState();
  const untilPlants = { name: own.name, afterEveryOp: (ctx: SimContext) => (planting ? Promise.resolve(null) : own.afterEveryOp!(ctx)) };
  const steps: Step[] = [
    ...revertSetup('own/os-p0.txt'),
    { rounds: 12 },
    {
      probe: 'plants', run: async (ctx) => {
        facts.set('clean', await oracleState().afterEveryOp!(ctx));
        planting = true;
        const git = async (i: number, args: string[]): Promise<string> => {
          const r = await ctx.git.run(args, { class: 'local', cwd: ctx.peers[i]!.dir });
          assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr.toString('utf8')}`);
          return r.stdout.toString('utf8').trim();
        };
        const ref = 'refs/cowork-local/main/state';
        // (i) on p1: a reflog line whose old value is not the previous line's new value (the ref itself unchanged).
        const cur1 = await git(1, ['rev-parse', ref]);
        const [laC1] = (await git(1, ['rev-list', '--parents', '-n', '1', cur1])).split(' ').slice(1);
        await appendFile(join(ctx.peers[1]!.dir, '.git', 'logs', ...ref.split('/')), `${laC1} ${cur1} planted <planted@cowork.invalid> 1700000000 +0000\tplanted\n`);
        facts.set('reflog', await oracleState().afterEveryOp!(ctx));
        // (iii) on p0: a CAS update-ref (reflog chain intact) to a commit with p0's state tree whose LA_C is the previous LA_C's parent.
        const cur0 = await git(0, ['rev-parse', ref]);
        const [laC0, laB0] = (await git(0, ['rev-list', '--parents', '-n', '1', cur0])).split(' ').slice(1);
        const back = await git(0, ['rev-parse', `${laC0}^`]);
        const planted = await git(0, ['commit-tree', `${cur0}^{tree}`, '-p', back, '-p', laB0!, '-m', 'planted state']);
        await git(0, ['update-ref', '--create-reflog', '-m', 'planted', ref, planted, cur0]);
        facts.set('laC', await oracleState().afterEveryOp!(ctx));
        facts.set('laC0', laC0!);
        facts.set('back', back);
      },
    },
  ];
  const r = await runSim({ ...s.tuple, ops: steps.length }, s.factory, [untilPlants], { ...s.options, generator: play(steps, s.markers), quiescence: undefined });
  assert.ok(r.ok, `the run's own oracleState passes until the plants: ${JSON.stringify(r.failure)}`);
  await dropArtifacts(r);
  assert.equal(facts.get('clean'), null, 'a fresh oracleState passes on the run as it is');
  assert.match(facts.get('reflog') ?? '', /^O-STATE \(i\) p1: reflog entry \d+ of refs\/cowork-local\/main\/state moves [0-9a-f]{40} -> [0-9a-f]{40}, but the previous entry left it at [0-9a-f]{40} \(not a CAS chain\)$/);
  assert.match(facts.get('laC') ?? '', new RegExp(`^O-STATE \\(iii\\) p0: state [0-9a-f]{40} -> [0-9a-f]{40} moves LA_C ${facts.get('laC0')} -> ${facts.get('back')}, which does not have ${facts.get('laC0')} on its first-parent chain \\(not monotone\\)$`));
});

// ---- board rewinds in the resurrection checks ----------------------------------------------------------------------------------------

/**
 * The matrix's recover lead-ins rewind the remote board (F-BR-3's fault, server-side: INV-FF's business, never an engine push) after a
 * row deletion has landed: the rewound tip is a board both resurrection checks — INV-NOLOSS's R3-64 clause and MATRIX-DELETION — already
 * judged, and still holds the deleted row. Each check judges a board commit once; a commit a peer builds on the rewound board is new and
 * judged. The plant runs both on a scratch copy of the remote, one judgment per probe step (each probe is a new op, so a new check).
 */
function rewindSteps(markers: MarkerModel, facts: Map<string, unknown>): Step[] {
  const plant: { view: SimContext | null; dir: string | null; noloss: Oracle | null; del: Oracle | null; m: string; t0: string; code0: string; deletion: RowDeletion | null } = {
    view: null, dir: null, noloss: null, del: null, m: '', t0: '', code0: '', deletion: null,
  };
  const both = async (key: string): Promise<void> => {
    facts.set(key, [await judge(plant.noloss!, plant.view!), await judge(plant.del!, plant.view!)]);
  };
  return [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { insert: false } },
    { rounds: 12 },
    {
      probe: 'seen live', run: async (ctx) => {
        const e = [...ctx.opLog].reverse().find((x) => x.kind === 'edit_band' && x.peer === 'p1' && findMarkers(Buffer.from(x.detail, 'latin1')).length > 0);
        assert.ok(e !== undefined, 'p1 wrote a band row with a marker');
        plant.m = findMarkers(Buffer.from(e.detail, 'latin1')).pop()!;
        plant.dir = await scratchRemote(ctx, 'rewind');
        plant.view = viewOf(ctx, { remoteDir: plant.dir });
        const mm = new MarkerModel(markers.run);
        mm.noteEdit('p1', 'shared.txt', [plant.m], [], true, () => false);
        plant.noloss = oracleNoloss(mm, RELEASE_NAMESPACE);
        const deletions: RowDeletion[] = [];
        plant.del = deletionOracle({ deletions });
        facts.set('seen', await judge(plant.noloss, plant.view));
        // p1's informed removal of its row: retired in the plant's model, recorded as the matrix records a deletion.
        mm.noteEdit('p1', 'shared.txt', [], [plant.m], true, () => true);
        plant.t0 = await g(plant.dir, ['rev-parse', REFS.remoteBoard]);
        plant.code0 = await g(plant.dir, ['rev-parse', REFS.remoteCode]);
        plant.deletion = { afterKill: 0, killed: 'p0', author: 'p1', path: 'shared.txt', marker: plant.m, liveBefore: plant.code0, landedIn: null };
        deletions.push(plant.deletion);
        facts.set('m', plant.m);
      },
    },
    { probe: 'tip still holds it', run: async () => { await both('held'); } },
    {
      probe: 'the removal lands', run: async () => {
        await liveRewritten(plant.dir!, (path, bytes) => (path === 'shared.txt' ? withoutRow(bytes, plant.m) : undefined));
        await both('landed');
        facts.set('landedIn', plant.deletion!.landedIn);
      },
    },
    {
      probe: 'the host rewinds the board', run: async () => {
        const t1 = await g(plant.dir!, ['rev-parse', REFS.remoteBoard]);
        await g(plant.dir!, ['update-ref', REFS.remoteBoard, plant.t0, t1]);
        await g(plant.dir!, ['update-ref', REFS.remoteCode, plant.code0]);
        await both('rewound');
      },
    },
    { probe: 'still rewound', run: async () => { await both('rewound again'); } },
    {
      probe: 'a new commit on the rewound board keeps the row', run: async () => {
        await liveRewritten(plant.dir!, (path, bytes) => (path === 'shared.txt' ? Buffer.concat([bytes, Buffer.from('plant row\n', 'utf8')]) : undefined));
        await both('kept');
        await dropScratch(plant.dir!);
      },
    },
  ];
}

test('INV-NOLOSS\'s resurrection clause and MATRIX-DELETION judge each board commit once: a host rewind of the board back onto a judged commit still holding a deleted, retired row fails neither, while a new commit on the rewound board that keeps the row fails both', { timeout: SIM_TIMEOUT }, async () => {
  const s = holdsSetup('holds-rewind-judge', { script: [] });
  const facts = new Map<string, unknown>();
  const steps = rewindSteps(s.markers, facts);
  const r = await runSim({ ...s.tuple, ops: steps.length }, s.factory, [], { ...s.options, generator: play(steps, s.markers), quiescence: undefined });
  assert.ok(r.ok, JSON.stringify(r.failure));
  await dropArtifacts(r);
  const m = facts.get('m') as string;
  assert.equal(facts.get('seen'), null, 'the marker is live');
  assert.deepEqual(facts.get('held'), [null, null], 'a retired marker still in live_code is not a resurrection; the deletion has not landed');
  assert.deepEqual(facts.get('landed'), [null, null], 'the removal lands');
  assert.match(String(facts.get('landedIn')), /^[0-9a-f]{40}$/, 'MATRIX-DELETION saw it land');
  assert.deepEqual(facts.get('rewound'), [null, null], 'the host rewind is no resurrection: the rewound tip was judged before');
  assert.deepEqual(facts.get('rewound again'), [null, null], 'nor on the next check while the board stays rewound');
  const [noloss, del] = facts.get('kept') as [string | null, string | null];
  assert.match(noloss ?? '', new RegExp(`^INV-NOLOSS \\(resurrection, R3-64\\): retired marker ${m} .* reappears in live_code of board [0-9a-f]{12} \\(shared\\.txt\\) after the board had left it`));
  assert.match(del ?? '', new RegExp(`^MATRIX-DELETION: p1 deleted the row ${m} of shared\\.txt \\(landed in [0-9a-f]{40}\\), but live code [0-9a-f]{40} has it again$`));
});

// ---- board rewinds in INV-NOLOSS's pre-mirror window (Task 16 fix round 1: holds-crash-1's second rewind lead-in) ---------------------

/**
 * p1 loses a same-row race on notes.txt (a K4 record holding its row at s2, OFF_DISK), the record mirrors (held/<id>/ on the board),
 * then on a scratch copy of the remote one INV-NOLOSS instance watches the board before and after the host moves the board ref back
 * below the commit that first carried held/<id>/ (F-BR-3, as the matrix's rewind lead-ins do); a fresh instance judges the rewound
 * board cold; and the watching instance judges a later landed publish of p1 on the rewound board whose mirror omits the record.
 */
function rewindWindowSteps(markers: MarkerModel, facts: Map<string, unknown>): Step[] {
  const at: { id: string; m: string; mm: MarkerModel | null; dir: string | null; view: SimContext | null; watch: NolossOracle | null } = { id: '', m: '', mm: null, dir: null, view: null, watch: null };
  const where = (): string | null => {
    const f = at.watch!.locations(at.view!).get(at.m) ?? null;
    return f === null ? null : `${f.at} ${f.detail}`;
  };
  return [
    { rounds: 2 },
    { kind: 'edit_same_line', peer: 0, params: { row: 4, other: 1 } },
    { iterate: 0 }, { advance: 25_000 }, { iterate: 0 }, { advance: 6_000 }, { iterate: 0 },
    until(1, 'k4', async (ctx) => live(await holdsOf(ctx, 1)).some((r) => has(r, 'conflict')), 20),
    {
      probe: 'k4 marker', run: async (ctx) => {
        const r = live(await holdsOf(ctx, 1)).find((x) => has(x, 'conflict'))!;
        const s2 = (r.blobs as { s2?: Record<string, string> }).s2 ?? {};
        const oid = s2['notes.txt'];
        assert.ok(oid !== undefined && oid !== 'ABSENT', `p1's K4 record holds notes.txt at s2: ${JSON.stringify(r.blobs)}`);
        const m = findMarkers(await readBlob(ctx.git, ctx.peers[1]!.dir, oid as Oid)).find((x) => x.endsWith('_p1'));
        assert.ok(m !== undefined, 'p1\'s row carries its marker');
        at.id = r.id;
        at.m = m;
        // A model with this one obligation (the run's other markers are not this plant's subject).
        at.mm = new MarkerModel(markers.run);
        at.mm.noteEdit('p1', 'notes.txt', [m], [], true, () => false);
        facts.set('m', m);
        facts.set('id', r.id);
      },
    },
    until(1, 'mirrored', async (ctx) => (await locateMarker(ctx, RELEASE_NAMESPACE, at.m, { peer: 'p1', path: 'notes.txt' }, {}))?.at === 'held', 40),
    {
      probe: 'watch', run: async (ctx) => {
        at.dir = await scratchRemote(ctx, 'rewind-window');
        at.view = viewOf(ctx, { remoteDir: at.dir });
        at.watch = oracleNoloss(at.mm!, RELEASE_NAMESPACE);
        facts.set('before', await judge(at.watch, at.view));
        facts.set('at-before', where());
      },
    },
    {
      probe: 'the host rewinds the board below the mirror', run: async () => {
        const dir = at.dir!;
        const tip = await g(dir, ['rev-parse', REFS.remoteBoard]);
        // The oldest board commit of the first-parent run from the tip that carries held/<id>/: the commit the mirror push landed.
        let mirror: string | null = null;
        for (const b of (await g(dir, ['rev-list', '--first-parent', tip])).split('\n')) {
          if ((await g(dir, ['ls-tree', b, `held/${at.id}`])) === '') break;
          mirror = b;
        }
        assert.ok(mirror !== null, `the tip carries held/${at.id}/`);
        const below = await g(dir, ['rev-parse', `${mirror}~1`]);
        await g(dir, ['update-ref', REFS.remoteBoard, below, tip]);
        facts.set('below', below);
        facts.set('rewound', await judge(at.watch!, at.view!));
        facts.set('at-rewound', where());
      },
    },
    { probe: 'a cold instance', run: async () => { facts.set('cold', await judge(oracleNoloss(at.mm!, RELEASE_NAMESPACE), at.view!)); } },
    {
      probe: 'p1 publishes on the rewound board without the record', run: async (ctx) => {
        const dir = at.dir!;
        const below = facts.get('below') as string;
        const parents = (await g(dir, ['rev-list', '--no-walk', '--parents', '-n', '1', below])).split(' ');
        const child = await g(dir, ['commit-tree', `${below}^{tree}`, '-p', below, '-p', parents[parents.length - 1]!], { stdin: Buffer.from('plant: a board commit on the rewound board\n', 'utf8') });
        await g(dir, ['update-ref', REFS.remoteBoard, child, below]);
        const pid = [...ctx.trace.names].find(([, n]) => n === 'p1')![0];
        const events: TraceEvent[] = [
          ...ctx.trace.events,
          { kind: 'iteration', peer: pid, n: 9_999, fetched: true, applied: false, pushes: 1 },
          { kind: 'mirror', peer: pid, bnew: child, holds: [] },
          { kind: 'push', peer: pid, purpose: 'publish', argv: [], bnew: child, outcome: 'landed' },
        ];
        // The same view object (the watching instance keys its run state by it), now over the edited trace.
        (at.view as { trace: SimContext['trace'] }).trace = traceView(ctx, events);
        facts.set('child', child);
        facts.set('missed', await judge(at.watch!, at.view!));
        await dropScratch(dir);
      },
    },
  ];
}

test('INV-NOLOSS re-opens the pre-mirror window of a record whose mirror a host rewind took off the board: the instance that watched the rewind finds the K4 loser\'s marker in its owner\'s registry (window open), a cold instance that never saw the board before the rewind still fails it, and a later landed push of the owner on the rewound board that omits the record is a missed mirror', { timeout: SIM_TIMEOUT }, async () => {
  const s = holdsSetup('holds-rewind-window', { script: [] });
  const facts = new Map<string, unknown>();
  const steps = rewindWindowSteps(s.markers, facts);
  const r = await runSim({ ...s.tuple, ops: steps.length }, s.factory, [], { ...s.options, generator: play(steps, s.markers), quiescence: undefined });
  assert.ok(r.ok, JSON.stringify(r.failure));
  await dropArtifacts(r);
  const m = facts.get('m') as string;
  const id = facts.get('id') as string;
  assert.equal(facts.get('before'), null, 'the mirrored marker is held on the board');
  assert.match(String(facts.get('at-before')), new RegExp(`^held held ${id}/s2/notes\\.txt$`));
  assert.equal(facts.get('rewound'), null, `the watching instance: ${String(facts.get('rewound'))}`);
  assert.match(String(facts.get('at-rewound')), new RegExp(`^registry registry p1 ${id} rev \\d+ s2/notes\\.txt \\(pre-mirror window open\\)$`));
  assert.match(String(facts.get('cold')), new RegExp(`^INV-NOLOSS: marker ${m} \\(author p1, path notes\\.txt, written at step \\d+\\) is in no location; last seen at nowhere$`), 'a cold instance knows no rewind: Task 15\'s closed window');
  assert.match(String(facts.get('missed')), new RegExp(`^INV-NOLOSS: marker ${m} .*missed mirror: p1's record ${id} holds ${m} since rev \\d+ \\(hold event #\\d+\\), and p1's landed push #\\d+ \\(bnew ${String(facts.get('child'))}\\) of a later iteration does not list it`));
});
