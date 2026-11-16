// The holds catalogue's ops against the real engine: the mass-change breaker, generated?, the resolve verbs, gc and crashes (Plan 3
// Task 13; 11-testing §3.5 F-ED-3, F-HLD-1, F-FS-4, F-FS-5; HLD-27, HLD-30, HLD-31, DAT-39, Table 4). Scripted holds runs (and one drawn
// crash run) on real git against file:// bare remotes (fix round 1 split of sim.holds.ops.test.ts; helpers in
// test/helpers/holdsScript.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOLD_CODES, HOLD_LOG_CODES } from '../../src/holds/codes.js';
import { isTerminal } from '../../src/holds/record.js';
import { seededRandom } from '../../src/ports/random.js';
import { SIM_TIMEOUT, okOrFail, type Probe, type Step, scriptRun, engineAt, until, has, holdsOf, live, liveFile, disk, logCodes } from '../helpers/holdsScript.js';
import { realEngineOf } from '../sim/engineAdapter.js';
import { holdsOp, holdsSetup, seedFilesPlan3 } from '../sim/generators.js';
import { advanceClocks, runSim, type Oracle, type SimContext } from '../sim/harness.js';
import { readBlob, readRegistry, treeEntries } from '../sim/holdsView.js';
import type { MarkerModel } from '../sim/markers.js';
import { exitOracles } from '../sim/oracles.js';

// ---- HLD-30, HLD-31: the mass-change breaker --------------------------------------------------------------------------------

/** One formatter run: p0's earlier fmt row published, the formatter on p1, MASS at p1's next tick, resume, one human CS. */
async function formatterRun(seed: string, glob: string, files: number, seedFiles?: Record<string, Buffer>): Promise<void> {
  let frozenAt = -1;
  let checked = false;
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'edit_own', peer: 0, params: { path: 'fmt/m05.py', row: 3, text: '    v4 = 4 p0 earlier' } },
    { rounds: 12 },
    { kind: 'formatter', peer: 1, params: { glob } },
    { advance: 2_500 },
    { iterate: 1 },
    {
      probe: 'frozen', run: async (ctx) => {
        const p1 = engineAt(ctx, 1);
        const ins = await p1.inspect();
        assert.ok(ins.freeze.includes('MASS'), `p1 entered FREEZE(MASS) at its next detection tick: ${JSON.stringify(ins.freeze)}`);
        const mass = ctx.trace.ofKind('mass').filter((e) => e.peer === p1.peerId && e.entered);
        assert.equal(mass.length, 1, 'it tripped once');
        assert.equal(mass[0]!.paths, files, `over ${files} files`);
        frozenAt = ctx.trace.events.length;
      },
    },
    { rounds: 4 },
    {
      probe: 'no code publish', run: async (ctx) => {
        const p1 = engineAt(ctx, 1);
        assert.deepEqual(ctx.trace.since(frozenAt).filter((e) => e.kind === 'publish' && e.peer === p1.peerId && e.c !== null), [], 'no code publish while frozen');
      },
    },
    { kind: 'resume', peer: 1 },
    { rounds: 12 },
    {
      probe: 'published', run: async (ctx) => {
        const p1 = engineAt(ctx, 1);
        const ins = await p1.inspect();
        assert.ok(!ins.freeze.includes('MASS'), 'resume lifted MASS');
        const pubs = ctx.trace.since(frozenAt).filter((e): e is Extract<typeof e, { kind: 'publish' }> => e.kind === 'publish' && e.peer === p1.peerId && e.c !== null);
        assert.equal(pubs.length, 1, 'the formatting published in one commit');
        const trailers = (await ctx.git.run(['log', '-1', '--format=%(trailers:key=Cowork-CS,valueonly)', pubs[0]!.c!], { class: 'local', cwd: ctx.peers[1]!.dir })).stdout.toString('utf8').trim().split('\n').filter((l) => l.length > 0);
        assert.equal(trailers.length, 1, `one human CS: ${trailers.join(' | ')}`);
        assert.match(trailers[0]!, new RegExp(`^${p1.peerId}/human/`));
        const changed = (await ctx.git.run(['diff-tree', '-r', '--name-only', '--no-commit-id', pubs[0]!.c!], { class: 'local', cwd: ctx.peers[1]!.dir })).stdout.toString('utf8').trim().split('\n');
        assert.equal(changed.length, files, `the commit carries all ${files} files`);
        assert.equal(ins.holds.filter((r) => has(r, 'revert')).length, 0, 'the reindent of p0\'s earlier row created no revert record (ws-equal)');
        assert.ok((await liveFile(ctx, 'fmt/m05.py'))!.toString('latin1').includes('  v4 = 4 p0 earlier'), 'p0\'s row, reindented, is live');
        checked = true;
      },
    },
  ];
  okOrFail((await scriptRun(seed, () => steps, seedFiles === undefined ? {} : { seedFiles })).r);
  assert.ok(checked);
}

