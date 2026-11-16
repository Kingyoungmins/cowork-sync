// The stop primitives Plan 7 builds `/cowork stop` and `uninstall` on (Plan 3 Task 12b; 05-holds HLD-62, HLD-63, §5 INV-HLD-DURABLE, 05
// I9 engine part, Table 2, M1; rulings R3-36, R3-45, R3-60): Engine.drain flushes the age anchors and never parks (also on
// IDLE_NO_SESSION); durabilityReport lists the non-terminal records that are not durable on the fetched board (local_only ones only in
// localOnly); parkAllForStop(leaveOpId) parks every ON_DISK PATCH/PIN with local_only false (displaced_by = the leave op, the markers
// park for a `markers` record, a refresh not yet durable reported failed); discardHolds ends each id through Table 4 --discard. The
// park family and --discard are attributed writes (ObservedWrites, the private-index entry, state:snap), so neither the detectors nor a
// restart see them as unobserved deltas. makeEngines on real clones of one file:// remote; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breakerTick, revertStep } from '../../src/engine/detect.js';
import { discardHolds } from '../../src/engine/escalation.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { blobAt, heldSide } from '../../src/holds/record.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { readWork, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { withEngines, type EngineFixture } from '../helpers/engineFixture.js';
import { DAY, elevenReverts, HUNDRED, privateEntries, rec, snapEntries, tFile, tText, untilDurable, untilNoOpenCs } from '../helpers/escalationFixture.js';
import { prepIt, registryCommits } from '../helpers/holdOpsFixture.js';
import { fpy, humanRemovesTeamLine, restartEngine, roundsUntil, T10, teammateLine, withGuard } from '../helpers/loopHoldsFixture.js';
import { buf } from '../helpers/publishHelpers.js';
import { gitIn } from '../helpers/startFixture.js';

const N = 30;
const IMG0 = Buffer.concat([Buffer.from([0, 1, 2, 3]), buf('IMG v0 original bytes\nmore original\n')]);
const IMG_TEAM = Buffer.concat([Buffer.from([0, 9, 8, 7]), buf('IMG TEAMBIN v1 bytes\nTEAMBIN = 1\n')]);
const IMG2 = Buffer.concat([Buffer.from([0, 5, 5, 5]), buf('IMG v2 a later local save\n')]);
const MARKED = 'm1\n<<<<<<< cowork:disk\nm2 local\n||||||| cowork:base\nm2\n=======\nm2 held\n>>>>>>> cowork:held\nm3\n';
const WIN = process.platform === 'win32';
const NON_PORTABLE = WIN ? `${'\u{d55c}'.repeat(100)}.txt` : 'con.py';
const FILES: Record<string, Buffer> = {
  'README.md': buf('# stop primitives\n'),
  'f.py': buf(fpy(N)),
  'g.txt': buf('g1\ng2\ng3\n'),
  'k.txt': buf('k1\nk2\nk3\n'),
  'm.txt': buf('m1\nm2\nm3\n'),
  'img.bin': IMG0,
};

type EnginePeer = EngineFixture['peers'][number];

async function started(fx: EngineFixture): Promise<EnginePeer> {
  await fx.startAll();
  await fx.rounds(2);
  return fx.peers[0]!;
}

const hash = (p: PeerFixture, s: string | Buffer): Promise<Oid> => p.core.repo.hashBytes(typeof s === 'string' ? buf(s) : s, true);
const holdDrafts = (p: PeerFixture): number => p.core.outbox.drafts().filter((d) => d.type === 'hold').length;
/** The `leave` op id Plan 7 would allocate: this peer's next own op id. */
const leaveOpOf = (p: PeerFixture): string => `${p.core.peerId}/${p.core.view!.meta.epoch}/${p.core.view!.meta.seq_next}`;

test('drain() flushes age anchors in one registry commit with no hold op and never parks, also on IDLE_NO_SESSION', T10, async () => {
  await withEngines('stop-drain', { n: 1, files: FILES }, async (fx) => {
    let p = await started(fx);
    await teammateLine(fx, p, N, 10);
    const r = await humanRemovesTeamLine(fx, p, N);
    await untilDurable(fx, p, [r.id]);
    for (const code of [null, 'IDLE_NO_SESSION'] as const) {
      fx.advance(DAY + 60_000);   // past S6's age, with no loop in between: only drain runs
      const accum = rec(p, r.id).age_anchor.mono_accum_ms;
      const drafts = holdDrafts(p);
      const pushes = p.core.pushAttempts;
      const { commits } = await registryCommits(p, () => p.engine.drain(code));
      assert.equal(commits, 1, `${code}: one registry commit`);
      const after = rec(p, r.id);
      assert.ok(after.age_anchor.mono_accum_ms >= accum + DAY, `${code}: the accumulated Δmono flushed (${accum} → ${after.age_anchor.mono_accum_ms})`);
      assert.deepEqual([after.residence, after.state], ['ON_DISK', 'ACTIVE'], `${code}: drain never parks`);
      assert.equal(holdDrafts(p), drafts, `${code}: no hold op`);
      assert.equal(p.core.pushAttempts, pushes, `${code}: no push`);
      assert.equal((await readWork(p, 'f.py'))?.toString('utf8'), fpy(N), `${code}: the disk untouched`);
      await restartEngine(p);
      p = fx.peers[0]!;
    }
  });
});

test('05 I9 engine part: durabilityReport lists every non-terminal non-local_only record in notDurable before one governed push and none after it, lists local_only records only in localOnly, and a kill at registry.cas plus git gc --prune=now loses no record or blob', T10, async () => {
  await withEngines('stop-i9', { n: 1, files: FILES }, async (fx) => {
    let p = await started(fx);
    // Records of several kinds and guard classes, made between iterations (no push yet).
    const A = await p.core.repo.readTreeMap(p.core.view!.base);
    const a = (path: string): Oid => A.get(path)!.oid;
    const parked = await p.core.holds.hold({ kind: 'PATCH', residence: 'OFF_DISK', state: 'PARKED', paths: ['g.txt'], guard: 'revert', origin: 'human', cs_ids: [], displaced_by: null, blobs: { h0: { 'g.txt': a('g.txt') }, h1: { 'g.txt': await hash(p, 'g1\ng2 held\ng3\n') } } });
    const conflicted = await p.core.holds.hold({ kind: 'PATCH', residence: 'OFF_DISK', state: 'CONFLICTED', paths: ['k.txt'], guard: 'conflict', origin: 'daemon', cs_ids: [], displaced_by: null, blobs: { s1: { 'k.txt': a('k.txt') }, s2: { 'k.txt': await hash(p, 'k1\nk2 mine\nk3\n') }, s3: { 'k.txt': a('k.txt') } } });
    const late = await p.core.holds.hold({ kind: 'PATCH', residence: 'OFF_DISK', state: 'PARKED', paths: ['README.md'], guard: null, origin: 'daemon', cs_ids: [], displaced_by: null, blobs: { h0: { 'README.md': a('README.md') }, h1: { 'README.md': await hash(p, '# late\n') } } });
    const secret = await p.core.holds.hold({ kind: 'PATCH', residence: 'OFF_DISK', state: 'PARKED', paths: ['.env'], guard: null, origin: 'daemon', cs_ids: [], displaced_by: null, blobs: { h0: { '.env': ABSENT }, h1: { '.env': await hash(p, 'SECRET=1\n') } } });
    assert.equal(rec(p, secret).local_only, true);
    const mirrored = [parked, conflicted, late];
    const before = await p.engine.durabilityReport();
    for (const id of mirrored) assert.ok(before.notDurable.includes(id), `${id} not durable before the push`);
    assert.deepEqual(before.localOnly, [secret]);
    assert.ok(!before.notDurable.includes(secret) && !before.offDisk.includes(secret), 'a local_only record only in localOnly');
    const pushes = p.core.pushAttempts;
    await fx.rounds(1);
    assert.equal(p.core.pushAttempts, pushes + 1, 'one governed push');
    const after = await p.engine.durabilityReport();
    assert.deepEqual(after.notDurable, [], `none after it: ${JSON.stringify(after)}`);
    assert.deepEqual(after.localOnly, [secret]);
    // A kill at registry.cas (before, then after the CAS) of a registry commit, then `git gc --prune=now`: nothing is lost.
    for (const nth of [1, 2]) {
      fx.advance(60_000);
      let hits = 0;
      setCrashHandler((name) => {
        if (name === 'registry.cas' && ++hits === nth) throw new KilledAt(name);
      });
      try {
        await assert.rejects(p.engine.drain(null), (e: unknown) => e instanceof KilledAt, `killed at registry.cas #${nth}`);
      } finally {
        setCrashHandler(null);
      }
      await gitIn(p, ['gc', '--prune=now', '--quiet']);
      await restartEngine(p);
      p = fx.peers[0]!;
      for (const id of [...mirrored, secret]) {
        const r = p.core.holds.get(id);
        assert.ok(r !== undefined && r.state === (id === conflicted ? 'CONFLICTED' : 'PARKED'), `kill #${nth}: ${id} kept`);
        for (const path of r.paths) {
          const o = blobAt(heldSide(r), path);
          if (o !== undefined && o !== ABSENT) assert.ok((await p.core.repo.readBlob(o as Oid)).length > 0, `kill #${nth}: ${id}'s blob survives gc`);
        }
      }
    }
  });
});

test('parkAllForStop(leaveOpId) parks every ON_DISK PATCH or PIN with local_only false with displaced_by = leaveOpId, parks a markers record by the markers park and lists its companion, leaves local_only records ON_DISK, and reports a record whose refresh rev is not yet durable in failed', T10, async () => {
  await withEngines('stop-park', { n: 1, files: FILES }, async (fx) => {
    const p = await started(fx);
    await teammateLine(fx, p, N, 10);
    const revert = (await humanRemovesTeamLine(fx, p, N)).id;
    // A binary revert PIN whose held side the disk no longer equals (its park must refresh it first: a rev not yet durable).
    await fx.pushTeamChange({ 'img.bin': IMG_TEAM });
    await roundsUntil(fx, async () => (await readWork(p, 'img.bin'))?.equals(IMG_TEAM) === true, 'the teammate img.bin applied');
    await writeWork(p, 'img.bin', IMG0);
    await roundsUntil(fx, () => withGuard(p, 'revert').some((r) => r.paths[0] === 'img.bin'), 'the binary revert PIN');
    const pin = withGuard(p, 'revert').find((r) => r.paths[0] === 'img.bin')!.id;
    const r0 = rec(p, pin);
    assert.ok('h0' in r0.blobs);
    await p.core.holds.transition(pin, { blobs: { h0: { ...r0.blobs.h0 }, h1: { 'img.bin': await hash(p, buf('an older held side\n')) } } });
    // A markers record: restore-marker rows on disk (R1 and the markers PREDICATE keep it while they are there).
    await writeWork(p, 'm.txt', MARKED);
    const A = await p.core.repo.readTreeMap(p.core.view!.base);
    const markers = await p.core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: ['m.txt'], guard: 'markers', origin: 'human', cs_ids: [], displaced_by: null,
      blobs: { h0: { 'm.txt': A.get('m.txt')!.oid }, h1: { 'm.txt': await hash(p, 'm1\nm2 held\nm3\n') } },
    });
    // A local_only record: a `portability` record (DAT-33).
    await writeWork(p, NON_PORTABLE, 'np\n');
    await roundsUntil(fx, () => withGuard(p, 'portability').length === 1, 'the portability record');
    const port = withGuard(p, 'portability')[0]!.id;
    const leave = leaveOpOf(p);
    const res = await p.engine.parkAllForStop(leave);
    assert.deepEqual([...res.parked].sort(), [markers, revert].sort(), JSON.stringify(res));
    assert.deepEqual(res.failed, [pin], 'the refresh rev is not durable yet');
    const companions = p.core.holds.companionsOf(markers);
    assert.deepEqual(res.companions, companions.map((c) => c.id));
    assert.equal(companions.length, 1);
    for (const id of [revert, markers]) assert.deepEqual([rec(p, id).residence, rec(p, id).state, rec(p, id).displaced_by], ['OFF_DISK', 'PARKED', leave], `${id}`);
    assert.equal(rec(p, pin).residence, 'ON_DISK');
    assert.equal(blobAt(heldSide(rec(p, pin)), 'img.bin'), await p.core.repo.hashBytes(IMG0, false), 'the PIN\'s refresh rev: h1 := the disk');
    assert.deepEqual([rec(p, port).residence, rec(p, port).local_only], ['ON_DISK', true], 'local_only records stay ON_DISK');
    assert.ok(!res.parked.includes(port) && !res.failed.includes(port));
    assert.equal((await readWork(p, 'f.py'))?.toString('utf8'), fpy(N, { after: { 10: 'TEAM = 1' } }), 'the team version on disk');
    assert.equal((await readWork(p, 'm.txt'))?.toString('utf8'), 'm1\nm2\nm3\n', 'the markers park wrote A');
  });
});

