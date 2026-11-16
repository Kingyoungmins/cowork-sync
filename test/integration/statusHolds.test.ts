// status.json from hold records (Plan 3 Task 12a; 05-holds HLD-24; 01-engine ENG-57, test 42; I3, CS-12, CS-30, CS-45, T-06, T-10,
// I-DAT-08 keep variant; rulings R3-46, R3-53, R3-56, R3-61; contract addition 4): the counts, not_converged extending Plan 2's
// entries with every ON_DISK record path, deferred and not-applicable paths, the groups FREEZE or a pause keeps back, R3-56's
// record-less exclusions, and the HOLD_DIVERGED_REGIONS / CS_NO_CHECKS_CONFIGURED messages. makeEngines({n: 2}); the records come
// from the Plan 3 creators the loop runs (the revert detector, R-07's eol-bom, portabilityStep, incomingStep, resolve) or, for the
// guards whose creator needs a later plan's input, from HoldRegistry.hold as those creators call it. Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regionSpecId, PLAN2_REGION_SPEC } from '../../src/engine/deps.js';
import type { Oid } from '../../src/git/oid.js';
import type { HoldBlobs } from '../../src/holds/record.js';
import type { SimContext } from '../sim/harness.js';
import { oracleConverge } from '../sim/oracles.js';
import { readWork, workPath, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { logOf, remoteBoardTip, withEngines, type EngineFixture } from '../helpers/engineFixture.js';
import { fpy, humanRemovesTeamLine, roundsUntil, statusOf, T10, teammateLine, withGuard } from '../helpers/loopHoldsFixture.js';
import { buf, failedResult, wrapGit } from '../helpers/publishHelpers.js';

const N = 30;
const WIN = process.platform === 'win32';
/** A stageable non-portable new name (portabilityStep's record): a reserved device name off Windows, an over-long component on it. */
const NOT_PORTABLE = WIN ? `${'\u{d55c}'.repeat(100)}.txt` : 'con.py';
const FILES: Record<string, Buffer> = {
  'README.md': buf('# status holds\n'),
  '.gitignore': buf('.env\nblk\n'),
  'f.py': buf(fpy(N)),
  'g.py': buf(fpy(12).replace(/row_/g, 'g_')),
  'other.txt': buf('other 1\nother 2\nother 3\n'),
  'mixed.txt': buf('a\r\nb\nc\r\nd\n'),
};
const N_PKG = 200;
const N_FMT = 180;
const pkg = (i: number): string => `pkg/m${i}.py`;
const pkgText = (i: number, q: string): string => Array.from({ length: 20 }, (_, j) => `x_${j} = ${q}v${i}_${j}${q}\n`).join('');
const MASS_FILES: Record<string, Buffer> = { ...FILES, ...Object.fromEntries(Array.from({ length: N_PKG }, (_, i) => [pkg(i), buf(pkgText(i, "'"))])) };

type EnginePeer = EngineFixture['peers'][number];

async function started(fx: EngineFixture): Promise<EnginePeer> {
  await fx.startAll();
  await fx.rounds(2);
  return fx.peers[0]!;
}

/** One iteration of p alone, `ms` later. */
async function step(fx: EngineFixture, p: EnginePeer, ms = 2_500): Promise<void> {
  fx.advance(ms);
  await p.engine.iterate();
}

const incomingOn = (p: PeerFixture, path: string): boolean => p.core.holds.nonTerminal().some((r) => r.kind === 'INCOMING' && r.paths.includes(path));

test('holds_active counts non-terminal non-INCOMING records, holds_local_only those with local_only, incoming the INCOMING records plus closure paths deferred under 60 s (each path once), and cs_open/cs_ready come from the CS table', T10, async () => {
  await withEngines('sh-counts', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    // A revert record (the detector), a local_only portability record (portabilityStep).
    await teammateLine(fx, p, N, 10);
    await humanRemovesTeamLine(fx, p, N);
    await writeWork(p, NOT_PORTABLE, 'not portable\n');
    await roundsUntil(fx, () => withGuard(p, 'portability').length === 1, 'the portability record');
    // An INCOMING collision record (incomingStep): its path is also a not-applicable meta.pending row — counted once.
    await writeWork(p, '.env', 'LOCAL=1\n');
    await fx.pushTeamChange({ '.env': buf('TEAM=1\n') });
    await roundsUntil(fx, () => incomingOn(p, '.env'), 'the INCOMING collision record');
    assert.equal(p.core.view!.meta.pending['.env'], 'collision');
    // A closure deferred under 60 s (a lock on other.txt): no record yet, one deferred path.
    const release = p.fs.holdLock(workPath(p, 'other.txt'), 'share-none');
    try {
      await fx.pushTeamChange({ 'other.txt': buf('other 1\nother 2 team\nother 3\n') });
      await roundsUntil(fx, () => Object.hasOwn(p.core.view!.meta.pending, 'other.txt'), 'the deferred closure');
      assert.equal(incomingOn(p, 'other.txt'), false, 'younger than 60 s: no record');
      // An open human CS on g.py.
      await writeWork(p, 'g.py', fpy(12, { replace: { 5: 'g_5 = 55' } }).replace(/row_/g, 'g_'));
      await step(fx, p);
      const s = await statusOf(p);
      const nonTerminal = p.core.holds.nonTerminal();
      const local = nonTerminal.filter((r) => r.kind !== 'INCOMING');
      assert.ok(local.some((r) => r.guards.some((g) => g.name === 'revert')) && local.some((r) => r.local_only), 'a revert and a local_only record');
      assert.equal(s.pending.holds_active, local.length, 'holds_active: non-terminal non-INCOMING records');
      assert.equal(s.pending.holds_local_only, local.filter((r) => r.local_only).length, 'holds_local_only: those with local_only');
      assert.ok(s.pending.holds_local_only >= 1);
      assert.equal(s.pending.incoming, 2, 'incoming: .env (record and pending row, once) and other.txt (a deferral under 60 s)');
      const counts = p.core.cs.counts();
      assert.equal(s.pending.cs_open, counts.open);
      assert.ok(s.pending.cs_open >= 1, 'the open human CS');
      assert.equal(s.pending.cs_ready, p.core.cs.ready().length);
      assert.equal(s.pending.cs_ready, Object.keys((await p.engine.inspect()).csTable.orders).length, 'the CS table\'s journaled pairs');
    } finally {
      release();
    }
  });
});

