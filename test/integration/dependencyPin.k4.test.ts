// HLD-42's dependency PIN for a K4-born record (EF4 round 2 P-1, ruling R3-EF4-14; class o-atomic-pub-split, seeds meas-holds-3, 20
// and 22; 05-holds HLD-17, HLD-42, INV-HLD-ATOMIC-PUB exception (c); 03-data DAT-43; glossary §24 default 3; ruling R3-FF2-B0).
// A K4 record never pins its group only while it still IS the TAKE_TIP displacement: stage blobs, CONFLICTED, guard `conflict`
// (isK4Displacement). HLD-17's RESTORE releases `conflict` and leaves the record ON_DISK with its stage blobs; a conflicted restore adds
// `markers` (MASK step 3), and a record left CONFLICTED is withheld whole at MASK step 4 — either way the rest of its group is PINned
// dependency:<id> like any whole-path record ("A path withheld whole by MASK steps 2–4 never splits a CS"). Before the fix,
// dependencySlot skipped every record with stage blobs, so the rest of the CS published alone. The release half: a dependency PIN on
// such a record releases once an apply-side K4 onto it (ruling R3-EF4-7's transition) makes it the displacement again — DAT-43's
// displaced local side does not hold the rest of the CS. Real clones; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasRestoreMarkerRow } from '../../src/data/rows.js';
import { applyStep } from '../../src/engine/apply.js';
import { captureDue } from '../../src/engine/core.js';
import { restore } from '../../src/engine/holdOps.js';
import { recordStep } from '../../src/engine/holdSteps.js';
import { publishStep, releaseDependencyGuards, type PublishReport } from '../../src/engine/publish.js';
import { pinCs, shadowRecord } from '../../src/holds/changesets.js';
import { guardName, isK4Displacement, isTerminal, setBlob, type BlobMap, type HoldRecord } from '../../src/holds/record.js';
import { writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { blob, nr, P, prepIt, stages, withPeers } from '../helpers/holdOpsFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { buf, captureReady, prep, remoteLiveCode, stateA, treeOf } from '../helpers/publishHelpers.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };
const HUMAN = { humanEvidence: true, actor: 'human' } as const;
const OTHER = 'src/other.txt';

const dependencyPinsOf = (p: PeerFixture): HoldRecord[] => p.core.holds.nonTerminal().filter((r) => r.kind === 'PIN' && r.guards.some((g) => guardName(g) === 'dependency'));

/** A = T9{8:eight} through a teammate's change applied here (s3 = A, disk = A). */
async function teamEight(fx: CoreFixture, p: PeerFixture): Promise<void> {
  await fx.pushTeamChange({ [P]: buf(t9([8, 'eight'])) });
  fx.advance(10_000);
  const r = await applyStep(p.core, await prepIt(p, { forceFetch: true }));
  assert.ok(r.written.includes(P), JSON.stringify(r));
}

/**
 * Seed 20's shape: the K4 record as an apply's TAKE_TIP left it (OFF_DISK CONFLICTED [conflict]; s1 = T9, s2 = T9{2:two}, s3 = A),
 * restored by the human over a conflicting disk edit of row 2 — ON_DISK ACTIVE [markers], the restore-marker rows on disk.
 */
async function restoredWithMarkers(p: PeerFixture): Promise<string> {
  const id = await p.core.holds.hold(nr({
    residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon',
    blobs: stages(await blob(p, T9), await blob(p, t9([2, 'two'])), await blob(p, t9([8, 'eight']))),
  }));
  await writeWork(p, P, t9([2, 'TWO'], [8, 'eight']));
  const it = await prepIt(p, { holdPaths: [P] });
  assert.deepEqual(await restore(p.core, it, id, HUMAN), { kind: 'RESTORED', markers: true });
  return id;
}

/** The human CS's ready pair over what is on disk now (P and OTHER), as the I13 test captures it. */
async function captureHuman(fx: CoreFixture, p: PeerFixture): Promise<void> {
  await prep(p);
  fx.advance(20_000);
  await captureReady(p, await prep(p, true));
}

