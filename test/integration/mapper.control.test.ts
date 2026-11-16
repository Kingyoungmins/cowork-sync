// FoldMapper/1 against real git (04-regions §3.4 measurements, §3.2 item 5; T-REG-03, R1-064; ruling R4-17): an exact-equality diff of the
// BOM+CRLF and LF forms of the 5,960-row file counts every row changed, where FoldMapper/1's equality gives zero hunks; and the hunks
// job through threadWorkers equals the direct function. Real git on a temp root with a space and Hangul in the path; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { realClock } from '../../src/ports/clock.js';
import { lineArray } from '../../src/regions/lines.js';
import { hunks } from '../../src/regions/mapper.js';
import { threadWorkers } from '../../src/regions/pool.js';
import { RC_TOUCH_R2, fixture } from '../helpers/regionFixtures.js';
import { testRegionRuntime, testWorkerPath } from '../helpers/regionRuntime.js';
import { makeTempRoot, testRunner } from '../helpers/tmp.js';

test('exact-equality control: real git counts 5,960 changed lines', async () => {
  const wt = fixture('big_wt.py');
  const lf = fixture('big_lf.py');
  const { root, cleanup } = await makeTempRoot('mapper-control');
  try {
    const a = join(root, 'big_wt.py');
    const b = join(root, 'big_lf.py');
    await writeFile(a, wt);
    await writeFile(b, lf);
    // Exact equality: no EOL conversion and no whitespace option (git's defaults pinned so no user config leaks in).
    const r = await testRunner().run(['diff', '--no-index', '--numstat', '--no-color', a, b], {
      class: 'local',
      cwd: root,
      config: { 'core.autocrlf': 'false', 'core.eol': 'lf', 'diff.algorithm': 'myers' },
    });
    assert.equal(r.code, 1, `git diff --no-index exits 1 on a difference: ${r.stderr.toString('utf8')}`);
    assert.match(r.stdout.toString('utf8'), /^5960\t5960\t/);
  } finally {
    await cleanup();
  }
  // FoldMapper/1's step 1 equality: the two forms give zero hunks.
  assert.deepEqual(hunks(lineArray(wt), lineArray(lf)), []);
});

test('the hunks job through threadWorkers equals the direct function on the same-tail pair', async () => {
  const row = RC_TOUCH_R2.find((r) => r.name === 'py_same_tail_def_after');
  assert.ok(row !== undefined);
  const from = lineArray(fixture(row.base));
  const to = lineArray(fixture(row.post));
  const pool = await threadWorkers(await testRegionRuntime(), { threads: 2, workerPath: await testWorkerPath(), clock: realClock });
  try {
    const direct = hunks(from, to);
    assert.deepEqual(direct, [{ aLo: 5342, aHi: 5341, bLo: 5342, bHi: 5350 }]);
    assert.deepEqual(await pool.run({ kind: 'hunks', from, to }, 'fg', null), { kind: 'ok', value: direct });
    assert.deepEqual(await pool.run({ kind: 'hunks', from, to }, 'bg', null), { kind: 'ok', value: direct });
  } finally {
    await pool.close();
  }
});