test('HLD-24, R3-30 (EF4 E3-2, R3-EF4-6): a not-applicable meta.pending row whose INCOMING record ended SUBSUMED under FREEZE(MASS) is no incoming path once older than 60 s (incoming = non-terminal INCOMING records ∪ rows younger than 60 s)', T10, async () => {
  await withEngines('sh-na-frozen', { n: 2, files: MASS_FILES }, async (fx) => {
    const p = await started(fx);
    // An unmaterializable incoming path (beneath a local file, P2-NOFOLLOW): its own INCOMING record at once, a meta.pending row.
    await writeWork(p, 'blk', 'a local file\n');
    await fx.pushTeamChange({ 'blk/x.txt': buf('x\n') });
    await roundsUntil(fx, () => incomingOn(p, 'blk/x.txt'), 'the INCOMING unmaterializable record');
    assert.equal(p.core.view!.meta.pending['blk/x.txt'], 'unmaterializable');
    // FREEZE(MASS): a formatter over 180 files; no apply is admitted from here on, so nothing rebuilds meta.pending (R-05).
    for (let i = 0; i < N_FMT; i++) await writeWork(p, pkg(i), pkgText(i, '"'));
    await step(fx, p);
    assert.ok(p.core.view!.meta.freeze_reasons.includes('MASS'), 'FREEZE(MASS)');
    // The team removes the path (TIP no longer changes it): HLD-54 ends the record SUBSUMED; the row stays.
    await fx.pushTeamChange({ 'blk/x.txt': null });
    await step(fx, p, 61_000);
    await step(fx, p);
    await step(fx, p);
    assert.ok(p.core.view!.meta.freeze_reasons.includes('MASS'), 'still frozen');
    assert.equal(incomingOn(p, 'blk/x.txt'), false, 'the record ended (HLD-54: TIP no longer changes the path)');
    assert.ok(Object.hasOwn(p.core.view!.meta.pending, 'blk/x.txt'), 'the meta.pending row outlives its record (precondition)');
    assert.ok(((await p.engine.inspect()).pendingAgeMs['blk/x.txt'] ?? 0) >= 60_000, 'the row is older than 60 s (precondition)');
    const s = await statusOf(p);
    assert.equal(s.pending.incoming, 0, `incoming = INCOMING records + rows younger than 60 s: none (${JSON.stringify({ ...s.pending, not_converged: s.pending.not_converged.length })})`);
    assert.ok(s.pending.not_converged.includes('blk/x.txt'), 'the row is still listed in not_converged (R3-EF4-6: no stale-row drop)');
  });
});

