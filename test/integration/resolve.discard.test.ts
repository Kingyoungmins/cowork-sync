// `--discard` of /cowork resolve (Plan 3 Task 11; 05-holds Table 4 `--discard`, HLD-16, HLD-42, 05 F7, U8; 03-data DAT-39, I-DAT-20
// exclude half, TC-HLD-10; rulings R3-28, R3-36, R3-60; contract addition 2): an ON_DISK discard is an operator write with origin
// discard:<id> (inflight[r] first, ObservedWrites, the private-index entry and R3-60's snap transition, then the final patch), its
// end mirrored, logged (HOLD_DISCARDED) and traced (`discard`, the held-side blobs); a crash inside it is completed by restart; an
// OFF_DISK or INCOMING discard changes state only; a CONFLICTED record gets A[p]; a `generated?` record records the exclude answer.
// Real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStep } from '../../src/engine/apply.js';
import { captureStep } from '../../src/engine/csStep.js';
import { churnStep } from '../../src/engine/dataRecords.js';
import { evaluateRecords, parkWritten } from '../../src/engine/holdOps.js';
import { maskInputsOf, publishStep } from '../../src/engine/publish.js';
import { recordStep } from '../../src/engine/holdSteps.js';
import { restart } from '../../src/engine/restart.js';
import { resolve, type ResolveResult } from '../../src/engine/resolve.js';
import { readOpSnap } from '../../src/engine/state.js';
import type { WriteLocalResult } from '../../src/engine/writer.js';
import { ABSENT } from '../../src/git/oid.js';
import { maskEntries } from '../../src/holds/mask.js';
import type { PublishGatePort } from '../../src/holds/ports.js';
import { blobAt, guardName, heldSide, type HoldRecord } from '../../src/holds/record.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { readWork, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { remoteLive } from '../helpers/dataRecordsFixture.js';
import { blob, nr, pair, prepIt, recordLog, stages } from '../helpers/holdOpsFixture.js';
import { incomingRecords, loop, privateBlobs } from '../helpers/incomingFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { win } from '../helpers/mirrorFixture.js';
import { buf, editAndCapture, LogRecorder, prep, remoteLiveCode, treeOf, withCores } from '../helpers/publishHelpers.js';
import { HUMAN, landHoldOps } from '../helpers/resolveFixture.js';
import { humanCapture } from '../helpers/revertFixture.js';
import { gitIn, restartCore } from '../helpers/startFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const R1 = 'src/r1.txt';
const R2 = 'src/r2.txt';
const R3 = 'src/r3.txt';
const GEN = 'gen/api.ts';
const USE = 'src/use.ts';
const FILES: Record<string, Buffer> = {
  'README.md': buf('# resolve discard\n'), '.env': buf('KEY=1\n'), [R1]: buf(T9), [R2]: buf(T9), [R3]: buf(T9), 'src/r4.txt': buf(T9),
  [GEN]: buf('export const api = 1;\n'), [USE]: buf('export const use = 1;\n'),
};
const done = (code: string, id: string, created: string | null = null): ResolveResult => ({ kind: 'done', code, id, created });
const text = async (p: PeerFixture, path: string): Promise<string | null> => (await readWork(p, path))?.toString('utf8') ?? null;
const discards = (fx: CoreFixture): Array<Extract<TraceEvent, { kind: 'discard' }>> => fx.trace.ofKind('discard') as Array<Extract<TraceEvent, { kind: 'discard' }>>;
const heldOf = (r: HoldRecord): Array<{ path: string; blob: string | null }> => r.paths.map((x) => {
  const b = blobAt(heldSide(r), x) ?? ABSENT;
  return { path: x, blob: b === ABSENT ? null : b };
});

/** Throws KilledAt at the `nth` hit of `point` while fn runs (a dead process: the core is abandoned). */
async function killedAt<T>(point: string, nth: number, fn: () => Promise<T>): Promise<void> {
  let hits = 0;
  setCrashHandler((name) => {
    if (name === point && ++hits === nth) throw new KilledAt(name);
  });
  try {
    await assert.rejects(fn(), (e: unknown) => e instanceof KilledAt && e.point === point, `killed at ${point} #${nth}`);
  } finally {
    setCrashHandler(null);
  }
}