test('formatter over the 24 fmt files on p1 enters FREEZE(MASS) at p1\'s next detection tick (no code publish while hold ops still mirror), resume lifts it, the formatting publishes in one human CS, and the whitespace-only reindent of p0\'s earlier fmt rows creates no revert record on p1 (ws-equal pairs, HLD-27); the same with seedFiles adding fmt/x000.py…fmt/x179.py and glob \'fmt/**\' trips once over 204 files', { timeout: 2 * SIM_TIMEOUT }, async () => {
  await formatterRun('holds-formatter-24', 'fmt/*.py', 24);
  const seedFiles = seedFilesPlan3(seededRandom('holds-formatter-204/files'));
  for (let x = 0; x < 180; x++) seedFiles[`fmt/x${String(x).padStart(3, '0')}.py`] = Buffer.from(Array.from({ length: 12 }, (_, k) => `    x${x}_${k + 1} = ${k + 1}\n`).join(''), 'utf8');
  await formatterRun('holds-formatter-204', 'fmt/**', 204, seedFiles);
});

// ---- DAT-39: generated? ------------------------------------------------------------------------------------------------------

test('generated? exclude: three consecutive p0 rewrites of 12 of the 20 rows of gen/out.txt at three detection ticks give one ON_DISK PATCH \'generated?\' (GENERATED_SUSPECT); resolve --discard writes nothing, sets guard generated?:exclude, keeps gen/out.txt masked and releases the dependency PIN of its CS in that loop', { timeout: SIM_TIMEOUT }, async (t) => {
  const GEN = 'gen/out.txt';
  const rows = (v: number): Buffer => Buffer.from(Array.from({ length: 20 }, (_, k) => `gen row ${k}${k < 12 && v > 0 ? ` v${v}` : ''}\n`).join(''), 'utf8');
  const seedFiles = { ...seedFilesPlan3(seededRandom('holds-generated/files')), [GEN]: rows(0) };
  /** One rewrite of rows 0–11 on p0's disk, then p0's next detection tick 2.5 s later (one harness step: no suspend-sized gap). */
  const rewriteAndTick = (v: number): Probe => ({
    probe: `rewrite ${v}`, run: async (ctx) => {
      const abs = join(ctx.peers[0]!.dir, 'gen', 'out.txt');
      await writeFile(abs, rows(v));
      const at = ctx.clocks.get('p0')!.wallMs() / 1_000;
      await utimes(abs, at, at);
      advanceClocks(ctx, 2_500);
      await ctx.engines[0]!.step(ctx);
      await ctx.scheduler.runUntilIdle(10_000);
    },
  });
  /** What the run showed; the brief's clauses are asserted after it (some in the todo below). */
  const facts = {
    created: null as { id: string; residence: string | null; state: string; kind: string } | null, suspect: false,
    survived: false, pin: null as string | null, pinPaths: [] as string[],
    discard: null as unknown, unwritten: false, exclude: false, pinReleased: false, masked: false, otherPublished: false,
  };
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'edit_own', peer: 0, params: { path: 'fmt/m06.py', row: 3, text: '    v4 = 4 p0 with the generator' } },   // the CS's other path
    rewriteAndTick(1),
    rewriteAndTick(2),
    rewriteAndTick(3),
    {
      probe: 'created', run: async (ctx) => {
        const peer = engineAt(ctx, 0).peerId;
        const ev = ctx.trace.ofKind('hold').find((e) => e.peer === peer && e.rev === 1 && e.guards.includes('generated?') && e.paths.includes(GEN));
        if (ev !== undefined) facts.created = { id: ev.id, residence: ev.residence, state: ev.state, kind: ev.holdKind };
        facts.suspect = (await logCodes(ctx, 0)).some((l) => l.code === 'GENERATED_SUSPECT' && l.params['path'] === GEN);
      },
    },
    { rounds: 12 },
    {
      probe: 'suspect', run: async (ctx) => {
        const rs = live(await holdsOf(ctx, 0));
        const g = rs.find((r) => r.id === facts.created?.id);
        facts.survived = g !== undefined && g.residence === 'ON_DISK';
        const pins = rs.filter((r) => r.kind === 'PIN' && r.guards.some((x) => x.name === `dependency:${facts.created?.id}`));
        if (pins.length === 1) {
          facts.pin = pins[0]!.id;
          facts.pinPaths = pins[0]!.paths;
        }
      },
    },
    {
      probe: 'discard', run: async (ctx) => {
        if (facts.created === null) return;
        const before = await disk(ctx, 0, GEN);
        facts.discard = await engineAt(ctx, 0).resolve(facts.created.id, 'discard', { humanEvidence: true, actor: 'human' });
        facts.unwritten = (await disk(ctx, 0, GEN))?.equals(before!) === true;
        const all = await holdsOf(ctx, 0);
        const g = all.find((r) => r.id === facts.created!.id);
        facts.exclude = g !== undefined && !isTerminal(g) && g.guards.some((x) => x.name === 'generated?:exclude');
        // Table 3 (`generated?` exclude): "HLD-42 PINs depending on the record release at once" — the PIN's dependency guard goes
        // (releaseDependencyGuards in resolve's loop, as dependencyPin.test.ts reads a release: guards []), terminal or not.
        const pin = all.find((r) => r.id === facts.pin);
        facts.pinReleased = pin !== undefined && (isTerminal(pin) || !pin.guards.some((x) => x.name === `dependency:${facts.created!.id}`));
      },
    },
    { rounds: 12 },
    {
      probe: 'masked', run: async (ctx) => {
        const ins = await engineAt(ctx, 0).inspect();
        const a = await treeEntries(ctx.git, ctx.peers[0]!.dir, ins.aTree);
        facts.masked = ins.sPub?.get(GEN)?.oid === a.get(GEN)?.oid && !(await liveFile(ctx, GEN))!.toString('latin1').includes(' v3');
        facts.otherPublished = (await liveFile(ctx, 'fmt/m06.py'))!.toString('latin1').includes('p0 with the generator');
      },
    },
  ];
  okOrFail((await scriptRun('holds-generated', () => steps, { seedFiles })).r);
  // DAT-39 at the third tick: one ON_DISK PATCH generated? and GENERATED_SUSPECT.
  assert.deepEqual(facts.created && { residence: facts.created.residence, state: facts.created.state, kind: facts.created.kind }, { residence: 'ON_DISK', state: 'ACTIVE', kind: 'PATCH' }, 'one ON_DISK PATCH generated? at the third tick');
  assert.ok(facts.suspect, 'GENERATED_SUSPECT');
  // The rest needs the record to stay ON_DISK. Task 13 found it ended GONE in the iteration that created it: R1 (evaluateRecords) ran on
  // a tick-only iteration against the last materialized S_disk, whose gen/out.txt is A's. Since Plan 3 Task EF R1 takes no S_disk verdict
  // for a path whose S_disk is not current (the tick changed it since the last materialization).
  await t.test('the generated? record persists; --discard answers it (generated?:exclude, nothing written), masks gen/out.txt and releases its CS\'s dependency PIN in that loop', () => {
    assert.ok(facts.survived, 'the record is still ON_DISK after its creation');
    // R3-44: HLD-42's dependency PIN is over the group's LIVE paths minus local_only record paths — the generated? path included (as
    // dependencyPin.test.ts's TC-HLD-10 dependency half pins gen/api.ts and src/use.ts).
    assert.deepEqual(facts.pinPaths, ['fmt/m06.py', GEN], 'its CS\'s dependency PIN');
    assert.deepEqual(facts.discard, { kind: 'done', code: 'HOLD_ANSWERED', id: facts.created?.id, created: null });
    assert.ok(facts.unwritten, 'nothing written');
    assert.ok(facts.exclude, 'generated?:exclude');
    assert.ok(facts.pinReleased, 'the PIN released in that loop');
    assert.ok(facts.masked, 'gen/out.txt masked');
    assert.ok(facts.otherPublished, 'the CS\'s other path published');
  });
});