test('T-10: not_converged lists every path of every ON_DISK record of each Plan 3 kind plus deferred and not-applicable paths, and no OFF_DISK record path', T10, async () => {
  await withEngines('sh-t10', { n: 2, files: { ...FILES, 'k.txt': buf('k1\nk2\nk3\n'), 'gen.ts': buf('export const v = 1;\n'), 'm.txt': buf('m1\nm2\nm3\n'), 'park.txt': buf('park\n'), 'u.txt': buf('u1\n') } }, async (fx) => {
    const p = await started(fx);
    const want: Record<string, string> = {};
    // revert (the detector)
    await teammateLine(fx, p, N, 10);
    await humanRemovesTeamLine(fx, p, N);
    want['f.py'] = 'revert';
    // eol-bom (R-07 at a canon refusal)
    await writeWork(p, 'mixed.txt', 'a\nb\nc\nd\nE\n');
    await roundsUntil(fx, () => withGuard(p, 'eol-bom').length === 1, 'the eol-bom record');
    want['mixed.txt'] = 'eol-bom';
    // portability (portabilityStep)
    await writeWork(p, NOT_PORTABLE, 'not portable\n');
    await roundsUntil(fx, () => withGuard(p, 'portability').length === 1, 'the portability record');
    want[NOT_PORTABLE] = 'portability';
    // collision:keep (incomingStep's collision record, then the human's --discard = keep local, DAT-29) and unmaterializable
    // (an incoming path beneath a local file, P2-NOFOLLOW)
    await writeWork(p, '.env', 'LOCAL=1\n');
    await writeWork(p, 'blk', 'a local file\n');
    await fx.pushTeamChange({ '.env': buf('TEAM=1\n'), 'blk/x.txt': buf('x\n') });
    await roundsUntil(fx, () => incomingOn(p, '.env') && incomingOn(p, 'blk/x.txt'), 'both INCOMING records');
    const collision = p.core.holds.nonTerminal().find((r) => r.kind === 'INCOMING' && r.paths.includes('.env'))!;
    assert.equal((await fx.resolve(0, collision.id, 'discard')).kind, 'done');
    assert.ok(p.core.holds.get(collision.id)!.guards.some((g) => g.name === 'collision:keep'), 'collision:keep');
    want['.env'] = 'collision:keep';
    want['blk/x.txt'] = 'unmaterializable';
    // a lock-deferred closure (no record before 60 s)
    const release = p.fs.holdLock(workPath(p, 'other.txt'), 'share-none');
    const unreadable = p.fs.holdLock(workPath(p, 'new.txt'), 'share-none');
    let unreadableTracked: (() => void) | null = null;
    try {
      await fx.pushTeamChange({ 'other.txt': buf('other 1\nother 2 team\nother 3\n') });
      await roundsUntil(fx, () => Object.hasOwn(p.core.view!.meta.pending, 'other.txt'), 'the deferred closure');
      want['other.txt'] = 'lock-deferred';
      // a never-staged unreadable new file older than 60 s: no record (R3-56), listed
      await writeWork(p, 'new.txt', 'never staged\n');
      // Fix round 1 (finding 4): an `unreadable` PIN (Task 6's transient PIN, HLD-32): a tracked file the human changed, then held
      // without read sharing before any tick read it, stays a publish-side `unreadable` exclusion; after 60 s incomingStep holds it in
      // a PIN (h0 = A[p], h1 = the private index's blob), whose path is listed as blocked_publish.
      await writeWork(p, 'u.txt', 'u2 local\n');
      unreadableTracked = p.fs.holdLock(workPath(p, 'u.txt'), 'share-none');
      // markers, generated? and conflict (a K4 stage record before its TIP write): the records their creators make (RESTORE with
      // markers, churnStep, the apply's conflict function) are made here through HoldRegistry.hold as those creators call it, with the
      // disk each one leaves behind; a PARKED (OFF_DISK) record's path must not be listed.
      const A = await p.core.repo.readTreeMap(p.core.view!.base);
      const blob = (text: string): Promise<Oid> => p.core.repo.hashBytes(buf(text), true);
      const hold = (o: { path: string; guard: string; blobs: HoldBlobs; residence?: 'ON_DISK' | 'OFF_DISK'; state?: 'ACTIVE' | 'CONFLICTED' | 'PARKED' }): Promise<string> =>
        p.core.holds.hold({
          kind: 'PATCH', residence: o.residence ?? 'ON_DISK', state: o.state ?? 'ACTIVE', paths: [o.path], guard: o.guard, origin: 'human',
          cs_ids: [], displaced_by: null, blobs: o.blobs,
        });
      await writeWork(p, 'm.txt', 'm1\n<<<<<<< cowork:disk\nm2 local\n=======\nm2 held\n>>>>>>> cowork:held\nm3\n');
      await hold({ path: 'm.txt', guard: 'markers', blobs: { h0: { 'm.txt': A.get('m.txt')!.oid }, h1: { 'm.txt': await blob('m1\nm2 held\nm3\n') } } });
      want['m.txt'] = 'markers';
      await writeWork(p, 'gen.ts', 'export const v = 2;\n');
      await hold({ path: 'gen.ts', guard: 'generated?', blobs: { h0: { 'gen.ts': A.get('gen.ts')!.oid }, h1: { 'gen.ts': await blob('export const v = 2;\n') } } });
      want['gen.ts'] = 'generated?';
      await writeWork(p, 'k.txt', 'k1\nk2 mine\nk3\n');
      const k = A.get('k.txt')!.oid;
      await hold({ path: 'k.txt', guard: 'conflict', state: 'CONFLICTED', blobs: { s1: { 'k.txt': k }, s2: { 'k.txt': await blob('k1\nk2 mine\nk3\n') }, s3: { 'k.txt': await blob('k1\nk2 team\nk3\n') } } });
      want['k.txt'] = 'conflict';
      await hold({ path: 'park.txt', guard: 'revert', residence: 'OFF_DISK', state: 'PARKED', blobs: { h0: { 'park.txt': A.get('park.txt')!.oid }, h1: { 'park.txt': await blob('park held\n') } } });
      await fx.rounds(26, 2_500);   // > 60 s for new.txt's and u.txt's exclusions (the lock closure gets its INCOMING record meanwhile)
      want['new.txt'] = 'R3-56';
      const pins = withGuard(p, 'unreadable');
      assert.deepEqual(pins.map((r) => [r.kind, r.residence, r.paths]), [['PIN', 'ON_DISK', ['u.txt']]], 'the unreadable PIN');
      want['u.txt'] = 'unreadable PIN';
      const s = await statusOf(p);
      const nc = new Set(s.pending.not_converged);
      for (const [path, what] of Object.entries(want)) assert.ok(nc.has(path), `${path} (${what}) in not_converged: ${JSON.stringify(s.pending.not_converged)}`);
      assert.equal(nc.has('park.txt'), false, 'a PARKED (OFF_DISK) record\'s path is absent');
      assert.equal(p.core.holds.nonTerminal().some((r) => r.paths.includes('new.txt')), false, 'no record for the never-staged file (R3-56)');
      const why = (await p.engine.inspect()).notConvergedWhy!;
      assert.equal(why['new.txt']?.cause, 'deferred');
      assert.equal(why['f.py']?.cause, 'blocked_publish');
      assert.deepEqual(why['u.txt'], { cause: 'blocked_publish', guard: 'unreadable' });
      assert.equal(s.state, 'degraded');
    } finally {
      unreadableTracked?.();
      unreadable();
      release();
    }
  });
});

