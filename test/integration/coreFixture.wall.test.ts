// The core fixture's virtual wall against real-clock mtimes (Plan 3 Task EF, item 6). Files the engine's writer makes (applies, the
// revert write, --discard), files a clone checks out and files tests write with node:fs carry REAL mtimes, while every peer clock is
// virtual; the snapshot's quiet rule compares the two (a path whose mtime is ahead of the wall waits for its stat to stay unchanged
// 300 ms, a tick). Task 17 reproduced the failure of the old 60 s margin: under a ~6x slowdown real time overtook it, a revert write
// was "in the future" for the virtual clock, its first tick quiet-excluded it and the capture took the pre-write entry. The margin
// must outlast any test that holds one fixture. Real clones; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { applyStep } from '../../src/engine/apply.js';
import { workPath } from '../helpers/coreFixture.js';
import { buf, prep, withCores } from '../helpers/publishHelpers.js';

/** The longest node:test timeout of any test that holds a core or engine fixture (apply.bomcrlf.test.ts: 60 min). */
const LONGEST_FIXTURE_TEST_MS = 60 * 60_000;

test('a file the writer makes stays behind every peer\'s virtual wall for longer than any core-fixture test may run (Task 17\'s overtaken 60 s margin)', { timeout: 10 * 60_000 }, async () => {
  await withCores('fx-wall', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    const wall0 = p.clock.wallMs();
    await fx.pushTeamChange({ 'src/b.txt': buf('alpha\nbeta by the team\ngamma\n') });
    fx.advance(10_000);
    const r = await applyStep(p.core, await prep(p));
    assert.ok(r.written.includes('src/b.txt'), JSON.stringify(r.written));
    const mtime = (await stat(workPath(p, 'src/b.txt'))).mtimeMs;
    // The wall the run started with, minus the real time of the write: what is left of the margin for the rest of the test.
    const left = wall0 - mtime;
    assert.ok(left > LONGEST_FIXTURE_TEST_MS, `the writer's real mtime is ${Math.round(left / 1_000)} s behind the virtual wall at the start; a test may run ${LONGEST_FIXTURE_TEST_MS / 60_000} min`);
  });
});