test('--discard writes r\'s step-5 MASK result for an ON_DISK PATCH and A[p] for a PIN, a local_only record and a whole-path-guard record, then ends RESOLVED_DISCARD with a mirrored op, a daemon log line and a discard trace naming the held-side blobs', T10, async () => {
  await withCores('rdis-writes', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, R1, t9([2, 'two'], [6, 'six']));
    await writeWork(p, R2, t9([4, 'pin']));
    await writeWork(p, R3, t9([5, 'eol']));
    await writeWork(p, '.env', 'KEY=2\n');
    const it0 = await prepIt(p, { materialize: false });
    const a = it0.A.get(R1)!.oid;
    const reg = p.core.holds;
    const rows: Array<{ id: string; path: string; want: string }> = [
      { id: await reg.hold(nr({ paths: [R1], blobs: pair(a, await blob(p, t9([2, 'two'])), R1) })), path: R1, want: t9([6, 'six']) },
      { id: await reg.hold(nr({ kind: 'PIN', guard: 'join', paths: [R2], blobs: pair(a, await blob(p, t9([4, 'pin'])), R2) })), path: R2, want: T9 },
      { id: await reg.hold(nr({ guard: 'restart', origin: 'daemon', paths: ['.env'], blobs: pair(it0.A.get('.env')!.oid, await blob(p, 'KEY=2\n'), '.env') })), path: '.env', want: 'KEY=1\n' },
      { id: await reg.hold(nr({ guard: 'eol-bom', origin: 'daemon', paths: [R3], blobs: pair(a, await blob(p, t9([5, 'eol'])), R3) })), path: R3, want: T9 },
    ];
    assert.equal(reg.get(rows[2]!.id)!.local_only, true, 'precondition: the .env record is local_only');
    await landHoldOps(fx, p);
    const it = await prepIt(p, { forceFetch: true, holdPaths: rows.map((r) => r.path) });
    const log = recordLog(p);
    // The writer's calls: the origin, and what the registry held when the write ran.
    const writer = p.core.writer;
    const orig = writer.writeLocalGroup.bind(writer);
    const seen: Array<{ origin: string; inflight: string | null }> = [];
    writer.writeLocalGroup = (entries, origin, humanEvidence): Promise<WriteLocalResult> => {
      const id = origin.slice('discard:'.length);
      seen.push({ origin, inflight: p.core.holds.local().inflight[id]?.op ?? null });
      return orig(entries, origin, humanEvidence);
    };
    const trace0 = discards(fx).length;
    for (const row of rows) {
      const before = reg.get(row.id)!;
      assert.deepEqual(await resolve(p.core, it, row.id, 'discard', HUMAN), done('RESOLVED_DISCARD', row.id), row.path);
      assert.equal(await text(p, row.path), row.want, `${row.path}: the written target`);
      const after = reg.get(row.id)!;
      assert.deepEqual([after.state, after.residence], ['RESOLVED_DISCARD', null]);
      assert.deepEqual(p.core.holds.local().inflight, {}, 'the final patch cleared the inflight entry');
      const written = await blob(p, row.want);
      // Final review F1: recorded (R3-36), then forgotten once the private-index entry holds the write (parkWritten).
      assert.equal(p.core.observed.peek(row.path, written), false, `${row.path}: no lingering ObservedWrites entry (F1)`);
      assert.equal((await privateBlobs(p))(row.path), written, `${row.path}: the private-index entry is the written blob`);
      assert.equal((await p.core.repo.readTreeMap(p.core.view!.snap)).get(row.path)?.oid, written, `${row.path}: state:snap[p] is the written blob`);
      const ev = discards(fx).at(-1)!;
      assert.deepEqual([ev.id, ev.rev, ev.held], [row.id, after.rev, heldOf(before)], `${row.path}: the discard trace names the held-side blobs`);
      assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_DISCARDED').at(-1)?.params, { hid: row.id, rev: after.rev, paths: row.path }, `${row.path}: the daemon log line`);
      const op = p.core.outbox.pendingHold(row.id)!;
      assert.deepEqual([op.state, op.local_only], ['RESOLVED_DISCARD', row.path === '.env'], `${row.path}: the mirrored op (a stub for local_only)`);
    }
    writer.writeLocalGroup = orig;
    assert.equal(discards(fx).length - trace0, rows.length);
    assert.deepEqual(seen.map((s) => s.origin), rows.map((r) => `discard:${r.id}`), 'origin discard:<id>');
    assert.ok(seen.every((s) => s.inflight === 'discard'), 'inflight[r] = {op: discard, …} was committed before each write');
    // The ends land on the board (the local_only record's as a stub: the fold keeps no blob for it).
    await landHoldOps(fx, p);
    const f = (await prep(p)).fold;
    for (const row of rows) assert.equal(f.holds[row.id]?.state, 'RESOLVED_DISCARD', `${row.path}: folded`);
    assert.equal(f.holds[rows[2]!.id]?.local_only, true);
  });
});

test('a kill inside --discard\'s write is completed by restart as RESOLVED_DISCARD, never GONE', T10, async () => {
  await withCores('rdis-kill', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, R1, t9([2, 'two'], [6, 'six']));
    await writeWork(p, R2, t9([2, 'two'], [6, 'six']));
    const it0 = await prepIt(p, { materialize: false });
    const two = await blob(p, t9([2, 'two']));
    const id = await p.core.holds.hold(nr({ paths: [R1], blobs: pair(it0.A.get(R1)!.oid, two, R1) }));
    const id2 = await p.core.holds.hold(nr({ paths: [R2], blobs: pair(it0.A.get(R2)!.oid, two, R2) }));
    await landHoldOps(fx, p);
    // (1) Killed at apply.group.phase2 inside the --discard write: the disk is at the target, the record not yet ended.
    let it = await prepIt(p, { forceFetch: true, holdPaths: [R1] });
    await killedAt('apply.group.phase2', 1, () => resolve(p.core, it, id, 'discard', HUMAN));
    assert.equal(await text(p, R1), t9([6, 'six']), 'the write completed before the kill');
    assert.equal(p.core.holds.local().inflight[id]?.op, 'discard', 'inflight[r] is still set');
    await gitIn(p, ['gc', '-q', '--prune=now']);
    const trace0 = fx.trace.ofKind('discard').length;
    await restartCore(p);
    await restart(p.core);
    const r = p.core.holds.get(id)!;
    assert.equal(r.state, 'RESOLVED_DISCARD', 'settleHoldOps completed the discard');
    assert.deepEqual(p.core.holds.local().inflight, {}, 'the inflight entry is cleared');
    const ev = fx.trace.ofKind('discard').slice(trace0) as Array<Extract<TraceEvent, { kind: 'discard' }>>;
    assert.deepEqual(ev.map((e) => [e.id, e.rev]), [[id, r.rev]], 'its discard trace');
    // R1 never ends it GONE (it is terminal), and its end is mirrored.
    const ir = await prepIt(p, { materialize: true });
    await evaluateRecords(p.core, ir, new Set([R1]), []);
    assert.equal(p.core.holds.get(id)!.state, 'RESOLVED_DISCARD', 'never GONE');
    await landHoldOps(fx, p);
    assert.equal((await prep(p)).fold.holds[id]?.state, 'RESOLVED_DISCARD', 'its mirrored op');
    // (2) Killed at the second registry.cas hit (after the inflight commit's CAS, before the write): the disk is unchanged and the
    // record stays ON_DISK ACTIVE; restart clears the entry by observation (every path still at its pre-image).
    it = await prepIt(p, { forceFetch: true, holdPaths: [R2] });
    await killedAt('registry.cas', 2, () => resolve(p.core, it, id2, 'discard', HUMAN));
    assert.equal(await text(p, R2), t9([2, 'two'], [6, 'six']), 'the disk is unchanged');
    await restartCore(p);
    await restart(p.core);
    const r2 = p.core.holds.get(id2)!;
    assert.deepEqual([r2.residence, r2.state], ['ON_DISK', 'ACTIVE']);
    assert.deepEqual(p.core.holds.local().inflight, {});
    assert.equal(await text(p, R2), t9([2, 'two'], [6, 'six']));
  });
});

