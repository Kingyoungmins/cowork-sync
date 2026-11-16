// `--publish`'s re-base keeps one change on one id (F2 #151; 05-holds HLD-07 "One change MUST have one id", INV-HLD-SINGLE, Table 4
// `--publish` ruling G2-PUBLISH; 11-testing O-LIVE-RECORD single). G2 #5 / #7 re-base an unpublishable ON_DISK record (CONFLICTED, or a
// held side with restore-marker rows) on the disk — (A, S_disk), guards released, ACTIVE — in the rev that releases it. When another
// non-terminal record of this peer already holds that change (same kind and path set, current H1' = S_disk at A), that rev made two live
// ids of one change: the SIM's O-AND run (sim.oracles.holds.rows.test.ts) failed O-LIVE-RECORD at its `--publish` step since the F1 merge.
// Now the release rev also ends that twin GONE (its bytes are on the disk and are the re-based record's held side) and the record the
// human named takes its cs_ids; a twin --publish cannot end (a guard --publish does not release or one outside Table 3, OFF_DISK, a
// stage record, in flight, an offer) refuses the verb HOLD_GUARDS_REMAIN {hid: <the twin>, guards} before anything is written. A record
// whose current H1' is not S_disk is another change and is left alone. The state is built directly in the registry (as
// resolve.publishOnDisk.test.ts's G2 #5 cell does), so it does not depend on the SIM. Real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolve, type ResolveResult } from '../../src/engine/resolve.js';
import type { Oid } from '../../src/git/oid.js';
import type { TreeMap } from '../../src/git/repo.js';
import { blobAt, guardName, heldSide, type HoldRecord } from '../../src/holds/record.js';
import type { NewRecord } from '../../src/holds/registry.js';
import { readWork, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { remoteLive } from '../helpers/dataRecordsFixture.js';
import { blob, nr, pair, prepIt, recordLog, registryCommits } from '../helpers/holdOpsFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { buf, withCores } from '../helpers/publishHelpers.js';
import { captureAndLand, HUMAN } from '../helpers/resolveFixture.js';
import { testRunner } from '../helpers/tmp.js';
import { singleCollisions } from '../sim/oraclesHolds.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const P = 'src/t9.txt';
const P2 = 'src/t9b.txt';
const Q = 'src/q9.txt';
const FILES: Record<string, Buffer> = { 'README.md': buf('# resolve publish dedupe\n'), [P]: buf(T9), [P2]: buf(T9), [Q]: buf(T9) };
const HUMAN_TEXT = t9([2, 'human two']);
const done = (code: string, id: string, created: string | null = null): ResolveResult => ({ kind: 'done', code, id, created });
const guardsOf = (r: HoldRecord | undefined): string[] => (r?.guards ?? []).map((g) => g.name);
const dependencyPins = (p: PeerFixture): HoldRecord[] => p.core.holds.nonTerminal().filter((r) => r.guards.some((g) => guardName(g) === 'dependency'));
const baseAt = (r: HoldRecord, path: string): string | undefined => ('h0' in r.blobs ? blobAt(r.blobs.h0, path) : undefined);
/** The fields a rev changes (state, residence, rev, guards, blobs, cs_ids). */
const shape = (r: HoldRecord | undefined): unknown => (r === undefined ? undefined
  : { state: r.state, residence: r.residence, rev: r.rev, guards: guardsOf(r), blobs: r.blobs, cs_ids: r.cs_ids });

const git = testRunner();
/** O-LIVE-RECORD's own INV-HLD-SINGLE check (test-side REBASE at A) over the peer's non-terminal records: [] = one change, one id. */
function collisions(fx: CoreFixture, p: PeerFixture, A: TreeMap): Promise<string[]> {
  return singleCollisions(git, join(fx.root, 'single-scratch'), p.clone.dir, p.core.holds.nonTerminal(), A, p.core.holds.local().settleCopies ?? {});
}

/**
 * The paths core.cs.observe was handed while `fn` ran, and fn's result: a call-through spy on the peer's real ChangeSets (every call
 * still reaches it). --publish's observe branch is judged on that call, not on ChangeSets.openPaths() (the open CSs plus the paths
 * waiting for a recapture): setup()'s detection already put P there, so openPaths() holds P before the verb whichever branch it takes
 * (review fix round 2).
 */
async function observedDuring<T>(p: PeerFixture, fn: () => Promise<T>): Promise<{ observed: string[]; result: T }> {
  const cs = p.core.cs;
  const own = Object.hasOwn(cs, 'observe');
  const real = cs.observe.bind(cs);
  const observed: string[] = [];
  cs.observe = (changed: Iterable<string>): void => {
    const all = [...changed];
    observed.push(...all);
    real(all);
  };
  try {
    return { observed, result: await fn() };
  } finally {
    if (own) cs.observe = real;
    else Reflect.deleteProperty(cs, 'observe');   // back to ChangeSets.prototype.observe
  }
}

/**
 * The human's version on `path`, then R1 — the record a MASK conflict leaves (revert PATCH unless `r1o` says otherwise, h0 = A[path],
 * h1 = T9{2:two}, CONFLICTED: the human edited the held line) — and R2 = r2Of(a, S_disk's blob); then an iteration materializing `path`.
 */
async function setup(p: PeerFixture, path: string, r2Of: (a: Oid, human: Oid) => Promise<NewRecord>, r1o: Partial<NewRecord> = {}): Promise<{ r1: string; r2: string; a: Oid; human: Oid }> {
  await writeWork(p, path, HUMAN_TEXT);
  const it0 = await prepIt(p, { materialize: false });
  const a = it0.A.get(path)!.oid;
  const human = await blob(p, HUMAN_TEXT);
  const r1 = await p.core.holds.hold(nr({ ...r1o, paths: [path], state: 'CONFLICTED', blobs: pair(a, await blob(p, t9([2, 'two'])), path) }));
  const r2 = await p.core.holds.hold(await r2Of(a, human));
  return { r1, r2, a, human };
}

/**
 * Test 1's state: R2 is an ACTIVE revert PATCH holding the human's version over A[P] (the second revert record the SIM's marker
 * resolution births), then R1's --publish, asserting its release rev: one change keeps one id. Returns the ids for the landing.
 */
async function twinPublish(fx: CoreFixture, p: PeerFixture): Promise<{ r1: string; r2: string; human: Oid }> {
  const { r1, r2, a, human } = await setup(p, P, async (a0, h) => nr({ paths: [P], blobs: pair(a0, h, P) }));
  assert.notEqual(r2, r1, 'precondition: R2 is its own record (H1\' = the human\'s version, not R1\'s `two`: two changes, HLD-07 attaches nothing)');
  const it = await prepIt(p, { holdPaths: [P] });
  assert.deepEqual(await collisions(fx, p, it.A), [], 'precondition: before the verb the two records are two changes');
  // A revert PATCH names no change-set (05-holds Table 4): the union R1 takes is empty, so the observe branch is the one this cell
  // judges (the cs_ids branch is the wake-scope PIN cell below).
  assert.deepEqual([p.core.holds.get(r1)!.cs_ids, p.core.holds.get(r2)!.cs_ids], [[], []], 'precondition: neither record names a change-set');
  const { commits, result: { observed, result } } = await registryCommits(p, () => observedDuring(p, () => resolve(p.core, it, r1, 'publish', HUMAN)));
  assert.deepEqual(result, done('RESOLVED_PUBLISH', r1));
  // One change, one id: the oracle's own check, then the direct key (kind PATCH, path set [P], base A[P], held side S_disk).
  assert.deepEqual(await collisions(fx, p, it.A), [], 'INV-HLD-SINGLE / O-LIVE-RECORD single: no two non-terminal records hold one change');
  const holders = p.core.holds.nonTerminal().filter((x) => x.kind === 'PATCH' && x.paths.length === 1 && x.paths[0] === P
    && baseAt(x, P) === a && blobAt(heldSide(x), P) === human);
  assert.deepEqual(holders.map((x) => x.id), [r1], 'exactly one non-terminal record holds (PATCH, [P], A[P] -> S_disk): the one the human named');
  // The survivor: R1 re-based as G2 does (the union of the two records' cs_ids is empty here); R2 ends GONE in the same (one)
  // registry commit.
  const one = p.core.holds.get(r1)!;
  assert.deepEqual([one.residence, one.state, guardsOf(one)], ['ON_DISK', 'ACTIVE', []], 'R1 released and ACTIVE');
  assert.equal(blobAt(heldSide(one), P), human, 'R1\'s held side is the disk\'s version');
  assert.equal(baseAt(one, P), a, 'on the base A[P]');
  assert.deepEqual(one.cs_ids, [], 'R1 names no change-set (the union of none)');
  assert.ok(observed.includes(P), 'R1 names no change-set after the release rev: --publish hands P to core.cs.observe, so its content joins the open human CS (Table 4)');
  assert.ok(p.core.holds.local().explicit.includes(r1), 'R1 marked explicit (HLD-29)');
  const twin = p.core.holds.get(r2)!;
  assert.deepEqual([twin.state, twin.residence], ['GONE', null], 'R2, the same change, ends GONE (terminal, no residence)');
  assert.equal(commits, 1, 'R1\'s release rev and R2\'s end are ONE registry commit');
  assert.equal((await readWork(p, P))?.toString('utf8'), HUMAN_TEXT, 'no write');
  return { r1, r2, human };
}

test('F2 #151: --publish re-bases an ON_DISK CONFLICTED revert PATCH onto (A, S_disk) while a second revert PATCH already holds S_disk at A — one change keeps one id', T10, async () => {
  await withCores('rpub-dedupe-twin', { n: 1, files: FILES }, async (fx) => {
    await twinPublish(fx, fx.peers[0]!);
  });
});

test('F2 #151: after that --publish the content publishes — R1 ends RESOLVED_PUBLISH, the twin stays GONE, no HOLD_GONE, no dependency PIN', T10, async () => {
  // The same state and verb as the test above (every assertion of it runs again here), then one capture-and-land: its own fixture and
  // 10-minute budget, since the landing is the slow part on a loaded PC.
  await withCores('rpub-dedupe-twin-land', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = recordLog(p);
    const { r1, r2, human } = await twinPublish(fx, p);
    // The content publishes and R1 ends RESOLVED_PUBLISH (no false success, G2 #5); R2 stays terminal; HOLD_GONE is R1 evaluation's code
    // only (holdOps.ts), so R2's end told the user nothing.
    await captureAndLand(fx, p);
    assert.equal((await remoteLive(fx, p)).get(P), human, 'the human\'s version is live');
    assert.equal(p.core.holds.get(r1)!.state, 'RESOLVED_PUBLISH', 'R1 ends RESOLVED_PUBLISH once its content is in A');
    assert.equal(p.core.holds.get(r2)!.state, 'GONE', 'R2 stays terminal');
    assert.deepEqual(dependencyPins(p), [], 'no dependency PIN');
    assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_GONE').map((l) => l.params), [], 'no HOLD_GONE was raised');
  });
});

