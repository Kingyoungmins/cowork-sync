// Plan 8a Task 18 step B1: T-VIZ-golden-sim (12 §7; R-V37; INV-VIZ-DET, VIZ-08, VIZ-27). Three SIM seeds of the real engine
// (Plan 2 Tasks 18–19: realEngine, the `edits` profile, the R-32 quiescence, as tools/sim/run-shard.ts runs them), each read at
// quiescence from SIM peer 0's clone — its fetched board ref refs/cowork-remote/main/board, as `view --repo <peer0>` reads it —
// through the viewer's git source and through the demo log tools/viz/export-demo.ts writes from the same ref. Both timelines are
// computed inside an Oracle.atQuiescence hook, because runSim deletes its temp root on success (V20); tools/viz/golden.ts's
// goldenSimTimelines runs them, the function `npm run viz:golden -- --update` writes the goldens with. A slow suite
// (COWORK_VIZ_SLOW=1, viz-slow.yml): six SIM runs of ≈ 1 min each on a Windows PC. The fast tests before it pin what
// `npm run viz:golden` does with the SIM set off Linux (12 §7: the SIM goldens are Linux artifacts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GOLDEN_SETS, GOLDEN_SIMS, goldenSimTimelines, keepSimTimeline, runGolden, SIM_GOLDENS, SIM_RESULTS_DIR, type GoldenIo, type GoldenSet } from '../../../tools/viz/golden.js';
import { makeTempRoot } from '../../helpers/tmp.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SLOW = process.env['COWORK_VIZ_SLOW'] === '1';

interface Serialized { events: Array<Record<string, unknown>>; layout: { homeOrder: string[] }; }

/** The output lines of a run. */
function sink(): GoldenIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

/** A one-file set, test/golden/viz/<name>.json = text, that counts the calls of files() (a SIM set's files() costs minutes). */
function stubSet(name: string, text: string, linuxOnly: boolean): GoldenSet & { calls: number } {
  const s: GoldenSet & { calls: number } = {
    name,
    calls: 0,
    files: async () => {
      s.calls++;
      return [{ path: `test/golden/viz/${name}.json`, text }];
    },
  };
  if (linuxOnly) s.linuxOnly = true;
  return s;
}

