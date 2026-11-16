// `--publish` of an ON_DISK record whose own pair cannot publish as it stands (G2 #5, #7 of the 2026-10-20 audit; 05-holds Table 4
// `--publish`, HLD-03, HLD-29, HLD-42, MASK steps 2 and 4, DAT-46; rulings R3-EF4-24, R3-FF2-B0): a CONFLICTED record (the human edited
// its held line, a MASK conflict) and a record whose held side carries restore-marker rows are re-based on the disk — (A, S_disk), guards
// released, ACTIVE — so the human's version publishes and R1 ends the record RESOLVED_PUBLISH; a record that would stay local_only on a
// path this PC does not sync is refused (05 §1's not-LIVE shape) instead of answered RESOLVED_PUBLISH. Built from the audit probe
// scratchpad/audit/probes-lostpc2/cpub.test.mts (there: RESOLVED_PUBLISH, then the record ON_DISK CONFLICTED with no guard for good, a
// dependency PIN on it, the human's line never live). Real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, type ResolveResult } from '../../src/engine/resolve.js';
import { blobAt, guardName, heldSide, type HoldRecord } from '../../src/holds/record.js';
import { readWork, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { remoteLive } from '../helpers/dataRecordsFixture.js';
import { blob, nr, pair, prepIt } from '../helpers/holdOpsFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { buf, withCores } from '../helpers/publishHelpers.js';
import { captureAndLand, HUMAN } from '../helpers/resolveFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const P = 'src/t9.txt';
const IGNORE = '.gitignore';
const FILES: Record<string, Buffer> = { 'README.md': buf('# resolve publish on disk\n'), [P]: buf(T9), [IGNORE]: buf('*.log\n') };
const done = (code: string, id: string, created: string | null = null): ResolveResult => ({ kind: 'done', code, id, created });
const guardsOf = (r: HoldRecord | undefined): string[] => (r?.guards ?? []).map((g) => g.name);
const dependencyPins = (p: PeerFixture): HoldRecord[] => p.core.holds.nonTerminal().filter((r) => r.guards.some((g) => guardName(g) === 'dependency'));

test('G2 #5: --publish of an ON_DISK CONFLICTED revert PATCH (the human edited its held line) re-bases it on the disk — guards released, ACTIVE, held side := S_disk — so the human\'s version publishes, no dependency PIN forms and R1 ends it RESOLVED_PUBLISH', T10, async () => {
  await withCores('rpub-conflicted', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const human = t9([2, 'human two']);
    await writeWork(p, P, human);
    const it0 = await prepIt(p, { materialize: false });
    const a = it0.A.get(P)!.oid;
    // The record a MASK conflict leaves (the probe's): revert PATCH, h0 = A[P], h1 = T9{2:two}, CONFLICTED (the human edited the held line).
    const id = await p.core.holds.hold(nr({ paths: [P], state: 'CONFLICTED', blobs: pair(a, await blob(p, t9([2, 'two'])), P) }));
    const it = await prepIt(p, { holdPaths: [P] });
    assert.deepEqual(await resolve(p.core, it, id, 'publish', HUMAN), done('RESOLVED_PUBLISH', id));
    const r = p.core.holds.get(id)!;
    assert.deepEqual([r.residence, r.state, guardsOf(r)], ['ON_DISK', 'ACTIVE', []], 'released and ACTIVE (MASK step 4 no longer withholds the path)');
    assert.equal(blobAt(heldSide(r), P), await blob(p, human), 'the held side is the disk\'s version');
    assert.equal('h0' in r.blobs ? blobAt(r.blobs.h0, P) : null, a, 'on the base A[P]');
    assert.ok(p.core.holds.local().explicit.includes(id), 'marked explicit (HLD-29)');
    assert.ok(p.core.cs.openPaths().has(P), 'its path is in the human CS');
    assert.equal((await readWork(p, P))?.toString('utf8'), human, 'no write');
    await captureAndLand(fx, p);
    assert.equal((await remoteLive(fx, p)).get(P), await blob(p, human), 'the human\'s version is live');
    assert.equal(p.core.holds.get(id)!.state, 'RESOLVED_PUBLISH', 'R1 ends it RESOLVED_PUBLISH once its content is in A');
    assert.deepEqual(dependencyPins(p), [], 'no dependency PIN on a record that withholds nothing');
  });
});