test('Plan 2\'s not_converged entries stay listed with Plan 3\'s records present', T10, async () => {
  await withEngines('sh-plan2', { n: 2, files: FILES, platform: 'win32' }, async (fx) => {
    const p = await started(fx);
    // P2-CARRY: a teammate case pair; on a win32 disk the later spelling is not applicable here (D7 rule 4).
    await fx.pushTeamChange({ 'Case.txt': buf('upper\n'), 'case.txt': buf('lower\n') });
    await roundsUntil(fx, async () => (await readWork(p, 'Case.txt')) !== null, 'the first spelling applied');
    // An ON_DISK revert record.
    await teammateLine(fx, p, N, 10);
    await humanRemovesTeamLine(fx, p, N);
    // A kept ambiguous push intent: the push never reaches the server, the classification is lost; a teammate's empty change lands
    // on top, and the first-parent walk that would decide it fails, so the intent stays kept (Plan 2 Task 14 carry).
    await writeWork(p, 'other.txt', 'other 1 mine\nother 2\nother 3\n');
    await step(fx, p);
    fx.advance(21_000);
    let phase: 'push' | 'blind' | 'walk' | 'off' = 'push';
    const restore = wrapGit(p, async (args, opts, inner) => {
      if (phase === 'push' && args[0] === 'push') {
        phase = 'blind';
        return failedResult(-1, 'error: killed\n');
      }
      if (phase === 'blind' && (args[0] === 'fetch' || args[0] === 'ls-remote')) return failedResult(128, 'fatal: unable to access the remote\n');
      if (phase === 'walk' && args[0] === 'rev-list' && args.includes('--max-count=10000') && args.some((a) => a.startsWith('^'))) return failedResult(128);
      return inner(args, opts);
    });
    try {
      await p.engine.iterate();
      assert.equal(p.core.view!.intent.kind, 'push', 'the intent is kept');
      await fx.pushTeamChange({});
      phase = 'walk';
      fx.advance(31_000);
      for (let i = 0; i < 26; i++) await step(fx, p);   // > 60 s with the intent kept
      assert.equal(p.core.view!.intent.kind, 'push', 'still kept');
      const s = await statusOf(p);
      const why = (await p.engine.inspect()).notConvergedWhy!;
      assert.equal(why['case.txt']?.cause, 'not_applicable', `the carried spelling: ${JSON.stringify(why)}`);
      assert.equal(why['other.txt']?.cause, 'push_unresolved');
      assert.ok(why['f.py'] !== undefined, 'and the ON_DISK record path');
      assert.equal(s.state, 'degraded');
      assert.deepEqual([s.message_code, s.message_params['cause']], ['NOT_CONVERGED', 'push_unresolved'], 'Plan 2\'s specific cause keeps its message');
      // Plan 2's INV-CONVERGE oracle passes on that state (every non-converged path excused, the rest converged at T*).
      const tStar = (await remoteBoardTip(fx))!;
      const ctx = {
        root: fx.root, remote: fx.remote, peers: [p.clone], engines: [{ peer: p.clone, step: async () => {}, inspect: () => p.engine.inspect() }],
        quiescence: { reached: true, tStar, rounds: 0, pushAttemptsInExtra: 0, boardChangedInExtra: false },
      } as unknown as SimContext;
      assert.equal(await oracleConverge().atQuiescence!(ctx), null);
    } finally {
      phase = 'off';
      restore();
    }
  });
});