async function publish(fx: CoreFixture, p: PeerFixture): Promise<PublishReport> {
  fx.advance(30_000);
  return publishStep(p.core, await prep(p));
}

test('05 I13 + HLD-42 (seed 20 shape): a conflicted RESTORE of a K4 record adds markers; the rest of the human CS (src/other.txt) is PINned dependency:<id> and nothing of the CS publishes', T10, async () => {
  await withPeers('ef4-k4-markers', {}, async (fx) => {
    const p = fx.peers[0]!;
    await teamEight(fx, p);
    const id = await restoredWithMarkers(p);
    const r0 = p.core.holds.get(id)!;
    assert.deepEqual([r0.residence, r0.state, r0.guards.map((g) => g.name), 's2' in r0.blobs], ['ON_DISK', 'ACTIVE', ['markers'], true],
      'HLD-17: ON_DISK, `conflict` released, `markers` added; the record keeps its stage blobs');
    const tip0 = await remoteLiveCode(fx, p);
    const A0 = (await stateA(p)).get(OTHER)!.oid;
    await writeWork(p, OTHER, 'other, with the restore\n');
    await captureHuman(fx, p);
    const r1 = await publish(fx, p);
    assert.equal(r1.c, null, `HLD-42: nothing of the human CS publishes while markers withholds ${P} whole: ${JSON.stringify(r1)}`);
    assert.equal(await remoteLiveCode(fx, p), tip0, 'the live code chain is unchanged');
    assert.equal((await stateA(p)).get(OTHER)!.oid, A0, `A[${OTHER}] unchanged`);
    const pins = dependencyPinsOf(p);
    assert.equal(pins.length, 1, `one dependency PIN: ${JSON.stringify(pins.map((x) => [x.id, x.guards, x.paths]))}`);
    assert.deepEqual(pins[0]!.guards.map((g) => g.name), [`dependency:${id}`]);
    assert.deepEqual(pins[0]!.paths, [OTHER], 'the group\'s LIVE paths minus the markers record\'s path (pinnablePaths, R3-FF2-B2 / final review F4)');
    assert.deepEqual(r1.dependencyPins, [pins[0]!.id]);
  });
});

test('HLD-42 / R3-FF2-B0 (seed 22 shape): a K4-born record ON_DISK CONFLICTED with no guard (displacement over) pins the rest of the group', T10, async () => {
  await withPeers('ef4-k4-conflicted', {}, async (fx) => {
    const p = fx.peers[0]!;
    await teamEight(fx, p);
    await writeWork(p, P, t9([2, 'two'], [8, 'eight']));
    await writeWork(p, OTHER, 'other, edited\n');
    await captureHuman(fx, p);
    const it = await prepIt(p);
    const id = await p.core.holds.hold(nr({
      residence: 'ON_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', cs_ids: [],
      blobs: stages(await blob(p, T9), it.mat?.sDiskMap.get(P)?.oid ?? await blob(p, t9([2, 'two'], [8, 'eight'])), it.A.get(P)!.oid),
    }));
    await p.core.holds.releaseGuard(id, 'conflict');   // the displacement guard released (HLD-17); the record stays ON_DISK CONFLICTED
    const r0 = p.core.holds.get(id)!;
    assert.deepEqual([r0.residence, r0.state, r0.guards.length, 's2' in r0.blobs], ['ON_DISK', 'CONFLICTED', 0, true]);
    const tip0 = await remoteLiveCode(fx, p);
    const r1 = await publish(fx, p);
    assert.equal(r1.c, null, `HLD-42: an ON_DISK CONFLICTED record withholds ${P} whole, so ${OTHER} waits: ${JSON.stringify(r1)}`);
    assert.equal(await remoteLiveCode(fx, p), tip0);
    const pins = dependencyPinsOf(p);
    assert.equal(pins.length, 1, `one dependency PIN: ${JSON.stringify(pins.map((x) => [x.id, x.guards, x.paths]))}`);
    assert.deepEqual(pins[0]!.guards.map((g) => g.name), [`dependency:${id}`]);
    assert.deepEqual([...pins[0]!.paths].sort(), [OTHER, P].sort());
  });
});

