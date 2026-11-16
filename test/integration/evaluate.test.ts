// Algorithm R1 and the OFF_DISK A-change check (Plan 3 Task 5; 05-holds §3.6, HLD-08, HLD-29, INV-HLD-OFFDISK; rulings R3-17,
// R3-62): evaluateOnDisk / evaluateOffDisk over hand-built records on a real clone, and evaluateRecords over a peer's registry
// (one commitMany per evaluation, HOLD_CONFLICTED / HOLD_SUBSUMED / HOLD_GONE). Notation (Task 1 notes): T9 is "1\n…9\n" at
// src/t9.txt; T9{2:two} replaces line 2. Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOffDisk, evaluateOnDisk } from '../../src/holds/evaluate.js';
import type { TreeEntry } from '../../src/git/repo.js';
import { RebaseCache } from '../../src/holds/rebase.js';
import { makeGuard, type Guard } from '../../src/holds/record.js';
import { applyStep } from '../../src/engine/apply.js';
import { captureDue } from '../../src/engine/core.js';
import { evaluateRecords, restore } from '../../src/engine/holdOps.js';
import { publishStep } from '../../src/engine/publish.js';
import type { Oid } from '../../src/git/oid.js';
import { runMergeFile } from '../../src/git/merge.js';
import { readWork, writeWork } from '../helpers/coreFixture.js';
import { captureReady, editAndCapture, prep, treeOf } from '../helpers/publishHelpers.js';
import { blob, nr, pair, plantRecord, prepIt, recordLog, registryCommits, callsDuring, withMaps, withPeers, P } from '../helpers/holdOpsFixture.js';
import { binary, record, T9, t9, withMaskRepo, type MaskCtx } from '../helpers/maskFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const U = 'src/u9.txt';

function cache(c: MaskCtx): RebaseCache {
  return new RebaseCache(c.repo, () => true);
}

/** A tree map of path → blob of text. */
async function m(c: MaskCtx, files: Record<string, string>): Promise<Map<string, TreeEntry>> {
  const out = new Map<string, TreeEntry>();
  for (const [path, s] of Object.entries(files)) out.set(path, { path, mode: '100644', oid: await c.blob(s) });
  return out;
}

test('R1 is CONFLICTED > SUBSUMED > GONE > ACTIVE', T10, async () => {
  await withMaskRepo('r1-order', async (c) => {
    const r = record(pair(await c.blob(T9), await c.blob(t9([2, 'two']))), { guards: ['revert'] });
    const v = async (A: string, sDisk: string): Promise<string> => evaluateOnDisk(r, await m(c, { [P]: A }), await m(c, { [P]: sDisk }), cache(c), false, false);
    assert.equal(await v(t9([3, 'three']), t9([2, 'two'])), 'CONFLICTED', 'REBASE conflicts (adjacent rows)');
    assert.equal(await v(t9([2, 'two']), t9([2, 'two'])), 'SUBSUMED', "H1' == A");
    assert.equal(await v(T9, t9([6, 'six'])), 'GONE', 'the held change was undone on disk');
    assert.equal(await v(T9, t9([2, 'two'], [6, 'six'])), 'ACTIVE');
  });
});

test('a PIN is CONFLICTED when REBASE(H1) conflicts and GONE when S_disk equals A on every path', T10, async () => {
  await withMaskRepo('r1-pin', async (c) => {
    const t = await c.blob(T9);
    const two = await c.blob(t9([2, 'two']));
    const pin = record({ h0: { [P]: t, [U]: t }, h1: { [P]: two, [U]: two } }, { kind: 'PIN', guards: ['join'], paths: [P, U] });
    const conflicted = await evaluateOnDisk(pin, await m(c, { [P]: t9([3, 'three']), [U]: T9 }), await m(c, { [P]: t9([2, 'two']), [U]: t9([2, 'two']) }), cache(c), false, false);
    assert.equal(conflicted, 'CONFLICTED');
    assert.equal(await evaluateOnDisk(pin, await m(c, { [P]: T9, [U]: T9 }), await m(c, { [P]: T9, [U]: T9 }), cache(c), false, false), 'GONE', 'S_disk == A on both paths');
    assert.equal(await evaluateOnDisk(pin, await m(c, { [P]: T9, [U]: T9 }), await m(c, { [P]: T9, [U]: t9([2, 'two']) }), cache(c), false, false), 'ACTIVE', 'one path still differs');
  });
});

