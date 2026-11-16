// SIM regressions of the second Plan 3 engine-fix task (EF2), on real git against file:// bare remotes; git is never mocked. D4: a
// rewind after a restart (05-holds Algorithm D2 step 1, HLD-27, HLD-28; 01-engine ENG-36, §3.14 restart step 5; R3-60). D2 (holds-time-15):
// a MASS freeze still on at quiescence (HLD-30, HLD-31; R3-47's scripted resume). The Task 15 P7 seeds that failed INV-NOLOSS on the
// pre-EF2 engine (D3, D4). The long seeds run under `npm run test:sim` (TEST_SIM_FULL=1, R3-55).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RELEASE_NAMESPACE } from '../../src/engine/refs.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { alone, disk, engineAt, has, holdsOf, live, liveFile, okOrFail, opMarker, play, scriptRun, SIM_TIMEOUT, until, type Step } from '../helpers/holdsScript.js';
import { removeKeptRoot } from '../helpers/tmp.js';
import { holdsOp, holdsSetup } from '../sim/generators.js';
import { runSim, type Oracle } from '../sim/harness.js';
import { readStatus } from '../sim/holdsView.js';
import { oracleNoloss } from '../sim/oracleNoloss.js';
import { exitOracles } from '../sim/oracles.js';

const NS = RELEASE_NAMESPACE;
const FULL = process.env['TEST_SIM_FULL'] === '1';
const ROW = 'shared band 1 row 4 (14) p1';

// EF2 D4. An apply round-trips the private-index entry of every path it writes to the written blob (writer.ts), so the revert
// detector's prev[p] (05 D2 step 1) is M_disk[p] and the applied rows are no local delta. The ENG-36 state update used to journal
// snap := the pre-apply S_disk, and a restart reseeds the private index from state:snap (unconditionally, R3-60), so after a restart
// that came before the next materialization prev[p] was the pre-apply bytes again: a rewind (or stale save) to those bytes, which
// removes the teammate's applied row, read as no removal at all — no revert record, and the row left live_code at the next publish.
test('EF2 D4: p0 applies p1\'s shared.txt row cleanly, rewinds shared.txt to its genesis bytes and is killed at its next materialization (snapshot.index_written) before the revert detector runs; after the restart the removal of p1\'s row still becomes a revert PATCH and live shared.txt keeps p1\'s row and marker (INV-NOLOSS after every op)', { timeout: SIM_TIMEOUT }, async () => {
  let killed = 0;
  let restore: ((name: string) => void) | null = null;
  let p1Marker = '';
  let done = false;
  const steps = (): Step[] => [
    { iterate: 0 }, ...alone(0, 2),
    { iterate: 1 }, ...alone(1, 2),
    { kind: 'edit_band', peer: 1, params: { insert: false, row: 14, text: ROW } },
    ...alone(1, 12),
    ...alone(0, 4),
    {
      probe: 'p0 applied p1\'s row', run: async (ctx) => {
        p1Marker = opMarker(ctx, 'edit_band', 'p1', 'shared.txt');
        assert.ok((await liveFile(ctx, 'shared.txt'))?.toString('latin1').includes(p1Marker), 'p1\'s row is live');
        assert.ok((await disk(ctx, 0, 'shared.txt'))?.toString('latin1').includes(p1Marker), 'p0 applied p1\'s row');
      },
    },
    { kind: 'rewind', peer: 0, params: { path: 'shared.txt', buffer: 'genesis' } },
    {
      probe: 'arm', run: async () => {
        restore = setCrashHandler((name) => {
          if (name !== 'snapshot.index_written' || killed > 0) return;
          killed++;
          throw new KilledAt(name);
        });
      },
    },
    ...alone(0, 14),
    {
      probe: 'disarm', run: async (ctx) => {
        setCrashHandler(restore);
        restore = null;
        assert.equal(killed, 1, 'p0 was killed at its first materialization after the rewind');
        const k = ctx.opLog.findIndex((e) => e.kind === 'killed' && e.peer === 'p0' && e.detail.startsWith('snapshot.index_written'));
        assert.ok(k >= 0, 'the op-log shows the kill');
        assert.ok(ctx.opLog.slice(k).some((e) => e.kind === 'start' && e.peer === 'p0' && e.detail.startsWith('restart')), 'and p0\'s restart');
      },
    },
    { rounds: 8 },
    {
      probe: 'facts', run: async (ctx) => {
        const recs = live(await holdsOf(ctx, 0)).filter((r) => r.kind === 'PATCH' && r.paths.includes('shared.txt') && has(r, 'revert'));
        assert.equal(recs.length, 1, `p0 holds the removal of p1's row in a revert PATCH: ${JSON.stringify((await holdsOf(ctx, 0)).map((r) => [r.kind, r.paths, r.guards.map((x) => x.name), r.state]))}`);
        const text = (await liveFile(ctx, 'shared.txt'))?.toString('latin1') ?? '';
        assert.ok(text.includes(ROW) && text.includes(p1Marker), 'live shared.txt keeps p1\'s row and marker');
        done = true;
      },
    },
  ];
  try {
    // scriptRun's composition (holdsSetup with an empty script, crash rate 0, no quiescence) with INV-NOLOSS after every op over the
    // run's own MarkerModel.
    const s = holdsSetup('holds-d4-min', { script: [] });
    const script = steps();
    const options = { ...s.options, generator: play(script, s.markers) };
    delete options.quiescence;
    okOrFail(await runSim({ ...s.tuple, ops: script.length }, s.factory, [oracleNoloss(s.markers, NS)], options));
  } finally {
    if (restore !== null) setCrashHandler(restore);
  }
  assert.ok(done);
});