test('control, exception (c) (glossary §24 default 3, DAT-43): an ON_DISK CONFLICTED [conflict] K4 record (the displacement itself) does not pin the group; the rest publishes', T10, async () => {
  await withPeers('ef4-k4-displacement', {}, async (fx) => {
    const p = fx.peers[0]!;
    await teamEight(fx, p);
    await writeWork(p, P, t9([2, 'two'], [8, 'eight']));
    await writeWork(p, OTHER, 'other, edited\n');
    await captureHuman(fx, p);
    const it = await prepIt(p);
    const id = await p.core.holds.hold(nr({
      residence: 'ON_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', cs_ids: [],
      blobs: stages(await blob(p, T9), it.mat?.sDiskMap.get(P)?.oid ?? await blob(p, t9([2, 'two'], [8, 'eight'])), it.A.get(P)!.oid),
    }));
    const A0 = (await stateA(p)).get(P)!.oid;
    const r1 = await publish(fx, p);
    assert.equal(r1.outcome, 'landed', JSON.stringify(r1));
    assert.deepEqual(r1.dependencyPins, [], 'INV-HLD-ATOMIC-PUB exception (c)');
    assert.equal(dependencyPinsOf(p).length, 0);
    const tree = await treeOf(p, r1.c!);
    assert.equal((await p.core.repo.readBlob(tree.get(OTHER)!.oid)).toString('utf8'), 'other, edited\n', `${OTHER} publishes`);
    assert.equal(tree.get(P)?.oid, A0, `${P} stays at A (the K4 record withholds it whole)`);
    assert.ok(p.core.holds.get(id) !== undefined);
  });
});

test('R3-EF4-14 release half (R3-EF4-7 transition): a dependency PIN on a restored markers K4 record releases once an apply-side K4 onto that record makes it the displacement again; the rest of the group then publishes', T10, async () => {
  await withPeers('ef4-k4-redisplaced', {}, async (fx) => {
    const p = fx.peers[0]!;
    await teamEight(fx, p);
    const id = await restoredWithMarkers(p);
    await writeWork(p, OTHER, 'other, with the restore\n');
    await captureHuman(fx, p);
    const r1 = await publish(fx, p);
    assert.equal(r1.c, null, JSON.stringify(r1));
    const pins = dependencyPinsOf(p);
    assert.equal(pins.length, 1, `one dependency PIN: ${JSON.stringify(pins.map((x) => [x.id, x.guards, x.paths]))}`);
    const pin = pins[0]!;
    assert.deepEqual([pin.guards.map((g) => g.name), pin.paths], [[`dependency:${id}`], [OTHER]]);
    // A teammate changes row 2 as well: the apply's merge of (A, S_disk with the restore-marker rows, TIP) conflicts on P — TAKE_TIP,
    // and the K4 lands on the markers record (R3-EF4-7: a local_only companion keeps the marker file, the record goes CONFLICTED
    // [conflict] with marker-free stages and, after the verified TIP write, OFF_DISK with `markers` released).
    const team = t9([2, 'TEAM2'], [8, 'eight']);
    await fx.pushTeamChange({ [P]: buf(team) });
    fx.advance(10_000);
    const it = await prepIt(p, { forceFetch: true });
    const ar = await applyStep(p.core, it);
    assert.ok(ar.written.includes(P), JSON.stringify(ar));
    const rec = p.core.holds.get(id)!;
    assert.deepEqual([rec.residence, rec.state, rec.guards.map((g) => g.name), 's2' in rec.blobs], ['OFF_DISK', 'CONFLICTED', ['conflict'], true],
      'the record is the TAKE_TIP displacement again (isK4Displacement)');
    assert.deepEqual(p.core.holds.get(pin.id)!.guards.map((g) => g.name), [`dependency:${id}`], 'not released before recordStep');
    await recordStep(p.core, it, ar);
    assert.deepEqual(p.core.holds.get(pin.id)!.guards, [],
      'releaseDependencyGuards: a displaced local side does not hold the rest of the CS (HLD-42, DAT-43, glossary §24 default 3) — no human resolve is needed');
    // The rest of the group publishes: a capture over the disk after the apply (P = TIP = A, OTHER edited) lands OTHER.
    await captureHuman(fx, p);
    const r2 = await publish(fx, p);
    assert.equal(r2.outcome, 'landed', JSON.stringify(r2));
    const tree = await treeOf(p, r2.c!);
    assert.equal((await p.core.repo.readBlob(tree.get(OTHER)!.oid)).toString('utf8'), 'other, with the restore\n', `${OTHER} publishes`);
    assert.equal((await p.core.repo.readBlob(tree.get(P)!.oid)).toString('utf8'), team, `${P} is the team's (the displacement keeps A = TIP)`);
    assert.deepEqual(dependencyPinsOf(p).filter((x) => x.guards.length > 0), [], 'no dependency PIN is made again on the displacement');
    const k4 = p.core.holds.get(id)!;
    assert.ok(!isTerminal(k4) && k4.residence === 'OFF_DISK', 'the displaced record waits for its human resolve, off disk');
  });
});

