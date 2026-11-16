// S6, the 24 h ON_DISK hold auto-park (Plan 3 Task 12b; 05-holds HLD-61, HLD-16, HLD-62, §3.4 item 3; 05 I11, TC-HLD-06, I-DAT-12's
// offline variant; glossary §20 "ON_DISK hold auto-park", §25.2 item 1 (S6 waits for durability); Review Focus 2 and 4; rulings R3-36,
// R3-45; ENG-37). timerStep's s6Step parks an ON_DISK PATCH or PIN with local_only false aged ≥ S6_AFTER_MS that is durable on the
// fetched board tip, in no open CS, outside every FREEZE reason and with no kept push intent — the markers park for a record carrying
// `markers` — and retries REFRESHED, LOCKED and POSTPONED at a later loop. makeEngines({n: 2}) on real clones of one file:// remote; ages
// come from the peer's VirtualClock; the synthetic teammate writes the teammate lines; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHeld } from '../../src/board/boardCommit.js';
import { breakerTick, revertStep } from '../../src/engine/detect.js';
import { S6_AFTER_MS, s6Step } from '../../src/engine/escalation.js';
import { evaluateRecords, restore } from '../../src/engine/holdOps.js';
import { resolve } from '../../src/engine/resolve.js';
import { hasRestoreMarkerRow } from '../../src/data/rows.js';
import type { Oid } from '../../src/git/oid.js';
import { heldBlobs, mirrorKey } from '../../src/holds/mirror.js';
import { blobAt, heldSide } from '../../src/holds/record.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { readWork, workPath, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { logOf, withEngines, type EngineFixture } from '../helpers/engineFixture.js';
import { DAY, elevenReverts, HUNDRED, MIN, rec, tFile, tText, untilDurable, untilNoOpenCs } from '../helpers/escalationFixture.js';
import { remoteLive } from '../helpers/dataRecordsFixture.js';
import { blob, nr, pair, prepIt, registryCommits, remoteCoworkBlobs } from '../helpers/holdOpsFixture.js';
import { fpy, humanRemovesTeamLine, remoteLiveFiles, restartEngine, roundsUntil, statusOf, T10, teammateLine, withGuard } from '../helpers/loopHoldsFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { win } from '../helpers/mirrorFixture.js';
import { buf, captureReady, failedResult, prep, withCores, wrapGit } from '../helpers/publishHelpers.js';
import { HUMAN, landHoldOps } from '../helpers/resolveFixture.js';

const N = 30;
const IMG0 = Buffer.concat([Buffer.from([0, 1, 2, 3]), buf('IMG v0 original bytes\nmore original\n')]);
const IMG_TEAM = Buffer.concat([Buffer.from([0, 9, 8, 7]), buf('IMG TEAMBIN v1 bytes\nTEAMBIN = 1\n')]);
const IMG2 = Buffer.concat([Buffer.from([0, 5, 5, 5]), buf('IMG v2 a later local save\n')]);
const FILES: Record<string, Buffer> = {
  'README.md': buf('# s6\n'),
  'f.py': buf(fpy(N)),
  'other.txt': buf('o1\no2\no3\n'),
  '.env': buf('SECRET=1\n'),
  'img.bin': IMG0,
};
const WIN = process.platform === 'win32';
/** A NOT_ADMITTED `portability` new name a record can carry (Task 7's: D7 rule 2, a reserved device name; on win32 an over-long component). */
const NON_PORTABLE = WIN ? `${'\u{d55c}'.repeat(100)}.txt` : 'con.py';

type EnginePeer = EngineFixture['peers'][number];

async function started(fx: EngineFixture): Promise<EnginePeer> {
  await fx.startAll();
  await fx.rounds(2);
  return fx.peers[0]!;
}

/** Peer 0's ON_DISK revert PATCH over f.py (the teammate's TEAM = 1 removed by a stale save), durable on the board. */
async function durableRevert(fx: EngineFixture, p: EnginePeer): Promise<{ id: string; team: string; held: string }> {
  const team = await teammateLine(fx, p, N, 10);
  const r = await humanRemovesTeamLine(fx, p, N);
  await untilDurable(fx, p, [r.id]);
  return { id: r.id, team, held: fpy(N) };
}

