// Plan 8a Task 15: T-VIZ-contention (12 §3.3.2, §3.12 "Effect on daemons", §7; VIZ-07, VIZ-41; Review Focus 4; glossary §26.1 W3).
// A slow suite on the Windows legs (COWORK_VIZ_SLOW=1, viz-slow.yml's Windows job of its own; at least 10 min of writer sleep alone,
// 2 phases × 3,000 writes × 100 ms, and 1,476 s measured on a loaded PC; the timeout is 35 min), where a rename over a file another process holds
// open fails: a daemon fixture replaces <gitdir>/cowork/status.json by temp + rename every 100 ms (3,000 writes) and fetches the
// board ref 1,000 times (each fetch moves it one commit forward), first with no viewer (the control), then while a viewer polls
// the room on the real clock with a page's stream open. The viewer holds no handle (a stat, one open-read-close, a cat-file process per batch), so the
// daemon sees no more rename or ref-update failures with it than without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realClock } from '../../../src/ports/clock.js';
import { openStream } from '../../helpers/vizHttp.js';
import { statusBytes } from '../../helpers/vizStatus.js';
import { pubs } from '../../helpers/vizStore.js';
import { fetchedRoomsFixture, startTestViewer, worldOf } from '../../helpers/vizViewer.js';

const SLOW = process.env['COWORK_VIZ_SLOW'] === '1';
const WRITES = 3_000, WRITE_MS = 100, FETCHES = 1_000;

interface Failures { renames: number; fetches: number; codes: string[]; }

test('T-VIZ-contention (Windows legs): a writer replacing status.json by temp + rename every 100 ms for 3,000 writes and a daemon fixture fetching the board ref 1,000 times see zero rename or ref-update failures beyond the no-viewer control', {
  skip: !SLOW ? 'slow suite: set COWORK_VIZ_SLOW=1 (viz-slow.yml)' : process.platform !== 'win32' ? 'Windows legs only (W3: a rename over an open file fails there)' : false,
  timeout: 2_100_000,
}, async (t) => {
  const f = await fetchedRoomsFixture('viz-contention', ['main']);
  try {
    const room = f.rooms[0]!;
    const gitDir = room.fx.paths.gitDir;
    // The writers' chain the fetches walk: 2 × FETCHES commits ahead, pushed one step at a time.
    await room.writer.commitMany(pubs(2 * FETCHES, 'chain'));
    const chain = (await f.fx.repo.run(['rev-list', '--first-parent', '--reverse', room.writer.ref])).stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
    const e = room.writer.ref.split('/')[2]!;
    // The remote holds the whole chain (under a ref of its own), so its board ref can move one commit at a time.
    const pushed = await f.fx.runner.run(['push', '-q', f.fx.remote.url, `+${room.writer.ref}:refs/cowork-chain/${e}`], { class: 'network', cwd: f.fx.paths.workTree });
    assert.equal(pushed.code, 0, pushed.stderr.toString('utf8'));
    let step = chain.length - 2 * FETCHES;

    /** One daemon iteration's fetch: the remote's ref one commit forward, then a fetch into the viewer's clone (a fast-forward). */
    const fetchOnce = async (fail: Failures): Promise<void> => {
      const oid = chain[step++]!;
      const moved = await f.fx.runner.run(['update-ref', `refs/cowork/${e}/board`, oid], { class: 'local', cwd: f.fx.remote.dir });
      if (moved.code !== 0) throw new Error(`the fixture's remote ref did not move: ${moved.stderr.toString('utf8')}`);
      const r = await f.fx.runner.run(['fetch', '-q', f.fx.remote.url, `+refs/cowork/${e}/board:${room.writer.ref}`], { class: 'network', cwd: room.dir });
      if (r.code !== 0) {
        fail.fetches++;
        fail.codes.push(`fetch ${r.code}: ${r.stderr.toString('utf8').trim().slice(0, 120)}`);
      }
    };
    /** The daemon's status.json replace: write a temp file, rename it over status.json (W3). */
    const writeOnce = (i: number, fail: Failures): void => {
      const tmp = join(gitDir, 'cowork', `status.json.tmp`);
      writeFileSync(tmp, statusBytes({ heartbeat_mono_ms: 1_000_000 + i, pending: { cs_ready: i % 7, cs_open: 0, holds_active: 0, holds_local_only: 0, incoming: 0, not_converged: [] } }));
      try {
        renameSync(tmp, join(gitDir, 'cowork', 'status.json'));
      } catch (err) {
        fail.renames++;
        fail.codes.push(`rename ${(err as NodeJS.ErrnoException).code ?? '?'}`);
      }
    };
    const daemon = async (writes: number, fetches: number): Promise<Failures> => {
      const fail: Failures = { renames: 0, fetches: 0, codes: [] };
      const writer = (async () => {
        for (let i = 0; i < writes; i++) {
          writeOnce(i, fail);
          await new Promise((r) => setTimeout(r, WRITE_MS));
        }
      })();
      const fetcher = (async () => {
        for (let i = 0; i < fetches; i++) await fetchOnce(fail);
      })();
      await Promise.all([writer, fetcher]);
      return fail;
    };

    mkdirSync(join(gitDir, 'cowork'), { recursive: true });
    writeOnce(0, { renames: 0, fetches: 0, codes: [] });
    const control = await daemon(WRITES, FETCHES);
    t.diagnostic(`control (no viewer): ${control.renames} rename and ${control.fetches} fetch failures ${control.codes.slice(0, 5).join('; ')}`);
    // The chain has FETCHES more steps for the viewer's run.
    const v = await startTestViewer({ repos: [room.dir] }, { clock: realClock });
    let withViewer: Failures;
    try {
      const s = await v.session();
      assert.equal((await worldOf(v.port, s)).rooms.length, 1);
      // A page is open the whole time (its stream keeps the viewer alive past the 10 min idle exit, as a real tab does).
      const st = await openStream(v.port, { 'x-cowork-session': s });
      assert.equal(st.status, 200);
      try {
        withViewer = await daemon(WRITES, FETCHES);
        // The viewer kept up: its window reached the last fetched commit.
        const world = await worldOf(v.port, s);
        t.diagnostic(`viewer at height ${world.rooms[0]!.window.h1}`);
      } finally {
        st.close();
        await st.ended;
      }
    } finally {
      await v.stop('VIZ_EXIT_SIGNAL');
    }
    t.diagnostic(`with the viewer: ${withViewer.renames} rename and ${withViewer.fetches} fetch failures ${withViewer.codes.slice(0, 5).join('; ')}`);
    assert.ok(withViewer.renames <= control.renames, `rename failures ${withViewer.renames} > control ${control.renames}`);
    assert.ok(withViewer.fetches <= control.fetches, `ref-update failures ${withViewer.fetches} > control ${control.fetches}`);
  } finally {
    await f.cleanup();
  }
});