// EF4 round 2 I2-3 (ruling R3-EF4-20; r2 rereview P newBreakage[0]): after a conflicted RESTORE of a K4 record the pinned group keeps its
// ready pair journaled, and that pair's R holds the restore-marker rows. When the human removes the rows, recordStep releases `markers` and
// then the dependency PIN. If that iteration materialized for an apply (a teammate's unrelated change inside the human's quiet period: no
// capture due), the stale pair used to compose at the next window and ENG-41 (k) aborted it (NOT_CONVERGED publish_assert:k) — every
// window of the peer until the group's next capture. Now the release withdraws every ready pair whose R holds a restore-marker row at the
// record's paths (silently, its group whole) and the group is re-captured from the disk: no window aborts, the recapture lands.
test('R3-EF4-20: markers releasing on an apply-driven materialization (no capture due) withdraws the stale marker-bearing pair; no window aborts with publish_assert:k and the re-captured group lands', T10, async () => {
  await withPeers('ef4-markers-withdraw', {}, async (fx) => {
    const p = fx.peers[0]!;
    await teamEight(fx, p);
    const id = await restoredWithMarkers(p);
    await writeWork(p, OTHER, 'other, with the restore\n');
    await captureHuman(fx, p);
    const r1 = await publish(fx, p);
    assert.equal(r1.c, null, JSON.stringify(r1));
    assert.equal(dependencyPinsOf(p).length, 1, 'the group is pinned dependency:<id>');
    const stale = p.core.cs.ready().filter((x) => x.paths.includes(P));
    assert.equal(stale.length, 1, 'premise: the pinned group\'s pair over P is journaled');
    const staleR = await p.core.repo.readTreeMap(stale[0]!.R);
    assert.ok(hasRestoreMarkerRow(await p.core.repo.readBlob(staleR.get(P)!.oid)), 'premise: its R holds the restore-marker rows');
    // The human removes the rows; a teammate's unrelated change arrives inside the human's quiet period.
    const resolved = t9([2, 'two'], [8, 'eight']);
    await writeWork(p, P, resolved);
    await prep(p);
    fx.advance(1_500);
    await prep(p);
    await fx.pushTeamChange({ 'src/team.txt': buf('team\n') });
    fx.advance(10_000);
    const it2 = await prepIt(p, { forceFetch: true });
    assert.equal(captureDue(p.core), false, 'premise: no capture is due (the human\'s quiet period has not passed)');
    const ar = await applyStep(p.core, it2);
    assert.ok(ar.written.includes('src/team.txt'), JSON.stringify(ar));
    assert.ok(it2.mat !== null, 'premise: the iteration materialized (for the apply)');
    await recordStep(p.core, it2, ar);
    assert.ok(!p.core.holds.get(id)!.guards.some((g) => guardName(g) === 'markers'), '`markers` released');
    const readyAfterRelease = p.core.cs.ready().map((x) => x.csId);
    const outcomes: PublishReport[] = [await publishStep(p.core, it2)];
    fx.advance(5_000);
    outcomes.push(await publishStep(p.core, await prep(p)));
    // The group is re-captured from the disk and lands.
    fx.advance(20_000);
    await captureReady(p, await prep(p, true));
    const r4 = await publish(fx, p);
    outcomes.push(r4);
    const aborted = outcomes.filter((r) => r.outcome === 'aborted').map((r) => r.why);
    assert.deepEqual(aborted, [], 'no window aborted (ENG-41 (k) never saw the stale pair)');
    assert.deepEqual(readyAfterRelease, [], 'the release withdrew the stale marker-bearing pair (its group whole) from journal/ready/');
    assert.equal(r4.outcome, 'landed', JSON.stringify(r4));
    const live = await treeOf(p, await remoteLiveCode(fx, p));
    assert.equal((await p.core.repo.readBlob(live.get(P)!.oid)).toString('utf8'), resolved, `${P}: the human's resolution`);
    assert.equal((await p.core.repo.readBlob(live.get(OTHER)!.oid)).toString('utf8'), 'other, with the restore\n', `${OTHER} lands with it`);
  });
});