/** Every fetch, ls-remote and push of p fails as an unreachable remote does; returns the reconnect. */
function offline(p: PeerFixture): () => void {
  return wrapGit(p, async (args, opts, inner) => (args[0] === 'fetch' || args[0] === 'ls-remote' || args[0] === 'push'
    ? failedResult(128, 'fatal: unable to access the remote\n') : inner(args, opts)));
}

const mine = (p: PeerFixture) => (e: TraceEvent): boolean => (e as { peer?: string }).peer === p.core.peerId;

/**
 * Rounds one at a time (at most `max`) until record `id` is OFF_DISK; the round in which a Bnew of p carried a mirror of `id` first
 * (`mirrored`, from `since`) and the round in which it left the disk (`parked`); -1 when it did not happen.
 */
async function mirrorThenPark(fx: EngineFixture, p: EnginePeer, id: string, max = 16): Promise<{ mirrored: number; parked: number }> {
  let mirrored = -1;
  let parked = -1;
  for (let i = 0; i < max && parked < 0; i++) {
    const from = fx.trace.events.length;
    await fx.rounds(1);
    const ev = fx.trace.events.slice(from).filter(mine(p));
    if (mirrored < 0 && ev.some((e) => e.kind === 'mirror' && e.holds.some((h) => h.id === id))) mirrored = i;
    if (ev.some((e) => e.kind === 'hold' && e.id === id && e.residence === 'OFF_DISK')) parked = i;
  }
  return { mirrored, parked };
}

test('05 I11 / TC-HLD-06: an ACTIVE revert record with local_only false is auto-parked at 24 h: OFF_DISK PARKED, displaced_by null, disk = the team version, its held/ blobs on the board, HOLD_AUTO_PARKED {path, hid, next: \'/cowork resolve <id> --restore\'}, and --restore brings the bytes back', T10, async () => {
  assert.equal(S6_AFTER_MS, 86_400_000);
  await withEngines('s6-i11', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    const log = logOf(p);
    const { id, team, held } = await durableRevert(fx, p);
    assert.equal(rec(p, id).local_only, false);
    fx.advance(DAY - 10 * MIN);
    await fx.rounds(2);
    assert.equal(rec(p, id).residence, 'ON_DISK', 'not before 24 h');
    fx.advance(10 * MIN);
    await fx.rounds(1);
    const r = rec(p, id);
    assert.deepEqual([r.residence, r.state, r.displaced_by], ['OFF_DISK', 'PARKED', null]);
    assert.equal((await readWork(p, 'f.py'))?.toString('utf8'), team, 'disk = the team version');
    assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_AUTO_PARKED').map((l) => l.params), [{ path: 'f.py', hid: id, next: '/cowork resolve <id> --restore' }]);
    const st = await statusOf(p);
    assert.deepEqual([st.state, st.message_code, st.message_params], ['ok', 'HOLD_AUTO_PARKED', { path: 'f.py', hid: id, next: '/cowork resolve <id> --restore' }], 'status');
    // The parked rev is mirrored: the board's held/<id>/ holds the record's blobs.
    await untilDurable(fx, p, [id]);
    const held0 = await readHeld(p.core.repo, p.core.view!.meta.fold_board! as Oid, id);
    assert.deepEqual(held0, heldBlobs(rec(p, id)), 'held/<id>/ on the board');
    assert.equal((await p.core.repo.readBlob(blobAt(heldSide(rec(p, id)), 'f.py') as Oid)).toString('utf8'), held, 'the registry holds the bytes');
    const res = await fx.resolve(0, id, 'restore');
    assert.equal(res.kind, 'done', JSON.stringify(res));
    assert.equal((await readWork(p, 'f.py'))?.toString('utf8'), held, '--restore brings the bytes back');
  });
});

