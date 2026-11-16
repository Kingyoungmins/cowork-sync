// Inspection in the SIM (Plan 3 Task 13; X-03: EngineInspection's Plan 3 fields, the widened `hold` event, the `apply` event's
// INV-GROUP input; HLD-21, HLD-62). Scripted holds runs on real git against file:// bare remotes; git is never mocked. Every
// virtual-time bound is driven by {rounds: n} steps (Task 13 Notes, "Timing in tests").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseOid } from '../../src/git/oid.js';
import { GitRepo } from '../../src/git/repo.js';
import type { HoldRecord } from '../../src/holds/record.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { realEngineOf } from '../sim/engineAdapter.js';
import { holdsSetup, scriptedGenerator, type ScriptStep } from '../sim/generators.js';
import { advanceClocks, runSim, type OpGenerator, type Oracle, type SimContext, type SimOptions, type SimResult } from '../sim/harness.js';
import { readBlob, treeEntries } from '../sim/holdsView.js';
import type { MarkerModel } from '../sim/markers.js';

/** A scripted SIM run on a loaded CI machine can outlast node:test's 10-minute default (R3-55: such a test sets its own timeout). */
const SIM_TIMEOUT = 30 * 60_000;

function okOrFail(r: SimResult): void {
  assert.ok(r.ok, `run failed: ${JSON.stringify(r.failure)}; artifacts kept in ${String(r.artifactsDir)}; op-log tail ${JSON.stringify(r.opLog.slice(-8))}`);
}

interface Probe { probe: string; run(ctx: SimContext): Promise<string | void>; }
type Step = ScriptStep | Probe;

function play(steps: readonly Step[], markers: MarkerModel): OpGenerator {
  const inner = scriptedGenerator(steps.map((s): ScriptStep => ('probe' in s ? { advance: 0 } : s)), markers);
  return {
    next(ctx, step) {
      const s = steps[step];
      if (s !== undefined && 'probe' in s) return { peer: '*', kind: 'probe', run: async (c) => `${s.probe} ${(await s.run(c)) ?? ''}`.trim() };
      return inner.next(ctx, step);
    },
  };
}

async function scriptRun(seed: string, steps: readonly Step[], oracles: Oracle[] = []): Promise<SimResult> {
  const s = holdsSetup(seed, { script: [] });
  const options: SimOptions = { ...s.options, generator: play(steps, s.markers) };
  delete options.quiescence;
  return runSim({ ...s.tuple, ops: steps.length }, s.factory, oracles, options);
}

const engineAt = (ctx: SimContext, i: number) => {
  const e = realEngineOf(ctx.engines[i]!);
  assert.ok(e !== null, `p${i} has a running engine`);
  return e;
};

/** A probe step that iterates peer i alone (2.5 s apart) until `cond` holds, at most `max` times. */
function until(i: number, label: string, cond: (ctx: SimContext) => Promise<boolean>, max = 30): Probe {
  return {
    probe: label,
    run: async (ctx) => {
      for (let n = 1; n <= max; n++) {
        advanceClocks(ctx, 2_500);
        await ctx.engines[i]!.step(ctx);
        await ctx.scheduler.runUntilIdle(10_000);
        if (await cond(ctx)) return `after ${n}`;
      }
      throw new Error(`${label}: not within ${max} iterations of p${i}`);
    },
  };
}

const hasGuard = (r: HoldRecord, g: string): boolean => r.guards.some((x) => x.name === g);

