// `--publish` and `--restore` of /cowork resolve (Plan 3 Task 11; 05-holds Table 4, HLD-17, HLD-29, HLD-52, HLD-66, 05 I13, I15, U8;
// 03-data DAT-33, DAT-39, DAT-45, TC-HLD-10, I-DAT-09 `--publish` clause; glossary §25.2 item 2; rulings R3-17, R3-35, R3-54, R3-65;
// contract additions 1 and 3): releases, RESOLVED_PUBLISH through local.explicit, restore markers, the binary refusals, the marker
// companion, the answers that keep a `generated?` path syncing, the wake-scope PIN and the guards --publish never releases. Real git
// on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStep } from '../../src/engine/apply.js';
import { churnStep } from '../../src/engine/dataRecords.js';
import { recordStep } from '../../src/engine/holdSteps.js';
import { restore } from '../../src/engine/holdOps.js';
import { maskInputsOf } from '../../src/engine/publish.js';
import { resolve, type ResolveResult } from '../../src/engine/resolve.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { pinCs } from '../../src/holds/changesets.js';
import { maskEntries } from '../../src/holds/mask.js';
import { guardName, type HoldRecord } from '../../src/holds/record.js';
import { readWork, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { remoteLive } from '../helpers/dataRecordsFixture.js';
import { blob, nr, pair, prepIt, recordLog, stages } from '../helpers/holdOpsFixture.js';
import { binary, T9, t9 } from '../helpers/maskFixture.js';
import { win } from '../helpers/mirrorFixture.js';
import { buf, captureReady, editAndCapture, lines, prep, remoteLiveCode, treeOf, withCores } from '../helpers/publishHelpers.js';
import { captureAndLand, HUMAN } from '../helpers/resolveFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const P = 'src/t9.txt';
const K = 'src/k4.txt';
const GEN = 'gen/api.ts';
const FILES: Record<string, Buffer> = {
  'README.md': buf('# resolve publish\n'), [P]: buf(T9), [K]: buf(T9), 'img.bin': binary(0), 'img2.bin': binary(0),
  [GEN]: buf(Array.from({ length: 50 }, (_, k) => `export const v${k + 1} = ${k + 1};\n`).join('')),
  'a.py': buf(lines(12, (i) => `a_${i} = ${i}`)), 'b.py': buf(lines(12, (i) => `b_${i} = ${i}`)),
};
const SEAT = 'd'.repeat(32);
const done = (code: string, id: string, created: string | null = null): ResolveResult => ({ kind: 'done', code, id, created });
const guardsOf = (r: HoldRecord | undefined): string[] => (r?.guards ?? []).map((g) => g.name);
const text = async (p: PeerFixture, path: string): Promise<string | null> => (await readWork(p, path))?.toString('utf8') ?? null;

test('--publish of an ON_DISK revert record releases revert, marks it explicit and adds its paths to the human CS; after its publish lands R1 ends it RESOLVED_PUBLISH, not SUBSUMED', T10, async () => {
  await withCores('rpub-revert', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, t9([2, 'two'], [6, 'six']));
    const it0 = await prepIt(p, { materialize: false });
    const id = await p.core.holds.hold(nr({ paths: [P], blobs: pair(it0.A.get(P)!.oid, await blob(p, t9([2, 'two'])), P) }));
    // The CS that saw the edit closes and publishes what MASK lets through (line 6): the path leaves every open CS.
    fx.advance(21_000);
    await captureReady(p, await prep(p, true));
    for (let i = 0; i < 3; i++) await win(fx, p);
    assert.equal((await remoteLive(fx, p)).get(P), await blob(p, t9([6, 'six'])), 'precondition: line 6 published, line 2 held');
    assert.equal(p.core.cs.openPaths().has(P), false, 'precondition: no open CS holds the path');
    const it = await prepIt(p, { holdPaths: [P] });
    assert.deepEqual(await resolve(p.core, it, id, 'publish', HUMAN), done('RESOLVED_PUBLISH', id));
    const r = p.core.holds.get(id)!;
    assert.deepEqual([r.residence, r.state, guardsOf(r)], ['ON_DISK', 'ACTIVE', []], 'revert released');
    assert.ok(p.core.holds.local().explicit.includes(id), 'marked explicit');
    assert.ok(p.core.cs.openPaths().has(P), 'its paths are in the human CS');
    assert.equal(await text(p, P), t9([2, 'two'], [6, 'six']), 'no write');
    await captureAndLand(fx, p);
    assert.equal((await remoteLive(fx, p)).get(P), await blob(p, t9([2, 'two'], [6, 'six'])), 'the held line published');
    assert.equal(p.core.holds.get(id)!.state, 'RESOLVED_PUBLISH', 'R1 ends it RESOLVED_PUBLISH, not SUBSUMED');
  });
});