test('S6 is postponed while any FREEZE reason is set and parks in the first loop after the lift', T10, async () => {
  await withEngines('s6-freeze', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    const { id } = await durableRevert(fx, p);
    await p.core.commit({ meta: { ...p.core.view!.meta, freeze_reasons: ['MASS'] } });
    fx.advance(DAY);
    await fx.rounds(3);
    assert.equal(rec(p, id).residence, 'ON_DISK', 'postponed under FREEZE(MASS)');
    const rep = await p.engine.resume();
    assert.equal(rep.massLifted, true);
    await fx.rounds(1);
    assert.deepEqual([rec(p, id).residence, rec(p, id).state], ['OFF_DISK', 'PARKED'], 'parked in the first loop after the lift');
  });
});

// Fix round 1 (minor c): s6Step runs in timerStep, which an out-of-cycle iteration (Engine.signal: steps 0–4) never reaches; so only a
// loop iteration materializes the S6 candidates' paths (W6 (c): no hold-record occasion without its operator).
test('an out-of-cycle iteration materializes no S6 candidate\'s path and parks nothing; the next loop iteration parks it', T10, async () => {
  await withEngines('s6-outofcycle', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    const { id } = await durableRevert(fx, p);
    await untilNoOpenCs(fx, p);
    fx.advance(DAY);
    const snap = p.core.snapshot;
    const materialize = snap.materialize.bind(snap);
    const only: Array<string[] | null> = [];
    snap.materialize = (inp, o) => {
      only.push(o === undefined ? null : [...o]);
      return materialize(inp, o);
    };
    try {
      // A boundary signal of a seat with nothing open asks for an out-of-cycle iteration that has nothing to capture.
      await fx.signal(0, { kind: 'stop', seat: 'c'.repeat(32) });
      assert.ok(!only.some((x) => x !== null && x.includes('f.py')), `no materialization of f.py out of cycle: ${JSON.stringify(only)}`);
      assert.equal(rec(p, id).residence, 'ON_DISK', 'nothing parked out of cycle');
      only.length = 0;
      await fx.rounds(1);
      assert.ok(only.some((x) => x === null || x.includes('f.py')), `the loop iteration materialized f.py: ${JSON.stringify(only)}`);
    } finally {
      snap.materialize = materialize;
    }
    assert.deepEqual([rec(p, id).residence, rec(p, id).state], ['OFF_DISK', 'PARKED'], 'parked by the loop iteration');
  });
});

test('Review Focus 4: a peer offline since before the record\'s creation keeps it ON_DISK past 24 h; after reconnect the queued mirror lands first and S6 parks in a later loop', T10, async () => {
  await withEngines('s6-offline', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    await teammateLine(fx, p, N, 10);
    const reconnect = offline(p);
    let id: string;
    try {
      const r = await humanRemovesTeamLine(fx, p, N);
      id = r.id;
      fx.advance(DAY + 10 * MIN);
      await fx.rounds(3);
      assert.equal(rec(p, id).residence, 'ON_DISK', 'never auto-parked while not mirrored');
      assert.equal((await p.engine.inspect()).mirror[id]?.durable, false);
    } finally {
      reconnect();
    }
    fx.advance(6 * MIN);   // past the network backoff
    const { mirrored, parked } = await mirrorThenPark(fx, p, id);
    assert.ok(mirrored >= 0, 'the queued mirror landed');
    assert.ok(parked > mirrored, `S6 parked in a later loop than the mirror's: mirror ${mirrored}, park ${parked}`);
    assert.deepEqual([rec(p, id).residence, rec(p, id).state], ['OFF_DISK', 'PARKED']);
  });
});

/** The 300 paths of the many-path PIN: long names, so its op line is over 16 KiB. */
const manyPath = (i: number): string => `many/a-rather-long-directory-name-for-the-op-line/file-number-${String(i).padStart(3, '0')}-with-a-long-suffix.txt`;
const MANY: Record<string, Buffer> = { ...FILES, ...Object.fromEntries(Array.from({ length: 300 }, (_, i) => [manyPath(i), buf(`m${i}\n`)])) };