test('F2 #151: --publish re-bases an ON_DISK CONFLICTED PIN onto (A, S_disk) while a wake-scope PIN naming a change-set already holds S_disk at A — R1 takes the twin\'s cs_ids, so the content rides with that change-set and does not join the open human CS', T10, async () => {
  // The case where the cs_ids union matters (review fix round 1): a revert PATCH names no change-set, a wake-scope PIN does (HLD-66,
  // pinCs; wake-scope is one of the guards --publish releases). R1 is a CONFLICTED `join` PIN that names none; after the release rev
  // it carries the twin's change-set (HLD-52 publishes that CS when the last guard goes), so core.cs.observe is not called for it —
  // decided on R1 as the release rev left it, not on R1 as it was before.
  await withCores('rpub-dedupe-pin-cs', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const cs = [`${'a'.repeat(32)}/1`];
    const { r1, r2, a, human } = await setup(p, P,
      async (a0, h) => nr({ kind: 'PIN', guard: 'wake-scope', origin: 'wake', paths: [P], blobs: pair(a0, h, P), cs_ids: cs }),
      { kind: 'PIN', guard: 'join' });
    assert.notEqual(r2, r1, 'precondition: R2 is its own record');
    const it = await prepIt(p, { holdPaths: [P] });
    assert.deepEqual([p.core.holds.get(r1)!.cs_ids, p.core.holds.get(r2)!.cs_ids], [[], cs], 'precondition: only the twin names a change-set');
    assert.deepEqual(await collisions(fx, p, it.A), [], 'precondition: before the verb the two records are two changes');
    const { commits, result: { observed, result } } = await registryCommits(p, () => observedDuring(p, () => resolve(p.core, it, r1, 'publish', HUMAN)));
    assert.deepEqual(result, done('RESOLVED_PUBLISH', r1));
    assert.deepEqual(await collisions(fx, p, it.A), [], 'INV-HLD-SINGLE / O-LIVE-RECORD single: no two non-terminal records hold one change');
    const one = p.core.holds.get(r1)!;
    assert.deepEqual([one.kind, one.residence, one.state, guardsOf(one)], ['PIN', 'ON_DISK', 'ACTIVE', []], 'R1 released and ACTIVE');
    assert.equal(blobAt(heldSide(one), P), human, 'R1\'s held side is the disk\'s version');
    assert.equal(baseAt(one, P), a, 'on the base A[P]');
    assert.deepEqual(one.cs_ids, cs, 'R1\'s cs_ids are the union of its own (none) and the twin\'s');
    assert.equal(observed.includes(P), false, 'R1 names the twin\'s change-set: --publish does not hand P to core.cs.observe, the content rides with that CS, not the open human CS (HLD-52)');
    const twin = p.core.holds.get(r2)!;
    assert.deepEqual([twin.state, twin.residence], ['GONE', null], 'R2, the same change, ends GONE');
    assert.equal(commits, 1, 'R1\'s release rev and R2\'s end are ONE registry commit');
    assert.equal((await readWork(p, P))?.toString('utf8'), HUMAN_TEXT, 'no write');
  });
});