test('viz:golden: the SIM set is Linux-only (12 §7) — elsewhere compare mode skips it with a one-line notice and the other sets\' exit code, and --update refuses it with a non-zero exit while the other sets update as before; on Linux both modes run it', async () => {
  assert.equal(SIM_GOLDENS.linuxOnly, true, 'the SIM set is marked Linux-only');
  assert.ok(GOLDEN_SETS.includes(SIM_GOLDENS), 'npm run viz:golden still covers it');
  assert.deepEqual(GOLDEN_SETS.filter((s) => s.linuxOnly === true), [SIM_GOLDENS], 'the row and board goldens are compared and written on every OS');
  const { root, cleanup } = await makeTempRoot('viz-golden-linux-only');
  try {
    const file = (name: string): string => path.join(root, 'test', 'golden', 'viz', `${name}.json`);
    mkdirSync(path.dirname(file('plain')), { recursive: true });
    writeFileSync(file('plain'), 'plain\n');
    writeFileSync(file('sim'), 'linux sim\n');   // the Linux golden; this OS's SIM boards would give another text
    const notice = (os: string): string => `viz:golden: skipped the sim set on ${os}: SIM goldens are compared on Linux only (12 §7)`;
    const sim = stubSet('sim', 'win32 sim\n', true);

    // win32, compare: the SIM runs are not started, one notice, and the exit code is the other sets' (0 match, 1 differ).
    const cmp = sink();
    assert.equal(await runGolden([], { root, sets: [stubSet('plain', 'plain\n', false), sim], io: cmp, platform: 'win32' }), 0, cmp.errors.join('\n'));
    assert.deepEqual([cmp.lines, cmp.errors], [[notice('win32'), 'viz:golden: 1 golden files match'], []]);
    assert.equal(sim.calls, 0, 'compare mode on win32 does not generate the SIM set');
    const plain = stubSet('plain', 'plain changed\n', false);
    const cmpDiff = sink();
    assert.equal(await runGolden([], { root, sets: [plain, sim], io: cmpDiff, platform: 'win32' }), 1);
    assert.deepEqual(cmpDiff.lines, [notice('win32')]);
    assert.equal(cmpDiff.errors[0], 'viz:golden: test/golden/viz/plain.json differs at line 1 (1 of 1 golden files differ)');
    const mac = sink();
    assert.equal(await runGolden([], { root, sets: [stubSet('plain', 'plain\n', false), sim], io: mac, platform: 'darwin' }), 0);
    assert.deepEqual(mac.lines, [notice('darwin'), 'viz:golden: 1 golden files match']);
    assert.equal(sim.calls, 0, 'nor on darwin');

    // win32, --update: the SIM set is refused (non-zero exit, 12 §7 named) and its Linux golden untouched; the other set is written.
    const up = sink();
    assert.equal(await runGolden(['--update'], { root, sets: [plain, sim], io: up, platform: 'win32' }), 1);
    assert.deepEqual(up.lines, ['viz:golden: wrote test/golden/viz/plain.json', 'viz:golden: 1 written, 0 unchanged']);
    assert.deepEqual(up.errors, ['viz:golden: --update refuses the sim set on win32: SIM goldens are written on Linux only (12 §7)']);
    assert.equal(sim.calls, 0, '--update on win32 does not generate the SIM set');
    assert.equal(readFileSync(file('sim'), 'utf8'), 'linux sim\n', 'the Linux golden is not overwritten');
    assert.equal(readFileSync(file('plain'), 'utf8'), 'plain changed\n', 'the other set is written as before');

    // linux: both modes generate the SIM set; compare reports the stale golden, --update writes it and exits 0.
    const lcmp = sink();
    assert.equal(await runGolden([], { root, sets: [plain, sim], io: lcmp, platform: 'linux' }), 1);
    assert.deepEqual(lcmp.lines, []);
    assert.equal(lcmp.errors[0], 'viz:golden: test/golden/viz/sim.json differs at line 1 (1 of 2 golden files differ)');
    assert.equal(sim.calls, 1, 'compare mode on linux generates the SIM set');
    const lup = sink();
    assert.equal(await runGolden(['--update'], { root, sets: [plain, sim], io: lup, platform: 'linux' }), 0, lup.errors.join('\n'));
    assert.deepEqual([lup.lines, lup.errors], [['viz:golden: wrote test/golden/viz/sim.json', 'viz:golden: 1 written, 1 unchanged'], []]);
    assert.equal(sim.calls, 2, '--update on linux generates the SIM set');
    assert.equal(readFileSync(file('sim'), 'utf8'), 'win32 sim\n');
  } finally {
    await cleanup();
  }
});

test('the golden SIM test keeps each computed timeline in test-results/viz-golden-sim/ (git-ignored; CI uploads it): `${text}\\n`, exactly what --update writes, overwritten on every run, with the sha-256 of it and of the golden', async () => {
  assert.equal(SIM_RESULTS_DIR, 'test-results/viz-golden-sim');
  const ignored = readFileSync(path.join(REPO, '.gitignore'), 'utf8').split('\n');
  assert.ok(ignored.includes('test-results/'), '.gitignore ignores test-results/');
  const { root, cleanup } = await makeTempRoot('viz-golden-sim-results');
  try {
    const sha = (s: string): string => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
    const kept = path.join(root, 'test-results', 'viz-golden-sim', 'viz-golden-2.timeline.json');
    // No golden yet (and no results folder): the file is written, the golden's hash is null.
    assert.deepEqual(keepSimTimeline(root, 'viz-golden-2', '{"a":"한글"}'), { file: kept, sha256: sha('{"a":"한글"}\n'), goldenSha256: null });
    assert.equal(readFileSync(kept, 'utf8'), '{"a":"한글"}\n');
    // With a golden: its hash; a second run overwrites the kept file.
    mkdirSync(path.join(root, 'test', 'golden', 'viz'), { recursive: true });
    writeFileSync(path.join(root, 'test', 'golden', 'viz', 'viz-golden-2.timeline.json'), '{"a":1}\n');
    assert.deepEqual(keepSimTimeline(root, 'viz-golden-2', '{"a":1}'), { file: kept, sha256: sha('{"a":1}\n'), goldenSha256: sha('{"a":1}\n') });
    assert.ok(readFileSync(kept).equals(Buffer.from('{"a":1}\n', 'utf8')), 'LF, UTF-8 without BOM, the text --update would write');
  } finally {
    await cleanup();
  }
});