test('a HOLD_MIRROR_REJECTED record and a many-path PIN whose op line exceeds 16 KiB are never auto-parked, and durabilityReport lists both in notDurable', T10, async () => {
  await withEngines('s6-rejected', { n: 2, files: MANY }, async (fx) => {
    const p = await started(fx);
    const log = logOf(p);
    await teammateLine(fx, p, N, 10);
    const reconnect = offline(p);
    let revert: string;
    let pin: string;
    try {
      // Offline: the revert record is made, and a human change to many/000 is captured (not published).
      await writeWork(p, manyPath(0), 'm0 changed\n');
      revert = (await humanRemovesTeamLine(fx, p, N)).id;
      fx.advance(21_000);
      await roundsUntil(fx, () => p.core.cs.ready().some((x) => x.paths.includes(manyPath(0))), 'the change captured');
      // A forged `validator` rejection of the revert record's mirror key (05 F5 shape), its unlanded draft dropped.
      await p.core.holds.markMirrorRejected(revert, mirrorKey(rec(p, revert)), 'validator');
      p.core.outbox.drop((d) => d.type === 'hold' && d.hold_id === revert);
      // A many-path PIN over the 300 paths (the R-22 `join` shape): its op line is over 16 KiB.
      const A = await p.core.repo.readTreeMap(p.core.view!.base);
      const h0: Record<string, Oid> = {};
      const h1: Record<string, Oid> = {};
      for (let i = 0; i < 300; i++) h0[manyPath(i)] = h1[manyPath(i)] = A.get(manyPath(i))!.oid;
      h1[manyPath(0)] = await p.core.repo.hashBytes(buf('m0 changed\n'), true);
      pin = await p.core.holds.hold({
        kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: Object.keys(h0), guard: 'join', origin: 'human', cs_ids: [], displaced_by: null, blobs: { h0, h1 },
      });
      assert.equal(rec(p, pin).local_only, false);
    } finally {
      reconnect();
    }
    fx.advance(DAY + 6 * MIN);
    await fx.rounds(4);
    assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_MIRROR_REJECTED').map((l) => l.params), [{ hold_id: pin, reason: 'validator' }], 'the PIN\'s local rejection');
    for (const id of [revert, pin]) assert.deepEqual([rec(p, id).residence, rec(p, id).state], ['ON_DISK', 'ACTIVE'], `${id} never auto-parked`);
    const report = await p.engine.durabilityReport();
    assert.ok(report.notDurable.includes(revert) && report.notDurable.includes(pin), JSON.stringify(report));
  });
});

test('I-DAT-12 variant: a record restored with markers while the remote is unreachable stays ON_DISK past 24 h; after reconnect the markers park runs in a later loop and no restore-marker row reaches any remote object', T10, async () => {
  await withEngines('s6-markers', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    const { id, team } = await durableRevert(fx, p);
    assert.equal((await fx.resolve(0, id, 'park')).kind, 'done');
    await untilDurable(fx, p, [id]);
    const reconnect = offline(p);
    let marked: Buffer;
    try {
      // The line next to the held change edited, then a RESTORE that conflicts: restore-marker rows on disk, guard `markers`.
      await writeWork(p, 'f.py', fpy(N, { after: { 10: 'TEAM = 1' }, replace: { 10: 'row_10 = ten' } }));
      const it = await prepIt(p, { holdPaths: ['f.py'] });
      const out = await restore(p.core, it, id, { humanEvidence: true, actor: 'human' });
      assert.deepEqual(out, { kind: 'RESTORED', markers: true });
      marked = (await readWork(p, 'f.py'))!;
      assert.ok(hasRestoreMarkerRow(marked), 'marker rows on disk');
      fx.advance(DAY + 10 * MIN);
      await fx.rounds(3);
      assert.deepEqual([rec(p, id).residence, rec(p, id).guards.map((g) => g.name)], ['ON_DISK', ['revert', 'markers']], 'stays ON_DISK while unmirrored');
    } finally {
      reconnect();
    }
    fx.advance(6 * MIN);
    const { mirrored, parked } = await mirrorThenPark(fx, p, id);
    assert.ok(mirrored >= 0 && parked > mirrored, `the markers park ran in a later loop than the mirror: ${mirrored} ${parked}`);
    assert.equal((await readWork(p, 'f.py'))?.toString('utf8'), team, 'disk = the team version');
    const companions = p.core.holds.companionsOf(id).filter((c) => c.state === 'PARKED');
    assert.equal(companions.length, 1, 'one marker companion');
    const c = companions[0]!;
    assert.deepEqual([c.residence, c.local_only], ['OFF_DISK', true]);
    assert.ok((await p.core.repo.readBlob(blobAt(heldSide(c), 'f.py') as Oid)).equals(marked), 'the companion holds the marker file byte-exact');
    await fx.rounds(3);
    for (const b of await remoteCoworkBlobs(fx)) assert.ok(!hasRestoreMarkerRow(b), 'no restore-marker row in any remote object');
    const res = await fx.resolve(0, c.id, 'restore');
    assert.equal(res.kind, 'done', JSON.stringify(res));
    assert.ok((await readWork(p, 'f.py'))!.equals(marked), '--restore of the companion brings the rows back');
    assert.deepEqual(rec(p, c.id).guards.map((g) => g.name), ['markers']);
  });
});