test('01 #42: a ready group kept back by FREEZE(MASS) and by the regionSpec VERSION pause has its paths in not_converged as blocked_publish, and after the lift they publish and leave the list', T10, async () => {
  await withEngines('sh-42', { n: 2, files: MASS_FILES }, async (fx) => {
    const [p1, p2] = fx.peers as [EnginePeer, EnginePeer];
    // The regionSpec VERSION pause on p2.
    p2.deps.regionSpec = regionSpecId(['FoldMapper/2', 'extent-convention/1', 'label-convention/1']);
    await fx.startAll();
    await fx.rounds(3);
    await writeWork(p2, 'g.py', fpy(12, { replace: { 3: 'g_3 = p2' } }).replace(/row_/g, 'g_'));
    await fx.rounds(1);
    fx.advance(21_000);
    await fx.rounds(2);
    assert.equal(p2.core.cs.ready().length, 1, 'the ready group waits');
    let why = (await p2.engine.inspect()).notConvergedWhy!;
    assert.deepEqual(why['g.py'], { cause: 'blocked_publish', reason: 'VERSION' });
    p2.deps.regionSpec = PLAN2_REGION_SPEC;   // the lift
    await roundsUntil(fx, () => p2.core.cs.ready().length === 0, 'published after the VERSION lift');
    await fx.rounds(1);
    assert.equal((await statusOf(p2)).pending.not_converged.includes('g.py'), false, 'left the list');
    // FREEZE(MASS) on p1: the formatter's CS is captured under the freeze and waits.
    for (let i = 0; i < N_FMT; i++) await writeWork(p1, pkg(i), pkgText(i, '"'));
    await step(fx, p1);
    assert.ok(p1.core.view!.meta.freeze_reasons.includes('MASS'));
    await step(fx, p1, 21_000);
    assert.ok(p1.core.cs.ready().some((r) => r.paths.includes(pkg(0))), 'captured under MASS');
    await step(fx, p1);
    why = (await p1.engine.inspect()).notConvergedWhy!;
    assert.deepEqual(why[pkg(0)], { cause: 'blocked_publish', reason: 'MASS' });
    assert.ok((await statusOf(p1)).pending.not_converged.includes(pkg(N_FMT - 1)));
    await p1.engine.resume();
    await roundsUntil(fx, () => p1.core.cs.ready().length === 0, 'published after resume', 20);
    await fx.rounds(2);
    const s = await statusOf(p1);
    assert.equal(s.pending.not_converged.some((q) => q.startsWith('pkg/')), false, 'the formatted paths left the list');
  });
});

