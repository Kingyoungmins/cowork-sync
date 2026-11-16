// PARK and the unpublished ready pairs over the parked paths (Plan 3 final review F6; 05-holds §3.4 item 3, HLD-16, HLD-41, HLD-42,
// INV-HLD-OFFDISK, INV-HLD-ATOMIC-PUB, INV-HLD-NOREVERT, INV-NOLOSS, DAT-46 / INV-SECRET). PARK writes the team version (or an ACTIVE
// PATCH's step-5 MASK result) over the record's paths and moves the record OFF_DISK, where it masks nothing. A ready pair captured before
// the park still carried the parked bytes in its R — a K6 / dependency PIN's whole change-set, the marker rows a RESTORE wrote — and once
// nothing else held its group it published them, while the author's disk kept A and nothing tracked the divergence. Every operator write
// that takes a record's bytes off the disk (park, the markers park, their restart completions, the ON_DISK --discard) now withdraws every
// publication group with an unpublished ready pair covering a written path, whole (HLD-41's withdrawal: never one pair alone), and the
// group is re-captured from the post-write disk. Real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasRestoreMarkerRow } from '../../src/data/rows.js';
import { applyStep } from '../../src/engine/apply.js';
import { captureStep } from '../../src/engine/csStep.js';
import { revertStep } from '../../src/engine/detect.js';
import { parseOid } from '../../src/git/oid.js';
import { park, restore, settleHoldOps } from '../../src/engine/holdOps.js';
import { recordStep } from '../../src/engine/holdSteps.js';
import { publishStep } from '../../src/engine/publish.js';
import { resolve } from '../../src/engine/resolve.js';
import { blobAt, heldSide } from '../../src/holds/record.js';
import type { PublishGatePort } from '../../src/holds/ports.js';
import { readWork, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { remoteLive } from '../helpers/dataRecordsFixture.js';
import { blob, nr, pair, prepIt } from '../helpers/holdOpsFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { buf, captureReady, editAndCapture, prep, stateA, withCores } from '../helpers/publishHelpers.js';
import { HUMAN } from '../helpers/resolveFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const K6 = 'k6.txt';
const R1 = 'src/r1.txt';
const text = async (p: PeerFixture, path: string): Promise<string | null> => (await readWork(p, path))?.toString('utf8') ?? null;
const done = (code: string, id: string): unknown => ({ kind: 'done', code, id, created: null });

/** A B1 stub: a foreign claim on k6.txt blocks every group naming it while `on()`. */
const k6Gate = (on: () => boolean): PublishGatePort => ({
  gate: async (_r, _t, _A, _R, paths) => (on() && paths.includes(K6) ? { block: { claimId: 'abcdefghij234567' } } : { block: null }),
  claimStillBlocks: async () => on(),
});

/** One loop's steps 3–5 and the publish window (a capture when due, the apply, the record step, the governed publish). */
async function loopOnce(fx: CoreFixture, p: PeerFixture, ms = 30_000): Promise<void> {
  fx.advance(ms);
  const it = await prep(p, 'auto');
  await captureStep(p.core, it);
  const ap = await applyStep(p.core, it);
  await recordStep(p.core, it, ap);
  await publishStep(p.core, it);
}

/** The ready pairs whose R carries `oid` at `path`. */
async function pairsCarrying(p: PeerFixture, path: string, oid: string): Promise<string[]> {
  const out: string[] = [];
  for (const r of p.core.cs.ready()) if ((await p.core.repo.readTreeMap(r.R)).get(path)?.oid === oid) out.push(r.csId);
  return out;
}

test('ChangeSets.withdrawPaths withdraws the whole publication group of a pair naming a written path, never one pair alone, and keeps every other group (final review F6, HLD-41, INV-HLD-ATOMIC-PUB)', T10, async () => {
  const files = { 'README.md': buf('# f6\n'), 'a.txt': buf('a\n'), 'b.txt': buf('b\n'), 'c.txt': buf('c\n'), 'd.txt': buf('d\n') };
  await withCores('f6-withdraw-group', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    const { pair: p1 } = await editAndCapture(fx, p, { 'a.txt': 'a local\n', 'b.txt': 'b local\n' });
    const { pair: p2 } = await editAndCapture(fx, p, { 'b.txt': 'b local, later\n', 'c.txt': 'c local\n' });
    const { pair: p3 } = await editAndCapture(fx, p, { 'd.txt': 'd local\n' });
    assert.deepEqual(p.core.cs.withdrawPaths(new Set(['zzz.txt'])), [], 'no pair names the path: nothing withdrawn');
    assert.deepEqual(p.core.cs.withdrawPaths(new Set(['a.txt'])), [p1.csId, p2.csId], 'p2 shares b.txt with p1: one group, withdrawn whole');
    assert.deepEqual(p.core.cs.ready().map((r) => r.csId), [p3.csId], 'the other group stays ready');
    assert.deepEqual([...p.core.cs.openPaths()].sort(), ['a.txt', 'b.txt', 'c.txt'], 'the withdrawn paths wait for their re-capture from the disk');
  });
});