// EF2 fix round 1, F1 (the other half of D4): the restart's ENG-53 completion of an interrupted apply journaled snap := t/S (the
// pre-apply S_disk) while the writer had already round-tripped the private index to the written blob; the unconditional reseed from
// state:snap (R3-60) then put the revert detector's prev[p] back on the pre-apply bytes. A kill after the round trip and before the
// apply's state commit — `apply.group.phase2` (inside the first write group) or `apply.between_groups` (between the first and the
// second) — recreated D4: a rewind of the written path to its pre-apply bytes read as no removal. p1 publishes two change-sets (notes.txt,
// then shared.txt), so p0's apply has two write groups and notes.txt is the first (groups are ordered by their first path).
const NOTE = 'note row 6 by p1';
for (const site of ['apply.group.phase2', 'apply.between_groups'] as const) {
  test(`EF2 r1 F1: p0 is killed at ${site} inside its apply of p1's notes.txt and shared.txt change-sets (two write groups), restarts, then rewinds notes.txt to its genesis bytes; the removal of p1's notes.txt row becomes a revert PATCH and live notes.txt keeps p1's row and marker (INV-NOLOSS after every op)`, { timeout: SIM_TIMEOUT }, async () => {
    let killed = 0;
    let restore: ((name: string) => void) | null = null;
    let noteMarker = '';
    let done = false;
    const steps = (): Step[] => [
      { iterate: 0 }, ...alone(0, 2),
      { iterate: 1 }, ...alone(1, 2),
      { kind: 'edit_band', peer: 1, params: { path: 'notes.txt', insert: false, row: 6, text: NOTE } },
      ...alone(1, 12),
      { kind: 'edit_band', peer: 1, params: { insert: false, row: 14, text: ROW } },
      ...alone(1, 12),
      {
        probe: 'arm', run: async (ctx) => {
          noteMarker = opMarker(ctx, 'edit_band', 'p1', 'notes.txt');
          assert.ok((await liveFile(ctx, 'notes.txt'))?.toString('latin1').includes(noteMarker), 'p1\'s notes.txt row is live');
          assert.ok((await liveFile(ctx, 'shared.txt'))?.toString('latin1').includes(ROW), 'p1\'s shared.txt row is live');
          restore = setCrashHandler((name) => {
            if (name !== site || killed > 0) return;
            killed++;
            throw new KilledAt(name);
          });
        },
      },
      until(0, `p0 killed at ${site} inside its apply`, async () => killed > 0, 10),
      { iterate: 0 },   // the restart: start() completes the journaled apply intent (ENG-53)
      {
        probe: 'after the restart', run: async (ctx) => {
          setCrashHandler(restore);
          restore = null;
          const k = ctx.opLog.findIndex((e) => e.kind === 'killed' && e.peer === 'p0' && e.detail.startsWith(site));
          assert.ok(k >= 0, 'the op-log shows the kill');
          assert.ok(ctx.opLog.slice(k).some((e) => e.kind === 'start' && e.peer === 'p0' && e.detail.startsWith('restart')), 'and p0\'s restart');
          assert.ok((await disk(ctx, 0, 'notes.txt'))?.toString('latin1').includes(noteMarker), 'the first write group (notes.txt) was written before the kill');
        },
      },
      { kind: 'rewind', peer: 0, params: { path: 'notes.txt', buffer: 'genesis' } },
      ...alone(0, 14),
      { rounds: 8 },
      {
        probe: 'facts', run: async (ctx) => {
          const all = await holdsOf(ctx, 0);
          const recs = live(all).filter((r) => r.kind === 'PATCH' && r.paths.includes('notes.txt') && has(r, 'revert'));
          assert.equal(recs.length, 1, `p0 holds the removal of p1's notes.txt row in a revert PATCH: ${JSON.stringify(all.map((r) => [r.kind, r.paths, r.guards.map((x) => x.name), r.state]))}`);
          const text = (await liveFile(ctx, 'notes.txt'))?.toString('latin1') ?? '';
          assert.ok(text.includes(NOTE) && text.includes(noteMarker), 'live notes.txt keeps p1\'s row and marker');
          assert.ok((await liveFile(ctx, 'shared.txt'))?.toString('latin1').includes(ROW), 'live shared.txt keeps p1\'s row');
          done = true;
        },
      },
    ];
    try {
      const s = holdsSetup(`holds-f1-${site === 'apply.group.phase2' ? 'p2' : 'bg'}`, { script: [] });
      const script = steps();
      const options = { ...s.options, generator: play(script, s.markers) };
      delete options.quiescence;
      okOrFail(await runSim({ ...s.tuple, ops: script.length }, s.factory, [oracleNoloss(s.markers, NS)], options));
    } finally {
      if (restore !== null) setCrashHandler(restore);
    }
    assert.ok(done);
  });
}