test('integration I-6 (Ruling R3-FF5-B1, 05 §3.6 R1): a guard-less ON_DISK PIN whose S_disk == A on every path ends before step 1 — SUBSUMED (RESOLVED_PUBLISH when explicit) when its REBASE gives H1\' == A, else GONE, never CONFLICTED and never RESOLVED_PUBLISH for a change A does not carry; a guarded PIN and a guard-less PIN whose change is still on disk follow R1 as before', T10, async () => {
  await withMaskRepo('r1-pin-guardless', async (c) => {
    const [t, two] = [await c.blob(T9), await c.blob(t9([2, 'two']))];
    const team = t9([2, 'team']);   // A moved under the PIN: REBASE(H1 = two over H0 = T9 onto team) conflicts on line 2
    const v = async (r: ReturnType<typeof record>, A: Record<string, string>, sDisk: Record<string, string>, explicit = false): Promise<string> =>
      evaluateOnDisk(r, await m(c, A), await m(c, sDisk), cache(c), explicit, false);
    for (const state of ['ACTIVE', 'CONFLICTED'] as const) {
      const pin = record(pair(t, two), { kind: 'PIN', state, guards: [] });
      assert.equal(await v(pin, { [P]: team }, { [P]: team }), 'GONE', `${state}: REBASE conflicts but the disk is at A: nothing is left on disk to resolve`);
      assert.equal(await v(pin, { [P]: team }, { [P]: team }, true), 'GONE', `${state}, explicit: H1' != A, so never RESOLVED_PUBLISH`);
      assert.equal(await v(pin, { [P]: t9([2, 'two']) }, { [P]: t9([2, 'two']) }), 'SUBSUMED', `${state}: H1' == A`);
      assert.equal(await v(pin, { [P]: t9([2, 'two']) }, { [P]: t9([2, 'two']) }, true), 'RESOLVED_PUBLISH', `${state}, explicit: H1' == A`);
      assert.equal(await v(pin, { [P]: team }, { [P]: t9([2, 'two']) }), 'CONFLICTED', `${state}: the held change is still on disk: R1 step 1 as before`);
    }
    // The same record with a guard: the new rule never applies (a human resolve guard keeps it CONFLICTED with the disk at A).
    for (const g of ['claim:abcdefghij234567', 'dependency:01ARZ3NDEKTSV4RRFFQ69G5FAV', 't0']) {
      const guarded = record(pair(t, two), { kind: 'PIN', state: 'CONFLICTED', guards: [g] });
      assert.equal(await v(guarded, { [P]: team }, { [P]: team }), 'CONFLICTED', `${g}: REBASE(H1) conflicts (R1 step 1) whatever the disk`);
    }
    // A PATCH is not a PIN: its R1 is unchanged (step 1 first).
    const patch = record(pair(t, two), { guards: [] });
    assert.equal(await v(patch, { [P]: team }, { [P]: team }), 'CONFLICTED', 'a guard-less PATCH whose REBASE conflicts stays CONFLICTED');
    // Two paths: the rule needs S_disk == A on every path; one path still holding the change keeps R1 as before.
    const pin2 = record({ h0: { [P]: t, [U]: t }, h1: { [P]: two, [U]: two } }, { kind: 'PIN', guards: [], paths: [P, U] });
    assert.equal(await v(pin2, { [P]: team, [U]: T9 }, { [P]: team, [U]: t9([2, 'two']) }), 'CONFLICTED', 'U still holds the change: REBASE on P conflicts (step 1)');
    assert.equal(await v(pin2, { [P]: team, [U]: T9 }, { [P]: team, [U]: T9 }), 'GONE', 'the disk is at A on both paths');
  });
});

test('R3-18: a binary PATCH whose disk differs from A and from its held side stays ACTIVE (withheld whole, never a conflict)', T10, async () => {
  await withMaskRepo('r1-binary', async (c) => {
    const [b0, b1, b2, b3] = [await c.blob(binary(0)), await c.blob(binary(1)), await c.blob(binary(2)), await c.blob(binary(3))];
    const r = record(pair(b0, b1), { guards: ['revert'] });
    const A = new Map<string, TreeEntry>([[P, { path: P, mode: '100644', oid: b0 }]]);
    const at = (o: typeof b0): Map<string, TreeEntry> => new Map([[P, { path: P, mode: '100644', oid: o }]]);
    assert.equal(await evaluateOnDisk(r, A, at(b3), cache(c), false, false), 'ACTIVE', 'B3 on disk: the whole-path rule withholds, no conflict');
    assert.equal(await evaluateOnDisk(r, A, at(b1), cache(c), false, false), 'ACTIVE', 'the held version on disk');
    assert.equal(await evaluateOnDisk(r, A, at(b0), cache(c), false, false), 'GONE', 'the disk back at A');
    assert.equal(await evaluateOnDisk(r, at(b2), at(b2), cache(c), false, false), 'CONFLICTED', 'A moved to B2: the REBASE conflicts');
  });
});