test('--discard of an OFF_DISK record changes state only, and of an INCOMING lock record ends it so the next apply writes TIP once the lock clears', T10, async () => {
  const PA = 'src/a.txt';
  const files = { ...FILES, [PA]: buf('a1\na2\na3\n') };
  await withCores('rdis-offdisk-lock', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    // OFF_DISK: state only.
    const it0 = await prepIt(p, { materialize: false });
    const parked = await p.core.holds.hold(nr({ paths: [R1], residence: 'OFF_DISK', state: 'PARKED', blobs: pair(it0.A.get(R1)!.oid, await blob(p, t9([2, 'two'])), R1) }));
    const writes = p.fs.calls.length;
    assert.deepEqual(await resolve(p.core, it0, parked, 'discard', HUMAN), done('RESOLVED_DISCARD', parked));
    assert.equal(p.core.holds.get(parked)!.state, 'RESOLVED_DISCARD');
    assert.equal(await text(p, R1), T9);
    assert.deepEqual(p.fs.calls.slice(writes).filter((c) => c.includes(workPath(p, R1))), [], 'no disk write');
    // INCOMING lock: a teammate's change to a file a program holds; after 60 s one INCOMING lock record covers it.
    await loop(p);
    fx.advance(10_000);
    const release = p.fs.holdLock(workPath(p, PA), 'share-read');
    let id: string | null = null;
    try {
      await fx.pushTeamChange({ [PA]: buf('a1\na2 team\na3\n') });
      for (let t = 0; t <= 90_000 && id === null; t += 10_000) {
        fx.advance(10_000);
        await loop(p);
        id = incomingRecords(p)[0]?.id ?? null;
      }
      assert.ok(id !== null, 'an INCOMING lock record');
      assert.equal(p.core.holds.get(id)!.guards[0]?.name, 'lock');
      const it = await prepIt(p, { forceFetch: true });
      assert.deepEqual(await resolve(p.core, it, id, 'discard', HUMAN), done('RESOLVED_DISCARD', id));
      assert.equal(p.core.holds.get(id)!.state, 'RESOLVED_DISCARD', 'the record ends');
      assert.equal(await text(p, PA), 'a1\na2\na3\n', 'nothing written yet');
    } finally {
      release();
    }
    fx.advance(10_000);
    const l = await loop(p);
    assert.ok(l.apply.written.includes(PA), 'the next apply writes TIP once the lock clears');
    assert.equal(await text(p, PA), 'a1\na2 team\na3\n');
  });
});

