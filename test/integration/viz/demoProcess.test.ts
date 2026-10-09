// Plan 8a Task 15: a demo run of the viewer process (12 §3.9.3; VIZ-06, VIZ-27; S17). `--demo` (the bundled log) and
// `--demo=<file>` fold the demo log after the ready line and serve it with the demo flag, no overlay and the captions on their
// rooms; the run starts no process at all (no git, no owner probe here: the probe is the test's), never builds a git runner,
// reads no file but viz.js, the demo file, the data directory (SEC-20) and its log directory, and accepts no --git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseServeArgv } from '../../../src/viz/main.js';
import type { BoundedReader } from '../../../src/viz/source/boundedRead.js';
import { realBoundedReader } from '../../../src/viz/source/boundedRead.js';
import { demoRoomId } from '../../../src/viz/source/demo.js';
import { VirtualClock } from '../../sim/vclock.js';
import { writeFileSync } from 'node:fs';
import { programsStartedBy } from '../../helpers/vizCli.js';
import { captionLine, demoBuffer, headerLine, storyLines } from '../../helpers/vizDemo.js';
import { spyFs, type FsCall } from '../../helpers/vizFs.js';
import { openStream } from '../../helpers/vizHttp.js';
import { apiGet, startTestViewer, viewerTemp, worldOf } from '../../helpers/vizViewer.js';

const within = (p: string, dir: string): boolean => p === dir || p.startsWith(`${dir}/`) || p.startsWith(`${dir}\\`);

test('T-VIZ-demo-format (process): a demo run makes 0 git spawns and touches no file but viz.js, the demo file, the data directory\'s SEC-20 check and its log directory', { timeout: 60_000 }, async () => {
  const root = viewerTemp('demo-process');
  const file = join(root, 'two rooms.jsonl');
  writeFileSync(file, demoBuffer([
    headerLine([{ room: 'a', name: 'shop-app', branch: 'main' }, { room: 'b', name: 'docs-site', branch: 'trunk' }]),
    ...storyLines('a'), ...storyLines('b'),
    captionLine('a', 2, { code: 'UI_VIZ_DEMO_CAPTION_1' }), captionLine('b', 4, { text: 'Two rooms, one viewer.' }),
  ]));
  for (const demo of [true, file] as const) {
    const calls: FsCall[] = [];
    const reads: string[] = [];
    const reader: BoundedReader = { read: (p, max) => { reads.push(p); return realBoundedReader.read(p, max); } };
    let runners = 0;
    const clock = new VirtualClock();
    const { result, started } = await programsStartedBy(async () => {
      const v = await startTestViewer({ demo }, {
        clock, fs: spyFs(calls), reader,
        gitRunner: () => { runners++; throw new Error('a demo run builds no git runner'); },
      });
      try {
        const s = await v.session();
        const world = await worldOf(v.port, s);
        const st = await openStream(v.port, { 'x-cowork-session': s });
        for (const r of world.rooms) {
          const page = await apiGet(v.port, s, `/api/v1/rooms/${r.room_id}/timeline?from=0&to=${r.window.h1}`);
          assert.equal(page.status, 200);
        }
        assert.equal((await apiGet(v.port, s, '/api/v1/strings?lang=en')).status, 200);
        for (let i = 0; i < 4; i++) {
          clock.advance(2_500);
          await delay(50);
        }
        st.close();
        return { world, dataDir: v.dataDir, selfPath: v.selfPath, stop: () => v.stop('VIZ_EXIT_SIGNAL') };
      } catch (e) {
        await v.stop('VIZ_EXIT_SIGNAL');
        throw e;
      }
    });
    await result.stop();
    const { world, dataDir, selfPath } = result;

    // The demo world: the demo flag, no overlay, header rooms in order, captions on their rooms.
    assert.equal(world.demo, true);
    assert.ok(world.rooms.every((r) => r.overlay === null));
    if (demo === file) {
      assert.deepEqual(world.rooms.map((r) => [r.label, r.branch, r.window.h1]), [['shop-app', 'main', 5], ['docs-site', 'trunk', 5]]);
      const ids = world.rooms.map((r) => r.room_id);
      assert.deepEqual(world.captions, [
        { room_id: ids[0], height: 2, code: 'UI_VIZ_DEMO_CAPTION_1', text: null },
        { room_id: ids[1], height: 4, code: null, text: 'Two rooms, one viewer.' },
      ]);
      assert.notEqual(ids[0], demoRoomId(new Uint8Array(32), 'a'), 'room ids are salted per viewer');
    } else {
      assert.deepEqual(world.rooms.map((r) => r.label), ['shop-app'], 'the bundled storyboard');
    }

    // Nothing started, no git runner built.
    assert.deepEqual(started, [], 'no process of any kind');
    assert.equal(runners, 0);
    // Files: viz.js, the demo file (through the BoundedReader only), the data directory itself and its log directory.
    assert.deepEqual(reads, demo === true ? [] : [file]);
    const logDir = join(dataDir, 'log');
    for (const c of calls) {
      for (const p of c.paths) {
        const ok = p === selfPath || p === dataDir || within(p, logDir);
        assert.ok(ok, `${c.op} ${p}`);
      }
    }
    assert.ok(calls.some((c) => c.op === 'readFile' && c.paths.includes(selfPath)), 'viz.js is hashed');
  }

  // No --git with a demo, whatever the order.
  const base = ['serve', '--data-dir', root, '--lang', 'en', '--sha256', 'ab'.repeat(32)];
  assert.equal(parseServeArgv([...base, '--demo', '--git', join(root, 'git')]), null);
  assert.equal(parseServeArgv([...base, '--git', join(root, 'git'), `--demo=${file}`]), null);
});
