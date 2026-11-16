// The escalation ladder on the owner's PC (Plan 3 Task 12b; 05-holds HLD-60, §2 age anchor, INV-CLOCK; 02-protocol INV-ONE-EVENT,
// T-PRO-16's one-time escalation event; glossary §20 "Hold escalation"; rulings R3-45, R3-70; carry 1 of the controller's notes: the
// degraded rung's hold code is cleared when what it names no longer holds). escalationStep runs in timerStep every loop: HOLD_CREATED
// / HOLD_CONFLICTED for every record created since its last call (then HOLD_BINARY_WHOLE_FILE again for a binary-path revert PIN, so
// status ends on it), and one event{kind: health, reason_code: HOLD_REVERT_HELD, refs: [hold_id]} per revert record at age ≥ 10 min,
// never again once the fold or the outbox holds it. Ages come from the record's age_anchor only. makeEngines on real clones of one
// file:// remote; the synthetic teammate writes the teammate lines; git is never mocked.
//
// The rev 2.5 test "HOLD_REVERT_HELD is in HEALTH_REASON_CODES and has an en template" applies only when Plan 8a's
// src/viz/i18n/codes.ts has merged before this task; it has not (no src/viz on this branch), so it moves to follow-up 3-V (F-P3-7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REVERT_EVENT_AFTER_MS, escalationStep, seedEscalation } from '../../src/engine/escalation.js';
import { evaluateRecords } from '../../src/engine/holdOps.js';
import { holdStatusInputs, settleHoldCode } from '../../src/engine/holdSteps.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { readWork, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { logOf, withEngines, type EngineFixture } from '../helpers/engineFixture.js';
import { MIN, rec, revertEvents } from '../helpers/escalationFixture.js';
import { blob, nr, pair, prepIt, recordLog, stages, withPeers } from '../helpers/holdOpsFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { fpy, humanRemovesTeamLine, restartEngine, roundsUntil, statusOf, T10, teammateLine, withGuard } from '../helpers/loopHoldsFixture.js';
import { buf } from '../helpers/publishHelpers.js';

const N = 30;
const G = (team: boolean): string => `g_1 = 1\ng_2 = 2\ng_3 = 3\n${team ? 'TEAM_G = 1\n' : ''}g_4 = 4\ng_5 = 5\n`;
const IMG0 = Buffer.concat([Buffer.from([0, 1, 2, 3]), buf('IMG v0 original bytes\nmore original\n')]);
const IMG_TEAM = Buffer.concat([Buffer.from([0, 9, 8, 7]), buf('IMG TEAMBIN v1 bytes\nTEAMBIN = 1\n')]);
const FILES: Record<string, Buffer> = {
  'README.md': buf('# escalation\n'),
  'f.py': buf(fpy(N)),
  'g.py': buf(G(false)),
  'k.txt': buf('k1\nk2\nk3\n'),
  'r.txt': buf('r1\nr2\nr3\n'),
  'mixed.txt': buf('a\r\nb\nc\r\nd\n'),
  'img.bin': IMG0,
};
const AUTHOR = 'ab'.repeat(16);

type EnginePeer = EngineFixture['peers'][number];

async function started(fx: EngineFixture): Promise<EnginePeer> {
  await fx.startAll();
  await fx.rounds(2);
  return fx.peers[0]!;
}

/** A blob in p's store. */
const hash = (p: PeerFixture, s: string): Promise<Oid> => p.core.repo.hashBytes(buf(s), true);