test('--publish of an OFF_DISK CONFLICTED K4 record restores first, and a clean restore ends RESOLVED_PUBLISH once the content is in A', T10, async () => {
  await withCores('rpub-k4', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const it0 = await prepIt(p, { materialize: false });
    const a = it0.A.get(K)!.oid;
    const id = await p.core.holds.hold(nr({ paths: [K], residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', blobs: stages(a, await blob(p, t9([3, 'mine'])), a, K) }));
    const it = await prepIt(p, { holdPaths: [K] });
    assert.deepEqual(await resolve(p.core, it, id, 'publish', HUMAN), done('RESOLVED_PUBLISH', id));
    assert.equal(await text(p, K), t9([3, 'mine']), 'RESTORE first');
    const r = p.core.holds.get(id)!;
    assert.deepEqual([r.residence, r.state, guardsOf(r)], ['ON_DISK', 'ACTIVE', []]);
    assert.ok(p.core.holds.local().explicit.includes(id));
    await captureAndLand(fx, p);
    assert.equal((await remoteLive(fx, p)).get(K), await blob(p, t9([3, 'mine'])), 'the content is in A');
    assert.equal(p.core.holds.get(id)!.state, 'RESOLVED_PUBLISH');
  });
});

/** A K4 record restored over an overlapping local edit (lines 3 and 8 edited locally; the held version changes line 3). */
async function markersRestore(p: PeerFixture): Promise<{ id: string; it: Awaited<ReturnType<typeof prepIt>>; res: ResolveResult; a: Oid }> {
  await writeWork(p, K, t9([3, 'local three'], [8, 'local eight']));
  const it0 = await prepIt(p, { materialize: false });
  const a = it0.A.get(K)!.oid;
  const id = await p.core.holds.hold(nr({ paths: [K], residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', blobs: stages(a, await blob(p, t9([3, 'mine'])), a, K) }));
  const it = await prepIt(p, { holdPaths: [K] });
  return { id, it, a, res: await resolve(p.core, it, id, 'restore', HUMAN) };
}

test('05 I13: --restore of a K4 record over an overlapping local edit writes cowork: restore markers, adds guard markers and reports RESTORE_MARKERS {id, path, rows}; S_pub and P keep A[p] and nothing publishes; after the rows are removed the edit publishes and the record ends RESOLVED_PUBLISH', T10, async () => {
  await withCores('rpub-i13', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = recordLog(p);
    const { id, a, res } = await markersRestore(p);
    assert.deepEqual(res, done('RESTORE_MARKERS', id));
    const onDisk = (await text(p, K))!;
    assert.match(onDisk, /^<{7} cowork:disk$/m);
    assert.match(onDisk, /^>{7} cowork:held$/m);
    const r = p.core.holds.get(id)!;
    assert.deepEqual([r.residence, r.state, guardsOf(r)], ['ON_DISK', 'ACTIVE', ['markers']], 'guard markers');
    assert.equal(p.core.holdCode?.code, 'RESTORE_MARKERS');
    const params = p.core.holdCode!.params as { id: string; path: string; rows: number[] };
    assert.deepEqual([params.id, params.path], [id, K]);
    assert.ok(Array.isArray(params.rows) && params.rows.length >= 3 && params.rows.every((n) => Number.isInteger(n) && n > 0), JSON.stringify(params.rows));
    assert.ok(log.lines.some((l) => l.code === 'RESTORE_MARKERS'));
    // S_pub (MASK of the materialized S_disk) keeps A[p]; the CS's P keeps A[p]; nothing publishes.
    fx.advance(3_000);
    const mit = await prepIt(p, { materialize: true });
    const sPub = await maskEntries(p.core.repo, mit.mat!.sDiskMap, maskInputsOf(p.core, mit, p.core.holds.maskingRecords()), p.core.rebase);
    assert.equal(sPub.entries.get(K)?.oid, a, 'S_pub[p] = A[p]');
    fx.advance(21_000);
    await captureReady(p, await prep(p, true));
    for (let i = 0; i < 3; i++) assert.equal((await win(fx, p)).r.c, null, 'P keeps A[p]: no code commit');
    assert.equal((await remoteLive(fx, p)).get(K), a, 'nothing published');
    // The human removes the rows, keeping the held line 3 and the local line 8; `markers` releases through its PREDICATE, Task 12a's
    // recordStep, at the next materialization whose S_disk has no restore-marker row (after the shrink guard's second tick).
    await writeWork(p, K, t9([3, 'mine'], [8, 'local eight']));
    await prep(p);
    fx.advance(2_500);
    await prep(p);
    const mit2 = await prepIt(p, { materialize: true });
    await recordStep(p.core, mit2, await applyStep(p.core, mit2));
    assert.deepEqual(guardsOf(p.core.holds.get(id)), [], 'recordStep released markers');
    await captureAndLand(fx, p);
    assert.equal((await remoteLive(fx, p)).get(K), await blob(p, t9([3, 'mine'], [8, 'local eight'])), 'the edit publishes');
    assert.equal(p.core.holds.get(id)!.state, 'RESOLVED_PUBLISH');
  });
});

test('05 I13 binary: --restore of a binary record whose disk differs from both its base and A is refused HOLD_RESTORE_CONFLICT with nothing written, and a seat actor\'s restore returns claude_refused with nothing written', T10, async () => {
  await withCores('rpub-i13-bin', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, 'img.bin', binary(2));
    await writeWork(p, 'img2.bin', binary(3));
    const it0 = await prepIt(p, { materialize: false });
    const b0 = it0.A.get('img.bin')!.oid;
    const k4 = await p.core.holds.hold(nr({ paths: ['img.bin'], residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', blobs: stages(b0, await blob(p, binary(1)), b0, 'img.bin') }));
    const mine = await p.core.holds.hold(nr({ paths: ['img2.bin'], residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: SEAT, blobs: pair(it0.A.get('img2.bin')!.oid, await blob(p, binary(4)), 'img2.bin') }));
    const it = await prepIt(p, { holdPaths: ['img.bin', 'img2.bin'] });
    const log = recordLog(p);
    p.core.holdCode = null;
    const head = p.core.holds.head();
    // Human: the disk is neither the base nor A — no markers are possible on a binary path.
    assert.deepEqual(await resolve(p.core, it, k4, 'restore', HUMAN), { kind: 'refused', code: 'HOLD_RESTORE_CONFLICT', params: { hid: k4 } });
    assert.deepEqual(await readWork(p, 'img.bin'), binary(2), 'nothing written');
    // A seat: the K4 record is the daemon's (not_owner); the seat's own binary record is human-only (binary).
    const claude = { actor: { seat: SEAT, agent: null }, humanEvidence: false } as const;
    assert.deepEqual(await resolve(p.core, it, k4, 'restore', claude), { kind: 'claude_refused', reason: 'not_owner' });
    assert.deepEqual(await resolve(p.core, it, mine, 'restore', claude), { kind: 'claude_refused', reason: 'binary' });
    assert.deepEqual(await readWork(p, 'img2.bin'), binary(3), 'nothing written');
    assert.equal(p.core.holdCode, null, 'no code in status');
    assert.deepEqual(log.lines, [], 'no log line');
    assert.equal(p.core.holds.head(), head, 'no registry commit');
    // RESTORE_BINARY_HUMAN_ONLY stays restore()'s operator-level outcome only.
    assert.deepEqual(await restore(p.core, it, mine, { humanEvidence: false, actor: 'claude' }), { kind: 'REFUSED', code: 'RESTORE_BINARY_HUMAN_ONLY' });
  });
});

test('--restore of a marker companion writes its rows back with guard markers', T10, async () => {
  await withCores('rpub-companion', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { id, res } = await markersRestore(p);
    assert.equal(res.kind === 'done' ? res.code : null, 'RESTORE_MARKERS');
    const rows = (await text(p, K))!;
    // --park of a record carrying markers is the markers park: the half-done resolution goes to a marker companion.
    const it = await prepIt(p, { holdPaths: [K] });
    assert.deepEqual(await resolve(p.core, it, id, 'park', HUMAN), done('HOLD_PARKED', id));
    const [c] = p.core.holds.companionsOf(id);
    assert.ok(c !== undefined);
    assert.deepEqual([c.residence, c.state, guardsOf(c), c.local_only], ['OFF_DISK', 'PARKED', [], true]);
    assert.equal(await text(p, K), T9, 'the rows left the disk: the markers park wrote A[p]');
    // The park shrank the file by more than half: its first tick waits for a second stable snapshot (the shrink guard), and a verb
    // never decides on a path its tick did not read (HOLD_DISK_CHANGED, "repeat the command"); the next tick reads it.
    fx.advance(2_500);
    const early = await prepIt(p, { holdPaths: [K] });
    assert.equal(early.tick?.excluded.get(K), 'shrink', 'the first tick after the park did not read the file (the shrink guard)');
    const before = p.core.holds.get(c.id);
    assert.deepEqual(await resolve(p.core, early, c.id, 'restore', HUMAN), { kind: 'refused', code: 'HOLD_DISK_CHANGED', params: { hid: c.id } });
    assert.deepEqual(p.core.holds.get(c.id), before, 'the refused restore changed nothing');
    assert.equal(await text(p, K), T9, 'and wrote nothing');
    fx.advance(2_500);
    const it2 = await prepIt(p, { holdPaths: [K] });
    assert.equal(it2.tick?.excluded.has(K), false, 'the second tick read the file');
    assert.deepEqual(await resolve(p.core, it2, c.id, 'restore', HUMAN), done('RESTORE_MARKERS', c.id));
    assert.equal(await text(p, K), rows, 'its rows are written back');
    const after = p.core.holds.get(c.id)!;
    assert.deepEqual([after.residence, after.state, guardsOf(after)], ['ON_DISK', 'ACTIVE', ['markers']]);
  });
});

test('05 U8: --publish on a portability record is refused HOLD_GUARDS_REMAIN', T10, async () => {
  await withCores('rpub-portability', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const NEW = 'notes/aux.txt';
    await writeWork(p, NEW, 'notes\n');
    const it0 = await prepIt(p, { materialize: false });
    const id = await p.core.holds.hold(nr({ paths: [NEW], guard: 'portability', blobs: pair(ABSENT, await blob(p, 'notes\n'), NEW) }));
    const head = p.core.holds.head();
    assert.deepEqual(await resolve(p.core, it0, id, 'publish', HUMAN), { kind: 'refused', code: 'HOLD_GUARDS_REMAIN', params: { hid: id, guards: ['portability'] } });
    assert.equal(p.core.holds.head(), head, 'nothing changed');
  });
});

/** gen/api.ts rewritten wholesale (30 of 50 rows) for round `round`. */
const rewrite = (p: PeerFixture, round: number): Promise<void> =>
  writeWork(p, GEN, Array.from({ length: 50 }, (_, k) => (k < 30 ? `export const v${k + 1} = ${round * 1_000 + k + 1}; // gen ${round}\n` : `export const v${k + 1} = ${k + 1};\n`)).join(''));

/** Three qualifying ticks: the churn guard's generated? record over gen/api.ts. */
async function generatedRecord(fx: CoreFixture, p: PeerFixture): Promise<{ id: string; round: number }> {
  await prepIt(p, { materialize: false });
  let round = 0;
  let id: string | null = null;
  for (let k = 0; k < 3; k++) {
    await rewrite(p, ++round);
    fx.advance(2_500);
    const r = await churnStep(p.core, await prepIt(p, { materialize: false }));
    id = r.created[0] ?? id;
  }
  assert.ok(id !== null, 'precondition: a generated? record');
  return { id, round };
}

/** `n` qualifying rewrites, each at its own tick through churnStep: the records they create. */
async function qualifyingTicks(fx: CoreFixture, p: PeerFixture, from: number, n: number): Promise<string[]> {
  const created: string[] = [];
  for (let k = 1; k <= n; k++) {
    await rewrite(p, from + k);
    fx.advance(2_500);
    const it = await prepIt(p, { materialize: false });
    assert.ok(it.tick?.changed.has(GEN), `precondition: tick ${k} changed ${GEN}`);
    created.push(...(await churnStep(p.core, it)).created);
  }
  return created;
}

test('--publish of a generated? record keeps syncing: the guard releases, keepSyncing gains the path, the path publishes with its group, and churnStep never creates another record for it', T10, async () => {
  await withCores('rpub-generated', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { id, round } = await generatedRecord(fx, p);
    const it = await prepIt(p, { holdPaths: [GEN] });
    assert.deepEqual(await resolve(p.core, it, id, 'publish', HUMAN), done('RESOLVED_PUBLISH', id));
    assert.deepEqual(guardsOf(p.core.holds.get(id)), [], 'the guard releases');
    assert.deepEqual(p.core.holds.local().keepSyncing, [GEN], 'keepSyncing gains the path');
    const generatedBytes = await readWork(p, GEN);
    await captureAndLand(fx, p);
    assert.equal((await remoteLive(fx, p)).get(GEN), await blob(p, generatedBytes!), 'the path publishes with its group');
    assert.equal(p.core.holds.get(id)!.state, 'RESOLVED_PUBLISH', 'the record ended: only keepSyncing stops a new one');
    assert.deepEqual(await qualifyingTicks(fx, p, round, 5), [], '5 further qualifying ticks: no record');
    assert.equal(p.core.holds.nonTerminal().filter((r) => r.guards.some((g) => guardName(g) === 'generated?')).length, 0);
  });
});

test('--publish after an exclude answer still means keep syncing', T10, async () => {
  await withCores('rpub-exclude', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { id } = await generatedRecord(fx, p);
    const it = await prepIt(p, { holdPaths: [GEN] });
    assert.deepEqual(await resolve(p.core, it, id, 'discard', HUMAN), done('HOLD_ANSWERED', id));
    assert.deepEqual(guardsOf(p.core.holds.get(id)), ['generated?:exclude']);
    assert.deepEqual(p.core.holds.local().keepSyncing, []);
    assert.deepEqual(await resolve(p.core, it, id, 'publish', HUMAN), done('RESOLVED_PUBLISH', id));
    assert.deepEqual(guardsOf(p.core.holds.get(id)), [], 'generated?:exclude released the same way');
    assert.deepEqual(p.core.holds.local().keepSyncing, [GEN]);
  });
});

test('05 I15 Plan 3 part: a wake-scope PIN refuses --handoff with HOLD_NOT_OFFERABLE, and --publish releases wake-scope so the whole CS publishes in one commit once T0 passes', T10, async () => {
  await withCores('rpub-wake', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const a2 = lines(12, (i) => `a_${i} = ${i}${i === 5 ? ' + 1' : ''}`);
    const b2 = lines(12, (i) => `b_${i} = ${i}${i === 7 ? ' + 1' : ''}`);
    const { pair: ready, it } = await editAndCapture(fx, p, { 'a.py': a2, 'b.py': b2 });
    const R = await p.core.repo.readTreeMap(ready.R);
    // Plan 6's backstop binding creates it through pinCs('wake-scope', …) with origin wake (X-41).
    const pin = await p.core.holds.hold(pinCs('wake-scope', [ready.csId], ['a.py', 'b.py'], it.A, { 'a.py': R.get('a.py')!.oid, 'b.py': R.get('b.py')!.oid }, 'wake', 'none'));
    for (let i = 0; i < 2; i++) assert.equal((await win(fx, p)).r.c, null, 'the PIN holds the whole CS');
    const live0 = await remoteLiveCode(fx, p);
    const it2 = await prepIt(p, { holdPaths: ['a.py', 'b.py'] });
    assert.deepEqual(await resolve(p.core, it2, pin, 'handoff', HUMAN), { kind: 'refused', code: 'HOLD_NOT_OFFERABLE', params: { hid: pin } });
    assert.deepEqual(await resolve(p.core, it2, pin, 'publish', HUMAN), done('RESOLVED_PUBLISH', pin));
    assert.deepEqual(guardsOf(p.core.holds.get(pin)), [], 'wake-scope released');
    let landed = false;
    for (let i = 0; i < 4 && !landed; i++) landed = (await win(fx, p)).r.c !== null;
    assert.ok(landed, 'the CS published');
    // One live commit on top of the previous one carries both paths.
    const live1 = await remoteLiveCode(fx, p);
    assert.deepEqual((await p.core.repo.readCommit(live1)).parents, [live0], 'one commit');
    const before = await treeOf(p, live0);
    const after = await treeOf(p, live1);
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k)?.oid !== after.get(k)?.oid).sort();
    assert.deepEqual(changed, ['a.py', 'b.py'], 'the whole CS in one commit');
  });
});