// Fix round 1 (minor a): a stop whose only candidate needs a refresh rev parks nothing, yet that rev is a registry change the stop's
// final publish must carry (R3-45: it is parked once the rev is durable) — Engine.parkAllForStop drafts its mirror too.
test('parkAllForStop with only a refresh-needing PIN parks nothing, reports it failed, and drafts the refresh rev\'s mirror for the stop\'s final publish', T10, async () => {
  await withEngines('stop-refresh-only', { n: 1, files: FILES }, async (fx) => {
    const p = await started(fx);
    await fx.pushTeamChange({ 'img.bin': IMG_TEAM });
    await roundsUntil(fx, async () => (await readWork(p, 'img.bin'))?.equals(IMG_TEAM) === true, 'the teammate img.bin applied');
    await writeWork(p, 'img.bin', IMG0);
    await roundsUntil(fx, () => withGuard(p, 'revert').some((r) => r.paths[0] === 'img.bin'), 'the binary revert PIN');
    const pin = withGuard(p, 'revert').find((r) => r.paths[0] === 'img.bin')!.id;
    await untilDurable(fx, p, [pin]);
    await roundsUntil(fx, () => p.core.outbox.pendingHold(pin) === null, 'no hold op of the PIN pending');
    // A later local save of the PIN's file (no loop runs before the stop): its held side is no longer the disk, so its park refreshes
    // the held side first (HLD-16) and parks only once that rev is durable (R3-45).
    await writeWork(p, 'img.bin', IMG2);
    fx.advance(1_000);   // past the quiet period: the stop's materialization reads it
    const res = await p.engine.parkAllForStop(leaveOpOf(p));
    assert.deepEqual(res, { parked: [], companions: [], failed: [pin] }, 'the refresh rev is not durable yet');
    const r1 = rec(p, pin);
    assert.equal(r1.residence, 'ON_DISK');
    assert.equal(blobAt(heldSide(r1), 'img.bin'), await p.core.repo.hashBytes(IMG2, false), 'the refresh rev: h1 := the disk');
    assert.deepEqual(await readWork(p, 'img.bin'), IMG2, 'nothing written');
    const draft = p.core.outbox.pendingHold(pin);
    assert.ok(draft !== null, 'the refresh rev\'s mirror is drafted');
    assert.deepEqual([draft.rev, draft.residence, draft.state], [r1.rev, 'ON_DISK', r1.state], 'the draft carries the refresh rev');
  });
});