test('HLD-60: every record creation sets HOLD_CREATED {path, hid, REASON} on the owner\'s PC, and a CONFLICTED record HOLD_CONFLICTED {path, author, hid}, in status and the log', T10, async () => {
  await withEngines('esc-created', { n: 1, files: FILES }, async (fx) => {
    const p = await started(fx);
    const log = logOf(p);
    // A revert PATCH, made by the loop's revert detector: announced in the iteration that made it.
    await teammateLine(fx, p, N, 10);
    const revert = await humanRemovesTeamLine(fx, p, N);
    assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_CREATED').map((l) => l.params), [{ path: 'f.py', hid: revert.id, REASON: 'revert' }], 'the log');
    let st = await statusOf(p);
    assert.deepEqual([st.state, st.message_code, st.message_params], ['degraded', 'HOLD_CREATED', { path: 'f.py', hid: revert.id, REASON: 'revert' }], 'status');
    // An eol-bom PATCH (R-07: a canon-refused save of a mixed-EOL file), made at the materialization that refused it.
    await writeWork(p, 'mixed.txt', 'a\nb\nc\nd\nE\n');
    await roundsUntil(fx, () => withGuard(p, 'eol-bom').length === 1, 'the eol-bom record');
    await fx.rounds(2);
    const eol = withGuard(p, 'eol-bom')[0]!.id;
    const created = (id: string): Array<Record<string, unknown>> => log.lines.filter((l) => l.code === 'HOLD_CREATED' && l.params.hid === id).map((l) => l.params);
    assert.deepEqual(created(eol), [{ path: 'mixed.txt', hid: eol, REASON: 'form' }]);
    // Its captured CS got HLD-42's dependency PIN at publish: a creation too.
    const dep = withGuard(p, 'dependency');
    assert.equal(dep.length, 1, 'the dependency PIN');
    assert.deepEqual(created(dep[0]!.id), [{ path: 'mixed.txt', hid: dep[0]!.id, REASON: 'bundle' }]);
    for (const r of p.core.holds.all()) assert.equal(created(r.id).length, 1, `one HOLD_CREATED line for ${r.id} (${r.guards.map((g) => g.name).join(',')})`);
    // A record born CONFLICTED (a K4 stage record before its TIP write: the local version on disk, materialized in the loop that
    // applies a teammate's README change): HOLD_CONFLICTED, never HOLD_CREATED.
    await writeWork(p, 'k.txt', 'k1\nk2 mine\nk3\n');
    await fx.pushTeamChange({ 'README.md': buf('# escalation, edited\n') });
    const A = await p.core.repo.readTreeMap(p.core.view!.base);
    const k4 = await p.core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'CONFLICTED', paths: ['k.txt'], guard: 'conflict', origin: 'daemon', cs_ids: [], displaced_by: null,
      peer_authors: [AUTHOR], blobs: { s1: { 'k.txt': A.get('k.txt')!.oid }, s2: { 'k.txt': await hash(p, 'k1\nk2 mine\nk3\n') }, s3: { 'k.txt': await hash(p, 'k1\nk2 team\nk3\n') } },
    });
    fx.advance(10_000);
    await fx.rounds(1);
    assert.equal((await readWork(p, 'README.md'))?.toString('utf8'), '# escalation, edited\n', 'the loop applied (and materialized)');
    assert.deepEqual([rec(p, k4).residence, rec(p, k4).state], ['ON_DISK', 'CONFLICTED']);
    assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_CONFLICTED').map((l) => l.params), [{ path: 'k.txt', author: AUTHOR, hid: k4 }]);
    assert.ok(!log.lines.some((l) => l.code === 'HOLD_CREATED' && l.params.hid === k4), 'a CONFLICTED birth is HOLD_CONFLICTED only');
    st = await statusOf(p);
    assert.deepEqual([st.message_code, st.message_params], ['HOLD_CONFLICTED', { path: 'k.txt', author: AUTHOR, hid: k4 }]);
    // Announced once: later loops add nothing.
    const told = log.lines.filter((l) => l.code === 'HOLD_CREATED' || l.code === 'HOLD_CONFLICTED').length;
    await fx.rounds(3);
    assert.equal(log.lines.filter((l) => l.code === 'HOLD_CREATED' || l.code === 'HOLD_CONFLICTED').length, told);
    assert.equal(log.lines.filter((l) => l.code === 'HOLD_CREATED').length, p.core.holds.all().length - 1, 'every creation but the CONFLICTED one');
  });
});