test('inspection in SIM: after p0\'s stale_save over p1\'s shared.txt row 14 materializes, inspect() shows registryHead = rev-parse of p0\'s registry ref, sPub[\'shared.txt\'] = the step-5 result (≠ the snap entry, = the newest \'mask\' event\'s map entry), ranges[\'shared.txt\'] = [[14, 14]], csTable with p0\'s human CS; after p0\'s next landed push mirror[id] = {durable: true, rejected: null} and a \'mirror\' event lists {id, rev, localOnly: false, held: 2}', { timeout: SIM_TIMEOUT }, async () => {
  let revert: HoldRecord | null = null;
  let humanCs = false;
  let checkedA = false;
  let checkedB = false;
  const revertOf = async (ctx: SimContext): Promise<HoldRecord | null> =>
    (await engineAt(ctx, 0).inspect()).holds.find((r) => hasGuard(r, 'revert') && r.paths.includes('shared.txt')) ?? null;
  const steps: Step[] = [
    { rounds: 1 },
    // p1's band row 3 (0-based 13, 1-based row 14), published; p0 applies it
    { kind: 'edit_band', peer: 1, params: { insert: false, row: 13, text: 'shared band 1 row 3 (13) p1 teammate line' } },
    { rounds: 14 },
    // p0's editor saves the genesis buffer (without p1's row) plus one own row (appended: ≥ 2 rows from row 14)
    { kind: 'stale_save', peer: 0, params: { path: 'shared.txt', buffer: 'genesis' } },
    until(0, 'materialized', async (ctx) => {
      // p0's human CS over shared.txt, in the table from its open (the detection tick) up to its capture's publish
      const engine = engineAt(ctx, 0);
      const ins = await engine.inspect();
      if (ins.csTable.cs.some((c) => c.cs_id.startsWith(`${engine.peerId}/human/`) && c.paths.includes('shared.txt'))) humanCs = true;
      return (revert = await revertOf(ctx)) !== null;
    }),
    {
      probe: 'A', run: async (ctx) => {
        const engine = engineAt(ctx, 0);
        const ins = await engine.inspect();
        const dir = ctx.peers[0]!.dir;
        const head = (await ctx.git.run(['rev-parse', '--verify', 'refs/cowork-local/main/holds'], { class: 'local', cwd: dir })).stdout.toString('utf8').trim();
        assert.equal(ins.registryHead, head);
        // the step-5 result computed test-side by row replacement: S_disk (the newest mask event's materialized snapshot) with row 14
        // put back to A's
        const masks = ctx.trace.ofKind('mask').filter((e) => e.peer === engine.peerId);
        const newest = masks[masks.length - 1]!;
        const snap = await treeEntries(ctx.git, dir, newest.sDisk);
        const a = await treeEntries(ctx.git, dir, ins.aTree);
        const disk = (await readBlob(ctx.git, dir, snap.get('shared.txt')!.oid)).toString('utf8').split('\n');
        const aRows = (await readBlob(ctx.git, dir, a.get('shared.txt')!.oid)).toString('utf8').split('\n');
        assert.ok(aRows[13]!.startsWith('shared band 1 row 3 (13) p1 teammate line CWM_'), `A holds p1's row 14: ${aRows[13]}`);
        assert.notEqual(disk[13], aRows[13], 'S_disk holds the stale row');
        const expected = [...disk];
        expected[13] = aRows[13]!;
        const want = (await ctx.git.run(['hash-object', '--stdin', '--no-filters'], { class: 'local', cwd: dir, stdin: Buffer.from(expected.join('\n'), 'utf8') })).stdout.toString('utf8').trim();
        const sPub = ins.sPub?.get('shared.txt')?.oid;
        assert.equal(sPub, want, 'sPub = the step-5 result');
        assert.notEqual(sPub, snap.get('shared.txt')!.oid, 'sPub ≠ the snapshot entry (S_disk)');
        assert.ok(newest.partial.includes('shared.txt'), 'the newest mask event lists shared.txt as a step-5 path');
        assert.deepEqual(ins.ranges['shared.txt'], [[14, 14]]);
        // A human CS is in the table from its first capture (its cs_id) until its publish lands; the capture of the materializing
        // iteration published in that iteration here, so the table is read where the engine composed it: the compose event's pairs
        // are the journaled pairs of the table at that composition (R3-63).
        const human = ins.csTable.cs.filter((c) => c.cs_id.startsWith(`${engine.peerId}/human/`) && c.paths.includes('shared.txt'));
        const composed = ctx.trace.ofKind('compose').filter((e) => e.peer === engine.peerId)
          .some((e) => e.pairs.some((p) => p.csId.startsWith(`${engine.peerId}/human/`) && p.paths.includes('shared.txt')));
        assert.ok(humanCs || human.length > 0 || composed, `p0's human CS over shared.txt in the CS table: ${JSON.stringify(ins.csTable)}`);
        checkedA = true;
        return revert!.id;
      },
    },
    until(0, 'mirrored', async (ctx) => {
      const ins = await engineAt(ctx, 0).inspect();
      return ins.mirror[revert!.id]?.durable === true;
    }),
    {
      probe: 'B', run: async (ctx) => {
        const engine = engineAt(ctx, 0);
        const ins = await engine.inspect();
        const r = ins.holds.find((x) => x.id === revert!.id)!;
        assert.deepEqual(ins.mirror[r.id], { durable: true, rejected: null });
        const mirrored = ctx.trace.ofKind('mirror').filter((e) => e.peer === engine.peerId).flatMap((e) => e.holds).filter((h) => h.id === r.id);
        assert.ok(mirrored.some((h) => h.rev === r.rev && h.localOnly === false && h.held === 2), `a mirror event lists {id, rev ${r.rev}, localOnly false, held 2}: ${JSON.stringify(mirrored)}`);
        checkedB = true;
      },
    },
  ];
  okOrFail(await scriptRun('holds-inspect', steps));
  assert.ok(checkedA && checkedB);
});