test('discardHolds ends each id RESOLVED_DISCARD through Table 4 --discard with a mirrored op', T10, async () => {
  await withEngines('stop-discard', { n: 1, files: FILES }, async (fx) => {
    const p = await started(fx);
    await teammateLine(fx, p, N, 10);
    const onDisk = (await humanRemovesTeamLine(fx, p, N)).id;
    await untilNoOpenCs(fx, p);
    const A = await p.core.repo.readTreeMap(p.core.view!.base);
    const offDisk = await p.core.holds.hold({ kind: 'PATCH', residence: 'OFF_DISK', state: 'PARKED', paths: ['g.txt'], guard: 'revert', origin: 'human', cs_ids: [], displaced_by: null, blobs: { h0: { 'g.txt': A.get('g.txt')!.oid }, h1: { 'g.txt': await hash(p, 'g1\ng2 held\ng3\n') } } });
    const it = await prepIt(p, { holdPaths: ['f.py', 'g.txt'] });
    assert.deepEqual(await discardHolds(p.core, it, [onDisk, offDisk]), [onDisk, offDisk]);
    for (const id of [onDisk, offDisk]) {
      assert.equal(rec(p, id).state, 'RESOLVED_DISCARD');
      assert.equal(p.core.outbox.pendingHold(id)?.state, 'RESOLVED_DISCARD', `${id}: its op drafted`);
    }
    assert.equal((await readWork(p, 'f.py'))?.toString('utf8'), fpy(N, { after: { 10: 'TEAM = 1' } }), 'the ON_DISK discard wrote A');
    await roundsUntil(fx, async () => {
      const m = (await p.engine.inspect()).mirror;
      return m[onDisk]!.durable && m[offDisk]!.durable;
    }, 'both mirrored');
  });
});