// EF4 round 2 I2-4 (ruling R3-EF4-22, the scope of R3-EF4-14's release clause; r2 rereview P newBreakage[1]): the release of a dependency
// PIN whose target became a K4 displacement applies to HLD-42 PINs only. An HLD-48 `dependency:<shadow id>` PIN (t0Slot) still releases
// only when its SHADOW is terminal (Table 3): an apply-side K4 hold that attaches to the SHADOW (HLD-07's converge branch of attachOf: same
// kind and path set, s1/s2 equal to its h0/h1) makes it ON_DISK CONFLICTED [claim:<id>, conflict] with stages — isK4Displacement — and
// before the scope the PIN's guard was released (the CS could publish before its SHADOW ended; t0Slot re-made the guard every window).
test('R3-EF4-22: an HLD-48 dependency:<shadow id> PIN keeps its guard when an apply-side K4 attaches to its SHADOW (a target carrying claim is no HLD-42 displacement)', T10, async () => {
  await withPeers('ef4-k4-shadow-scope', {}, async (fx) => {
    const p = fx.peers[0]!;
    const it = await prepIt(p);
    const a = it.A.get(P)!.oid;
    const denied = await blob(p, t9([2, 'two']));
    const tip = await blob(p, t9([2, 'TEAM']));
    const seat = 'a'.repeat(32);
    const sid = await p.core.holds.hold({ ...shadowRecord('claim:abcdefghij234567', P, a, denied, seat), cs_ids: [`${seat}/1`] });
    const h1: BlobMap = {};
    setBlob(h1, OTHER, await blob(p, 'other\n'));
    const pinId = await p.core.holds.hold(pinCs(`dependency:${sid}`, [`${seat}/1`], [OTHER], it.A, h1, seat, 'none'));
    // The apply-side K4 hold call (apply.ts's shape): ON_DISK CONFLICTED `conflict`, s1 = A[p], s2 = S_disk[p] (the denied edit), s3 = TIP[p].
    const k4 = await p.core.holds.holdOutcome({
      kind: 'PATCH', residence: 'ON_DISK', state: 'CONFLICTED', paths: [P],
      blobs: { s1: { [P]: a }, s2: { [P]: denied }, s3: { [P]: tip } },
      guard: 'conflict', origin: 'daemon', cs_ids: [], displaced_by: null,
    });
    assert.deepEqual([k4.id, k4.created], [sid, false], 'the K4 attaches to the SHADOW (HLD-07)');
    const s = p.core.holds.get(sid)!;
    assert.deepEqual([s.residence, s.state, s.guards.map((g) => guardName(g)), isK4Displacement(s)], ['ON_DISK', 'CONFLICTED', ['claim', 'conflict'], true],
      'premise: the SHADOW now reads as a K4 displacement');
    assert.deepEqual(await releaseDependencyGuards(p.core, it), [], 'nothing released');
    assert.deepEqual(p.core.holds.get(pinId)!.guards.map((g) => g.name), [`dependency:${sid}`], 'the HLD-48 PIN waits for its SHADOW to end (Table 3)');
  });
});