test('a K6 PIN --park withdraws its change-set\'s unpublished ready pair: once the claim lifts the parked bytes never publish, live and disk agree on A and the PIN keeps the bytes (final review F6)', T10, async () => {
  let claimed = false;
  await withCores('f6-k6-park', { n: 1, files: { 'README.md': buf('# f6\n'), [R1]: buf(T9), [K6]: buf(T9) }, ports: { gate: k6Gate(() => claimed) } }, async (fx) => {
    const p = fx.peers[0]!;
    const PARKED = t9([4, 'a human hunk in a foreign claim']);
    const OTHER = t9([3, 'other edit, same change-set']);
    await editAndCapture(fx, p, { [K6]: PARKED, [R1]: OTHER });
    claimed = true;
    fx.advance(30_000);
    assert.equal((await publishStep(p.core, await prep(p))).c ?? null, null, 'B1 holds the group');
    const k6 = p.core.holds.nonTerminal().find((r) => r.kind === 'PIN' && r.guards.some((g) => g.name.startsWith('claim:')))!;
    assert.ok(k6 !== undefined, 'the K6 PIN');
    assert.deepEqual(await resolve(p.core, await prepIt(p, { forceFetch: true, holdPaths: k6.paths }), k6.id, 'park', HUMAN), done('HOLD_PARKED', k6.id));
    const parked = await blob(p, PARKED);
    const other = await blob(p, OTHER);
    const leftAfterPark = [...(await pairsCarrying(p, K6, parked)), ...(await pairsCarrying(p, R1, other))];
    for (let i = 0; i < 3; i++) await loopOnce(fx, p);   // while the claim still blocks
    claimed = false;
    for (let i = 0; i < 4; i++) await loopOnce(fx, p);   // the claim is gone
    const live = await remoteLive(fx, p);
    const a = await blob(p, T9);
    assert.equal(live.get(K6), a, 'the parked hunk never publishes');
    assert.equal(live.get(R1), a, 'nor does the rest of the parked change-set');
    assert.equal(await text(p, K6), T9, 'the disk keeps A[p]: no silent divergence from the live branch');
    assert.equal(await text(p, R1), T9);
    assert.deepEqual(leftAfterPark, [], 'the park withdrew every ready pair carrying the parked bytes');
    const r = p.core.holds.get(k6.id)!;
    assert.deepEqual([r.residence, r.state], ['OFF_DISK', 'PARKED'], 'the PIN stays parked, restorable');
    assert.equal(blobAt(heldSide(r), K6), parked, 'and holds the parked bytes');
  });
});