// EF2 D2 (holds-time-15). HLD-30/HLD-31: nothing lifts FREEZE(MASS) but a human `/cowork resume`; R3-47's holds profile pairs its one
// formatter op with a scripted resume. In holds-time-15 the scheduled resume ran while p1 was down (killed right after the formatter,
// before its breaker saw the batch: "resume p1 skipped (no engine)"), and p1 tripped MASS at its restart, in quiescence, after the
// generator's step S−2 cleanup — so the run declared T* with a peer that by spec never converges. holdsSetup's beforeQuiescenceRound
// (resumeMassFrozen) is that human's resume at the first quiescence round.
test('EF2 D2: p1\'s formatter trips FREEZE(MASS), p0 publishes a shared.txt row after the trip, and no scripted resume follows before the op budget ends; holdsSetup\'s beforeQuiescenceRound resumes p1 at the first quiescence round (one op-log `resume` row), the formatting publishes, p1 takes p0\'s row, and the run reaches T* with Plan 2\'s six exit oracles passing', { timeout: SIM_TIMEOUT }, async () => {
  let frozen = false;
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'formatter', peer: 1, params: { glob: 'fmt/*.py' } },
    { advance: 2_500 },
    { iterate: 1 },
    {
      probe: 'frozen', run: async (ctx) => {
        const ins = await engineAt(ctx, 1).inspect();
        assert.ok(ins.freeze.includes('MASS'), `p1 is frozen MASS: ${JSON.stringify(ins.freeze)}`);
        frozen = true;
      },
    },
    // The board moves on while p1 is frozen (holds-time-15: the others advanced T* past p1's LA_B).
    { kind: 'edit_band', peer: 0, params: { path: 'shared.txt', insert: false, row: 5, text: 'p0 row 5 after the trip' } },
    { rounds: 12 },
  ];
  // At quiescence: p1 is no longer frozen and lists nothing in not_converged, so INV-CONVERGE (which skips not_converged paths
  // and compares through canon: p1 has core.autocrlf=true) has checked that its formatted files are T*'s.
  const p1Settled: Oracle = {
    name: 'P1-RESUMED',
    async atQuiescence(ctx) {
      const ins = await engineAt(ctx, 1).inspect();
      if (ins.freeze.length > 0) return `p1 still frozen: ${JSON.stringify(ins.freeze)}`;
      const nc = (await readStatus(ctx.peers[1]!.dir))?.pending.not_converged ?? ['(no status.json)'];
      return nc.length === 0 ? null : `p1 lists not_converged ${JSON.stringify(nc)}`;
    },
  };
  const { r } = await scriptRun('holds-ef2-mass', () => steps, { oracles: [...exitOracles(), p1Settled], quiescence: true });
  okOrFail(r);
  assert.ok(frozen);
  assert.equal(r.quiescence?.reached, true, 'T* reached');
  const resumes = r.opLog.filter((e) => e.kind === 'resume');
  assert.equal(resumes.length, 1, `one resume, the quiescence round's: ${JSON.stringify(resumes)}`);
  assert.equal(resumes[0]!.peer, 'p1');
  assert.match(resumes[0]!.detail, /^quiescence \{/);
  const at = r.opLog.indexOf(resumes[0]!);
  assert.ok(r.opLog[at - 1]?.kind === 'round' && r.opLog[at - 1]!.detail.startsWith('quiescence'), 'at the start of a quiescence round');
  assert.equal(r.opLog.filter((e) => e.kind === 'round' && e.detail.startsWith('quiescence') && e.step < resumes[0]!.step).length, 0, 'the first one');
  assert.equal(r.quiescence?.resumes, 1, 'the SIM result reports the one quiescence resume (EF2 r1 F4)');
});

