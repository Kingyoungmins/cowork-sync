// Plan 8a Task 15: the viewer writes nothing of a repository (12 §3.2 item 7, §7 T-VIZ-readonly; INV-VIZ-READONLY, VIZ-07). A real
// clone with a 1,401-height board (so its window starts at 256 and "load earlier" has a segment to fold) and a status.json: its
// refs, `git count-objects -v`, the index bytes, and the listings with sizes and mtimes of the worktree and of <gitdir>/cowork/
// are the same before and after 10 virtual minutes of live polling, timeline seeks across the window and "load earlier".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { machineMonoMs } from '../../../src/ports/clock.js';
import { VirtualClock } from '../../sim/vclock.js';
import { openStream } from '../../helpers/vizHttp.js';
import { pubs, writeStatus } from '../../helpers/vizStore.js';
import { apiGet, gitRoomsFixture, startTestViewer, worldOf, type RoomClone } from '../../helpers/vizViewer.js';

/** Every entry under `dir` (not descending into `skip`), with its size and mtime in ns, sorted. */
function listing(dir: string, skip: readonly string[] = []): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (skip.includes(p)) continue;
      const s = statSync(p, { bigint: true });
      out.push(`${relative(dir, p)} ${e.isDirectory() ? 'dir' : s.size} ${s.mtimeNs}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

async function snapshot(c: RoomClone): Promise<Record<string, unknown>> {
  const git = async (args: string[]): Promise<string> => (await c.repo.run(args)).stdout.toString('utf8');
  return {
    refs: await git(['for-each-ref', '--format=%(objectname) %(refname)']),
    objects: await git(['count-objects', '-v']),
    index: readFileSync(join(c.paths.gitDir, 'index')).toString('base64'),
    worktree: listing(c.dir, [c.paths.gitDir]),
    cowork: listing(join(c.paths.gitDir, 'cowork')),
  };
}

test('T-VIZ-readonly: refs, count-objects -v, index bytes, worktree and <gitdir>/cowork/ listings and mtimes are identical before and after 10 virtual minutes of polling, seeks and load earlier', { timeout: 120_000 }, async () => {
  const f = await gitRoomsFixture('viz-readonly', 1);
  try {
    const c = f.clones[0]!;
    await c.writer.commitMany(pubs(1_400));
    writeStatus(c.paths.gitDir, { heartbeat_mono_ms: machineMonoMs() });
    const before = await snapshot(c);
    const clock = new VirtualClock();
    const v = await startTestViewer({ repos: [c.dir] }, { clock });
    try {
      const s = await v.session();
      const st = await openStream(v.port, { 'x-cowork-session': s });
      const room = (await worldOf(v.port, s)).rooms[0]!;
      assert.deepEqual(room.window, { h0: 256, h1: 1_401 });
      const page = async (from: number, to: number): Promise<void> => {
        assert.equal((await apiGet(v.port, s, `/api/v1/rooms/${room.room_id}/timeline?from=${from}&to=${to}`)).status, 200, `${from}…${to}`);
      };
      for (let minute = 1; minute <= 10; minute++) {
        clock.advance(60_000);
        await page(257 + 97 * minute, 257 + 97 * minute + 200);   // seeks across the window
        if (minute === 3) await page(0, 100);                      // "load earlier": one segment below h0
        if (minute === 6) await page(5, 60);                       // a seek into it
        await new Promise((r) => setTimeout(r, 1_200));
      }
      st.close();
    } finally {
      await v.stop('VIZ_EXIT_SIGNAL');
    }
    assert.deepEqual(await snapshot(c), before);
  } finally {
    await f.cleanup();
  }
});