test('--discard of an ON_DISK CONFLICTED record writes A[p]', T10, async () => {
  await withCores('rdis-conflicted', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    // (1) A revert PATCH made CONFLICTED by a MASK conflict: an edit on the line next to its held line.
    await writeWork(p, R1, t9([2, 'two'], [3, 'three edited']));
    // (2) An ON_DISK CONFLICTED K4 record whose TIP write is pending: the local version on disk, A[p] still the old version.
    await writeWork(p, R2, t9([3, 'mine']));
    const it0 = await prepIt(p, { materialize: true });
    const a = it0.A.get(R1)!.oid;
    const rev = await p.core.holds.hold(nr({ paths: [R1], blobs: pair(a, await blob(p, t9([2, 'two'])), R1) }));
    const masked = await maskEntries(p.core.repo, it0.mat!.sDiskMap, maskInputsOf(p.core, it0, p.core.holds.maskingRecords()), p.core.rebase);
    assert.deepEqual(masked.conflicted, [rev], 'precondition: a MASK conflict');
    await p.core.holds.transition(rev, { state: 'CONFLICTED' });   // the caller's transition (maskStep, HLD-15)
    const k4 = await p.core.holds.hold(nr({ paths: [R2], state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', blobs: stages(a, await blob(p, t9([3, 'mine'])), await blob(p, t9([3, 'team'])), R2) }));
    assert.deepEqual([p.core.holds.get(k4)!.residence, p.core.holds.get(k4)!.state], ['ON_DISK', 'CONFLICTED']);
    await landHoldOps(fx, p);
    const it = await prepIt(p, { forceFetch: true, holdPaths: [R1, R2] });
    for (const [rid, path] of [[rev, R1], [k4, R2]] as const) {
      const before = p.core.holds.get(rid)!;
      // R3-EF4-28: a CONFLICTED record's held side := S_disk before A[p] is written (PARK's whole refresh) — the revert PATCH's h1 lacks
      // the adjacent edit on disk; the K4's s2 is the disk already.
      const disk = [{ path, blob: it.mat!.sDiskMap.get(path)!.oid as string }];
      if (rid === rev) assert.notDeepEqual(heldOf(before), disk, 'precondition: the revert record\'s held side is not the disk');
      else assert.deepEqual(heldOf(before), disk);
      const n = fx.trace.ofKind('discard').length;
      assert.deepEqual(await resolve(p.core, it, rid, 'discard', HUMAN), done('RESOLVED_DISCARD', rid));
      assert.equal(await text(p, path), T9, `${path}: A[p] written (MASK step 4)`);
      const after = p.core.holds.get(rid)!;
      assert.equal(after.state, 'RESOLVED_DISCARD');
      assert.deepEqual(heldOf(after), disk, 'the ended record holds the bytes the discard took off the disk');
      assert.equal(p.core.outbox.pendingHold(rid)?.state, 'RESOLVED_DISCARD', 'a mirrored op');
      const ev = fx.trace.ofKind('discard').slice(n) as Array<Extract<TraceEvent, { kind: 'discard' }>>;
      assert.deepEqual(ev.map((e) => [e.id, e.held]), [[rid, disk]], 'a discard trace naming its held-side blobs');
    }
  });
});

test('05 U8 generated?: --discard writes nothing, sets generated?:exclude in a new mirrored rev, releases the dependent HLD-42 PIN at once so src/use.ts publishes in the next window, keeps gen/api.ts masked, and the record ends SUBSUMED when the scope reports gen/api.ts UNMANAGED', T10, async () => {
  await withCores('rdis-generated', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const tip0 = await remoteLiveCode(fx, p);
    const { it } = await editAndCapture(fx, p, { [GEN]: 'export const api = 2;\n', [USE]: 'export const use = api;\n' });
    const a0 = it.A.get(GEN)!.oid;
    const gen = await p.core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: [GEN], guard: 'generated?', origin: 'human', cs_ids: [], displaced_by: null,
      blobs: { h0: { [GEN]: a0 }, h1: { [GEN]: it.mat!.sDiskMap.get(GEN)!.oid } },
    });
    // The window: the CS touching gen/api.ts is PINned dependency:<generated? id> and nothing of it publishes (TC-HLD-10).
    const { r: r0 } = await win(fx, p);
    assert.equal(r0.c, null);
    const [pin] = r0.dependencyPins;
    assert.ok(pin !== undefined && p.core.holds.get(pin)!.guards.some((g) => g.name === `dependency:${gen}`), 'the dependency PIN');
    assert.equal(await remoteLiveCode(fx, p), tip0);
    const disk0 = await readWork(p, GEN);
    const genRev = p.core.holds.get(gen)!.rev;
    const it2 = await prepIt(p, { forceFetch: true, holdPaths: [GEN] });
    assert.deepEqual(await resolve(p.core, it2, gen, 'discard', HUMAN), done('HOLD_ANSWERED', gen));
    assert.deepEqual(await readWork(p, GEN), disk0, 'writes nothing');
    const g = p.core.holds.get(gen)!;
    assert.deepEqual([g.residence, g.state, g.guards.map((x) => x.name), g.rev], ['ON_DISK', 'ACTIVE', ['generated?:exclude'], genRev + 1], 'a new rev');
    assert.deepEqual(p.core.outbox.pendingHold(gen)?.guards.map((x) => x.name), ['generated?:exclude'], 'mirrored');
    assert.equal(p.core.holds.get(pin)!.guards.some((x) => guardName(x) === 'dependency'), false, 'the dependent PIN released at once');
    // The next window: src/use.ts publishes; gen/api.ts stays masked (A's blob).
    const { r: r1 } = await win(fx, p);
    assert.notEqual(r1.c, null, `src/use.ts publishes in the next window: ${JSON.stringify(r1)}`);
    const live = await remoteLive(fx, p);
    assert.equal(live.get(USE), await blob(p, 'export const use = api;\n'));
    assert.equal(live.get(GEN), a0, 'gen/api.ts kept masked');
    // A new EPOCH_BASE making gen/api.ts UNMANAGED (Task 7's scope seam): the record ends SUBSUMED.
    fx.advance(2_500);
    const it3 = await prepIt(p, { materialize: false });
    const res = await churnStep(p.core, { ...it3, scope: (q) => (q === GEN ? { cls: 'UNMANAGED', reason: null } : it3.scope(q)) });
    assert.deepEqual(res.released, [gen]);
    assert.equal(p.core.holds.get(gen)!.state, 'SUBSUMED');
  });
});