test('the markers park withdraws a ready pair that captured a RESTORE\'s marker rows: no marker row ever reaches the live ref (final review F6, DAT-46, INV-SECRET)', T10, async () => {
  await withCores('f6-markers-park', { n: 1, files: { 'README.md': buf('# f6\n'), [R1]: buf(T9) } }, async (fx) => {
    const p = fx.peers[0]!;
    const it0 = await prepIt(p, { materialize: false });
    const a = it0.A.get(R1)!.oid;
    const id = await p.core.holds.hold(nr({ paths: [R1], residence: 'OFF_DISK', state: 'PARKED', guard: null, blobs: pair(a, await blob(p, t9([2, 'the held change'])), R1) }));
    await writeWork(p, R1, t9([2, 'a conflicting local edit']));
    await prep(p);
    assert.deepEqual(await restore(p.core, await prepIt(p, { holdPaths: [R1] }), id, { humanEvidence: true, actor: 'human' }), { kind: 'RESTORED', markers: true });
    // The human CS captures the marker rows (no publish window in between: offline, paused, or a quick --park).
    for (let i = 0; i < 4; i++) {
      fx.advance(12_000);
      const it = await prep(p, 'auto');
      await captureStep(p.core, it);
    }
    const marked: string[] = [];
    for (const r of p.core.cs.ready()) {
      const e = (await p.core.repo.readTreeMap(r.R)).get(R1);
      if (e !== undefined && hasRestoreMarkerRow(await p.core.repo.readBlob(e.oid))) marked.push(r.csId);
    }
    assert.equal(marked.length, 1, `precondition: a ready pair carries the marker rows: ${JSON.stringify(p.core.cs.ready().map((r) => r.csId))}`);
    assert.deepEqual(await resolve(p.core, await prepIt(p, { forceFetch: true, holdPaths: [R1] }), id, 'park', HUMAN), done('HOLD_PARKED', id));
    assert.equal(await text(p, R1), T9, 'the markers park wrote A[p]');
    const left = p.core.cs.ready().filter((r) => marked.includes(r.csId)).map((r) => r.csId);
    for (let i = 0; i < 4; i++) await loopOnce(fx, p);
    const live = (await remoteLive(fx, p)).get(R1);
    assert.ok(live === undefined || !hasRestoreMarkerRow(await p.core.repo.readBlob(parseOid(live))), 'no restore-marker row on the live ref');
    assert.equal(live, a, 'live src/r1.txt stays A, as the disk does');
    assert.deepEqual(left, [], 'the markers park withdrew the marker-carrying pair');
  });
});

test('a parked HLD-42 dependency PIN leaves no ready pair behind: when its target ends, nothing publishes the bytes the park took off the disk (final review F6)', T10, async () => {
  const X = 'src/x.txt';
  const O = 'src/o.txt';
  await withCores('f6-dep-park', { n: 1, files: { 'README.md': buf('# f6\n'), [X]: buf('x1\nx2\nx3\n'), [O]: buf('o1\no2\no3\n') } }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    const A = await stateA(p);
    // The dependency target: a CONFLICTED revert PATCH on x.txt (it withholds the path whole, MASK step 4).
    await p.core.holds.hold(nr({ paths: [X], state: 'CONFLICTED', blobs: pair(A.get(X)!.oid, await blob(p, 'x1\nx2 local\nx3\n'), X) }));
    await editAndCapture(fx, p, { [X]: 'x1\nx2 local\nx3\n', [O]: 'o1\no2 local\no3\n' });
    await prep(p);
    fx.advance(6_000);
    const first = await publishStep(p.core, await prep(p, true));
    assert.equal(first.dependencyPins.length, 1, `Algorithm P made the dependency PIN: ${JSON.stringify(first)}`);
    const pin = first.dependencyPins[0]!;
    const out = await park(p.core, await prep(p, true), pin, { humanEvidence: true, displacedBy: null, refreshMustBeDurable: false });
    assert.equal(out.kind, 'PARKED');
    assert.equal(await text(p, O), 'o1\no2\no3\n', 'the park wrote A over the group');
    const local = [...(await pairsCarrying(p, X, await blob(p, 'x1\nx2 local\nx3\n'))), ...(await pairsCarrying(p, O, await blob(p, 'o1\no2 local\no3\n')))];
    const published: string[] = [];
    for (let k = 0; k < 4; k++) {
      await prep(p);
      fx.advance(6_000);
      const it = await prep(p, true);
      const ap = await applyStep(p.core, it);
      await recordStep(p.core, it, ap);
      const r = await publishStep(p.core, it);
      if (r.c !== null) {
        const t = await p.core.repo.readTreeMap((await p.core.repo.readCommit(r.c)).tree);
        published.push(`${t.get(X)?.oid === A.get(X)!.oid ? 'x:A' : 'x:local'} ${t.get(O)?.oid === A.get(O)!.oid ? 'o:A' : 'o:local'}`);
      }
    }
    assert.ok(published.every((s) => s === 'x:A o:A'), `no live commit carries the parked bytes: ${JSON.stringify(published)}`);
    const live = await remoteLive(fx, p);
    assert.deepEqual([live.get(X), live.get(O)], [A.get(X)!.oid, A.get(O)!.oid], 'live x.txt and o.txt stay A, as the disk does');
    assert.deepEqual(local, [], 'the park withdrew the pair carrying the parked bytes');
    assert.equal(p.core.holds.get(pin)!.residence, 'OFF_DISK', 'the PIN keeps the bytes OFF_DISK');
  });
});