test('a binary-path revert PIN ends status on HOLD_BINARY_WHOLE_FILE after HOLD_CREATED', T10, async () => {
  await withEngines('esc-binary', { n: 1, files: FILES }, async (fx) => {
    const p = await started(fx);
    const log = logOf(p);
    await fx.pushTeamChange({ 'img.bin': IMG_TEAM });
    await roundsUntil(fx, async () => (await readWork(p, 'img.bin'))?.equals(IMG_TEAM) === true, 'the teammate img.bin applied');
    await writeWork(p, 'img.bin', IMG0);   // a stale copy over the teammate's version (Task 8's shape), through iterate()
    await roundsUntil(fx, () => withGuard(p, 'revert').length > 0, 'the binary revert PIN', 16);
    const pin = withGuard(p, 'revert')[0]!;
    assert.deepEqual([pin.kind, pin.paths], ['PIN', ['img.bin']]);
    const created = log.lines.findIndex((l) => l.code === 'HOLD_CREATED' && l.params.hid === pin.id);
    assert.ok(created >= 0, 'HOLD_CREATED for the PIN');
    assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_BINARY_WHOLE_FILE').map((l) => l.params), [{ hid: pin.id, path: 'img.bin' }], 'one log line (revertStep\'s)');
    assert.deepEqual(p.core.holdCode, { code: 'HOLD_BINARY_WHOLE_FILE', params: { hid: pin.id, path: 'img.bin' } }, 'status ends on the binary code after HOLD_CREATED');
    const st = await statusOf(p);
    assert.deepEqual([st.message_code, st.message_params], ['HOLD_BINARY_WHOLE_FILE', { hid: pin.id, path: 'img.bin' }]);
    await fx.rounds(2);
    assert.equal(log.lines.filter((l) => l.code === 'HOLD_BINARY_WHOLE_FILE').length, 1, 'still one line');
  });
});

test('HLD-60 revert row: at age 10 min (REVERT_EVENT_AFTER_MS = 600,000) exactly one event{kind: health, reason_code: HOLD_REVERT_HELD, refs: [hold_id]} is drafted, none again after a restart because the fold holds it, and none for any other kind', T10, async () => {
  assert.equal(REVERT_EVENT_AFTER_MS, 600_000);
  await withEngines('esc-event', { n: 1, files: FILES }, async (fx) => {
    let p = await started(fx);
    const log = logOf(p);
    await teammateLine(fx, p, N, 10);
    const r = await humanRemovesTeamLine(fx, p, N);
    // Another kind of the same age: a `restart` PATCH.
    await writeWork(p, 'r.txt', 'r1\nr2 kept\nr3\n');
    const A = await p.core.repo.readTreeMap(p.core.view!.base);
    const other = await p.core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: ['r.txt'], guard: 'restart', origin: 'daemon', cs_ids: [], displaced_by: null,
      blobs: { h0: { 'r.txt': A.get('r.txt')!.oid }, h1: { 'r.txt': await hash(p, 'r1\nr2 kept\nr3\n') } },
    });
    fx.advance(9 * MIN);
    await fx.rounds(2);
    assert.deepEqual(revertEvents(p, r.id), { folded: 0, queued: 0 }, 'not before 10 min');
    fx.advance(MIN);
    await fx.rounds(1);
    assert.deepEqual(revertEvents(p, r.id), { folded: 0, queued: 1 }, 'drafted at 10 min');
    const draft = p.core.outbox.drafts().find((d) => d.type === 'event' && d.reason_code === 'HOLD_REVERT_HELD')!;
    assert.deepEqual(draft, { type: 'event', cid: '', kind: 'health', refs: [r.id], reason_code: 'HOLD_REVERT_HELD' });
    assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_REVERT_HELD').map((l) => l.params), [{ path: 'f.py', author: null, hid: r.id }], 'status and the log');
    await roundsUntil(fx, () => revertEvents(p, r.id).folded === 1, 'the event folded');
    await fx.rounds(4);
    assert.deepEqual(revertEvents(p, r.id), { folded: 1, queued: 0 }, 'exactly one');
    // A restart (a new core: every in-memory set empty): the fold holds it, so none is drafted again.
    await p.engine.drain(null);
    await restartEngine(p);
    p = fx.peers[0]!;
    fx.advance(MIN);
    await fx.rounds(4);
    assert.deepEqual(revertEvents(p, r.id), { folded: 1, queued: 0 }, 'none again after the restart');
    assert.deepEqual(revertEvents(p, other), { folded: 0, queued: 0 }, 'none for another kind');
    assert.equal(rec(p, r.id).residence, 'ON_DISK');
  });
});