// EF2 fix round 1, F3's open question (the review: "nothing in resolve.ts cancels a ready pair when its K6 PIN is discarded"). Table 4
// `--discard` of an ON_DISK PIN writes A[p] and ends it; the CS the PIN held (HLD-45 K6: a human hunk in a foreign claim) is that
// content, so once the record is RESOLVED_DISCARD the discarded bytes must never publish — with or without a restart — and its ready
// pair must not stay in journal/ready/ to be captured over by a later re-form.
const K6_FILE = 'k6.txt';
const k6Gate = (on: () => boolean): PublishGatePort => ({
  gate: async (_r, _t, _A, _R, paths) => (on() && paths.includes(K6_FILE) ? { block: { claimId: 'abcdefghij234567' } } : { block: null }),
  claimStillBlocks: async () => on(),
});
for (const after of ['no restart', 'a restart', 'parked first'] as const) {
  test(`--discard of a K6 PIN (${after === 'parked first' ? 'OFF_DISK: --park, then --discard' : 'ON_DISK'}) drops the record's paths from the unpublished ready pair it holds: once the claim is gone the discarded bytes never publish (${after}; EF2 r1 F3)`, T10, async () => {
    let claimed = false;
    await withCores(`rdis-k6-${after.split(' ')[0]}`, { n: 1, files: { ...FILES, [K6_FILE]: buf(T9) }, ports: { gate: k6Gate(() => claimed) } }, async (fx) => {
      const p = fx.peers[0]!;
      const OTHER = t9([3, 'other edit, same change-set']);
      const DISCARDED = t9([4, 'a human hunk in a foreign claim']);
      const { pair: k6Pair } = await editAndCapture(fx, p, { [K6_FILE]: DISCARDED, [R1]: OTHER });
      claimed = true;
      fx.advance(30_000);
      const held = await publishStep(p.core, await prep(p));
      assert.equal(held.c ?? null, null, `B1 holds the group: ${JSON.stringify(held)}`);
      const k6 = p.core.holds.nonTerminal().find((r) => r.kind === 'PIN' && r.guards.some((g) => g.name.startsWith('claim:')));
      assert.ok(k6 !== undefined && k6.cs_ids.includes(k6Pair.csId), `the K6 PIN holds the CS: ${JSON.stringify(p.core.holds.nonTerminal().map((r) => [r.kind, r.paths, r.guards.map((g) => g.name), r.cs_ids]))}`);
      assert.deepEqual([...k6.paths].sort(), [K6_FILE, R1].sort(), 'a whole-CS PIN');
      if (after === 'parked first') {
        assert.deepEqual(await resolve(p.core, await prepIt(p, { forceFetch: true, holdPaths: k6.paths }), k6.id, 'park', HUMAN), done('HOLD_PARKED', k6.id));
        assert.equal(p.core.holds.get(k6.id)!.residence, 'OFF_DISK');
        // Final review F6 (flips EF2's 'a park keeps the pair'): an OFF_DISK PIN holds no group, so the park withdrew the pair; its paths
        // are re-captured from the disk the park wrote (A[p]).
        assert.ok(!p.core.cs.ready().some((x) => x.csId === k6Pair.csId), 'the park withdrew the pair (F6)');
      }
      const res = await resolve(p.core, await prepIt(p, { forceFetch: true, holdPaths: k6.paths }), k6.id, 'discard', HUMAN);
      assert.deepEqual(res, done('RESOLVED_DISCARD', k6.id));
      assert.equal(await text(p, K6_FILE), T9, 'the discard wrote A[p]');
      assert.equal(await text(p, R1), T9);
      assert.ok(!p.core.cs.ready().some((x) => x.paths.includes(K6_FILE) || x.paths.includes(R1)), `no ready pair names the discarded paths: ${JSON.stringify(p.core.cs.ready().map((x) => [x.csId, x.paths]))}`);
      if (after === 'a restart') {
        await restartCore(p);
        await restart(p.core);
      }
      claimed = false;
      for (let i = 0; i < 3; i++) {
        fx.advance(30_000);
        await publishStep(p.core, await prep(p, 'auto'));
      }
      const live = await remoteLive(fx, p);
      assert.equal(live.get(K6_FILE), await blob(p, T9), 'the discarded hunk never publishes');
      assert.equal(live.get(R1), await blob(p, T9), 'nor does the rest of the discarded CS');
      assert.equal(await text(p, K6_FILE), T9, 'the disk keeps A[p]');
    });
  });
}

// EF2 fix round 1, F3 (R-01 as ruled): the restart's re-form hands over a ready pair's path whose snap entry is not the pair's R entry —
// snap == A included (a revert to A after the capture) — except an R3-60 snap-only operator transition's write, journaled in
// journal/keep/op_snap. A K6 PIN --park writes A[p]: the running daemon never observes that write (its private-index entry is set), and
// neither does a restart. The journaled entry lasts while snap holds it: an apply that takes other bytes of that path into snap drops it
// (core.commit). Final review F6 (flips EF2's 'the PIN keeps its pair'): the park withdraws the K6 pair (an OFF_DISK PIN holds no group,
// so the pair would publish the parked bytes) and its paths are re-captured from the disk; with no pair naming k6.txt any more, a later
// return to A's bytes is no change at all — nothing to re-form or publish after a kill.
test('a K6 PIN --park writes A[p] and withdraws its ready pair: a restart does not re-form the operator\'s write; once an apply took a human edit of the path into snap the entry is gone, and a later return to A\'s bytes leaves nothing to re-form after a kill (EF2 r1 F3, final review F6)', T10, async () => {
  let claimed = false;
  await withCores('rdis-k6-opsnap', { n: 1, files: { ...FILES, [K6_FILE]: buf(T9) }, ports: { gate: k6Gate(() => claimed) } }, async (fx) => {
    const p = fx.peers[0]!;
    const { pair: k6Pair } = await editAndCapture(fx, p, { [K6_FILE]: t9([4, 'a human hunk in a foreign claim']), [R1]: t9([3, 'same change-set']) });
    claimed = true;
    fx.advance(30_000);
    assert.equal((await publishStep(p.core, await prep(p))).c ?? null, null, 'B1 holds the group');
    const k6 = p.core.holds.nonTerminal().find((r) => r.kind === 'PIN' && r.guards.some((g) => g.name.startsWith('claim:')))!;
    assert.deepEqual(await resolve(p.core, await prepIt(p, { forceFetch: true, holdPaths: k6.paths }), k6.id, 'park', HUMAN), done('HOLD_PARKED', k6.id));
    const a = await blob(p, T9);
    assert.deepEqual([...(await readOpSnap(p.core.repo, p.core.view!))].sort(), [[K6_FILE, a], [R1, a]].sort(), 'the park journaled its writes in op_snap');
    assert.ok(!p.core.cs.ready().some((x) => x.csId === k6Pair.csId), 'the park withdrew the K6 pair (F6)');
    // A restart (the process dies after the park): no pair names either path, and neither operator's write is re-formed.
    await restartCore(p);
    await restart(p.core);
    await prep(p);
    assert.ok(!p.core.cs.ready().some((x) => x.paths.includes(K6_FILE) || x.paths.includes(R1)), 'no ready pair names the parked paths');
    assert.deepEqual([...p.core.cs.openPaths()].filter((x) => x === K6_FILE || x === R1), [], 'the operator\'s writes are re-formed into no change-set');

    // The human edits k6.txt; an apply takes the edit into snap: the k6.txt entry leaves op_snap (R1's stays).
    const applyWith = async (row: number): Promise<void> => {
      await fx.pushTeamChange({ [R3]: buf(t9([row, `team row ${row}`])) });
      fx.advance(10_000);
      const r = await applyStep(p.core, await prep(p));
      assert.equal(r.skipped, null, JSON.stringify(r));
    };
    await writeWork(p, K6_FILE, t9([7, 'a later human edit']));
    await prep(p);
    await applyWith(2);
    assert.deepEqual([...(await readOpSnap(p.core.repo, p.core.view!))], [[R1, a]], 'the apply took other bytes of k6.txt into snap: its entry is gone');
    // Back to A's bytes (a human change, not the operator's), taken into snap by the next apply; then a kill before any capture.
    await writeWork(p, K6_FILE, T9);
    await prep(p);
    await applyWith(6);
    assert.equal((await p.core.repo.readTreeMap(p.core.view!.snap)).get(K6_FILE)?.oid, a, 'snap[k6.txt] == A[k6.txt] again');
    fx.advance(1_000);
    await killedAt('snapshot.index_written', 1, () => prep(p, true));
    await restartCore(p);
    await restart(p.core);
    await prep(p);
    // Before F6 the K6 pair (R[k6.txt] ≠ snap == A) made this return the human change to re-form; with the pair withdrawn the disk, snap
    // and A agree and no pair names the path, so there is nothing to re-form or publish.
    assert.ok(!p.core.cs.ready().some((x) => x.paths.includes(K6_FILE) || x.paths.includes(R1)), 'no ready pair names the parked paths');
    assert.ok(!p.core.cs.openPaths().has(K6_FILE), `the return to A's bytes needs no re-form: ${JSON.stringify([...p.core.cs.openPaths()])}`);
    assert.ok(!p.core.cs.openPaths().has(R1), 'nor does the operator\'s write of src/r1.txt');
  });
});