/** Three detection ticks (materializing) on p: none lists `paths`, the breaker stays silent, no revert record, no MASS, no human CS. */
async function threeQuietTicks(fx: EngineFixture, p: EnginePeer, paths: ReadonlySet<string>, what: string): Promise<void> {
  const reverts = withGuard(p, 'revert').length;
  for (let k = 0; k < 3; k++) {
    fx.advance(2_500);
    const it = await prepIt(p, { materialize: true });
    assert.deepEqual([...it.tick!.changed].filter((x) => paths.has(x)), [], `${what}: tick ${k} lists none of the 11 paths`);
    assert.equal(await breakerTick(p.core, it), null, `${what}: breakerTick`);
    assert.deepEqual(await revertStep(p.core, it), [], `${what}: no revert record`);
    assert.ok(!p.core.view!.meta.freeze_reasons.includes('MASS'), `${what}: no MASS`);
    assert.deepEqual([...p.core.cs.openPaths()].filter((x) => paths.has(x)), [], `${what}: no human CS`);
  }
  assert.equal(withGuard(p, 'revert').length, reverts, `${what}: no new revert record`);
}

test('discardHolds of 11 ON_DISK revert PATCHes, then three ticks and a restart: no MASS, no revert record and no human CS', T10, async () => {
  await withEngines('stop-discard11', { n: 1, files: HUNDRED }, async (fx) => {
    let p = await started(fx);
    const ids = await elevenReverts(fx, p);
    await untilNoOpenCs(fx, p);
    const paths = ids.map((id) => rec(p, id).paths[0]!);
    const origins: string[] = [];
    const writer = p.core.writer;
    const orig = writer.writeLocalGroup.bind(writer);
    writer.writeLocalGroup = (entries, origin, humanEvidence) => {
      origins.push(origin);
      return orig(entries, origin, humanEvidence);
    };
    const it = await prepIt(p, { holdPaths: paths });
    assert.deepEqual(await discardHolds(p.core, it, ids), ids);
    assert.deepEqual(origins, ids.map((id) => `discard:${id}`), 'each write carries origin discard:<id>');
    const A = await p.core.repo.readTreeMap(p.core.view!.base);
    const priv = await privateEntries(p, paths);
    const snap = await snapEntries(p, paths);
    for (const [i, path] of paths.entries()) {
      assert.equal((await readWork(p, path))?.toString('utf8'), tText(i, true), `${path}: A written`);
      // Final review F1: recorded in ObservedWrites (R3-36), then forgotten once the private-index entry holds the write (parkWritten).
      assert.ok(!p.core.observed.peek(path, A.get(path)!.oid), `${path}: no lingering ObservedWrites entry (F1)`);
      assert.equal(priv.get(path), A.get(path)!.oid, `${path}: the private-index entry set`);
      assert.equal(snap.get(path), A.get(path)!.oid, `${path}: state:snap`);
    }
    const set = new Set(paths);
    await threeQuietTicks(fx, p, set, 'after the discards');
    await restartEngine(p);
    p = fx.peers[0]!;
    await threeQuietTicks(fx, p, set, 'after a restart');
  });
});