test('T-06: a new record, a deferral, a not-converged path and MASS each appear in status.json within 2 iterations', T10, async () => {
  await withEngines('sh-t06', { n: 2, files: MASS_FILES }, async (fx) => {
    const p = await started(fx);
    await teammateLine(fx, p, N, 10);
    // A new record and its not-converged path: within 2 iterations of the iteration that made it.
    await writeWork(p, 'f.py', fpy(N));
    await step(fx, p);
    const before = (await statusOf(p)).pending.holds_active;
    let made = false;
    for (let i = 0; i < 12 && !made; i++) {
      await step(fx, p, i === 0 ? 21_000 : 2_500);
      made = withGuard(p, 'revert').length === 1;
    }
    assert.ok(made, 'the revert record');
    let s = await statusOf(p);
    for (let i = 0; i < 2 && !(s.pending.holds_active > before && s.pending.not_converged.includes('f.py')); i++) {
      await step(fx, p);
      s = await statusOf(p);
    }
    assert.ok(s.pending.holds_active > before, 'the new record is counted');
    assert.ok(s.pending.not_converged.includes('f.py'), 'its path is not converged');
    // A deferral.
    const release = p.fs.holdLock(workPath(p, 'other.txt'), 'share-none');
    try {
      await fx.pushTeamChange({ 'other.txt': buf('other 1\nother 2 team\nother 3\n') });
      await roundsUntil(fx, () => Object.hasOwn(p.core.view!.meta.pending, 'other.txt'), 'the deferral');
      s = await statusOf(p);
      for (let i = 0; i < 2 && !s.pending.not_converged.includes('other.txt'); i++) {
        await step(fx, p);
        s = await statusOf(p);
      }
      assert.ok(s.pending.incoming >= 1 && s.pending.not_converged.includes('other.txt'), JSON.stringify(s.pending));
    } finally {
      release();
    }
    // MASS.
    for (let i = 0; i < N_FMT; i++) await writeWork(p, pkg(i), pkgText(i, '"'));
    let frozen = false;
    for (let i = 0; i < 2 && !frozen; i++) {
      await step(fx, p);
      frozen = (await statusOf(p)).freeze_reasons.includes('MASS');
    }
    assert.ok(frozen, 'MASS in status.json');
    assert.equal((await statusOf(p)).state, 'frozen');
  });
});