// ---- Table 4 ---------------------------------------------------------------------------------------------------------------

test('resolve verbs on revert PATCHes: --park → OFF_DISK PARKED (HOLD_PARKED) with p0\'s disk equal to A on the held rows; --restore of that record → ON_DISK with the held rows back (HOLD_RESTORED); --discard on another → RESOLVED_DISCARD with one \'discard\' trace event naming its h1 blob; every result code is in HOLD_CODES', { timeout: SIM_TIMEOUT }, async () => {
  const ids = { shared: '', other: '' };
  const codes: string[] = [];
  let checked = false;
  const make = (markers: MarkerModel): Step[] => {
    const verb = (label: string, which: 'shared' | 'other', v: 'park' | 'restore' | 'discard'): Probe => ({
      probe: label, run: async (ctx) => {
        const detail = await holdsOp({ kind: 'resolve', peer: 0, params: { id: ids[which], verb: v } }, markers).run(ctx);
        const m = / → done ([A-Z_]+)$/.exec(detail);
        assert.ok(m !== null, `resolve --${v}: ${detail}`);
        codes.push(m[1]!);
        return detail;
      },
    });
    return [
      { rounds: 1 },
      { kind: 'edit_band', peer: 1, params: { path: 'shared.txt', insert: true, row: 30, n: 1, text: 'p1-line' } },
      { kind: 'edit_band', peer: 1, params: { path: 'fmt/m07.py', insert: true, row: 6, n: 1, text: 'p1-line' } },
      { rounds: 12 },
      { kind: 'stale_save', peer: 0, params: { path: 'shared.txt', buffer: 'genesis' } },
      { kind: 'stale_save', peer: 0, params: { path: 'fmt/m07.py', buffer: 'genesis' } },
      { rounds: 12 },
      {
        probe: 'two', run: async (ctx) => {
          const rs = live(await holdsOf(ctx, 0)).filter((r) => has(r, 'revert') && r.kind === 'PATCH');
          ids.shared = rs.find((r) => r.paths.includes('shared.txt'))!.id;
          ids.other = rs.find((r) => r.paths.includes('fmt/m07.py'))!.id;
        },
      },
      verb('park', 'shared', 'park'),
      {
        probe: 'parked', run: async (ctx) => {
          const ins = await engineAt(ctx, 0).inspect();
          const r = ins.holds.find((x) => x.id === ids.shared)!;
          assert.deepEqual([r.residence, r.state], ['OFF_DISK', 'PARKED']);
          const a = await treeEntries(ctx.git, ctx.peers[0]!.dir, ins.aTree);
          assert.deepEqual(await disk(ctx, 0, 'shared.txt'), await readBlob(ctx.git, ctx.peers[0]!.dir, a.get('shared.txt')!.oid), 'p0\'s disk equals A');
        },
      },
      { rounds: 2 },
      verb('restore', 'shared', 'restore'),
      {
        probe: 'restored', run: async (ctx) => {
          const r = (await holdsOf(ctx, 0)).find((x) => x.id === ids.shared)!;
          assert.equal(r.residence, 'ON_DISK');
          assert.ok(!(await disk(ctx, 0, 'shared.txt'))!.toString('latin1').includes('p1-line'), 'the held rows are back');
        },
      },
      { rounds: 2 },
      verb('discard', 'other', 'discard'),
      {
        probe: 'discarded', run: async (ctx) => {
          const peer = engineAt(ctx, 0).peerId;
          const r = (await holdsOf(ctx, 0)).find((x) => x.id === ids.other)!;
          assert.equal(r.state, 'RESOLVED_DISCARD');
          const evs = ctx.trace.ofKind('discard').filter((e) => e.peer === peer);
          assert.equal(evs.length, 1, 'one discard event');
          const h1 = (r.blobs as { h1: Record<string, string> }).h1['fmt/m07.py'];
          assert.deepEqual(evs[0]!.held, [{ path: 'fmt/m07.py', blob: h1 }], 'it names the h1 blob');
        },
      },
      { rounds: 1 },   // the adapter writes a daemon's queued log lines at the end of its next step
      {
        probe: 'logged', run: async (ctx) => {
          const codesLogged = (await logCodes(ctx, 0)).map((l) => l.code);
          assert.ok(codesLogged.includes('HOLD_DISCARDED'), 'R3-28\'s log line');
          assert.ok(codesLogged.includes('HOLD_PARKED') && codesLogged.includes('HOLD_RESTORED'), 'the operators\' codes');
          checked = true;
        },
      },
    ];
  };
  okOrFail((await scriptRun('holds-resolve-verbs', make)).r);
  assert.ok(checked);
  assert.deepEqual(codes, ['HOLD_PARKED', 'HOLD_RESTORED', 'RESOLVED_DISCARD']);
  // HOLD_PARKED and HOLD_RESTORED are HOLD_CODES; RESOLVED_DISCARD is resolve()'s CLI result word, logged as HOLD_DISCARDED (HOLD_LOG_CODES,
  // Task 11 ruling): the codes the verbs write to status and the log are all registered.
  assert.ok(HOLD_CODES.includes('HOLD_PARKED') && HOLD_CODES.includes('HOLD_RESTORED') && HOLD_LOG_CODES.includes('HOLD_DISCARDED'));
});

