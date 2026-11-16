// oracleGroup's and oracleReady's plants (Plan 3 Task 14; 11-testing §3.4 rows INV-GROUP and O-READY; HLD-41, HLD-53, HLD-54; glossary
// §20; rulings R3-30, R3-31). Every run is real git against file:// bare remotes (holdsSetup's composition). A plant is applied after the
// run's last real step inside a final probe — synthetic trace events naming crafted objects in a peer repo, inspect() wrappers — into a
// fork of the run's trace (forkTrace: each plant judged alone), and a fresh oracle's afterEveryOp is then invoked directly on that fork,
// so a plant never disturbs a running engine or another plant. The runs themselves carry the eight oracles too. Fix round 1 (R3-55)
// split sim.oracles.holds by area; the helpers are in test/helpers/holdsOracleScript.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TraceEvent } from '../../src/ports/trace.js';
import { SIM_TIMEOUT, okOrFail, type Step, scriptRun, engineAt, blobOf } from '../helpers/holdsScript.js';
import { fresh, G3, g3Steps, untilPlanting } from '../helpers/holdsOracleScript.js';
import type { SimContext } from '../sim/harness.js';
import { treeEntries } from '../sim/holdsView.js';
import { emitAs, forkTrace, oracleGroup, oracleReady, peerIdOf, plantBlob, plantCommit, plantTree } from '../sim/oraclesHolds.js';

type ApplyEvent = Extract<TraceEvent, { kind: 'apply' }>;
type MergeEvent = Extract<TraceEvent, { kind: 'merge' }>;
type StateEvent = Extract<TraceEvent, { kind: 'state' }>;

/** p0's apply that wrote all of G3, its merge event (A_before, S_disk, LA_C) and its state transition (A_after). */
function g3Apply(ctx: SimContext): { apply: ApplyEvent; merge: MergeEvent; state: StateEvent } {
  const id0 = peerIdOf(ctx, 0);
  const ev = ctx.trace.events;
  let at = -1;
  for (let k = ev.length - 1; k >= 0 && at < 0; k--) {
    const e = ev[k]!;
    if (e.kind === 'apply' && e.peer === id0 && G3.every((p) => e.written.includes(p))) at = k;
  }
  assert.ok(at >= 0, 'p0 applied the 3-path CS');
  const apply = ev[at] as ApplyEvent;
  let mergeAt = -1;
  for (let k = at - 1; k >= 0 && mergeAt < 0; k--) {
    const e = ev[k]!;
    if (e.kind === 'merge' && e.peer === id0 && e.use === 'apply' && e.tip === apply.tip) mergeAt = k;
  }
  assert.ok(mergeAt >= 0, 'its merge event');
  const state = ev.slice(mergeAt + 1, at).filter((e): e is StateEvent => e.kind === 'state' && e.peer === id0 && e.laC === apply.tip).pop();
  assert.ok(state !== undefined, 'its state transition');
  return { apply, merge: ev[mergeAt] as MergeEvent, state };
}

const iteration = (peer: string, n: number): TraceEvent => ({ kind: 'iteration', peer, n, fetched: true, applied: false, pushes: 0 });