test('S6 never parks a local_only record at any age', T10, async () => {
  await withEngines('s6-localonly', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    // A secret-like `.env` restart record (local_only by its path), planted in a loop that materializes (an apply runs).
    await writeWork(p, '.env', 'SECRET=2\n');
    await fx.pushTeamChange({ 'README.md': buf('# s6, edited\n') });
    const A = await p.core.repo.readTreeMap(p.core.view!.base);
    const env = await p.core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: ['.env'], guard: 'restart', origin: 'daemon', cs_ids: [], displaced_by: null,
      blobs: { h0: { '.env': A.get('.env')!.oid }, h1: { '.env': await p.core.repo.hashBytes(buf('SECRET=2\n'), true) } },
    });
    fx.advance(10_000);
    await fx.rounds(1);
    // A `portability` record (DAT-33: a new file whose name D7 refuses but a record can carry).
    await writeWork(p, NON_PORTABLE, 'np\n');
    await roundsUntil(fx, () => withGuard(p, 'portability').length === 1, 'the portability record');
    const port = withGuard(p, 'portability')[0]!.id;
    for (const x of [env, port]) assert.deepEqual([rec(p, x).residence, rec(p, x).local_only], ['ON_DISK', true], `${x} local_only ON_DISK`);
    fx.advance(2 * DAY);
    await fx.rounds(4);
    for (const x of [env, port]) assert.equal(rec(p, x).residence, 'ON_DISK', `${x} is never auto-parked`);
    assert.equal((await readWork(p, '.env'))?.toString('utf8'), 'SECRET=2\n');
  });
});

test('S6 is postponed while a record path is in an open human CS and parks after that CS has been captured', T10, async () => {
  await withEngines('s6-opencs', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    const { id } = await durableRevert(fx, p);
    await untilNoOpenCs(fx, p);
    fx.advance(DAY);
    // The human keeps editing f.py elsewhere (untainted rows): the open human CS holds f.py.
    for (let k = 0; k < 4; k++) {
      await writeWork(p, 'f.py', fpy(N, { replace: { 25: `row_25 = edit ${k}` } }));
      await fx.rounds(1);
      assert.ok(p.core.cs.openPaths().has('f.py'), 'f.py in the open human CS');
      assert.equal(rec(p, id).residence, 'ON_DISK', `postponed while open (${k})`);
    }
    const captured = await roundsUntil(fx, () => !p.core.cs.openPaths().has('f.py'), 'the CS captured', 16);
    assert.ok(captured > 0);
    await roundsUntil(fx, () => rec(p, id).residence === 'OFF_DISK', 'parked after the capture', 4);
    assert.match((await readWork(p, 'f.py'))!.toString('utf8'), /row_25 = edit 3/, 'the untainted edit stays on disk');
    assert.match((await readWork(p, 'f.py'))!.toString('utf8'), /TEAM = 1/, 'the held change left the disk');
  });
});