// ---- F-FS-4 ----------------------------------------------------------------------------------------------------------------

test('gc_prune between two materializing iterations of p0 holding an ON_DISK revert PATCH: every oid named by p0\'s registry records and state journal exists afterwards (cat-file -e) and the next \'mask\' event\'s step-5 result for that path equals the previous one', { timeout: SIM_TIMEOUT }, async () => {
  let before: string | undefined;
  let masks = 0;
  let checked = false;
  const maskCount = async (ctx: SimContext): Promise<number> => ctx.trace.ofKind('mask').filter((e) => e.peer === engineAt(ctx, 0).peerId).length;
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { path: 'shared.txt', insert: true, row: 30, n: 1, text: 'p1-line' } },
    { rounds: 12 },
    { kind: 'stale_save', peer: 0, params: { path: 'shared.txt', buffer: 'genesis' } },
    until(0, 'revert', async (ctx) => live(await holdsOf(ctx, 0)).some((r) => has(r, 'revert'))),
    {
      probe: 'before', run: async (ctx) => {
        before = (await engineAt(ctx, 0).inspect()).sPub?.get('shared.txt')?.oid;
        assert.ok(before !== undefined);
        masks = await maskCount(ctx);
      },
    },
    { kind: 'gc_prune', peer: 0 },
    { kind: 'edit_own', peer: 0, params: { path: 'fmt/m08.py', row: 3, text: '    v4 = 4 p0 after gc' } },
    until(0, 'next mask', async (ctx) => (await maskCount(ctx)) > masks),
    {
      probe: 'after', run: async (ctx) => {
        assert.match(ctx.opLog.find((e) => e.kind === 'gc_prune')!.detail, /rc=0$/);
        const dir = ctx.peers[0]!.dir;
        const oids = new Set<string>();
        for (const r of (await readRegistry(ctx.git, dir, 'main')).records.values()) {
          for (const side of Object.values(r.blobs) as Array<Record<string, string>>) for (const o of Object.values(side)) if (o !== 'ABSENT') oids.add(o);
        }
        for (const e of (await treeEntries(ctx.git, dir, 'refs/cowork-local/main/state^{tree}')).values()) oids.add(e.oid);
        const r = await ctx.git.run(['cat-file', '--batch-check'], { class: 'local', cwd: dir, stdin: Buffer.from(`${[...oids].join('\n')}\n`, 'utf8') });
        assert.ok(!r.stdout.toString('utf8').includes('missing'), `every named oid exists after gc: ${r.stdout.toString('utf8').split('\n').filter((l) => l.includes('missing')).join(', ')}`);
        assert.ok(oids.size > 5);
        assert.equal((await engineAt(ctx, 0).inspect()).sPub?.get('shared.txt')?.oid, before, 'the step-5 result is unchanged');
        checked = true;
      },
    },
  ];
  okOrFail((await scriptRun('holds-gc-prune', () => steps)).r);
  assert.ok(checked);
});