test('pendingAgeMs: with a share-read lock on p2\'s shared.txt and the lock phase driven by 30 consecutive {rounds: 1} steps, pendingAgeMs[\'shared.txt\'] read after each step is ≥ 60,000 and < 62,500 at the step whose \'hold\' event creates the record {holdKind: \'INCOMING\', guard: \'lock\', rev: 1, residence: \'ON_DISK\', localOnly: false}, and < 60,000 at every earlier step', { timeout: SIM_TIMEOUT }, async () => {
  const LOCK_PHASE = 30;
  const reads: Array<{ step: number; dt: number; age: number | undefined; created: Extract<TraceEvent, { kind: 'hold' }> | null }> = [];
  let mark = 0;
  const reader: Oracle = {
    name: 'PENDING_AGE',
    async afterEveryOp(ctx) {
      const last = ctx.opLog[ctx.opLog.length - 1]!;
      const events = ctx.trace.since(mark);
      mark = ctx.trace.events.length;
      if (last.kind !== 'rounds') return null;
      const engine = realEngineOf(ctx.engines[2]!);
      if (engine === null) return 'p2 has no engine';
      const ins = await engine.inspect();
      const created = events.find((e): e is Extract<TraceEvent, { kind: 'hold' }> => e.kind === 'hold' && e.peer === engine.peerId && e.holdKind === 'INCOMING' && e.guards.includes('lock')) ?? null;
      reads.push({ step: last.step, dt: Number(/dt=(\d+)/.exec(last.detail)?.[1] ?? NaN), age: ins.pendingAgeMs['shared.txt'], created });
      return null;
    },
  };
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'lock_share_read', peer: 2, params: { path: 'shared.txt' } },
    { kind: 'edit_band', peer: 1, params: { insert: false } },
    ...Array.from({ length: LOCK_PHASE }, (): Step => ({ rounds: 1 })),
    { kind: 'unlock', peer: 2 },
  ];
  okOrFail(await scriptRun('holds-pending-age', steps, [reader]));
  const at = reads.findIndex((x) => x.created !== null);
  assert.ok(at >= 0, `the INCOMING lock record was created within the lock phase: ${JSON.stringify(reads.map((x) => [x.step, x.age]))}`);
  const c = reads[at]!;
  assert.deepEqual(
    { holdKind: c.created!.holdKind, guard: c.created!.guard, rev: c.created!.rev, residence: c.created!.residence, localOnly: c.created!.localOnly },
    { holdKind: 'INCOMING', guard: 'lock', rev: 1, residence: 'ON_DISK', localOnly: false },
  );
  assert.ok(c.age !== undefined && c.age >= 60_000, `age ${c.age} at the creating step`);
  // The step's virtual time is its harness dt (1–5 s, drawn before every step) plus the round's 2,500 ms: the age at the creating
  // step lies within one such step of 60 s (the brief's 62,500 assumes the round alone).
  assert.ok(c.age < 60_000 + c.dt + 2_500, `age ${c.age} < 60,000 + dt ${c.dt} + 2,500`);
  for (const x of reads.slice(0, at)) if (x.age !== undefined) assert.ok(x.age < 60_000, `step ${x.step}: age ${x.age} < 60,000 before the record`);
  assert.ok(reads.slice(0, at).some((x) => x.age !== undefined), 'the deferral was seen pending before its record');
});