test('a PIN whose park must refresh its held side first commits the refresh rev and parks only after that rev is durable, in a later loop', T10, async () => {
  await withEngines('s6-refresh', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    await fx.pushTeamChange({ 'img.bin': IMG_TEAM });
    await roundsUntil(fx, async () => (await readWork(p, 'img.bin'))?.equals(IMG_TEAM) === true, 'the teammate img.bin applied');
    await writeWork(p, 'img.bin', IMG0);   // a stale copy: a binary revert PIN
    await roundsUntil(fx, () => withGuard(p, 'revert').length === 1, 'the revert PIN');
    const id = withGuard(p, 'revert')[0]!.id;
    assert.equal(rec(p, id).kind, 'PIN');
    // The human CS of the stale save closes against the held PIN and joins it as a bundle (HLD-49): it waits for the PIN, and never
    // blocks the PIN's own S6.
    await roundsUntil(fx, () => rec(p, id).cs_ids.length > 0 && p.core.cs.table().cs.every((e) => e.state !== 'open'), 'the CS bundled into the PIN', 16);
    // The PIN's held side is not the disk (in the loop a captured change refreshes a held PIN through its bundle, HLD-49; here the
    // registry is given an older held side directly), mirrored and durable.
    const r0 = rec(p, id);
    assert.ok('h0' in r0.blobs);
    await p.core.holds.transition(id, { blobs: { h0: { ...r0.blobs.h0 }, h1: { 'img.bin': await p.core.repo.hashBytes(IMG2, true) } } });
    await untilDurable(fx, p, [id]);
    const rev = rec(p, id).rev;
    fx.advance(DAY);
    await fx.rounds(1);
    const refreshed = rec(p, id);
    assert.equal(refreshed.residence, 'ON_DISK', 'the refresh loop parks nothing');
    assert.equal(refreshed.rev, rev + 1, 'one refresh rev');
    assert.equal(blobAt(heldSide(refreshed), 'img.bin'), await p.core.repo.hashBytes(IMG0, false), 'h1 := S_disk');
    assert.ok((await readWork(p, 'img.bin'))!.equals(IMG0), 'nothing written');
    assert.equal((await p.engine.inspect()).mirror[id]?.durable, false, 'the refresh rev is not durable yet');
    const { mirrored, parked } = await mirrorThenPark(fx, p, id);
    assert.ok(mirrored >= 0 && parked > mirrored, `parked only after the refresh rev was mirrored, in a later loop: ${mirrored} ${parked}`);
    assert.ok((await readWork(p, 'img.bin'))!.equals(IMG_TEAM), 'disk = the team version');
    assert.equal(blobAt(heldSide(rec(p, id)), 'img.bin'), await p.core.repo.hashBytes(IMG0, false), 'the parked bytes are the refreshed ones');
  });
});

test('a share-none lock on the record\'s file at 24 h writes nothing and keeps the record ON_DISK; S6 parks after the lock is released', T10, async () => {
  await withEngines('s6-lock', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    const { id, held, team } = await durableRevert(fx, p);
    await untilNoOpenCs(fx, p);
    const release = p.fs.holdLock(workPath(p, 'f.py'), 'share-none');
    try {
      fx.advance(DAY);
      await fx.rounds(3);
      assert.equal(rec(p, id).residence, 'ON_DISK', 'LOCKED: the residence does not change');
    } finally {
      release();
    }
    assert.equal((await readWork(p, 'f.py'))?.toString('utf8'), held, 'nothing written');
    await roundsUntil(fx, () => rec(p, id).residence === 'OFF_DISK', 'parked after the release', 6);
    assert.equal((await readWork(p, 'f.py'))?.toString('utf8'), team);
  });
});