test('integration I-7 (Ruling R3-FF4-A2, HLD-60): a revert settle copy older than 10 min posts no HOLD_REVERT_HELD event or line of its own; its parent posts exactly one', T10, async () => {
  await withEngines('esc-settle-copy', { n: 1, files: FILES }, async (fx) => {
    const p = await started(fx);
    const log = logOf(p);
    await teammateLine(fx, p, N, 10);
    const r = await humanRemovesTeamLine(fx, p, N);
    // The restart's safety copy of r's interrupted whole park, born as settleHoldOps births it (final review r3 A3-4: it keeps `revert`).
    const copy = await p.core.holds.holdOutcome({
      kind: 'PATCH', residence: 'OFF_DISK', state: 'PARKED', paths: [...r.paths], blobs: r.blobs, guard: 'revert', origin: 'daemon', cs_ids: [],
      displaced_by: null, settleCopyOf: r.id,
    });
    assert.deepEqual([copy.created, p.core.holds.isSettleCopy(copy.id), rec(p, copy.id).guards.map((g) => g.name)], [true, true, ['revert']]);
    fx.advance(10 * MIN);
    await fx.rounds(1);
    assert.deepEqual(revertEvents(p, r.id), { folded: 0, queued: 1 }, 'the parent\'s event is drafted at 10 min');
    assert.deepEqual(revertEvents(p, copy.id), { folded: 0, queued: 0 }, 'none for the copy');
    await roundsUntil(fx, () => revertEvents(p, r.id).folded === 1, 'the parent\'s event folded');
    fx.advance(MIN);
    await fx.rounds(4);
    assert.deepEqual(revertEvents(p, r.id), { folded: 1, queued: 0 }, 'exactly one for the parent');
    assert.deepEqual(revertEvents(p, copy.id), { folded: 0, queued: 0 }, 'still none for the copy');
    assert.ok(core10min(p, copy.id), 'the copy is non-terminal and older than 10 min');
    assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_REVERT_HELD').map((l) => l.params.hid), [r.id], 'one log line, the parent\'s');
  });
});

/** A non-terminal record of p aged at least REVERT_EVENT_AFTER_MS. */
function core10min(p: PeerFixture, id: string): boolean {
  const r = rec(p, id);
  return !['SUBSUMED', 'GONE', 'RESOLVED_PUBLISH', 'RESOLVED_DISCARD'].includes(r.state) && p.core.holds.ageMs(r) >= REVERT_EVENT_AFTER_MS;
}

test('age comes only from age_anchor: a +10 min wall-clock jump with 1 min of Δmono posts the event, and a restart after drain() keeps the accumulated Δmono', T10, async () => {
  await withEngines('esc-age', { n: 1, files: FILES }, async (fx) => {
    let p = await started(fx);
    await teammateLine(fx, p, N, 10);
    const r1 = await humanRemovesTeamLine(fx, p, N);
    // The PC slept 9 min (wall moves, mono does not), then 1 min of mono: the age is max(Δwall, Δmono) = 10 min.
    p.clock.suspend(9 * MIN);
    fx.advance(MIN);
    await fx.rounds(1);
    assert.equal(revertEvents(p, r1.id).queued + revertEvents(p, r1.id).folded, 1, 'the wall-clock jump made it 10 min old');
    // A second record, then a wall clock stepped back by an hour (an NTP correction): from then on only Δmono ages it.
    await fx.pushTeamChange({ 'g.py': buf(G(true)) });
    await roundsUntil(fx, async () => (await readWork(p, 'g.py'))?.toString('utf8') === G(true), 'the teammate g.py line applied');
    await writeWork(p, 'g.py', G(false));
    await roundsUntil(fx, () => withGuard(p, 'revert').some((x) => x.paths[0] === 'g.py'), 'the g.py revert record');
    const r2 = withGuard(p, 'revert').find((x) => x.paths[0] === 'g.py')!.id;
    const wall = p.clock.wallMs.bind(p.clock);
    p.clock.wallMs = (): number => wall() - 60 * MIN;
    try {
      fx.advance(6 * MIN);
      await fx.rounds(1);
      assert.deepEqual(revertEvents(p, r2), { folded: 0, queued: 0 }, '6 min of Δmono');
      await p.engine.drain(null);
      assert.ok(rec(p, r2).age_anchor.mono_accum_ms >= 6 * MIN, `drain() persisted the accumulated Δmono: ${rec(p, r2).age_anchor.mono_accum_ms}`);
      await restartEngine(p);
      p = fx.peers[0]!;
      fx.advance(4 * MIN + 5_000);
      await fx.rounds(1);
      const e = revertEvents(p, r2);
      assert.equal(e.queued + e.folded, 1, 'Δmono accumulated before the restart counts: 6 + 4 min');
    } finally {
      p.clock.wallMs = wall;
    }
  });
});