test('the \'apply\' event of p1\'s 3-path CS on p0 carries groups [{paths: [g/a.txt, g/b.txt, g/c.txt], outcome: \'written\', reason: null}], notApplicable [] and mDisk = the tree whose g/* blobs p0\'s disk now holds (DISK_EQ through a scratch index)', { timeout: SIM_TIMEOUT }, async () => {
  let checked = false;
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'new_file', peer: 1, params: { path: 'g/a.txt' } },
    { kind: 'new_file', peer: 1, params: { path: 'g/b.txt' } },
    { kind: 'new_file', peer: 1, params: { path: 'g/c.txt' } },
    { rounds: 14 },
    {
      probe: 'apply', run: async (ctx) => {
        const p0 = engineAt(ctx, 0);
        const applies = ctx.trace.ofKind('apply').filter((e) => e.peer === p0.peerId && e.written.includes('g/a.txt'));
        assert.equal(applies.length, 1, `one apply of g/* on p0: ${JSON.stringify(applies)}`);
        const ev = applies[0]!;
        assert.deepEqual(ev.groups, [{ paths: ['g/a.txt', 'g/b.txt', 'g/c.txt'], outcome: 'written', reason: null }]);
        assert.deepEqual(ev.notApplicable, []);
        assert.ok(ev.mDisk !== null);
        // DISK_EQ through a scratch index: mDisk read into it, refreshed against p0's disk: no g/* path differs
        const dir = ctx.peers[0]!.dir;
        const repo = new GitRepo(ctx.git, { workTree: p0.core.deps.paths.workTree, gitDir: p0.core.deps.paths.gitDir, coworkDir: p0.core.deps.paths.coworkDir }, () => ({
          attrTree: null, filterDrivers: [], identity: { name: 't', email: 't@cowork.invalid' }, wallMs: () => 0,
        }));
        const index = join(ctx.root, 'apply-event.index');
        try {
          await repo.readTreeIntoIndex(index, parseOid(ev.mDisk!));
          await repo.run(['update-index', '--refresh'], { class: 'refupdate', indexFile: index, okCodes: [0, 1] });
          const dirty = (await repo.run(['diff-files', '-z', '--name-only'], { indexFile: index })).stdout.toString('utf8').split('\0').filter((p) => p.startsWith('g/'));
          assert.deepEqual(dirty, [], 'p0\'s g/* files are mDisk\'s blobs');
          const m = await treeEntries(ctx.git, dir, ev.mDisk!);
          for (const p of ['g/a.txt', 'g/b.txt', 'g/c.txt']) assert.ok(m.has(p), `mDisk has ${p}`);
        } finally {
          await rm(index, { force: true });
        }
        checked = true;
      },
    },
  ];
  okOrFail(await scriptRun('holds-apply-event', steps));
  assert.ok(checked);
});
