// INV-CLOCK for the viewer (Plan 8a Task 7; 12 §3.3.5 "Seed", INV-VIZ-DET, INV-CLOCK; V10): the order is board position and
// no commit date is ever read, so one script written with different commit dates — ascending, shuffled, reversed and in
// 1970 — gives byte-identical timelines through the git source. Real git, one clone, one board per branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { realClock } from '../../../src/ports/clock.js';
import { realFs } from '../../../src/ports/fs.js';
import { ZERO_PEER, type Frame } from '../../../src/viz/model/frame.js';
import { buildTimeline, serializeTimeline } from '../../../src/viz/model/timeline.js';
import { GitRoomSource } from '../../../src/viz/source/git.js';
import { BoardWriter, type ScriptCommit } from '../../../tools/viz/boardWriter.js';
import { FIXTURE_WALL_MS, makeRepoFixture } from '../../helpers/repoFixture.js';
import { many, SEAT } from '../../helpers/vizBatchRead.js';
import { spiedVizGit, vizRunner } from '../../helpers/vizSource.js';

const SCRIPT: ScriptCommit[] = [
  { writer: 'ann', cs: [{ paths: ['src/cart.ts', 'src/price.ts'] }] },
  { writer: 'bob', cs: [{ paths: ['test/cart.test.ts'] }, { paths: ['README.md'], checks: 'pass' }] },
  { writer: 'ann', ops: [{ type: 'seat_start', seat_id: SEAT, permission_mode: 'default' }] },
  { writer: 'ann', cs: [{ seat: SEAT, origin: 'prompt', paths: ['src/cart.ts'] }] },
  { writer: 'bob', ops: [{ type: 'event', cid: '', kind: 'freeze', refs: [], reason_code: 'EPOCH' }] },
  { writer: 'bob', ops: [{ type: 'event', cid: '', kind: 'unfreeze', refs: [], reason_code: 'EPOCH' }] },
  { writer: 'ann', ops: [{ type: 'event', cid: '', kind: 'health', refs: [], reason_code: 'HOST_THROTTLED' }] },
  { writer: 'bob', code: 'base_move' },
  { writer: 'bob', cs: [{ paths: many(300, 'big') }] },
  { writer: 'ann', ops: [{ type: 'seat_end', seat_id: SEAT, permission_mode: 'default' }] },
  { writer: 'ann' },
];

/** wallMs sources: every call a new date, in the given order of seconds. */
const DATES: Array<[string, (k: number) => number]> = [
  ['ascending', (k) => FIXTURE_WALL_MS + k * 1_000],
  ['shuffled', (k) => FIXTURE_WALL_MS + ((k * 7_919) % 10_007) * 1_000],   // a permutation of 0…10,006 seconds
  ['reversed', (k) => FIXTURE_WALL_MS + (100_000 - k) * 1_000],
  ['1970', (k) => (1 + k) * 1_000],
];

test('T-VIZ-clock: boards written with commit dates shuffled, reversed and set to 1970 give byte-identical timelines', async () => {
  const fx = await makeRepoFixture('viz-clock');
  try {
    const dataDir = join(fx.root, 'viz data');
    const runner = vizRunner(dataDir);
    const texts: string[] = [];
    const tips: string[] = [];
    for (const [name, at] of DATES) {
      const branch = `clock-${name}`;
      const r = await fx.repo.run(['branch', branch, 'main']);
      assert.equal(r.code, 0);
      let k = 0;
      const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch, seed: 'viz-clock', wallMs: () => at(k++) });
      await w.genesis('ann');
      await w.join('bob');
      for (const c of SCRIPT.slice(0, 3)) await w.commit(c);
      await w.commitMany(SCRIPT.slice(3));
      await w.join('bob', { newEpoch: true });
      await w.commit({ writer: 'bob', cs: [{ paths: ['src/after.ts'] }] });
      tips.push(w.tip().oid);
      if (name === '1970') {
        const raw = (await fx.repo.run(['cat-file', 'commit', w.tip().oid])).stdout.toString('utf8');
        assert.match(raw, /^committer .* ([0-9]+) \+0000$/m);
        assert.ok(Number(/^committer .* ([0-9]+) \+0000$/m.exec(raw)![1]) < 86_400, 'a 1970 commit date');
      }
      const sg = spiedVizGit(runner, fx.paths.gitDir, dataDir);
      const src = new GitRoomSource({ id: 'r00000000', kind: 'git', label: 'x', branch, gitDir: fx.paths.gitDir, boardRef: w.ref, canonicalRoot: null }, sg.git, { fs: realFs, clock: realClock });
      const tip = (await src.tip())!;
      const start = await src.startAt(0);
      const frames: Frame[] = [];
      for await (const f of src.frames(start, 0, tip.height, ZERO_PEER)) frames.push(f);
      texts.push(serializeTimeline(buildTimeline({ h0: 0, start, frames })));
    }
    assert.equal(new Set(tips).size, DATES.length, 'the dates made different commits');
    for (let i = 1; i < texts.length; i++) assert.equal(texts[i], texts[0], `${DATES[i]![0]} dates: the same timeline`);
    assert.ok(texts[0]!.length > 1_000);
  } finally {
    await fx.cleanup();
  }
});