test('G2 #7: --publish of a revert record whose held side carries restore-marker rows (local_only, R3-EF4-24) is refused HOLD_GUARDS_REMAIN {markers} while the disk still holds the rows; once they are gone it is re-based on the disk, no longer local_only, and the resolution publishes', T10, async () => {
  await withCores('rpub-marker-held', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    // A resolution in progress inside a conflicted restore's rows, saved with the teammate's row dropped (the audit's markerRevert2b H1).
    const marked = '1\n2\n3\n4\n5\n6\n7\n<<<<<<< cowork:disk\n||||||| cowork:base\n8\n=======\nLOCAL held eight\n>>>>>>> cowork:held\n9\n';
    await writeWork(p, P, marked);
    const it0 = await prepIt(p, { materialize: false });
    const a = it0.A.get(P)!.oid;
    const id = await p.core.holds.hold(nr({ paths: [P], blobs: pair(a, await blob(p, marked), P) }));
    assert.equal(p.core.holds.get(id)!.local_only, true, 'precondition: R3-EF4-24 made it local_only');
    const it1 = await prepIt(p, { holdPaths: [P] });
    assert.deepEqual(await resolve(p.core, it1, id, 'publish', HUMAN), { kind: 'refused', code: 'HOLD_GUARDS_REMAIN', params: { hid: id, guards: ['markers'] } });
    assert.deepEqual([p.core.holds.get(id)!.state, guardsOf(p.core.holds.get(id))], ['ACTIVE', ['revert']], 'nothing changed');
    // The human finishes: the rows are gone (two ticks 2.5 s apart first: a > 50 % shrink is seen only at its second stable snapshot).
    const resolved = t9([8, 'LOCAL held eight']);
    await writeWork(p, P, resolved);
    await prepIt(p);
    fx.advance(2_500);
    await prepIt(p);
    const it2 = await prepIt(p, { holdPaths: [P] });
    assert.deepEqual(await resolve(p.core, it2, id, 'publish', HUMAN), done('RESOLVED_PUBLISH', id));
    const r = p.core.holds.get(id)!;
    assert.deepEqual([r.residence, r.state, guardsOf(r), r.local_only], ['ON_DISK', 'ACTIVE', [], false], 'released, re-based and mirrored again');
    assert.equal(blobAt(heldSide(r), P), await blob(p, resolved));
    assert.ok(p.core.cs.openPaths().has(P), 'its path is in the human CS (LOCAL_ONLY only by its own effect, which ended)');
    await captureAndLand(fx, p);
    assert.equal((await remoteLive(fx, p)).get(P), await blob(p, resolved), 'the resolution is live');
    assert.equal(p.core.holds.get(id)!.state, 'RESOLVED_PUBLISH');
  });
});

test('G2 #7: --publish of an ON_DISK record that stays local_only on a path this PC does not sync (.gitignore: save-only) is refused HOLD_GUARDS_REMAIN with not_live, never answered RESOLVED_PUBLISH; nothing changes', T10, async () => {
  await withCores('rpub-not-live', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, IGNORE, '*.log\n*.tmp\n');
    const it0 = await prepIt(p, { materialize: false });
    const id = await p.core.holds.hold(nr({ paths: [IGNORE], guard: 'join', kind: 'PIN', blobs: pair(it0.A.get(IGNORE)!.oid, await blob(p, '*.log\n*.tmp\n'), IGNORE) }));
    assert.equal(p.core.holds.get(id)!.local_only, true, 'precondition: a path that is not LIVE makes it local_only');
    const before = p.core.holds.get(id)!;
    const it = await prepIt(p, { holdPaths: [IGNORE] });
    assert.deepEqual(await resolve(p.core, it, id, 'publish', HUMAN), {
      kind: 'refused', code: 'HOLD_GUARDS_REMAIN', params: { hid: id, guards: [], not_live: [{ path: IGNORE, cls: 'SAVE_ONLY', reason: 'save-only' }] },
    });
    assert.deepEqual(p.core.holds.get(id), before, 'the record is unchanged');
    assert.equal(p.core.holds.local().explicit.includes(id), false, 'not marked explicit');
  });
});