// ---- F-FS-5 ----------------------------------------------------------------------------------------------------------------

/** Pinned at implementation time (Task 13 Notes): the first `holds-crash-smoke-<k>` whose run ends a step with a KilledAt — k = 0 arms one crash that its op budget disarms, k = 1 kills p1 at snapshot.index_written. */
const CRASH_SEED = 'holds-crash-smoke-1';

test('with crashRate 0.25 and 12 steps on a pinned seed at least one KilledAt ends a step, realEngineOf returns a new Engine for that peer at its next step, its registry head is the old or the new commit of any interrupted registry commit, and Plan 2\'s six exit oracles pass', { timeout: SIM_TIMEOUT }, async () => {
  const s = holdsSetup(CRASH_SEED, { crashRate: 0.25, steps: 12 });
  /** Per peer: every Engine object seen so far, and the registry head after the last step. */
  const engines = new Map<string, Set<unknown>>();
  const heads = new Map<string, string | null>();
  /** Killed peers waiting for their next running Engine, with the Engines seen before the kill. */
  const waiting: Array<{ peer: string; before: Set<unknown> }> = [];
  let renewed = 0;
  let logged = 0;
  const regHead = async (ctx: SimContext, dir: string): Promise<string | null> => {
    const r = await ctx.git.run(['rev-parse', '--verify', '--quiet', 'refs/cowork-local/main/holds'], { class: 'local', cwd: dir });
    return r.code === 0 ? r.stdout.toString('utf8').trim() : null;
  };
  const tracker: Oracle = {
    name: 'KILLS',
    async afterEveryOp(ctx) {
      for (const e of ctx.opLog.slice(logged)) {
        if (e.kind !== 'killed') continue;
        const i = ctx.peers.findIndex((p) => p.name === e.peer);
        const dir = ctx.peers[i]!.dir;
        if (realEngineOf(ctx.engines[i]!) !== null) return `${e.peer}: still has an Engine after its KilledAt`;
        waiting.push({ peer: e.peer, before: new Set(engines.get(e.peer) ?? []) });
        // the registry is the old commit or a later one on its chain: an interrupted registry commit is all or nothing
        const before = heads.get(e.peer) ?? null;
        const now = await regHead(ctx, dir);
        if (before !== null && now !== before) {
          const anc = now === null ? null : await ctx.git.run(['merge-base', '--is-ancestor', before, now], { class: 'local', cwd: dir });
          if (anc === null || anc.code !== 0) return `${e.peer}: registry head ${now} is neither ${before} nor after it`;
        }
        await readRegistry(ctx.git, dir, 'main');   // and it parses
      }
      logged = ctx.opLog.length;
      for (const [i, p] of ctx.peers.entries()) {
        const engine = realEngineOf(ctx.engines[i]!);
        if (engine !== null) {
          for (const w of waiting.filter((x) => x.peer === p.name)) {
            if (w.before.has(engine)) return `${p.name}: runs the Engine it had before its KilledAt`;
            renewed++;
            waiting.splice(waiting.indexOf(w), 1);
          }
          if (!engines.has(p.name)) engines.set(p.name, new Set());
          engines.get(p.name)!.add(engine);
        }
        heads.set(p.name, await regHead(ctx, p.dir));
      }
      return null;
    },
  };
  const r = await runSim(s.tuple, s.factory, [...exitOracles(), tracker], s.options);
  okOrFail(r);
  const killed = r.opLog.filter((e) => e.kind === 'killed');
  assert.ok(killed.length >= 1, `the pinned seed ${CRASH_SEED} no longer ends a step with a KilledAt: re-pick it (scan holds-crash-smoke-<k> from k = 0)`);
  assert.ok(renewed >= 1, 'a killed peer runs a new Engine at its next step');
});