test('carry 1: the degraded rung\'s hold code is cleared when the record it names ends or leaves not_converged, when the freeze it names lifts (MASS resume included), and when the path it names leaves not_converged', T10, async () => {
  await withPeers('esc-holdcode', { files: { 'README.md': buf('#\n'), 'src/t9.txt': buf(T9), 'src/u9.txt': buf(T9), 'src/k9.txt': buf(T9) } }, async (fx) => {
    const p = fx.peers[0]!;
    const P = 'src/t9.txt';
    await writeWork(p, P, t9([2, 'two']));
    const it = await prepIt(p, { materialize: false });
    const a = it.A.get(P)!.oid;
    const held = await p.core.holds.hold(nr({ paths: [P], blobs: pair(a, await blob(p, t9([2, 'two'])), P) }));
    const cur = (): { code: string } | null => holdStatusInputs(p.core, null).lastEvent;
    // A code naming an ON_DISK record that holds its path back: kept.
    p.core.holdCode = { code: 'HOLD_CREATED', params: { path: P, hid: held, REASON: 'revert' } };
    assert.equal(cur()?.code, 'HOLD_CREATED');
    assert.ok(holdStatusInputs(p.core, null).notConverged.includes(P));
    // The record ends: a code naming it is stale.
    await p.core.holds.transition(held, { state: 'GONE' });
    p.core.holdCode = { code: 'HOLD_GONE', params: { hid: held, path: P } };
    assert.equal(cur(), null, 'HOLD_GONE names a terminal record');
    // Fix round 1 (minor b): a status read changes nothing; the Engine's explicit step (settleHoldCode, at each status write) clears it.
    assert.equal(p.core.holdCode?.code, 'HOLD_GONE', 'a status read leaves the slot as it is');
    assert.equal(settleHoldCode(p.core, holdStatusInputs(p.core, null).notConvergedCauses), null);
    assert.equal(p.core.holdCode, null, 'cleared');
    // A record that left not_converged (OFF_DISK PARKED): HOLD_PARKED is not a degraded reason.
    const parked = await p.core.holds.hold(nr({ paths: ['src/u9.txt'], residence: 'OFF_DISK', state: 'PARKED', blobs: pair(a, await blob(p, t9([8, 'eight'])), 'src/u9.txt') }));
    p.core.holdCode = { code: 'HOLD_PARKED', params: { path: 'src/u9.txt', hid: parked } };
    assert.equal(cur(), null);
    // FROZEN {reasons: [MASS]}: kept while MASS is set, cleared once it lifts (the breaker's resume raises no UNFROZEN).
    await p.core.commit({ meta: { ...p.core.view!.meta, freeze_reasons: ['MASS'] } });
    p.core.holdCode = { code: 'FROZEN', params: { reasons: ['MASS'], why: 'window', paths: 12 } };
    assert.equal(cur()?.code, 'FROZEN');
    await p.core.commit({ meta: { ...p.core.view!.meta, freeze_reasons: [] } });
    assert.equal(cur(), null, 'MASS lifted');
    // A path-only code whose path is not in not_converged.
    p.core.holdCode = { code: 'PATH_NOT_PORTABLE', params: { path: 'src/gone:x.txt', rule: 'reserved' } };
    assert.equal(cur(), null);
    // A CONFLICTED stage record ON_DISK keeps HOLD_CONFLICTED.
    const k4 = await p.core.holds.hold(nr({ paths: ['src/k9.txt'], state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', blobs: stages(a, await blob(p, t9([3, 'mine'])), await blob(p, t9([3, 'team'])), 'src/k9.txt') }));
    p.core.holdCode = { code: 'HOLD_CONFLICTED', params: { path: 'src/k9.txt', author: null, hid: k4 } };
    assert.equal(cur()?.code, 'HOLD_CONFLICTED');
  });
});

// ---- fix round 1 (minors b, d, e) ----------------------------------------------------------------------------------------

const CP = 'src/t9.txt';
const CQ = 'src/q9.txt';
const CR = 'src/r9.txt';
const GEN = 'gen/api.ts';
const NOTES = 'notes/aux.txt';
const ENV = '.env';
const CORE_FILES: Record<string, Buffer> = { 'README.md': buf('#\n'), [CP]: buf(T9), [CQ]: buf(T9), [CR]: buf(T9), [GEN]: buf(T9), [ENV]: buf('SECRET=1\n') };

/** A plain ON_DISK revert PATCH over `path` (the disk holds `row 2 = two`), created through the registry. */
async function revertOn(p: PeerFixture, path: string): Promise<string> {
  await writeWork(p, path, t9([2, 'two']));
  const it = await prepIt(p, { materialize: false });
  return p.core.holds.hold(nr({ paths: [path], blobs: pair(it.A.get(path)!.oid, await blob(p, t9([2, 'two'])), path) }));
}

test('minor b: a status read (holdStatusInputs, Engine.inspect) never changes the hold-code slot; the Engine clears a stale code at its status write (settleHoldCode)', T10, async () => {
  await withEngines('esc-settle', { n: 1, files: FILES }, async (fx) => {
    const p = await started(fx);
    // A code naming a record this registry does not hold and a path in no not_converged entry: stale.
    const stale = { code: 'HOLD_GONE', params: { hid: '01K00000000000000000000000', path: 'k.txt' } };
    p.core.holdCode = stale;
    assert.equal(holdStatusInputs(p.core, null).lastEvent, null, 'not reported: it names nothing holding');
    assert.equal(p.core.holdCode, stale, 'holdStatusInputs left the slot as it is');
    await p.engine.inspect();
    assert.equal(p.core.holdCode, stale, 'Engine.inspect left the slot as it is');
    await fx.rounds(1);
    assert.equal(p.core.holdCode, null, 'the status write cleared it');
  });
});

test('minor b: an announcement judges the slot with Plan 2\'s not_converged of the last status write — HOLD_CREATED goes to the log and leaves a code that entry keeps current in the slot', T10, async () => {
  await withPeers('esc-settle-base', { files: CORE_FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = recordLog(p);
    seedEscalation(p.core);
    // A TIP name this clone carries by its name alone (Plan 2's not_converged: not_applicable unmaterializable) and Task 7's code for it.
    const CARRIED = 'docs/a:b.txt';
    p.core.holdCode = { code: 'PATH_NOT_PORTABLE', params: { path: CARRIED, rule: 2 } };
    assert.equal(settleHoldCode(p.core, new Map([[CARRIED, { cause: 'not_applicable', guard: 'unmaterializable' }]]))?.code, 'PATH_NOT_PORTABLE', 'kept at the status write');
    const id = await revertOn(p, CP);
    await escalationStep(p.core, await prepIt(p, { materialize: false }));
    assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_CREATED').map((l) => l.params), [{ path: CP, hid: id, REASON: 'revert' }], 'the log');
    assert.equal(p.core.holdCode?.code, 'PATH_NOT_PORTABLE', 'the announcement did not displace it');
  });
});

test('minor d: a record created ACTIVE and turned CONFLICTED by evaluateRecords (step 5R) before escalationStep (T) is logged HOLD_CONFLICTED once, never HOLD_CREATED; a later conflict is still told', T10, async () => {
  await withPeers('esc-conflicted-once', { files: CORE_FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = recordLog(p);
    seedEscalation(p.core);
    const id = await revertOn(p, CP);
    const it = await prepIt(p, { materialize: false });
    // 5R: MASK reported it conflicted (HLD-15), so R1 makes it CONFLICTED in the iteration that created it; then the timers.
    assert.deepEqual(await evaluateRecords(p.core, it, new Set(), [id]), [id]);
    assert.equal(rec(p, id).state, 'CONFLICTED');
    await escalationStep(p.core, it);
    const told = (): string[] => log.lines.filter((l) => l.params.hid === id).map((l) => l.code);
    assert.deepEqual(told(), ['HOLD_CONFLICTED'], 'one line');
    assert.deepEqual(p.core.holdCode, { code: 'HOLD_CONFLICTED', params: { path: CP, author: null, hid: id } });
    await escalationStep(p.core, it);
    assert.deepEqual(told(), ['HOLD_CONFLICTED'], 'nothing at the next timer step');
    // The conflict clears (R1 step 4) and comes back in a later iteration: evaluateRecords tells it again (HLD-08), once.
    await p.core.holds.transition(id, { state: 'ACTIVE' });
    const it2 = await prepIt(p, { materialize: false });
    assert.deepEqual(await evaluateRecords(p.core, it2, new Set(), [id]), [id]);
    await escalationStep(p.core, it2);
    assert.deepEqual(told(), ['HOLD_CONFLICTED', 'HOLD_CONFLICTED']);
  });
});

test('minor e: HLD-60\'s exclusions — no HOLD_CREATED or HOLD_CONFLICTED for an INCOMING record (incomingStep\'s lines), guard-less OFF_DISK PARKED births, local_only or not (their operators\'), a `portability` record (PATH_NOT_PORTABLE) or a `generated?` record (GENERATED_SUSPECT); a plain revert record created beside them gets HOLD_CREATED', T10, async () => {
  await withPeers('esc-exclusions', { files: CORE_FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = recordLog(p);
    seedEscalation(p.core);
    const control = await revertOn(p, CP);
    await writeWork(p, NOTES, 'notes\n');
    const it0 = await prepIt(p, { materialize: false });
    const A = (x: string): Oid => it0.A.get(x)!.oid as Oid;
    const excluded = {
      incoming: await p.core.holds.hold(nr({ kind: 'INCOMING', guard: 'lock', origin: 'daemon', paths: [CQ], blobs: pair(A(CQ), await blob(p, t9([7, 'tip'])), CQ) })),
      parkedBirth: await p.core.holds.hold(nr({ residence: 'OFF_DISK', state: 'PARKED', guard: null, paths: [CR], blobs: pair(A(CR), await blob(p, t9([5, 'five'])), CR) })),
      // A guard-less birth of a secret-like path (a collision take's capture of .env): local_only, so its {REASON} key is `local`.
      localParkedBirth: await p.core.holds.hold(nr({ residence: 'OFF_DISK', state: 'PARKED', guard: null, paths: [ENV], blobs: pair(A(ENV), await blob(p, 'SECRET=2\n'), ENV) })),
      portability: await p.core.holds.hold(nr({ paths: [NOTES], guard: 'portability', blobs: pair(ABSENT, await blob(p, 'notes\n'), NOTES) })),
      generated: await p.core.holds.hold(nr({ paths: [GEN], guard: 'generated?', blobs: pair(A(GEN), await blob(p, t9([4, 'gen'])), GEN) })),
    };
    assert.equal(new Set([control, ...Object.values(excluded)]).size, 6, 'six records');
    assert.equal(rec(p, excluded.localParkedBirth).local_only, true, 'the .env birth is local_only');
    await escalationStep(p.core, await prepIt(p, { materialize: false }));
    const told = (id: string): string[] => log.lines.filter((l) => l.params.hid === id && (l.code === 'HOLD_CREATED' || l.code === 'HOLD_CONFLICTED')).map((l) => l.code);
    assert.deepEqual(told(control), ['HOLD_CREATED'], 'the control');
    for (const [what, id] of Object.entries(excluded)) assert.deepEqual(told(id), [], `${what}: not announced`);
  });
});