test('an ON_DISK --discard of a revert PATCH withdraws the ready pair that captured the teammate-line removal: the removal never publishes (final review F6, INV-HLD-NOREVERT)', T10, async () => {
  const F = 'f.py';
  const rows = (r: readonly string[]): string => r.map((x) => `${x}\n`).join('');
  const BASE = Array.from({ length: 40 }, (_, i) => `row_${i + 1} = ${i + 1}`);
  const A1 = [...BASE.slice(0, 10), 'TEAM = 1', ...BASE.slice(10)];
  await withCores('f6-discard-revert', { n: 1, files: { 'README.md': buf('# f6\n'), [F]: buf(rows(BASE)) } }, async (fx) => {
    const p = fx.peers[0]!;
    await fx.pushTeamChange({ [F]: buf(rows(A1)) });
    fx.advance(10_000);
    assert.ok((await applyStep(p.core, await prep(p))).ran, 'A1 applied');
    // A stale save removes TEAM (and the human adds a row of their own); the detector makes the revert PATCH before the capture.
    const STALE = rows([...BASE.slice(0, 30), 'mine = 1', ...BASE.slice(30)]);
    await writeWork(p, F, STALE);
    await prep(p);
    fx.advance(20_000);
    const it = await prep(p, true);
    const ids = await revertStep(p.core, it);
    assert.equal(ids.length, 1, 'the TEAM removal is a revert record');
    const pr = await captureReady(p, it);
    assert.equal((await p.core.repo.readTreeMap(pr.R)).get(F)?.oid, await blob(p, STALE), 'precondition: the ready pair carries the removal');
    assert.deepEqual(await resolve(p.core, await prepIt(p, { forceFetch: true, holdPaths: [F] }), ids[0]!, 'discard', HUMAN), done('RESOLVED_DISCARD', ids[0]!));
    const kept = rows([...A1.slice(0, 31), 'mine = 1', ...A1.slice(31)]);
    assert.equal(await text(p, F), kept, 'the discard wrote the step-5 MASK result: TEAM back, the human row kept');
    for (let i = 0; i < 4; i++) await loopOnce(fx, p);
    const live = (await remoteLive(fx, p)).get(F)!;
    const liveText = (await p.core.repo.readBlob(parseOid(live))).toString('utf8');
    assert.ok(liveText.includes('TEAM = 1'), `the teammate's line is never removed on the live branch:\n${liveText}`);
    assert.equal(live, await blob(p, kept), 'live f.py is the re-captured disk: TEAM kept, the human row published');
  });
});

test('settleHoldOps completing an interrupted PARK at restart withdraws the ready pairs over its paths before the final patch (final review F6)', T10, async () => {
  await withCores('f6-settle-park', { n: 1, files: { 'README.md': buf('# f6\n'), [R1]: buf(T9) } }, async (fx) => {
    const p = fx.peers[0]!;
    const LOCAL = t9([5, 'five, local']);
    const { pair: captured } = await editAndCapture(fx, p, { [R1]: LOCAL });
    const it = await prepIt(p, { holdPaths: [R1] });
    const a = it.A.get(R1)!.oid;
    const local = await blob(p, LOCAL);
    const id = await p.core.holds.hold(nr({ kind: 'PIN', guard: 'join', paths: [R1], blobs: pair(a, local, R1) }));
    // A park whose write completed (disk = A) and whose snap transition and final commit did not: the in-flight entry is still set.
    await p.core.holds.commitMany([], [], { setInflight: { [id]: { op: 'park', entries: [{ path: R1, expected: local, target: a }], final: { residence: 'OFF_DISK', state: 'PARKED', displaced_by: null }, explicit: false } } });
    await writeWork(p, R1, T9);
    assert.ok(p.core.cs.ready().some((r) => r.csId === captured.csId), 'precondition: the pair is journaled');
    await settleHoldOps(p.core);
    assert.deepEqual([p.core.holds.get(id)!.residence, p.core.holds.get(id)!.state], ['OFF_DISK', 'PARKED'], 'the park completed');
    assert.deepEqual(await pairsCarrying(p, R1, local), [], 'the completion withdrew the pair carrying the parked bytes');
    assert.deepEqual(p.core.view!.ready.filter((r) => r.csId === captured.csId), [], 'journal/ready/ no longer holds it');
  });
});