/**
 * Test 2's cell: R2 is another change than R1's re-based pair (A, S_disk) — R1's --publish re-bases R1 as G2 does and leaves R2's
 * state, rev, guards, blobs and cs_ids as they were. Each variant runs on its own fixture (and its own 10-minute budget).
 */
async function otherChange(label: string, path: string, r2Of: (p: PeerFixture, a: Oid, human: Oid) => Promise<NewRecord>): Promise<void> {
  await withCores(`rpub-dedupe-${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 20)}`, { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { r1, r2, a, human } = await setup(p, path, (a0, h) => r2Of(p, a0, h));
    assert.notEqual(r2, r1, `${label}: precondition, R2 is its own record`);
    const it = await prepIt(p, { holdPaths: [path] });
    const before = shape(p.core.holds.get(r2));
    assert.deepEqual(await resolve(p.core, it, r1, 'publish', HUMAN), done('RESOLVED_PUBLISH', r1), label);
    assert.deepEqual(shape(p.core.holds.get(r2)), before, `${label}: R2 (another change) is unchanged — state, rev, guards, blobs, cs_ids`);
    const one = p.core.holds.get(r1)!;
    assert.deepEqual([one.residence, one.state, guardsOf(one)], ['ON_DISK', 'ACTIVE', []], `${label}: R1 released and ACTIVE`);
    assert.equal(blobAt(heldSide(one), path), human, `${label}: R1 re-based on the disk's version`);
    assert.equal(baseAt(one, path), a, `${label}: on the base A`);
  });
}