test('age survives a restart: 20 h, drain() (one flushAgeAnchors commit, no park), restart, 4 h more → parked', T10, async () => {
  await withEngines('s6-restart', { n: 2, files: FILES }, async (fx) => {
    let p = await started(fx);
    const { id, team } = await durableRevert(fx, p);
    await untilNoOpenCs(fx, p);
    // This PC's wall clock stepped back two days (an NTP correction): from here only the accumulated Δmono ages the record.
    const wall = p.clock.wallMs.bind(p.clock);
    p.clock.wallMs = (): number => wall() - 2 * DAY;
    try {
      fx.advance(20 * 60 * MIN);
      await fx.rounds(1);
      assert.equal(rec(p, id).residence, 'ON_DISK');
      const { commits } = await registryCommits(p, () => p.engine.drain(null));
      assert.equal(commits, 1, 'one flushAgeAnchors commit');
      assert.equal(rec(p, id).residence, 'ON_DISK', 'drain never parks');
      assert.equal(p.core.outbox.drafts().filter((d) => d.type === 'hold').length, 0, 'no hold op');
      await restartEngine(p);
      p = fx.peers[0]!;
      fx.advance(4 * 60 * MIN);
      // EF2 D4: the apply's state:snap carries its round trip (snap[f.py] = the team version), so after the restart's reseed the first
      // tick reads the held removal (disk ≠ snap) into the human CS (R-01) and S6 waits until that CS has closed (HLD-61: no path in an
      // open CS) — 20 s of quiet after the 4 h jump (the bound was 4 rounds before EF2).
      await roundsUntil(fx, () => rec(p, id).residence === 'OFF_DISK', 'parked at 24 h of accumulated age', 16);
      // That change-set's capture was masked while the record held its path, and nothing of the removal publishes after the park.
      await fx.rounds(8);
      assert.equal((await remoteLiveFiles(fx, p)).get('f.py'), team, 'live f.py keeps the team line');
    } finally {
      p.clock.wallMs = wall;
    }
  });
});

test('S6 parking 11 durable records in one loop is attributed: no MASS, no revert record, no human CS', T10, async () => {
  await withEngines('s6-eleven', { n: 2, files: HUNDRED }, async (fx) => {
    const p = await started(fx);
    const ids = await elevenReverts(fx, p);
    await untilDurable(fx, p, ids, 24);
    await untilNoOpenCs(fx, p);
    fx.advance(DAY);
    await fx.rounds(1);
    for (const id of ids) assert.deepEqual([rec(p, id).residence, rec(p, id).state], ['OFF_DISK', 'PARKED'], `${id} parked in the one loop`);
    for (let i = 0; i < 11; i++) assert.equal((await readWork(p, tFile(i)))?.toString('utf8'), tText(i, true));
    const paths = new Set(ids.map((id) => rec(p, id).paths[0]!));
    const reverts = withGuard(p, 'revert').length;
    for (let k = 0; k < 3; k++) {
      fx.advance(2_500);
      const it = await prepIt(p, { materialize: true });
      assert.deepEqual([...it.tick!.changed].filter((x) => paths.has(x)), [], `tick ${k} lists none of the 11 paths`);
      assert.equal(await breakerTick(p.core, it), null);
      assert.deepEqual(await revertStep(p.core, it), [], 'no revert record');
      assert.ok(!p.core.view!.meta.freeze_reasons.includes('MASS'), 'no MASS');
      assert.deepEqual([...p.core.cs.openPaths()].filter((x) => paths.has(x)), [], 'no human CS');
    }
    assert.equal(withGuard(p, 'revert').length, reverts);
  });
});

