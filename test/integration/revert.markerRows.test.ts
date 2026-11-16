// The revert detector over a disk that holds restore-marker rows (G2 #7 of the 2026-10-20 audit; 05-holds Algorithm D2, HLD-27,
// INV-HLD-NOREVERT, §3.4 item 3, DAT-46; rulings R3-EF4-13, R3-EF4-24): a resolution in progress inside a conflicted restore's rows,
// saved with the teammate's row dropped inside the marker block, used to make a `revert` record whose H1 carried the whole -U0 hunk with
// its marker rows — local_only by R3-EF4-24, so its path turned LOCAL_ONLY ('secret-like'), MASK withheld it whole, --park was refused
// and nothing could ever end it. Such a delta is now judged only once the rows are gone, from the same base: the dropped teammate row
// is still a revert, with a marker-free H1. Built from the audit probe scratchpad/audit/probes-holdscode/markerRevert2.test.ts (its
// output markerRevert2b.out). Real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStep } from '../../src/engine/apply.js';
import { localOnlyScope } from '../../src/engine/core.js';
import { revertStep } from '../../src/engine/detect.js';
import { hasRestoreMarkerRow } from '../../src/data/rows.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { blobAt, heldSide } from '../../src/holds/record.js';
import { writeWork } from '../helpers/coreFixture.js';
import { P, prepIt, withPeers } from '../helpers/holdOpsFixture.js';
import { t9 } from '../helpers/maskFixture.js';
import { buf } from '../helpers/publishHelpers.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const TEAM8 = 'eight by team';
/** The disk mid-resolution: the restore's marker block with the teammate's side (row 8, TEAM8) deleted (an autosave). */
const MID = '1\n2\n3\n4\n5\n6\n7\n<<<<<<< cowork:disk\n||||||| cowork:base\n8\n=======\nLOCAL held eight\n>>>>>>> cowork:held\n9\n';
/** The finished resolution: the held side kept, the rows gone — the teammate's row 8 is still dropped. */
const RESOLVED = t9([8, 'LOCAL held eight']);

test('G2 #7: a materialized delta whose disk holds restore-marker rows makes no revert record; the delta that removes the rows is judged from the same base — one revert record with a marker-free H1, not local_only, its path not LOCAL_ONLY', T10, async () => {
  await withPeers('revert-marker-rows', {}, async (fx) => {
    const p = fx.peers[0]!;
    await fx.pushTeamChange({ [P]: buf(t9([8, TEAM8])) });
    fx.advance(10_000);
    const a1 = await applyStep(p.core, await prepIt(p, { forceFetch: true }));
    assert.ok(a1.written.includes(P), JSON.stringify(a1));
    await prepIt(p);
    fx.advance(1_500);
    assert.deepEqual(await revertStep(p.core, await prepIt(p, { materialize: true })), [], 'precondition: the apply is no delta');
    // The mid-resolution save: the teammate's row is gone inside the marker block.
    await writeWork(p, P, MID);
    await prepIt(p);
    fx.advance(1_500);
    assert.deepEqual(await revertStep(p.core, await prepIt(p, { materialize: true })), [], 'not judged while the rows are on the disk');
    assert.deepEqual(p.core.holds.nonTerminal().filter((r) => r.paths.includes(P)).map((r) => r.id), [], 'no record');
    assert.equal(localOnlyScope(p.core).paths.has(P), false, 'the path is not LOCAL_ONLY');
    // The human finishes: the rows are gone, the held side kept (two ticks 2.5 s apart: a > 50 % shrink is seen at its second snapshot).
    await writeWork(p, P, RESOLVED);
    await prepIt(p);
    fx.advance(2_500);
    await prepIt(p);
    fx.advance(1_500);
    const ids = await revertStep(p.core, await prepIt(p, { materialize: true }));
    assert.equal(ids.length, 1, 'the dropped teammate row is a revert, judged from the base before the rows');
    const r = p.core.holds.get(ids[0]!)!;
    assert.deepEqual([r.kind, r.residence, r.state, r.guards.map((g) => g.name), r.local_only], ['PATCH', 'ON_DISK', 'ACTIVE', ['revert'], false]);
    const h1 = blobAt(heldSide(r), P);
    assert.ok(h1 !== undefined && h1 !== ABSENT);
    const bytes = await p.core.repo.readBlob(h1 as Oid);
    assert.equal(hasRestoreMarkerRow(bytes), false, 'a marker-free H1');
    assert.equal(bytes.toString('utf8'), RESOLVED, 'H1 = taintOnlyH1(A, S_disk): the resolution');
    assert.equal(localOnlyScope(p.core).paths.has(P), false, 'its path is not LOCAL_ONLY');
  });
});