test('F2 #151: a record over P whose current H1\' is not S_disk is another change — the re-base leaves it untouched: (i) a held side one row off S_disk', T10, async () => {
  // R2's H1' at A is its h1 (A == h0), which differs from S_disk on row 5.
  await otherChange('(i) a held side one row off S_disk', P, async (p, a) => nr({ paths: [P], blobs: pair(a, await blob(p, t9([2, 'human two'], [5, 'five'])), P) }));
});

test('F2 #151: a record over P whose current H1\' is not S_disk is another change — the re-base leaves it untouched: (ii) the same pair as a PIN (another kind)', T10, async () => {
  await otherChange('(ii) a PIN (another kind)', P, async (_p, a, h) => nr({ kind: 'PIN', guard: 'join', paths: [P], blobs: pair(a, h, P) }));
});

test('F2 #151: a record over P whose current H1\' is not S_disk is another change — the re-base leaves it untouched: (ii) the same P side over another path set [P, Q]', T10, async () => {
  // This cell guards the outcome, not one filter: holdersOf's path-set test and holdsChange (rebase.converges compares the path
  // sets, and the base differs on Q) each reject this R2, so dropping either one alone leaves it green (review fix round 1).
  await otherChange('(ii) another path set [P, Q]', P, async (p, a, h) => {
    const aq = (await prepIt(p, { materialize: false })).A.get(Q)!.oid;
    return nr({ paths: [P, Q], blobs: { h0: { [P]: a, [Q]: aq }, h1: { [P]: h, [Q]: await blob(p, t9([7, 'q seven'])) } } });
  });
});