// EF2 fix round 1, F6 (controller ruling: S6 also waits while any unpublished ready pair covers the record's paths). A revert PATCH the
// human released with `--publish` is guard-less and waits for RESOLVED_PUBLISH; its hunks became an observed change of the human CS
// (Table 4), captured into a ready pair that has not published yet. Parking it then took the hunks off the disk while the pair still
// published them, and the record ended PARKED with its held side equal to A (the round-0 report's "sixth defect").
test('EF2 r1 F6: S6 waits while another CS\'s unpublished ready pair covers a record\'s path — a revert PATCH released by --publish, its hunks waiting in the captured human pair, is not parked at 24 h; once the pair landed R1 ends it RESOLVED_PUBLISH', T10, async () => {
  const P9 = 'src/t9.txt';
  await withCores('s6-ready-pair', { n: 1, files: { 'README.md': buf('# s6 ready pair\n'), [P9]: buf(T9) } }, async (fx) => {
    const p = fx.peers[0]!;
    const HELD = t9([2, 'a teammate row the human removed, then published']);
    await writeWork(p, P9, HELD);
    const it0 = await prepIt(p, { materialize: false });
    const id = await p.core.holds.hold(nr({ paths: [P9], blobs: pair(it0.A.get(P9)!.oid, await blob(p, HELD), P9) }));
    const res = await resolve(p.core, await prepIt(p, { holdPaths: [P9], forceFetch: true }), id, 'publish', HUMAN);
    assert.equal(res.kind, 'done', JSON.stringify(res));
    assert.deepEqual([p.core.holds.get(id)!.guards, p.core.holds.get(id)!.residence], [[], 'ON_DISK'], 'guard-less, ON_DISK');
    await landHoldOps(fx, p);   // its current rev is durable on the board; nothing of the CS is captured yet, so nothing of it publishes
    fx.advance(21_000);
    const held = await captureReady(p, await prep(p, true));
    assert.ok(held.paths.includes(P9) && !p.core.holds.get(id)!.cs_ids.includes(held.csId), 'another CS\'s pair carries the hunks');
    assert.ok(!p.core.cs.openPaths().has(P9), 'no open CS holds the path');
    fx.advance(S6_AFTER_MS + 60_000);
    const it = await prepIt(p, { holdPaths: [P9], forceFetch: true });
    assert.deepEqual(await s6Step(p.core, it), [], 'S6 parks nothing while the pair is unpublished');
    assert.equal(p.core.holds.get(id)!.residence, 'ON_DISK');
    assert.equal((await readWork(p, P9))?.toString('utf8'), HELD, 'the hunks stay on disk');
    // The pair lands with the hunks; R1 then ends the record RESOLVED_PUBLISH (its content is in A), never PARKED.
    let landed = false;
    for (let i = 0; i < 4 && !landed; i++) landed = (await win(fx, p)).r.outcome === 'landed';
    assert.ok(landed, 'the pair landed');
    assert.equal((await remoteLive(fx, p)).get(P9), await blob(p, HELD), 'the released hunks published');
    const after = await prepIt(p, { materialize: true });
    await evaluateRecords(p.core, after, new Set(after.A.keys()), []);
    assert.equal(p.core.holds.get(id)!.state, 'RESOLVED_PUBLISH');
  });
});

// EF2 fix round 1, F6, the record's own change-set: a guard-less PIN is no held PIN (heldPins), so the pair of a CS it names publishes
// too; S6 waits for that pair as for any other (a released PIN parked under its still-unpublished pair would lose its bytes from the
// disk while the pair publishes them).
test('EF2 r1 F6: a guard-less PIN released by --publish whose own change-set\'s ready pair is still unpublished is not parked at 24 h', T10, async () => {
  const P9 = 'src/t9.txt';
  await withCores('s6-own-pair', { n: 1, files: { 'README.md': buf('# s6 own pair\n'), [P9]: buf(T9) } }, async (fx) => {
    const p = fx.peers[0]!;
    const HELD = t9([4, 'a joined local row']);
    await writeWork(p, P9, HELD);
    const it0 = await prep(p);   // the tick: the open human CS takes the path
    assert.ok(p.core.cs.openPaths().has(P9));
    const next = `${p.core.peerId}/human/${p.core.view!.meta.cs_human_next}`;   // the cs_id that CS's capture gets (HLD-33)
    const id = await p.core.holds.hold(nr({ kind: 'PIN', guard: 'join', paths: [P9], blobs: pair(it0.A.get(P9)!.oid, await blob(p, HELD), P9), cs_ids: [next] }));
    const res = await resolve(p.core, await prepIt(p, { holdPaths: [P9], forceFetch: true }), id, 'publish', HUMAN);
    assert.equal(res.kind, 'done', JSON.stringify(res));
    assert.deepEqual(p.core.holds.get(id)!.guards, [], 'released: guard-less, no held PIN');
    await landHoldOps(fx, p);   // durable; the CS is not captured yet, so no code publishes
    fx.advance(21_000);
    const own = await captureReady(p, await prep(p, true));
    assert.equal(own.csId, next, 'the pair is the PIN\'s own change-set');
    fx.advance(S6_AFTER_MS + 60_000);
    const it = await prepIt(p, { holdPaths: [P9], forceFetch: true });
    assert.deepEqual(await s6Step(p.core, it), [], 'S6 waits for the record\'s own unpublished pair');
    assert.equal(p.core.holds.get(id)!.residence, 'ON_DISK');
    assert.equal((await readWork(p, P9))?.toString('utf8'), HELD, 'the bytes stay on disk');
  });
});