// EF2 fix round 2 (the round-1 re-review's finding; ruling: an op_snap entry is dropped when a human change of that path is captured — the
// capture commit drops the op_snap entries of the paths its newly captured pairs name). A capture's state commit does not move snap, so
// core.commit's pruning never saw a human edit of an operator-written path that was captured rather than applied: after park (op_snap[p] =
// snap[p] = A[p]), an edit to X captured into a pair (R[p] = X) and a return to A's bytes that only the open CS held, a kill made the
// restart read R[p] = X ≠ snap[p] as the operator's write, so nothing re-formed the return and the stale X capture published while the disk
// kept A. Two shapes: the PIN discarded after the park (state-only: the park's entries stay; the whole run converges), and the PIN still
// parked (the restart-side facts only). Final review F6: in both the park itself withdrew the K6 pair (a Plan 2 pair with no CS: its paths
// wait for the next capture, which the human edit's open CS takes them into), so the only pair naming k6.txt is the human one and it names
// src/r1.txt too.
for (const shape of ['discarded', 'parked'] as const) {
  test(`a K6 PIN --park writes A[p]${shape === 'discarded' ? ' and --discard ends the PIN' : ''}; a human edit of p captured by captureStep drops p's op_snap entry, so a return to A's bytes cut off by a kill before the next capture is re-formed by the restart${shape === 'discarded' ? ' and the superseded capture never publishes' : ''} (${shape}; EF2 r2)`, T10, async () => {
    let claimed = false;
    await withCores(`rdis-k6-recap-${shape}`, { n: 1, files: { ...FILES, [K6_FILE]: buf(T9) }, ports: { gate: k6Gate(() => claimed) } }, async (fx) => {
      const p = fx.peers[0]!;
      const { pair: k6Pair } = await editAndCapture(fx, p, { [K6_FILE]: t9([4, 'a human hunk in a foreign claim']), [R1]: t9([3, 'same change-set']) });
      claimed = true;
      fx.advance(30_000);
      assert.equal((await publishStep(p.core, await prep(p))).c ?? null, null, 'B1 holds the group');
      const k6 = p.core.holds.nonTerminal().find((r) => r.kind === 'PIN' && r.guards.some((g) => g.name.startsWith('claim:')))!;
      assert.deepEqual(await resolve(p.core, await prepIt(p, { forceFetch: true, holdPaths: k6.paths }), k6.id, 'park', HUMAN), done('HOLD_PARKED', k6.id));
      if (shape === 'discarded') {
        assert.deepEqual(await resolve(p.core, await prepIt(p, { forceFetch: true, holdPaths: k6.paths }), k6.id, 'discard', HUMAN), done('RESOLVED_DISCARD', k6.id));
        claimed = false;
      }
      assert.ok(!p.core.cs.ready().some((x) => x.csId === k6Pair.csId), 'no K6 pair: the park withdrew it (final review F6)');
      const a = await blob(p, T9);
      assert.deepEqual([...(await readOpSnap(p.core.repo, p.core.view!))].sort(), [[K6_FILE, a], [R1, a]].sort(), 'the park journaled its writes in op_snap');

      // The human edits k6.txt; captureStep journals a pair with R[k6.txt] = X. Its state commit does not move snap.
      const X = t9([7, 'a later human edit, captured']);
      const captured = await humanCapture(fx, p, { [K6_FILE]: X });
      const x = await blob(p, X);
      const newest = [...p.core.cs.ready()].sort((m, n) => m.order - n.order).filter((r) => r.paths.includes(K6_FILE)).at(-1);
      assert.ok(newest !== undefined && captured.includes(newest.csId), `captureStep journaled a pair naming k6.txt: ${JSON.stringify({ captured, ready: p.core.cs.ready().map((r) => [r.csId, r.paths]) })}`);
      assert.equal((await p.core.repo.readTreeMap(newest.R)).get(K6_FILE)?.oid, x, 'with R[k6.txt] = X');
      assert.equal((await p.core.repo.readTreeMap(p.core.view!.snap)).get(K6_FILE)?.oid, a, 'snap[k6.txt] still holds the park\'s write');
      const opsAfterCapture = [...(await readOpSnap(p.core.repo, p.core.view!))];

      // Back to A's bytes: only the open human CS holds this change (in memory); the process dies before the next capture.
      await writeWork(p, K6_FILE, T9);
      await prep(p);
      fx.advance(1_000);
      await prep(p);
      assert.ok(p.core.cs.openPaths().has(K6_FILE), `the open CS holds the return to A: ${JSON.stringify([...p.core.cs.openPaths()])}`);
      fx.advance(1_000);
      await killedAt('snapshot.index_written', 1, () => prep(p, true));
      await restartCore(p);
      await restart(p.core);
      await prep(p);   // the first tick after the restart: disk == snap == A[k6.txt], the newest pair's R is X
      assert.ok(p.core.cs.openPaths().has(K6_FILE), `the return to A's bytes is re-formed: ${JSON.stringify([...p.core.cs.openPaths()])}`);
      assert.ok(!p.core.cs.openPaths().has(R1), 'src/r1.txt, which no human changed, is not');
      // The capture dropped k6.txt's entry, and src/r1.txt's too: the paths of the withdrawn K6 pair (F6) were re-captured with the human edit,
      // so its pair names src/r1.txt as well — harmless, its R[src/r1.txt] is the operator's bytes, which snap holds, so the re-form hands it
      // over in neither shape.
      assert.deepEqual(opsAfterCapture, [], 'the capture of the human edit dropped the op_snap entries of the paths its pairs name');
      assert.ok(newest.paths.includes(R1), `the withdrawn K6 paths were re-captured with the human edit (F6): ${JSON.stringify(newest.paths)}`);
      if (shape === 'parked') {
        return;
      }

      // The re-formed CS is captured (R[k6.txt] = A) and the group publishes A's bytes, never X.
      fx.advance(20_000);
      await captureStep(p.core, await prep(p, true));
      for (let i = 0; i < 4 && p.core.cs.ready().length > 0; i++) {
        fx.advance(30_000);
        const pub = await publishStep(p.core, await prep(p));
        if (pub.c !== undefined && pub.c !== null) assert.equal((await treeOf(p, pub.c)).get(K6_FILE)?.oid, a, `the superseded capture X never publishes (${pub.outcome})`);
      }
      assert.deepEqual(p.core.cs.ready().map((r) => r.csId), [], 'every pair left journal/ready/');
      assert.equal((await remoteLive(fx, p)).get(K6_FILE), a, 'live k6.txt is A\'s bytes');
      assert.equal((await prep(p)).A.get(K6_FILE)?.oid, a, 'A[k6.txt] converged with the disk');
      assert.equal(await text(p, K6_FILE), T9, 'the disk keeps A\'s bytes');
    });
  });
}