// Ruling R3-SPEC-4 (Table 3 / R3-EF4-22; spec batch 1 review, HLD-48 Minor): an HLD-48 `dependency:<shadow id>` PIN releases only when its
// SHADOW is terminal — neither the `released` clause (guard set empty, not CONFLICTED) nor the displacement clause ends it. A SHADOW stays
// one after its `claim` releases (the claim released, STALE, transferred or granted: Table 3 `claim`), so the test is the record's identity,
// not a live `claim` guard: a PATCH whose offer left 'none' (only a SHADOW birth gives a PATCH an offer, HLD-09, glossary SHADOW; an offer
// never returns to 'none'). Before, the claim's release left the SHADOW guard-less — `released` ended the PIN (an OFF_DISK PARKED SHADOW)
// or, after an apply-side K4 attached to it, the displacement clause did (R3-EF4-22's exclusion tested the live `claim` guard only).
test('R3-SPEC-4: an HLD-48 dependency:<shadow id> PIN keeps its guard when the SHADOW\'s claim releases while the SHADOW is non-terminal (guard-less PARKED, or a K4 displacement), and releases once the SHADOW is terminal', T10, async () => {
  for (const attached of [false, true]) {
    await withPeers(`spec4-shadow-${attached ? 'k4' : 'parked'}`, {}, async (fx) => {
      const p = fx.peers[0]!;
      const it = await prepIt(p);
      const a = it.A.get(P)!.oid;
      const denied = await blob(p, t9([2, 'two']));
      const seat = 'a'.repeat(32);
      const claim = 'claim:abcdefghij234567';
      const sid = await p.core.holds.hold({ ...shadowRecord(claim, P, a, denied, seat), cs_ids: [`${seat}/1`] });
      const h1: BlobMap = {};
      setBlob(h1, OTHER, await blob(p, 'other\n'));
      const pinId = await p.core.holds.hold(pinCs(`dependency:${sid}`, [`${seat}/1`], [OTHER], it.A, h1, seat, 'none'));
      if (attached) {
        // R3-EF4-22's shape: an apply-side K4 hold attaches to the SHADOW (HLD-07), ON_DISK CONFLICTED [claim, conflict] with stages.
        const k4 = await p.core.holds.holdOutcome({
          kind: 'PATCH', residence: 'ON_DISK', state: 'CONFLICTED', paths: [P],
          blobs: { s1: { [P]: a }, s2: { [P]: denied }, s3: { [P]: await blob(p, t9([2, 'TEAM'])) } },
          guard: 'conflict', origin: 'daemon', cs_ids: [], displaced_by: null,
        });
        assert.deepEqual([k4.id, k4.created], [sid, false], 'the K4 attaches to the SHADOW (HLD-07)');
      }
      assert.deepEqual(await releaseDependencyGuards(p.core, it), [], 'the claim still holds: nothing released');
      // The claim releases (gate() returns none on the current tip); the SHADOW is not terminal.
      await p.core.holds.releaseGuard(sid, claim);
      const s = p.core.holds.get(sid)!;
      assert.deepEqual([s.residence, s.state, s.guards.map((g) => guardName(g)), s.offer, isTerminal(s), isK4Displacement(s)],
        attached ? ['ON_DISK', 'CONFLICTED', ['conflict'], 'pending_leftover', false, true] : ['OFF_DISK', 'PARKED', [], 'pending_leftover', false, false],
        'premise: a non-terminal SHADOW without `claim`');
      assert.deepEqual(await releaseDependencyGuards(p.core, it), [], 'the claim\'s release ends no HLD-48 PIN');
      assert.deepEqual(p.core.holds.get(pinId)!.guards.map((g) => g.name), [`dependency:${sid}`], 'the HLD-48 PIN waits for its SHADOW to end (Table 3)');
      // The SHADOW ends: the PIN releases.
      await p.core.holds.transition(sid, { state: 'GONE' });
      assert.deepEqual(await releaseDependencyGuards(p.core, it), [pinId], 'a terminal SHADOW releases its HLD-48 PIN');
      assert.deepEqual(p.core.holds.get(pinId)!.guards, []);
    });
  }
});