test('F2 #151: a record over P whose current H1\' is not S_disk is another change — the re-base leaves it untouched: (iii) a stored held side = S_disk whose REBASE conflicts at A (no H1\')', T10, async () => {
  // R2's base edits line 2 one way, A keeps line 2, S_disk edits it another way: merge-file conflicts, so R2 has no H1' at A.
  await otherChange('(iii) a REBASE that conflicts at A', P, async (p, _a, h) => nr({ paths: [P], blobs: pair(await blob(p, t9([2, 'base two'])), h, P) }));
});

/**
 * Test 3's cell: R2 holds R1's re-based pair (A, S_disk) but is a twin --publish may not end — R1's --publish is refused
 * HOLD_GUARDS_REMAIN {hid: R2, guards} and nothing is written (registry ref, both records, R1's explicit mark, the disk). Each variant
 * runs on its own fixture (and its own 10-minute budget).
 */
async function refusedTwin(label: string, path: string, r2Of: (a: Oid, human: Oid) => Promise<NewRecord>, guards: string[]): Promise<void> {
  await withCores(`rpub-dedupe-refuse-${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 16)}`, { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { r1, r2 } = await setup(p, path, r2Of);
    assert.notEqual(r2, r1, `${label}: precondition, R2 is its own record`);
    const it = await prepIt(p, { holdPaths: [path] });
    const head = p.core.holds.head();
    const [b1, b2] = [p.core.holds.get(r1), p.core.holds.get(r2)];
    const { commits, result } = await registryCommits(p, () => resolve(p.core, it, r1, 'publish', HUMAN));
    assert.deepEqual(result, { kind: 'refused', code: 'HOLD_GUARDS_REMAIN', params: { hid: r2, guards } }, label);
    assert.equal(commits, 0, `${label}: no registry commit`);
    assert.equal(p.core.holds.head(), head, `${label}: the registry ref is unchanged`);
    assert.deepEqual([p.core.holds.get(r1), p.core.holds.get(r2)], [b1, b2], `${label}: R1 and R2 are unchanged`);
    assert.equal(p.core.holds.local().explicit.includes(r1), false, `${label}: R1 not marked explicit`);
    assert.equal((await readWork(p, path))?.toString('utf8'), HUMAN_TEXT, `${label}: the disk is unchanged`);
  });
}

test('F2 #151: when the record already holding the re-based change keeps a guard --publish does not release, --publish is refused HOLD_GUARDS_REMAIN naming that record, and nothing is written', T10, async () => {
  // `base-move`: a DECISION guard outside PUBLISH_RELEASES (Table 3 names no human --publish release for it) that does not make the
  // record local_only (a `portability` twin would: R1 is then refused not_live first, 05 §1, whatever the twin rule says).
  await refusedTwin('a base-move twin', P, async (a, h) => nr({ guard: 'base-move', paths: [P], blobs: pair(a, h, P) }), ['base-move']);
});

test('F2 #151: when the record already holding the re-based change is OFF_DISK, --publish is refused HOLD_GUARDS_REMAIN naming that record, and nothing is written', T10, async () => {
  // An OFF_DISK PARKED twin (a guard-less capture of the same pair): not this verb's to end.
  await refusedTwin('an OFF_DISK twin', P2, async (a, h) => nr({ residence: 'OFF_DISK', state: 'PARKED', guard: null, paths: [P2], blobs: pair(a, h, P2) }), []);
});

test('F2 #151: when the record already holding the re-based change is under an offer, --publish is refused HOLD_GUARDS_REMAIN naming that record, and nothing is written', T10, async () => {
  // An ON_DISK revert twin whose leftover offer is pending (HLD-09; review fix round 2: absorbable()'s `offer === 'none'` conjunct):
  // ending it GONE would drop an offer nobody answered. Its guards are all ones --publish releases, so only the offer refuses it.
  await refusedTwin('an offered twin', P, async (a, h) => nr({ offer: 'pending_leftover', paths: [P], blobs: pair(a, h, P) }), ['revert']);
});