// EF2 fix round 1, F4: the quiescence resume is R3-47's one scripted resume of the formatter's trip, nothing more. A MASS freeze no
// formatter op explains — here the same 24-file reformat written by a probe, so the op-log holds no `formatter` row (as the engine's own
// unattributed writes would trip the breaker) — is never lifted silently: resumeMassFrozen fails the run at the first quiescence round.
test('EF2 r1 F4: a MASS freeze of p1 with no formatter op in the op-log (the reformat written by a probe) is not resumed at quiescence: the run fails with BEFORE_QUIESCENCE_ROUND naming p1 at the first quiescence round', { timeout: SIM_TIMEOUT }, async () => {
  let frozen = false;
  const { r } = await scriptRun('holds-ef2-mass-unattributed', (markers) => [
    { rounds: 1 },
    { probe: 'a 24-file reformat on p1 that is no formatter op', run: async (ctx) => holdsOp({ kind: 'formatter', peer: 1, params: { glob: 'fmt/*.py' } }, markers).run(ctx) },
    { advance: 2_500 },
    { iterate: 1 },
    {
      probe: 'frozen', run: async (ctx) => {
        assert.ok((await engineAt(ctx, 1).inspect()).freeze.includes('MASS'), 'p1 is frozen MASS');
        frozen = true;
      },
    },
    { rounds: 2 },
  ], { quiescence: true });
  try {
    assert.ok(frozen);
    assert.equal(r.opLog.filter((e) => e.kind === 'formatter').length, 0, 'no formatter op');
    assert.equal(r.ok, false, 'the run fails');
    const first = r.opLog.find((e) => e.kind === 'round' && e.detail.startsWith('quiescence'));
    assert.equal(r.failure?.oracle, 'BEFORE_QUIESCENCE_ROUND');
    assert.equal(r.failure?.step, first?.step, 'at the first quiescence round');
    assert.match(r.failure?.message ?? '', /p1 is frozen MASS/);
    assert.equal(r.opLog.filter((e) => e.kind === 'resume').length, 0, 'nothing resumed it');
  } finally {
    if (r.artifactsDir !== undefined) await removeKeptRoot(r.artifactsDir);
  }
});

/**
 * Task 15's two P7 seeds that failed INV-NOLOSS on the pre-EF2 engine: holds-p7-11 (EF2 D4: a rewind after a restart dropped p1's rows
 * with no revert record) and holds-p7-1 (EF2 D3: the restart's re-form skipped a ready pair's path whose newer edit an apply had taken
 * into state:snap). 05 P7 Plan 3 subset weights.
 */
const P7_WEIGHTS = { stale_save: 8, rewind: 4, edit_band: 8, edit_same_line: 6, edit_peer_line: 6, lock_share_none: 3, gc_prune: 3, resolve: 10 } as const;
test('EF2 regression seeds holds-p7-11 (D4) and holds-p7-1 (D3) with the 05 P7 weights pass INV-NOLOSS after every op and at quiescence', { skip: FULL ? false : 'TEST_SIM_FULL only (R3-55)', timeout: 60 * 60_000 }, async () => {
  for (const seed of ['holds-p7-11', 'holds-p7-1']) {
    const s = holdsSetup(seed, { weights: P7_WEIGHTS });
    const r = await runSim(s.tuple, s.factory, [oracleNoloss(s.markers, NS)], s.options);
    assert.ok(r.ok, `${seed}: ${JSON.stringify(r.failure)} (artifacts ${String(r.artifactsDir)})`);
  }
});