// EF2 fix round 2, the bundle arm: a closing CS whose group holds a held PIN journals no pair — it joins the PIN as a bundle (HLD-49,
// R3-44) — but it is a captured human change all the same, so its paths' op_snap entries go too. The operator's write here is made the way
// the park family makes it (the disk write, then holdOps.parkWritten: the private-index entry and the R3-60 snap-only transition that
// journals op_snap), on the paths of a K6 PIN that stays ON_DISK and held. Without the drop, a return to the operator's bytes cut off by a
// kill read as that write at the restart: nothing re-formed it and the PIN's h1 kept the superseded edit.
test('a K6 PIN held ON_DISK: a human edit of an operator-written path that captureStep bundles into the PIN drops that path\'s op_snap entry (src/r1.txt\'s stays), so a return to the operator\'s bytes cut off by a kill is re-formed by the restart and bundled into the PIN\'s h1 (bundled; EF2 r2)', T10, async () => {
  let claimed = false;
  await withCores('rdis-k6-recap-bundled', { n: 1, files: { ...FILES, [K6_FILE]: buf(T9) }, ports: { gate: k6Gate(() => claimed) } }, async (fx) => {
    const p = fx.peers[0]!;
    const { pair: k6Pair } = await editAndCapture(fx, p, { [K6_FILE]: t9([4, 'a human hunk in a foreign claim']), [R1]: t9([3, 'same change-set']) });
    claimed = true;
    fx.advance(30_000);
    assert.equal((await publishStep(p.core, await prep(p))).c ?? null, null, 'B1 holds the group');
    const k6 = p.core.holds.nonTerminal().find((r) => r.kind === 'PIN' && r.guards.some((g) => g.name.startsWith('claim:')))!;
    // The operator writes A's bytes over both paths (disk, then the R3-60 transition); the PIN stays ON_DISK and held.
    const a = await blob(p, T9);
    await writeWork(p, K6_FILE, T9);
    await writeWork(p, R1, T9);
    await parkWritten(p.core, [K6_FILE, R1].map((q) => ({ path: q, expected: ABSENT, target: a })), () => '100644');
    assert.deepEqual([...(await readOpSnap(p.core.repo, p.core.view!))].sort(), [[K6_FILE, a], [R1, a]].sort(), 'the operator\'s writes are journaled in op_snap');
    fx.advance(1_000);
    await prep(p);
    assert.deepEqual([...p.core.cs.openPaths()], [], 'the operator\'s writes join no change-set');

    // The human edits k6.txt to X: its CS closes into the held group and joins the PIN as a bundle (no pair is journaled).
    const X = t9([7, 'a later human edit, bundled']);
    const captured = await humanCapture(fx, p, { [K6_FILE]: X });
    assert.deepEqual(captured, [], 'no pair is journaled for a CS bundled into a held PIN');
    const bundled = p.core.holds.get(k6.id)!;
    assert.ok(bundled.residence === 'ON_DISK' && bundled.cs_ids.length > k6.cs_ids.length, `the CS joined the PIN: ${JSON.stringify({ residence: bundled.residence, cs_ids: bundled.cs_ids })}`);
    assert.equal(blobAt(heldSide(bundled), K6_FILE), await blob(p, X), 'the PIN\'s h1[k6.txt] = X');
    assert.deepEqual(p.core.cs.ready().filter((r) => r.paths.includes(K6_FILE)).map((r) => r.csId), [k6Pair.csId], 'the only pair naming k6.txt is the K6 pair, captured before the operator\'s write');
    const opsAfterCapture = [...(await readOpSnap(p.core.repo, p.core.view!))];

    // Back to the operator's bytes, held only by the open CS; the process dies before the next capture.
    await writeWork(p, K6_FILE, T9);
    await prep(p);
    fx.advance(1_000);
    await prep(p);
    assert.ok(p.core.cs.openPaths().has(K6_FILE), `the open CS holds the return: ${JSON.stringify([...p.core.cs.openPaths()])}`);
    fx.advance(1_000);
    await killedAt('snapshot.index_written', 1, () => prep(p, true));
    await restartCore(p);
    await restart(p.core);
    await prep(p);   // the first tick after the restart: disk == snap == the operator's bytes, the K6 pair's R is the PIN's first edit
    assert.ok(p.core.cs.openPaths().has(K6_FILE), `the return to the operator's bytes is re-formed: ${JSON.stringify([...p.core.cs.openPaths()])}`);
    assert.ok(!p.core.cs.openPaths().has(R1), 'the operator\'s write of src/r1.txt still is not (no later capture named it)');
    assert.deepEqual(opsAfterCapture, [[R1, a]], 'the bundle dropped k6.txt\'s op_snap entry and kept src/r1.txt\'s');

    // The re-formed CS is bundled into the PIN in turn: its h1[k6.txt] is the human's newest bytes, never the superseded X.
    fx.advance(20_000);
    await captureStep(p.core, await prep(p, true));
    assert.equal(blobAt(heldSide(p.core.holds.get(k6.id)!), K6_FILE), a, 'the PIN\'s h1[k6.txt] is the return to the operator\'s bytes');
  });
});