test('an explicitly released record ends RESOLVED_PUBLISH instead of SUBSUMED', T10, async () => {
  await withMaskRepo('r1-explicit', async (c) => {
    const r = record(pair(await c.blob(T9), await c.blob(t9([2, 'two']))), { guards: ['revert'] });
    const A = await m(c, { [P]: t9([2, 'two']) });
    assert.equal(await evaluateOnDisk(r, A, A, cache(c), true, false), 'RESOLVED_PUBLISH');
    assert.equal(await evaluateOnDisk(r, A, A, cache(c), false, false), 'SUBSUMED');
  });
});

test('R3-17: a record with no guard left stays ACTIVE until SUBSUMED', T10, async () => {
  await withMaskRepo('r1-r317', async (c) => {
    // After a RESTORE released its last guard: guards [], ON_DISK ACTIVE, explicit (local.explicit).
    const r = record(pair(await c.blob(T9), await c.blob(t9([2, 'two']))), { guards: [] });
    const sDisk = await m(c, { [P]: t9([2, 'two']) });
    assert.equal(await evaluateOnDisk(r, await m(c, { [P]: T9 }), sDisk, cache(c), true, false), 'ACTIVE', "step 3 is mf(S_disk, H1', H0') for r alone: two is on disk");
    assert.equal(await evaluateOnDisk(r, await m(c, { [P]: t9([2, 'two']) }), sDisk, cache(c), true, false), 'RESOLVED_PUBLISH', 'A carries two');
  });
});

test('R1 step 4: a CONFLICTED PATCH or PIN whose conflict is gone is ACTIVE again; a displacement or base-move conflict stays CONFLICTED', T10, async () => {
  // Finding 2 (Algorithm R1 "4. Otherwise ACTIVE"): the r-alone reverse merge decides a CONFLICTED PATCH (R3-17), REBASE(H1) a
  // CONFLICTED PIN; only a record whose displacement is pending (conflict / claim-breach: its TIP write) or a base-move conflict on
  // bytes still on disk (Table 1) stays CONFLICTED until GONE (S_disk == A) or SUBSUMED.
  await withMaskRepo('r1-step4', async (c) => {
    const [t, two] = [await c.blob(T9), await c.blob(t9([2, 'two']))];
    const A = await m(c, { [P]: T9 });
    const v = async (r: ReturnType<typeof record>, sDisk: string): Promise<string> => evaluateOnDisk(r, A, await m(c, { [P]: sDisk }), cache(c), false, false);
    const patch = record(pair(t, two), { state: 'CONFLICTED', guards: ['revert'] });
    assert.equal(await v(patch, t9([2, 'two'], [6, 'six'])), 'ACTIVE', 'the held change separates again: ACTIVE');
    assert.equal(await v(patch, t9([6, 'six'])), 'GONE', 'the held change is no longer on disk: GONE');
    assert.equal(await v(patch, t9([2, 'two'], [3, 'THREE'])), 'CONFLICTED', 'the adjacent edit is still there: still CONFLICTED');
    const pin = record(pair(t, two), { kind: 'PIN', state: 'CONFLICTED', guards: ['join'] });
    assert.equal(await v(pin, t9([2, 'two'])), 'ACTIVE', "REBASE(H1) is clean again: ACTIVE (step 3 withholds the PIN's path whole)");
    const stagesOf = (s1: Oid, s2: Oid, s3: Oid): Parameters<typeof record>[0] => ({ s1: { [P]: s1 }, s2: { [P]: s2 }, s3: { [P]: s3 } });
    for (const g of ['conflict', 'claim-breach']) {
      const k4 = record(stagesOf(t, two, await c.blob(t9([2, 'team']))), { state: 'CONFLICTED', guards: [g] });
      assert.equal(await v(k4, t9([2, 'two'])), 'CONFLICTED', `${g}: the TIP write is pending, the LOCAL bytes stay withheld`);
      assert.equal(await v(k4, T9), 'GONE', `${g}: S_disk == A`);
    }
    const baseMove = record(pair(t, two), { state: 'CONFLICTED', guards: ['base-move'] });
    assert.equal(await v(baseMove, t9([2, 'two'], [6, 'six'])), 'CONFLICTED', 'base-move: kept out until --restore or --discard');
  });
});