test('HOLD_DIVERGED_REGIONS {n: 2, age: <oldest record age in s>} is the message of the degraded state two ON_DISK records cause when no newer hold code is set, and CS_NO_CHECKS_CONFIGURED shows in the ok state when checks.checkpoint is empty and nothing outranks it', T10, async () => {
  await withEngines('sh-diverged', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    let s = await statusOf(p);
    assert.deepEqual([s.state, s.message_code], ['ok', 'CS_NO_CHECKS_CONFIGURED'], 'the default config has no checks.checkpoint');
    // Two ON_DISK revert records.
    await teammateLine(fx, p, N, 10);
    await fx.pushTeamChange({ 'g.py': buf(fpy(12, { after: { 6: 'TEAM_G = 1' } }).replace(/row_/g, 'g_')) });
    await roundsUntil(fx, async () => (await readWork(p, 'g.py'))?.toString('utf8').includes('TEAM_G') === true, 'the second teammate line');
    await writeWork(p, 'f.py', fpy(N));
    await writeWork(p, 'g.py', fpy(12).replace(/row_/g, 'g_'));
    await roundsUntil(fx, () => withGuard(p, 'revert').length === 2, 'two revert records');
    // Task 12b (HLD-60): each creation now sets HOLD_CREATED in the slot; the slot is emptied here to reach the rung under test (no newer
    // hold code), as a code naming a record that ended would empty it.
    assert.equal(p.core.holdCode?.code, 'HOLD_CREATED', 'HLD-60\'s creation line');
    p.core.holdCode = null;
    // Fix round 1 (finding 5): a Plan 2 engine event is newer than the records — the remote goes away for > 30 s (OFFLINE) and comes
    // back (ONLINE {}, the engine's lastEvent). It never takes the degraded rung, which reads only the hold-code slot (R3-61).
    const restore = wrapGit(p, async (args, opts, inner) => (args[0] === 'fetch' || args[0] === 'ls-remote' ? failedResult(128, 'fatal: unable to access the remote\n') : inner(args, opts)));
    try {
      fx.advance(31_000);
      await p.engine.iterate();
      assert.equal((await statusOf(p)).state, 'offline', 'the outage');
    } finally {
      restore();
    }
    fx.advance(31_000);   // past the 30 s network backoff
    await p.engine.iterate();
    assert.ok(logOf(p).lines.some((l) => l.code === 'ONLINE'), 'the ONLINE engine event');
    assert.equal(p.core.holdCode, null, 'still no hold code');
    s = await statusOf(p);
    const ages = withGuard(p, 'revert').map((r) => p.core.holds.ageMs(r));
    assert.deepEqual([s.state, s.message_code, s.message_params], ['degraded', 'HOLD_DIVERGED_REGIONS', { n: 2, age: Math.floor(Math.max(...ages) / 1_000) }]);
    assert.ok((s.message_params['age'] as number) >= 60);
  });
  // With checks.checkpoint configured, the ok state has no message.
  const files = { ...FILES, '.cowork/config.json': buf('{"checks":{"checkpoint":["npm test"]}}') };
  await withEngines('sh-checks', { n: 1, files }, async (fx) => {
    await fx.startAll();
    await fx.rounds(2);
    const s = await statusOf(fx.peers[0]!);
    assert.deepEqual([s.state, s.message_code], ['ok', null]);
  });
});
