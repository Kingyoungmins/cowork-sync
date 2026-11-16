// The receive-side budget (Plan 3 Task 6; 05-holds B1, HLD-10, HLD-32; 11-testing TC-HLD-05; INV-HLD-BUDGET; Review Focus 2): thirty
// virtual minutes with one permanent PATCH and one 40 s lock and no edits give exactly one push — the PATCH's creation mirror; a
// lock shorter than 60 s produces no record and no board op. The test loop runs every 2.5 virtual seconds as Plan 2's loop composes
// steps 1–6 (prepareIteration → applyStep → incomingStep → publishStep; Engine.iterate is Plan 2 Tasks 17–20, not on this base).
// Real git on file:// clones; never mocked.
//
// Plan 3 Task 16 (R3-55, the Task 10 precedent for I17/TC-HLD-08): TC-HLD-05 ran 245–563 s of its 600 s cap under `npm test`, so
// `npm test` runs an 8-minute form (the lock from minute 3) and `npm run test:sim` (TEST_SIM_FULL=1) the 30 minutes of 05 B1 (the lock
// from minute 10); both assert the same: one push in all — the creation mirror —, no INCOMING record ever, the change applied after
// the lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWork, workPath, writeWork } from '../helpers/coreFixture.js';
import { incomingRecords, loop } from '../helpers/incomingFixture.js';
import { holdPatch } from '../helpers/mirrorFixture.js';
import { buf, withCores } from '../helpers/publishHelpers.js';


const LOOP_MS = 2_500;
const MINUTE = 60_000;
/** R3-55: the full 30 minutes of 05 B1 under `npm run test:sim`, an 8-minute form under `npm test` (the same assertions). */
const FULL = process.env['TEST_SIM_FULL'] === '1';
const SPAN_MS = (FULL ? 30 : 8) * MINUTE;
const LOCK_AT_MS = (FULL ? 10 : 3) * MINUTE;
/** R3-55: the 10-minute node:test timeout; the full form gets 30 (it ran up to 563 s of 600 under npm test's load). */
const T = { timeout: (FULL ? 30 : 10) * 60_000 };

test(`05 B1 / TC-HLD-05: thirty minutes with one permanent PATCH and one 40 s lock and no edits give exactly one push (${FULL ? 'TEST_SIM_FULL=1: the 30 minutes' : 'npm test: an 8-minute form, R3-55'})`, T, async () => {
  const files = { 'README.md': buf('# budget\n'), 'gen/out.js': buf('// generated 1\n'), 'src/a.txt': buf('a1\na2\n') };
  await withCores('rbudget-b1', { n: 2, files }, async (fx) => {
    const p1 = fx.peers[1]!;
    await loop(p1);
    // t = 0: a `generated?` PATCH made with hold() (a non-escalating guard: a `revert` record would add HLD-60's +10 min event once
    // Task 12b's escalation runs).
    await writeWork(p1, 'gen/out.js', '// generated 2\n');
    await holdPatch(p1, 'gen/out.js', '// generated 2\n', 'generated?');
    const pushes0 = p1.core.pushAttempts;
    let release: (() => void) | null = null;
    let deferredWhileLocked = 0;
    let t = 0;
    for (; t < SPAN_MS; t += LOOP_MS) {
      if (t === LOCK_AT_MS) {
        // A teammate change whose target P1's FaultFs holds share-read for 40 s.
        release = p1.fs.holdLock(workPath(p1, 'src/a.txt'), 'share-read');
        await fx.pushTeamChange({ 'src/a.txt': buf('a1\na2 team\n') });
      }
      if (t === LOCK_AT_MS + 40_000) {
        release?.();
        release = null;
      }
      const l = await loop(p1, { publish: true });
      if (l.apply.closures.length > 0) deferredWhileLocked++;
      assert.deepEqual(incomingRecords(p1), [], `t = ${t} ms: no INCOMING record ever exists on P1`);
      fx.advance(LOOP_MS);
    }
    assert.ok(deferredWhileLocked >= 3, `the lock deferred the change's closure (${deferredWhileLocked} applies)`);
    assert.equal((await readWork(p1, 'src/a.txt'))?.toString(), 'a1\na2 team\n', 'the change applied after the lock');
    assert.equal(p1.core.pushAttempts - pushes0, 1, `P1's push attempts over ${SPAN_MS / MINUTE} min: the creation mirror only`);
  });
});