test('R3-17: a whole-path-guarded PATCH is GONE by the reverse merge of r alone, not by S_disk == A', T10, async () => {
  await withMaskRepo('r1-wholepath', async (c) => {
    const r = record(pair(await c.blob(T9), await c.blob(t9([2, 'two']))), { guards: ['eol-bom'] });
    const A = await m(c, { [P]: T9 });
    assert.equal(await evaluateOnDisk(r, A, await m(c, { [P]: t9([6, 'six']) }), cache(c), false, false), 'GONE', 'the held change is no longer on disk');
    assert.equal(await evaluateOnDisk(r, A, await m(c, { [P]: t9([2, 'two'], [6, 'six']) }), cache(c), false, false), 'ACTIVE');
  });
});

test('evaluateRecords moves a CONFLICTED record whose conflict is gone back to ACTIVE in its one commit, with no code', T10, async () => {
  await withPeers('r1-unconflict', { files: {
    'README.md': Buffer.from('# r1\n', 'utf8'), 'a.txt': Buffer.from(T9, 'utf8'), 'b.txt': Buffer.from(T9, 'utf8'), 'c.txt': Buffer.from(T9, 'utf8'),
  } }, async (fx) => {
    const p = fx.peers[0]!;
    const base = await prepIt(p, { materialize: true });
    const t = await blob(p, T9);
    const two = await blob(p, t9([2, 'two']));
    // A revert PATCH that MASK conflicted because the human edited row 3, next to the held row 2.
    const masked = await p.core.holds.hold(nr({ paths: ['a.txt'], blobs: pair(t, two, 'a.txt') }));
    const k4 = await p.core.holds.hold(nr({ paths: ['b.txt'], state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', blobs: { s1: { 'b.txt': t }, s2: { 'b.txt': two }, s3: { 'b.txt': await blob(p, t9([2, 'team'])) } } }));
    const baseMove = await p.core.holds.hold(nr({ paths: ['c.txt'], state: 'CONFLICTED', guard: 'base-move', origin: 'daemon', blobs: pair(t, two, 'c.txt') }));
    const A = { 'a.txt': t, 'b.txt': t, 'c.txt': t };
    await evaluateRecords(p.core, withMaps(base, { A, sDisk: { 'a.txt': await blob(p, t9([2, 'two'], [3, 'THREE'])), 'b.txt': two, 'c.txt': two } }), new Set(), [masked]);
    assert.equal(p.core.holds.get(masked)!.state, 'CONFLICTED');
    // The human undoes the adjacent edit: r alone separates again.
    const log = recordLog(p);
    const it = withMaps(base, { A, sDisk: { 'a.txt': two, 'b.txt': two, 'c.txt': await blob(p, t9([2, 'two'], [6, 'six'])) } });
    const { commits, result } = await registryCommits(p, () => evaluateRecords(p.core, it, new Set(), []));
    assert.deepEqual(result, [masked]);
    assert.equal(commits, 1, 'one registry commit');
    assert.deepEqual([p.core.holds.get(masked)!.residence, p.core.holds.get(masked)!.state], ['ON_DISK', 'ACTIVE'], 'masked by step 5 again');
    assert.equal(p.core.holds.get(k4)!.state, 'CONFLICTED', 'a pending K4 stays CONFLICTED');
    assert.equal(p.core.holds.get(baseMove)!.state, 'CONFLICTED', 'a base-move conflict stays CONFLICTED');
    assert.deepEqual(log.lines, [], 'no code: HOLD_CODES has none for a conflict that cleared');
  });
});

test('markers suspends R1 and a marker companion ends GONE once its markers releases', T10, async () => {
  await withMaskRepo('r1-markers', async (c) => {
    const r = record(pair(await c.blob(T9), await c.blob(t9([2, 'two']))), { guards: ['markers'] });
    for (const [A, sDisk] of [[t9([3, 'three']), T9], [t9([2, 'two']), t9([2, 'two'])], [T9, T9], [T9, t9([2, 'two'])]] as const) {
      assert.equal(await evaluateOnDisk(r, await m(c, { [P]: A }), await m(c, { [P]: sDisk }), cache(c), false, false), 'HELD_BY_MARKERS');
    }
    // A restored marker companion (ON_DISK, markers): held while markers holds; GONE once it releases.
    const comp = record(pair(await c.blob(T9), await c.blob(`1\n<<<<<<< cowork:disk\nTWO\n=======\ntwo\n>>>>>>> cowork:held\n3\n`)), { guards: ['markers'], local_only: true });
    const A = await m(c, { [P]: T9 });
    const sDisk = await m(c, { [P]: t9([2, 'mine']) });
    assert.equal(await evaluateOnDisk(comp, A, sDisk, cache(c), false, true), 'HELD_BY_MARKERS');
    assert.equal(await evaluateOnDisk({ ...comp, guards: [] }, A, sDisk, cache(c), false, true), 'GONE');
  });
});

test('evaluateOffDisk: SUBSUMED when the REBASE equals A, RESOLVED_PUBLISH when explicit, else nothing; never GONE', T10, async () => {
  await withMaskRepo('r1-offdisk-unit', async (c) => {
    const r = record(pair(await c.blob(T9), await c.blob(t9([2, 'two']))), { residence: 'OFF_DISK', state: 'PARKED', guards: [] });
    assert.equal(await evaluateOffDisk(r, await m(c, { [P]: t9([2, 'two']) }), cache(c), false), 'SUBSUMED');
    assert.equal(await evaluateOffDisk(r, await m(c, { [P]: t9([2, 'two']) }), cache(c), true), 'RESOLVED_PUBLISH');
    assert.equal(await evaluateOffDisk(r, await m(c, { [P]: t9([8, 'eight']) }), cache(c), false), null);
    assert.equal(await evaluateOffDisk(r, await m(c, { [P]: T9 }), cache(c), false), null, 'the disk equal to A never ends it');
  });
});

test('OFF_DISK records are checked only when A[p] changed and are never GONE', T10, async () => {
  await withPeers('r1-offdisk', {}, async (fx) => {
    const p = fx.peers[0]!;
    const base = await prepIt(p, { materialize: true });
    const t = await blob(p, T9);
    const two = await blob(p, t9([2, 'two']));
    const id = await p.core.holds.hold(nr({ residence: 'OFF_DISK', state: 'PARKED', guard: null, blobs: pair(t, two) }));
    // No A change on its paths: no git command at all.
    const quiet = await callsDuring(p, () => evaluateRecords(p.core, base, new Set(), []));
    assert.deepEqual(quiet.calls.map((x) => x.args[0]), [], 'no git command for r');
    assert.deepEqual(quiet.result, []);
    // A changed elsewhere in the file: no transition; equal to A: never GONE.
    for (const a of [t9([8, 'eight']), T9]) {
      const it = withMaps(base, { A: { [P]: await blob(p, a) }, sDisk: { [P]: await blob(p, a) } });
      assert.deepEqual(await evaluateRecords(p.core, it, new Set([P]), []), []);
      assert.equal(p.core.holds.get(id)!.state, 'PARKED');
      assert.equal(p.core.holds.get(id)!.residence, 'OFF_DISK');
    }
    // A carries the held change: SUBSUMED.
    const it2 = withMaps(base, { A: { [P]: two } });
    assert.deepEqual(await evaluateRecords(p.core, it2, new Set([P]), []), [id]);
    assert.equal(p.core.holds.get(id)!.state, 'SUBSUMED');
    // The same with an explicit release: RESOLVED_PUBLISH.
    const id2 = await p.core.holds.hold(nr({ residence: 'OFF_DISK', state: 'PARKED', guard: null, blobs: pair(t, await blob(p, t9([5, 'five']))) }));
    await p.core.holds.markExplicit(id2);
    const it3 = withMaps(base, { A: { [P]: await blob(p, t9([5, 'five'])) } });
    assert.deepEqual(await evaluateRecords(p.core, it3, new Set([P]), []), [id2]);
    assert.equal(p.core.holds.get(id2)!.state, 'RESOLVED_PUBLISH');
  });
});

test('evaluateRecords writes one commitMany and raises HOLD_CONFLICTED, HOLD_SUBSUMED and HOLD_GONE', T10, async () => {
  await withPeers('r1-batch', { files: {
    'README.md': Buffer.from('# r1\n', 'utf8'), 'a.txt': Buffer.from(T9, 'utf8'), 'b.txt': Buffer.from(T9, 'utf8'), 'c.txt': Buffer.from(T9, 'utf8'), 'd.txt': Buffer.from(T9, 'utf8'),
  } }, async (fx) => {
    const p = fx.peers[0]!;
    const base = await prepIt(p, { materialize: true });
    const t = await blob(p, T9);
    const two = await blob(p, t9([2, 'two']));
    const conflicted = await p.core.holds.hold(nr({ paths: ['a.txt'], blobs: pair(t, two, 'a.txt') }));
    const subsumed = await p.core.holds.hold(nr({ paths: ['b.txt'], blobs: pair(t, two, 'b.txt') }));
    const gone = await p.core.holds.hold(nr({ paths: ['c.txt'], blobs: pair(t, two, 'c.txt') }));
    const masked = await p.core.holds.hold(nr({ paths: ['d.txt'], blobs: pair(t, two, 'd.txt') }));
    const it = withMaps(base, {
      A: { 'a.txt': await blob(p, t9([3, 'three'])), 'b.txt': two, 'c.txt': t, 'd.txt': t },
      sDisk: { 'a.txt': two, 'b.txt': two, 'c.txt': await blob(p, t9([6, 'six'])), 'd.txt': two },
    });
    const log = recordLog(p);
    const { commits, result } = await registryCommits(p, () => evaluateRecords(p.core, it, new Set(), [masked]));
    assert.equal(commits, 1, 'exactly one registry commit');
    assert.deepEqual([...result].sort(), [conflicted, subsumed, gone, masked].sort());
    const state = (id: string): string => p.core.holds.get(id)!.state;
    assert.deepEqual([state(conflicted), state(subsumed), state(gone), state(masked)], ['CONFLICTED', 'SUBSUMED', 'GONE', 'CONFLICTED']);
    const line = (code: string): Record<string, unknown> | undefined => log.lines.find((l) => l.code === code)?.params;
    assert.deepEqual(Object.keys(line('HOLD_CONFLICTED') ?? {}).sort(), ['author', 'hid', 'path']);
    assert.deepEqual(line('HOLD_SUBSUMED'), { hid: subsumed, path: 'b.txt' });
    assert.deepEqual(line('HOLD_GONE'), { hid: gone, path: 'c.txt' });
    assert.ok(log.lines.some((l) => l.code === 'HOLD_CONFLICTED' && l.params['hid'] === masked), 'the MASK-conflicted record is told too');
    const last = log.lines[log.lines.length - 1]!;
    assert.deepEqual(p.core.holdCode, { code: last.code, params: last.params }, 'holdCode is the newest code');
  });
});

test('INCOMING records and records carrying an unknown guard are not evaluated', T10, async () => {
  await withPeers('r1-skip', {}, async (fx) => {
    const p = fx.peers[0]!;
    const base = await prepIt(p, { materialize: true });
    const t = await blob(p, T9);
    const two = await blob(p, t9([2, 'two']));
    // An INCOMING lock record whose paths applied (A == its H1): HLD-54 ends it, not R1.
    const incoming = await p.core.holds.hold(nr({ kind: 'INCOMING', guard: 'lock', origin: 'daemon', blobs: pair(t, two) }));
    // A record carrying `frobnicate` (a newer daemon's guard) that R1 would end SUBSUMED.
    const FROB: Guard = { name: 'frobnicate', class: 'DECISION', owner: 'XYZ' };
    const frobId = '01ARZ3NDEKTSV4RRFFQ69G5FZZ';
    await plantRecord(p, {
      id: frobId, rev: 1, owner: p.core.peerId, kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', offer: 'none', declines: 0, displaced_by: null,
      paths: [U], blobs: pair(t, two, U), guards: [FROB, makeGuard('revert')], origin: 'human', cs_ids: [], peer_authors: [], local_only: false,
      age_anchor: { since_rev: 1, anchor_wall_ms: 0, mono_accum_ms: 0 }, proto: 1,
    });
    const it = withMaps(base, { A: { [P]: two, [U]: two }, sDisk: { [P]: two, [U]: two } });
    const { commits, result } = await registryCommits(p, () => evaluateRecords(p.core, it, new Set([P, U]), []));
    assert.deepEqual(result, []);
    assert.equal(commits, 0);
    assert.equal(p.core.holds.get(incoming)!.state, 'ACTIVE');
    assert.equal(p.core.holds.get(frobId)!.state, 'ACTIVE');
  });
});

test('05 P3 holdcat X2: a conflict record is born OFF_DISK, a later local edit publishes within 2 loops, and --restore yields the HLD-17 result', T10, async () => {
  for (const variant of [{ name: 'same-line', teamRow: 2 }, { name: 'adjacent-line', teamRow: 3 }] as const) {
    await withPeers(`p3-${variant.name}`, { n: 2 }, async (fx) => {
      const [p1, p2] = [fx.peers[0]!, fx.peers[1]!];
      // P1 edits row 2 locally; P2 edits row 2 (same line) or row 3 (adjacent) and publishes first.
      await writeWork(p1, P, t9([2, 'two by p1']));
      await prepIt(p1);
      const TEAM = variant.teamRow === 2 ? t9([2, 'two by p2']) : t9([3, 'three by p2']);
      await editAndCapture(fx, p2, { [P]: TEAM });
      fx.advance(30_000);
      assert.equal((await publishStep(p2.core, await prep(p2))).outcome, 'landed');
      // P1's apply: the K4 record is OFF_DISK after the verified write.
      fx.advance(10_000);
      const it = await prepIt(p1, { forceFetch: true });
      const ar = await applyStep(p1.core, it);
      assert.ok(ar.written.includes(P), JSON.stringify(ar));
      assert.equal(ar.records.length, 1);
      const id = ar.records[0]!;
      assert.deepEqual([p1.core.holds.get(id)!.residence, p1.core.holds.get(id)!.state], ['OFF_DISK', 'CONFLICTED'], 'born OFF_DISK after the verified write');
      await evaluateRecords(p1.core, it, new Set(ar.changedA), []);
      // A later local edit four rows away publishes within 2 test-loop rounds once its human CS closes.
      const EDIT = (await readWork(p1, P))!.toString('utf8').replace('6\n', 'six by p1\n');
      await writeWork(p1, P, EDIT);
      await prepIt(p1);
      fx.advance(20_000);   // the human CS closes (HLD-35)
      let landedIn = 0;
      let live: Oid | null = null;
      for (let round = 1; round <= 2 && landedIn === 0; round++) {
        fx.advance(2_500);
        const itR = await prepIt(p1, { forceFetch: true });
        if (captureDue(p1.core)) await captureReady(p1, itR);
        const apply = await applyStep(p1.core, itR);
        await evaluateRecords(p1.core, itR, new Set(apply.changedA), []);
        const pub = await publishStep(p1.core, itR);
        if (pub.outcome === 'landed') {
          landedIn = round;
          live = pub.c;
        }
      }
      assert.ok(landedIn > 0, 'the edit published within 2 rounds');
      assert.ok(live !== null && p1.core.view?.laC === live, 'the landed live commit is the remote live tip');
      assert.equal((await p1.core.repo.readBlob((await treeOf(p1, live)).get(P)!.oid)).toString('utf8'), EDIT, 'the edit is in the remote live tree');
      assert.equal(p1.core.holds.get(id)!.residence, 'OFF_DISK', 'the OFF_DISK record masked nothing');
      // --restore: merge-file --diff3 (disk, s1, s2).
      const rec = p1.core.holds.get(id)!;
      assert.ok('s2' in rec.blobs);
      fx.advance(2_500);
      const itr = await prepIt(p1, { holdPaths: [P] });
      const D = itr.mat!.sRawMap.get(P)!.oid;
      const want = (await runMergeFile(p1.core.repo, ['merge-file', '-p', '--diff3', '--object-id', '-L', 'cowork:disk', '-L', 'cowork:base', '-L', 'cowork:held', D, rec.blobs.s1[P] as Oid, rec.blobs.s2[P] as Oid])).out;
      const out = await restore(p1.core, itr, id, { humanEvidence: true, actor: 'human' });
      assert.equal(out.kind, 'RESTORED');
      assert.deepEqual(await readWork(p1, P), want, 'the disk holds mf --diff3 (disk, s1, s2)');
      assert.equal(p1.core.holds.get(id)!.residence, 'ON_DISK');
    });
  }
});