test('--publish on secret-scan and filter-failure records is refused HOLD_GUARDS_REMAIN', T10, async () => {
  await withCores('rpub-sec', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, t9([2, 'secret']));
    await writeWork(p, K, t9([2, 'filtered']));
    const it = await prepIt(p, { materialize: false });
    const sec = await p.core.holds.hold(nr({ paths: [P], guard: 'secret-scan', origin: 'daemon', blobs: pair(it.A.get(P)!.oid, await blob(p, t9([2, 'secret'])), P) }));
    const flt = await p.core.holds.hold(nr({ paths: [K], guard: 'filter-failure', origin: 'daemon', blobs: pair(it.A.get(K)!.oid, await blob(p, t9([2, 'filtered'])), K) }));
    const head = p.core.holds.head();
    assert.deepEqual(await resolve(p.core, it, sec, 'publish', HUMAN), { kind: 'refused', code: 'HOLD_GUARDS_REMAIN', params: { hid: sec, guards: ['secret-scan'] } });
    assert.deepEqual(await resolve(p.core, it, flt, 'publish', HUMAN), { kind: 'refused', code: 'HOLD_GUARDS_REMAIN', params: { hid: flt, guards: ['filter-failure'] } });
    assert.equal(p.core.holds.head(), head, 'nothing released');
  });
});