// EF2 fix round 1, F5 (Table 4 `--discard` of an INCOMING record: "the record ends and the next apply writes TIP as usual"; ruling: the
// discard clears that path's meta.pending row). EF2 D5's recordStep re-derives a not-applicable path's INCOMING record from its
// meta.pending row; with the row left in place the very next recordStep re-created the record the human had just discarded (and raised
// INCOMING_UNMATERIALIZABLE again). With the row cleared the record comes back only when a later apply re-evaluates the path and it
// still cannot apply.
test('--discard of an INCOMING unmaterializable record clears its meta.pending row: the next recordStep re-creates nothing; the next apply that still cannot write the path makes a new record (EF2 r1 F5)', T10, async () => {
  const files = { 'README.md': buf('# incoming discard\n'), 'src/a.txt': buf('a\n') };
  await withCores('rdis-incoming-na', { n: 1, files, platform: 'win32' }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    const step = async (): Promise<void> => {
      const it = await prep(p, 'auto');
      await recordStep(p.core, it, await applyStep(p.core, it));
    };
    await fx.pushTeamChange({ 'con.py': buf('print(1)\n'), 'src/x.txt': buf('x\n') });
    fx.advance(10_000);
    await step();
    const first = incomingRecords(p).filter((r) => r.paths[0] === 'con.py');
    assert.equal(first.length, 1, 'one INCOMING record for con.py');
    assert.equal(p.core.view!.meta.pending['con.py'], 'unmaterializable', 'with its meta.pending row');
    const raised = (): number => log.lines.filter((x) => x.code === 'INCOMING_UNMATERIALIZABLE').length;
    const before = raised();
    assert.deepEqual(await resolve(p.core, await prepIt(p, { forceFetch: true }), first[0]!.id, 'discard', HUMAN), done('RESOLVED_DISCARD', first[0]!.id));
    assert.equal(Object.hasOwn(p.core.view!.meta.pending, 'con.py'), false, 'the discard cleared con.py\'s meta.pending row');
    // The next iteration, inside the apply coalescing window (no apply re-evaluates con.py): nothing is re-created.
    fx.advance(2_500);
    await step();
    assert.deepEqual(incomingRecords(p).filter((r) => r.paths[0] === 'con.py').map((r) => r.id), [], 'no INCOMING record re-created by recordStep');
    assert.equal(raised(), before, 'INCOMING_UNMATERIALIZABLE is not raised again');
    // con.py alone never triggers an apply (P2-CARRY: a TIP path that cannot be created here is carried); the next apply — another incoming
    // change — re-evaluates it, and it still cannot be written here: a new record, and the row again.
    fx.advance(10_000);
    await step();
    assert.deepEqual(incomingRecords(p).filter((r) => r.paths[0] === 'con.py').map((r) => r.id), [], 'no apply ran: still none');
    await fx.pushTeamChange({ 'src/a.txt': buf('a team\n') });
    fx.advance(10_000);
    await step();
    const again = incomingRecords(p).filter((r) => r.paths[0] === 'con.py');
    assert.equal(again.length, 1, 'the next apply makes one new record');
    assert.notEqual(again[0]!.id, first[0]!.id);
    assert.equal(p.core.view!.meta.pending['con.py'], 'unmaterializable');
  });
});