test('parkAllForStop of 11 records, then a restart and 3 ticks: no MASS, no revert record and no human CS', T10, async () => {
  await withEngines('stop-park11', { n: 1, files: HUNDRED }, async (fx) => {
    let p = await started(fx);
    const ids = await elevenReverts(fx, p);
    await untilNoOpenCs(fx, p);
    const res = await p.engine.parkAllForStop(leaveOpOf(p));
    assert.deepEqual([...res.parked].sort(), [...ids].sort(), JSON.stringify(res));
    const paths = ids.map((id) => rec(p, id).paths[0]!);
    await p.engine.drain(null);
    await restartEngine(p);   // a fresh engine: ObservedWrites empty, the private index reseeded from state:snap
    p = fx.peers[0]!;
    const A = await p.core.repo.readTreeMap(p.core.view!.base);
    const priv = await privateEntries(p, paths);
    for (const [i, path] of paths.entries()) {
      assert.equal((await readWork(p, path))?.toString('utf8'), tText(i, true), `${path}: parked to A`);
      assert.equal(priv.get(path), A.get(path)!.oid, `${path}: the private-index entry equals the parked blob after the restart`);
    }
    await threeQuietTicks(fx, p, new Set(paths), 'after the stop and a restart');
    for (const id of ids) assert.equal(rec(p, id).residence, 'OFF_DISK');
    assert.equal(tFile(0), paths[0]);
  });
});