test('T-VIZ-golden-sim: SIM seeds viz-golden-1..3 (profile edits, 3 peers): the timeline read through git from peer 0\'s board after quiescence and the timeline of its exported demo log are byte-identical on every OS; a second run is byte-identical; on the Linux leg both equal test/golden/viz/viz-golden-<n>.timeline.json', {
  skip: SLOW ? false : 'slow suite: set COWORK_VIZ_SLOW=1 (viz-slow.yml)',
  // Six SIM runs: ≈ 7 min on an idle Windows PC, 12 min on a loaded one; 25 min leaves 5 of the golden-sim job's 30 for checkout
  // and npm ci.
  timeout: 1_500_000,
}, async (t) => {
  assert.deepEqual(GOLDEN_SIMS.map((s) => [s.n, s.seed]), [[1, 'viz-golden-1'], [2, 'viz-golden-2'], [3, 'viz-golden-3']]);
  for (const { n, seed } of GOLDEN_SIMS) {
    const first = await goldenSimTimelines(n);
    // Kept before any assertion, as --update would write it: CI uploads test-results/viz-golden-sim/ even when this test fails,
    // so a Linux golden can be taken from a run (12 §7).
    const kept = keepSimTimeline(REPO, seed, first.git.text);
    t.diagnostic(`${seed}: sha-256 computed ${kept.sha256}, golden ${kept.goldenSha256 ?? 'missing'} (kept in ${SIM_RESULTS_DIR}/${seed}.timeline.json)`);
    // The room: peer 0's clone lists exactly one board ref under refs/cowork-remote/, the one read — what `view --repo <peer0>`
    // would admit without status.json.
    assert.deepEqual(first.boardRefsListed, ['refs/cowork-remote/main/board'], `${seed}: the board refs of peer 0's clone`);
    // The board read is the final one: no peer attempted a push in the extra loops after T* (R-32), peer 0's fetched board ref
    // names T*, and the remote's board names it too.
    assert.equal(first.quiescence.pushAttemptsInExtra, 0, `${seed}: push attempts after T*`);
    assert.equal(first.tip, first.quiescence.tStar, `${seed}: peer 0's board ref names T*`);
    assert.equal(first.remoteTip, first.tip, `${seed}: the remote's refs/cowork/main/board names it too`);
    assert.equal(first.demo.text, first.git.text, `${seed}: the git source's and the exported demo's timelines, byte for byte`);
    // A real engine's board has no R-V19 frame, so the two folds also count the same unknown ops.
    assert.deepEqual([first.git.malformed, first.git.shapeNull, first.git.unknown, first.git.heights], [0, 0, first.demo.unknown, first.demo.heights], `${seed}: R-V19 frames and counts`);
    // Not vacuous: three people entered and the change-sets they published reached file desks.
    const tl = JSON.parse(first.git.text) as Serialized;
    assert.equal(new Set(tl.layout.homeOrder).size, 3, `${seed}: three peers`);
    assert.equal(new Set(tl.events.filter((e) => e['kind'] === 'person_enter').map((e) => e['peer'])).size, 3, `${seed}: three people enter`);
    const published = tl.events.filter((e) => e['kind'] === 'publish' && Array.isArray(e['paths']) && e['paths'].length > 0);
    assert.ok(published.length > 0, `${seed}: ${published.length} publishes with paths`);
    t.diagnostic(`${seed}: ${first.git.heights} heights, ${tl.events.length} events, ${published.length} publishes, unknown ${first.git.unknown}`);

    const second = await goldenSimTimelines(n);
    assert.equal(second.tip, first.tip, `${seed}: a second run, the same board`);
    assert.equal(second.git.text, first.git.text, `${seed}: a second run, git source`);
    assert.equal(second.demo.text, first.demo.text, `${seed}: a second run, demo`);
    assert.ok(second.demoBytes.equals(first.demoBytes), `${seed}: a second run exports the same demo log`);

    const golden = readFileSync(path.join(REPO, 'test', 'golden', 'viz', `${seed}.timeline.json`));
    assert.ok(!golden.includes(0x0d) && !(golden[0] === 0xef && golden[1] === 0xbb && golden[2] === 0xbf), `${seed}: the golden is LF without BOM`);
    const same = golden.equals(Buffer.from(`${first.git.text}\n`, 'utf8'));
    // 12 §7: other legs compare with the golden only once TST-03 promises identical boards across OSes.
    if (process.platform === 'linux') assert.ok(same, `${seed}: equals test/golden/viz/${seed}.timeline.json (the computed text is kept in ${SIM_RESULTS_DIR}/, which CI uploads; npm run viz:golden -- --update on Linux, then review the diff)`);
    else t.diagnostic(`${seed}: the golden is compared on the Linux leg (here it is ${same ? 'equal' : 'different'})`);
  }
});