test('oracleGroup fails on four plants and names the clause: an \'apply\' event that writes 2 of a 3-path group, a deferred closure 62,501 virtual ms old with no INCOMING record, a not-applicable path without its own INCOMING record at X\'s next iteration event, and two written applies of one peer 9,999 virtual ms apart (by monoAt)', { timeout: SIM_TIMEOUT }, async (t) => {
  const run = untilPlanting();
  const verdicts: Record<string, string | null> = {};
  const steps: Step[] = [
    ...g3Steps(),
    {
      probe: 'plants', run: async (ctx) => {
        const id0 = peerIdOf(ctx, 0);
        const now = ctx.clocks.get('p0')!.monoMs();
        const { apply: real, merge, state } = g3Apply(ctx);
        verdicts['the run as it is'] = await fresh(oracleGroup, ctx);
        run.plant();
        const A0 = await treeEntries(ctx.git, ctx.peers[0]!.dir, merge.aTree);
        /** The apply's state transition with `reset` back at A_before: those paths' writes did not happen. */
        const stateWithout = async (p: SimContext, reset: readonly string[]): Promise<StateEvent> =>
          ({ ...state, base: await plantTree(p, 0, state.base, Object.fromEntries(reset.map((x) => [x, A0.get(x)?.oid ?? null]))) });
        /** One planted apply: its merge event, its state transition (none: a no-op apply, A unchanged) and the apply event. */
        const plantApply = (p: SimContext, st: StateEvent | null, ap: ApplyEvent, mono = now): void => {
          emitAs(p, 0, merge, mono);
          if (st !== null) emitAs(p, 0, st, mono);
          emitAs(p, 0, ap, mono);
        };
        const deferredG3: ApplyEvent = { ...real, written: [], deferred: [...G3], groups: [{ paths: [...G3], outcome: 'deferred', reason: 'locked' }] };
        let p: SimContext;

        // (i) all or none: only g/a.txt and g/b.txt written (A_after keeps g/c.txt at A_before)
        p = forkTrace(ctx);
        plantApply(p, await stateWithout(p, ['g/c.txt']), { ...real, written: ['g/a.txt', 'g/b.txt'] });
        verdicts['(i) 2 of 3 written'] = await fresh(oracleGroup, p);
        // (i)/(iii) finding 1: an engine that drops g/b.txt from every write group (not written, not deferred, not applicable)
        p = forkTrace(ctx);
        plantApply(p, await stateWithout(p, ['g/b.txt']), {
          ...real, written: real.written.filter((x) => x !== 'g/b.txt'),
          groups: real.groups.map((g) => ({ ...g, paths: g.paths.filter((x) => x !== 'g/b.txt') })).filter((g) => g.paths.length > 0),
        });
        verdicts['(i)/(iii) g/b.txt dropped from every group'] = await fresh(oracleGroup, p);
        // (i) written both ways: the event names g/c.txt written, A did not move
        p = forkTrace(ctx);
        plantApply(p, await stateWithout(p, ['g/c.txt']), real);
        verdicts['(i) written but A unmoved'] = await fresh(oracleGroup, p);
        // (i) written both ways: A moved for g/c.txt, the event's written list lacks it
        p = forkTrace(ctx);
        plantApply(p, state, { ...real, written: ['g/a.txt', 'g/b.txt'] });
        verdicts['(i) A moved but not written'] = await fresh(oracleGroup, p);
        // (v) a closure deferred 62,501 virtual ms ago with no INCOMING record, p0 iterating at that age
        p = forkTrace(ctx);
        plantApply(p, null, deferredG3, now - 62_501);
        emitAs(p, 0, iteration(id0, 999_999), now);
        verdicts['(v) deferred 62,501 ms'] = await fresh(oracleGroup, p);
        // (v) finding 2: the engine's own deferral clock restarted at every re-deferral (inspect().pendingAgeMs young) changes nothing
        p = forkTrace(ctx);
        plantApply(p, null, deferredG3, now - 62_501);
        for (let k = 1; k <= 25; k++) plantApply(p, null, deferredG3, now - 62_501 + k * 2_500);   // re-deferred every loop
        emitAs(p, 0, iteration(id0, 999_999), now);
        const p0 = engineAt(ctx, 0);
        const inspect = p0.inspect.bind(p0);
        p0.inspect = async () => {
          const x = await inspect();
          return { ...x, pendingAgeMs: { ...x.pendingAgeMs, ...Object.fromEntries(G3.map((g) => [g, 0])) } };
        };
        try {
          verdicts['(v) young engine clock'] = await fresh(oracleGroup, p);
        } finally {
          delete (p0 as { inspect?: unknown }).inspect;
        }
        // (v) a restart (a new Engine's first iteration, n = 1) re-anchors the deferral: 1,000 ms after it, nothing is due yet …
        p = forkTrace(ctx);
        plantApply(p, null, deferredG3, now - 70_000);
        emitAs(p, 0, iteration(id0, 1), now - 1_000);
        emitAs(p, 0, iteration(id0, 2), now);
        verdicts['(v) restart, 1,000 ms after its first iteration'] = await fresh(oracleGroup, p);
        // … and 62,501 ms after it the record is due
        emitAs(p, 0, iteration(id0, 3), now - 1_000 + 62_501);
        verdicts['(v) restart, 62,501 ms after its first iteration'] = await fresh(oracleGroup, p);
        // (iv) a not-applicable path with no INCOMING record by p0's next iteration event
        p = forkTrace(ctx);
        plantApply(p, state, { ...real, notApplicable: [{ path: 'g/x.txt', reason: 'collision' }] });
        emitAs(p, 0, iteration(id0, 1_000_000), now);
        verdicts['(iv) not applicable'] = await fresh(oracleGroup, p);
        // (vi) two written applies 9,999 virtual ms apart
        p = forkTrace(ctx);
        plantApply(p, state, real, now + 100_000);
        plantApply(p, state, real, now + 109_999);
        verdicts['(vi) 9,999 ms apart'] = await fresh(oracleGroup, p);
      },
    },
  ];
  okOrFail((await scriptRun('holds-plant-group', () => steps, { oracles: run.oracles })).r);
  t.diagnostic(JSON.stringify(verdicts, null, 1));
  const fails = (key: string, pattern: RegExp | string): void => {
    const v = verdicts[key];
    assert.ok(v !== undefined, `${key} was judged`);
    assert.ok(v !== null && (typeof pattern === 'string' ? v.includes(pattern) : pattern.test(v)), `${key} fails naming ${String(pattern)}: ${v}`);
  };
  assert.equal(verdicts['the run as it is'], null, 'a fresh oracleGroup passes on the run as it is');
  fails('(i) 2 of 3 written', /INV-GROUP \(i\) p0 apply [0-9a-f]+: closure \["g\/a\.txt","g\/b\.txt","g\/c\.txt"\] wrote \["g\/a\.txt","g\/b\.txt"\] only/);
  fails('(i)/(iii) g/b.txt dropped from every group', /INV-GROUP \(i\) p0 apply [0-9a-f]+: closure \["g\/a\.txt","g\/b\.txt","g\/c\.txt"\] wrote \["g\/a\.txt","g\/c\.txt"\] only/);
  fails('(i)/(iii) g/b.txt dropped from every group', /INV-GROUP \(iii\) p0 apply [0-9a-f]+: event groups \[\["g\/a\.txt","g\/c\.txt"\]\] != closures \[\["g\/a\.txt","g\/b\.txt","g\/c\.txt"\]\]/);
  fails('(i) written but A unmoved', /INV-GROUP \(i\) p0 apply [0-9a-f]+: g\/c\.txt is in the event's written list but A\[g\/c\.txt\] did not move/);
  fails('(i) A moved but not written', /INV-GROUP \(i\) p0 apply [0-9a-f]+: A\[g\/c\.txt\] moved \(absent -> [0-9a-f]+\) but g\/c\.txt is not in the event's written list/);
  fails('(v) deferred 62,501 ms', 'INV-GROUP (v) p0 closure ["g/a.txt","g/b.txt","g/c.txt"] deferred 62501 virtual ms has 0 non-terminal INCOMING record(s)');
  fails('(v) young engine clock', 'INV-GROUP (v) p0 closure ["g/a.txt","g/b.txt","g/c.txt"] deferred 62501 virtual ms has 0 non-terminal INCOMING record(s)');
  assert.equal(verdicts['(v) restart, 1,000 ms after its first iteration'], null, 'a restarted engine\'s deferral is measured from its first iteration');
  fails('(v) restart, 62,501 ms after its first iteration', 'INV-GROUP (v) p0 closure ["g/a.txt","g/b.txt","g/c.txt"] deferred 62501 virtual ms has 0 non-terminal INCOMING record(s)');
  fails('(iv) not applicable', 'INV-GROUP (iv) p0 not-applicable g/x.txt');
  fails('(vi) 9,999 ms apart', 'INV-GROUP (vi) p0 written applies 9999 virtual ms apart');
});

test('O-READY\'s after-apply clause judges only the paths where a ready pair carries content (R[p] ≠ A[p]; ruling on reading 18, pinned): a pair whose R keeps A on a path the apply wrote with another M_disk entry passes, a pair whose R carries content other than the apply\'s M_disk entry fails (rebase)', { timeout: SIM_TIMEOUT }, async (t) => {
  const run = untilPlanting();
  const verdicts: Record<string, string | null> = {};
  const steps: Step[] = [
    ...g3Steps(),
    {
      probe: 'plants', run: async (ctx) => {
        const id0 = peerIdOf(ctx, 0);
        const real = ctx.trace.ofKind('apply').filter((e) => e.peer === id0 && e.written.includes('g/a.txt')).pop();
        assert.ok(real !== undefined && real.mDisk !== null, 'p0 applied g/a.txt');
        verdicts['the run as it is'] = await fresh(oracleReady, ctx);
        run.plant();
        const p0 = engineAt(ctx, 0);
        const ins = await p0.inspect();
        const x = await plantBlob(ctx, 0, Buffer.from('pinned M_disk row\n', 'utf8'));
        const y = await plantBlob(ctx, 0, Buffer.from('pinned ready row\n', 'utf8'));
        const mDisk = await plantTree(ctx, 0, real.mDisk, { 'g/a.txt': x });
        const withPair = async (p: SimContext, R: string): Promise<string | null> => {
          const inspect = p0.inspect.bind(p0);
          p0.inspect = async () => ({ ...(await inspect()), ready: [{ csId: 'cs-pin', R: R as never, A: ins.aTree as never, paths: ['g/a.txt'], order: 1 }] });
          try {
            return await fresh(oracleReady, p);
          } finally {
            delete (p0 as { inspect?: unknown }).inspect;
          }
        };
        let p = forkTrace(ctx);
        emitAs(p, 0, { ...real, written: ['g/a.txt'], mDisk });
        verdicts['R keeps A'] = await withPair(p, ins.aTree);
        p = forkTrace(ctx);
        emitAs(p, 0, { ...real, written: ['g/a.txt'], mDisk });
        verdicts['R carries other content'] = await withPair(p, await plantTree(ctx, 0, ins.aTree, { 'g/a.txt': y }));
      },
    },
  ];
  okOrFail((await scriptRun('holds-plant-ready', () => steps, { oracles: run.oracles })).r);
  t.diagnostic(JSON.stringify(verdicts, null, 1));
  assert.equal(verdicts['the run as it is'], null, 'a fresh oracleReady passes on the run as it is');
  assert.equal(verdicts['R keeps A'], null, 'a pair whose R keeps A on the written path is not judged there');
  const v = verdicts['R carries other content'];
  assert.ok(v !== null && v !== undefined && /O-READY \(rebase\) p0 pair cs-pin: R\[g\/a\.txt\] [0-9a-f]+ != the apply's M_disk [0-9a-f]+/.test(v), `a pair carrying other content on the written path fails (rebase): ${v}`);
});

test('O-READY\'s after-apply rebase clause follows glossary §3 for a pair journaled before the apply (ruling R3-EF4-1; HLD-39, HLD-41): after a post-capture effect on the written path a clean plain rebase R[p] := merge-file(A_new, A_cap, R) passes and any other R fails, a pair kept after a rebase conflict fails (the capture is withdrawn); with no post-capture effect a conflict still takes the apply\'s M_disk (bullet 1)', { timeout: SIM_TIMEOUT }, async (t) => {
  const run = untilPlanting();
  const verdicts: Record<string, string | null> = {};
  const P = 'g/a.txt';
  const steps: Step[] = [
    ...g3Steps(),
    {
      probe: 'plants', run: async (ctx) => {
        const id0 = peerIdOf(ctx, 0);
        const { apply: real, merge } = g3Apply(ctx);
        verdicts['the run as it is'] = await fresh(oracleReady, ctx);
        run.plant();
        const p0 = engineAt(ctx, 0);
        const ins = await p0.inspect();
        const aNow = (await treeEntries(ctx.git, ctx.peers[0]!.dir, ins.aTree)).get(P);
        assert.ok(aNow !== undefined, `A carries ${P}`);
        // A_new = A[p] now (4 rows). A_cap = A_new with its first row as it was before a teammate changed it; the pair captured one row
        // appended at the end; a post-capture effect inserts a row after row 2 (the next open human CS's, HLD-35).
        const rows = (await blobOf(ctx, 0, aNow.oid))!.toString('utf8').split(/(?<=\n)/);
        assert.ok(rows.length >= 4 && rows.every((r) => r.endsWith('\n')), `${P} has 4 LF rows`);
        const text = (xs: readonly string[]): Buffer => Buffer.from(xs.join(''), 'utf8');
        const blob = (xs: readonly string[]): Promise<string> => plantBlob(ctx, 0, text(xs));
        const tree = async (oid: string): Promise<string> => plantTree(ctx, 0, ins.aTree, { [P]: oid as never });
        const cap = 'captured row\n';
        const late = 'post-capture row\n';
        const aCap = ['old row 1\n', ...rows.slice(1)];
        const withLate = (xs: readonly string[]): string[] => [...xs.slice(0, 2), late, ...xs.slice(2)];
        const rClean = [...aCap, cap];                        // plain rebase onto A_new: clean
        const rConflict = ['my row 1\n', ...rows.slice(1)];  // plain rebase onto A_new: a conflict on row 1
        const mDisk = await plantTree(ctx, 0, real.mDisk ?? ins.aTree, { [P]: (await blob([...withLate(rows), cap])) as never });
        /**
         * One plant: the pair `cs` journaled before the apply (a `state` event whose commit holds journal/ready/<base64url(cs)>/{R,A}
         * with R_before and A_cap on p), the apply's `merge` event (`ours` = S_disk before it) and the `apply` event writing p with
         * mDisk; after it inspect().ready lists the pair with R_after on p and A_cap = A.
         */
        const plant = async (label: string, before: { r: readonly string[]; sDisk: readonly string[] }, rAfter: string): Promise<void> => {
          const p = forkTrace(ctx);
          const cs = `${id0}/human/9`;
          const key = Buffer.from(cs, 'utf8').toString('base64url');
          const journal = await plantTree(ctx, 0, ins.aTree, { [`journal/ready/${key}/R/${P}`]: (await blob(before.r)) as never, [`journal/ready/${key}/A/${P}`]: (await blob(aCap)) as never });
          const state = await plantCommit(ctx, 0, journal as never, [], 'planted state', []);
          emitAs(p, 0, { kind: 'state', peer: id0, prev: null, next: state, laC: merge.laC, laB: merge.laB, base: merge.aTree });
          emitAs(p, 0, { ...merge, ours: await tree(await blob(before.sDisk)) });
          emitAs(p, 0, { ...real, written: [P], mDisk });
          const inspect = p0.inspect.bind(p0);
          p0.inspect = async () => ({ ...(await inspect()), ready: [{ csId: cs, R: rAfter as never, A: ins.aTree as never, paths: [P], order: 1 }] });
          try {
            verdicts[label] = await fresh(oracleReady, p);
          } finally {
            delete (p0 as { inspect?: unknown }).inspect;
          }
        };
        const post = { r: rClean, sDisk: withLate(rClean) };
        await plant('post-capture effect, R = plain rebase', post, await tree(await blob([...rows, cap])));
        await plant('post-capture effect, R = the apply\'s M_disk (re-captured from the written disk)', post, mDisk);
        await plant('post-capture effect, R = neither', post, await tree(await blob([...rows, 'other row\n'])));
        await plant('post-capture effect, rebase conflict, pair kept', { r: rConflict, sDisk: withLate(rConflict) }, await tree(await blob(['my row 1\n', ...rows.slice(1), cap])));
        await plant('no post-capture effect, rebase conflict, R = M_disk', { r: rConflict, sDisk: rConflict }, mDisk);
        await plant('no post-capture effect, rebase conflict, R ≠ M_disk', { r: rConflict, sDisk: rConflict }, await tree(await blob(['my row 1\n', ...rows.slice(1)])));
      },
    },
  ];
  okOrFail((await scriptRun('holds-plant-ready-journal', () => steps, { oracles: run.oracles })).r);
  t.diagnostic(JSON.stringify(verdicts, null, 1));
  assert.equal(verdicts['the run as it is'], null, 'a fresh oracleReady passes on the run as it is');
  assert.equal(verdicts['post-capture effect, R = plain rebase'], null, 'glossary §3: the plain rebase, without the uncaptured row the apply\'s M_disk carries');
  assert.equal(verdicts['post-capture effect, R = the apply\'s M_disk (re-captured from the written disk)'], null, 'R == M_disk passes as before (a withdrawn closed CS re-captures from the disk at once, same cs_id)');
  const fails = (key: string, pattern: RegExp): void => {
    const v = verdicts[key];
    assert.ok(v !== undefined && v !== null && pattern.test(v), `${key} fails naming ${String(pattern)}: ${v}`);
  };
  fails('post-capture effect, R = neither', /^O-READY \(rebase\) p0 pair [0-9a-f]+\/human\/9: R\[g\/a\.txt\] [0-9a-f]+ != merge-file\(A_new, A_cap, R\) [0-9a-f]+ \(HLD-41\)$/);
  fails('post-capture effect, rebase conflict, pair kept', /^O-READY \(rebase\) p0 pair [0-9a-f]+\/human\/9: R\[g\/a\.txt\] [0-9a-f]+ kept after a rebase conflict with a post-capture effect on g\/a\.txt \(HLD-41: the capture is withdrawn\)$/);
  assert.equal(verdicts['no post-capture effect, rebase conflict, R = M_disk'], null, 'HLD-41 bullet 1: S_disk[p] == R[p] before the apply, the conflict takes M_disk');
  fails('no post-capture effect, rebase conflict, R ≠ M_disk', /^O-READY \(rebase\) p0 pair [0-9a-f]+\/human\/9: R\[g\/a\.txt\] [0-9a-f]+ != the apply's M_disk [0-9a-f]+ \(HLD-41\)$/);
});

test('oracleGroup (iv) accepts a not-applicable path\'s own INCOMING record that was created after its apply and released SUBSUMED before the peer\'s next iteration event only when TIP no longer changes the path there (ruling R3-EF4-5; HLD-54\'s release condition): released after an apply at a TIP without the path passes; released while TIP still changes it, or ended GONE, fails (iv)', { timeout: SIM_TIMEOUT }, async (t) => {
  const run = untilPlanting();
  const verdicts: Record<string, string | null> = {};
  const X = 'np/team-1/x.txt';
  const steps: Step[] = [
    ...g3Steps(),
    {
      probe: 'plants', run: async (ctx) => {
        const id0 = peerIdOf(ctx, 0);
        const { apply: real, merge } = g3Apply(ctx);
        verdicts['the run as it is'] = await fresh(oracleGroup, ctx);
        run.plant();
        const ins = await engineAt(ctx, 0).inspect();
        const tipTree = (await ctx.git.run(['rev-parse', `${real.tip}^{tree}`], { class: 'local', cwd: ctx.peers[0]!.dir })).stdout.toString('utf8').trim();
        // The team pushes X (p0 cannot materialize it), then a fix that renames it away: TIP no longer changes X.
        const withX = await plantCommit(ctx, 0, await plantTree(ctx, 0, tipTree, { [X]: await plantBlob(ctx, 0, Buffer.from('x\n', 'utf8')) }), [real.tip as never], 'planted team push', []);
        const fixed = await plantCommit(ctx, 0, tipTree as never, [withX], 'planted team fix', []);
        /** A no-op apply at `tip` (LA_C already there: no incoming CS, no write group) naming `na` not applicable. */
        const applyAt = (p: SimContext, tip: string, na: string[]): void => {
          emitAs(p, 0, { ...merge, laC: tip, tip, aTree: ins.aTree, ours: ins.aTree });
          emitAs(p, 0, { ...real, tip, written: [], deferred: [], groups: [], notApplicable: na.map((path) => ({ path, reason: 'unmaterializable' })), mDisk: null });
        };
        const hold = (p: SimContext, state: string, rev: number): void => emitAs(p, 0, {
          kind: 'hold', peer: id0, id: '01KDVE0000000000000000T4AA', holdKind: 'INCOMING', guard: 'unmaterializable', guards: ['unmaterializable'], paths: [X],
          residence: state === 'ACTIVE' ? 'ON_DISK' : null, state, rev, localOnly: false,
        });
        let p = forkTrace(ctx);
        applyAt(p, withX, [X]);
        hold(p, 'ACTIVE', 1);
        applyAt(p, fixed, []);
        hold(p, 'SUBSUMED', 2);
        emitAs(p, 0, iteration(id0, 999_999));
        verdicts['created, then released SUBSUMED after an apply at a TIP without X'] = await fresh(oracleGroup, p);
        p = forkTrace(ctx);
        applyAt(p, withX, [X]);
        hold(p, 'ACTIVE', 1);
        hold(p, 'SUBSUMED', 2);
        emitAs(p, 0, iteration(id0, 999_999));
        verdicts['created, then SUBSUMED while TIP still changes X'] = await fresh(oracleGroup, p);
        p = forkTrace(ctx);
        applyAt(p, withX, [X]);
        hold(p, 'ACTIVE', 1);
        applyAt(p, fixed, []);
        hold(p, 'GONE', 2);
        emitAs(p, 0, iteration(id0, 999_999));
        verdicts['created, then GONE after an apply at a TIP without X'] = await fresh(oracleGroup, p);
      },
    },
  ];
  okOrFail((await scriptRun('holds-plant-group-iv', () => steps, { oracles: run.oracles })).r);
  t.diagnostic(JSON.stringify(verdicts, null, 1));
  assert.equal(verdicts['the run as it is'], null, 'a fresh oracleGroup passes on the run as it is');
  assert.equal(verdicts['created, then released SUBSUMED after an apply at a TIP without X'], null, 'HLD-54: released once TIP no longer changes X (the join-then-fix shape, E16-C)');
  for (const key of ['created, then SUBSUMED while TIP still changes X', 'created, then GONE after an apply at a TIP without X']) {
    const v = verdicts[key];
    assert.ok(v !== undefined && v !== null && v.includes(`INV-GROUP (iv) p0 not-applicable ${X}`), `${key} fails (iv): ${v}`);
  }
});

test('oracleGroup (iv) takes a frozen iteration\'s TIP from the board it fetched (ruling R3-EF4-17; HLD-54 applied or not): a record created after the not-applicable apply and released SUBSUMED in an iteration with no apply event passes when the fetched board\'s live code no longer changes the path, and fails (iv) when it still does or when only a later fetch (a publish\'s refetch) no longer does; the with-apply case keeps the apply\'s TIP', { timeout: SIM_TIMEOUT }, async (t) => {
  const run = untilPlanting();
  const verdicts: Record<string, string | null> = {};
  const X = 'np/team-1/x.txt';
  const steps: Step[] = [
    ...g3Steps(),
    {
      probe: 'plants', run: async (ctx) => {
        const id0 = peerIdOf(ctx, 0);
        const { apply: real, merge } = g3Apply(ctx);
        verdicts['the run as it is'] = await fresh(oracleGroup, ctx);
        run.plant();
        const ins = await engineAt(ctx, 0).inspect();
        const tipTree = (await ctx.git.run(['rev-parse', `${real.tip}^{tree}`], { class: 'local', cwd: ctx.peers[0]!.dir })).stdout.toString('utf8').trim();
        // The team pushes X (p0 cannot materialize it), then a fix that renames it away: TIP no longer changes X.
        const withX = await plantCommit(ctx, 0, await plantTree(ctx, 0, tipTree, { [X]: await plantBlob(ctx, 0, Buffer.from('x\n', 'utf8')) }), [real.tip as never], 'planted team push', []);
        const fixed = await plantCommit(ctx, 0, tipTree as never, [withX], 'planted team fix', []);
        // Board commits whose live code (the last parent) is withX / fixed, on top of the board p0 last fetched.
        const lastFetch = ctx.trace.ofKind('fetch').filter((e) => e.peer === id0 && e.ok && e.board !== null).pop();
        assert.ok(lastFetch !== undefined && lastFetch.board !== null, 'p0 fetched a board');
        const boardOf = (live: string): Promise<string> => plantCommit(ctx, 0, tipTree as never, [lastFetch.board as never, live as never], 'planted board', []);
        const [boardWithX, boardFixed] = [await boardOf(withX), await boardOf(fixed)];
        /** A no-op apply at `tip` (LA_C already there: no incoming CS, no write group) naming `na` not applicable. */
        const applyAt = (p: SimContext, tip: string, na: string[]): void => {
          emitAs(p, 0, { ...merge, laC: tip, tip, aTree: ins.aTree, ours: ins.aTree });
          emitAs(p, 0, { ...real, tip, written: [], deferred: [], groups: [], notApplicable: na.map((path) => ({ path, reason: 'unmaterializable' })), mDisk: null });
        };
        const fetch = (p: SimContext, board: string, code: string): void => emitAs(p, 0, { kind: 'fetch', peer: id0, ok: true, board, code, branch: null });
        const hold = (p: SimContext, state: string, rev: number): void => emitAs(p, 0, {
          kind: 'hold', peer: id0, id: '01KDVE0000000000000000O4AA', holdKind: 'INCOMING', guard: 'unmaterializable', guards: ['unmaterializable'], paths: [X],
          residence: state === 'ACTIVE' ? 'ON_DISK' : null, state, rev, localOnly: false,
        });
        // The frozen iteration: its fetch, its record step (the release) and its iteration event (applied: false), no apply event.
        const frozen = async (key: string, plant: (p: SimContext) => void): Promise<void> => {
          const p = forkTrace(ctx);
          applyAt(p, withX, [X]);   // the obligation (in seed 63 the join's apply)
          hold(p, 'ACTIVE', 1);
          plant(p);
          emitAs(p, 0, iteration(id0, 999_999));
          verdicts[key] = await fresh(oracleGroup, p);
        };
        await frozen('frozen: fetched a board without X, released SUBSUMED', (p) => {
          fetch(p, boardFixed, fixed);
          hold(p, 'SUBSUMED', 2);
        });
        await frozen('frozen: fetched a board that still changes X, released SUBSUMED', (p) => {
          fetch(p, boardWithX, withX);
          hold(p, 'SUBSUMED', 2);
        });
        await frozen('frozen: released SUBSUMED on a board that still changes X, a later refetch without X', (p) => {
          fetch(p, boardWithX, withX);
          hold(p, 'SUBSUMED', 2);
          fetch(p, boardFixed, fixed);
        });
        // With an apply event in the releasing iteration (R3-EF4-5's shape): its fetch, then its apply at the fixed TIP, then the release.
        await frozen('with an apply event: fetched and applied a TIP without X, released SUBSUMED', (p) => {
          fetch(p, boardFixed, fixed);
          applyAt(p, fixed, []);
          hold(p, 'SUBSUMED', 2);
        });
      },
    },
  ];
  okOrFail((await scriptRun('holds-plant-group-iv-frozen', () => steps, { oracles: run.oracles })).r);
  t.diagnostic(JSON.stringify(verdicts, null, 1));
  assert.equal(verdicts['the run as it is'], null, 'a fresh oracleGroup passes on the run as it is');
  assert.equal(verdicts['frozen: fetched a board without X, released SUBSUMED'], null, 'HLD-54 in a frozen iteration: the fetched TIP no longer changes X (seed 63, holds-x-3)');
  assert.equal(verdicts['with an apply event: fetched and applied a TIP without X, released SUBSUMED'], null, 'the apply\'s TIP as before (R3-EF4-5)');
  for (const key of ['frozen: fetched a board that still changes X, released SUBSUMED', 'frozen: released SUBSUMED on a board that still changes X, a later refetch without X']) {
    const v = verdicts[key];
    assert.ok(v !== undefined && v !== null && v.includes(`INV-GROUP (iv) p0 not-applicable ${X}`), `${key} fails (iv): ${v}`);
  }
});
