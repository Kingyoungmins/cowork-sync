// Plan 8a final review (Group A minor; 12 §3.3.6, §3.10.6; VIZ-13, R-V43): the room store's overlay keeps the last state of the closed
// set STATUS_STATES (glossary §14) when a status.json carries another one (a newer daemon, a hand edit), so the projection serves '?'
// only before any valid state, never in place of a known light. A RoomStore over an in-memory gitdir and a source with no board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { FoldState } from '../../../src/board/fold.js';
import { STATUS_STATES } from '../../../src/viz/i18n/codes.js';
import type { Frame } from '../../../src/viz/model/frame.js';
import { createHandleTable, projectOverlay } from '../../../src/viz/server/project.js';
import { RoomStore } from '../../../src/viz/server/store.js';
import { nullVizLog } from '../../../src/viz/server/vizLog.js';
import { fsBoundedReader } from '../../../src/viz/source/boundedRead.js';
import type { RoomSource, RoomSpec } from '../../../src/viz/source/roomSource.js';
import { VirtualClock } from '../../sim/vclock.js';
import { memFs, statusBytes, type MemFile } from '../../helpers/vizStatus.js';

const GITDIR = join('/', 'work', 'repo', '.git');
const STATUS = join(GITDIR, 'cowork', 'status.json');
const HEARTBEAT = 1_000_000;

/** A git room whose board does not exist yet: no tip, never changed (the overlay is read every tick all the same). */
const NO_BOARD: RoomSource = {
  kind: 'git',
  tip: async () => null,
  changed: async () => false,
  advance: async () => ({ kind: 'none' }),
  startAt: async (): Promise<FoldState> => { throw new Error('no board'); },
  frames: async function* (): AsyncIterable<Frame> { /* no frames */ },
};

test('the overlay keeps the last state of STATUS_STATES when status.json carries another; \'?\' is served only before any valid state (VIZ-13, R-V43)', async () => {
  const files = new Map<string, MemFile>([[GITDIR, { data: Buffer.alloc(0), mtimeNs: 1n, kind: 'dir' }]]);
  let mtime = 1n;
  const put = (state: string): void => {
    files.set(STATUS, { data: statusBytes({ state, heartbeat_mono_ms: HEARTBEAT }), mtimeNs: (mtime += 1_000_000n) });
  };
  const fs = memFs(files);
  const clock = new VirtualClock();
  const spec: RoomSpec = { id: 'r00000000', kind: 'git', label: 'repo', branch: 'main', gitDir: GITDIR, boardRef: 'refs/cowork-remote/main/board', canonicalRoot: null };
  const store = new RoomStore(spec, NO_BOARD, {
    clock, fs, reader: fsBoundedReader(fs), log: nullVizLog, viewerVersion: '0.0.0', machineMonoMs: () => HEARTBEAT + 1,
  });
  const handles = createHandleTable();
  const served = (): string | undefined => projectOverlay(store.snapshot().overlay, handles)?.state;
  assert.ok(!STATUS_STATES.has('quantum') && !STATUS_STATES.has('weird'));

  // Before any valid state: the out-of-set value is served as '?'.
  put('weird');
  await store.init();
  assert.equal(served(), '?', 'no valid state yet: ?');
  // A valid state is the light.
  put('degraded');
  clock.advance(2_500);
  await store.tick();
  assert.equal(served(), 'degraded');
  // Another out-of-set state keeps the last valid one (it used to be served as '?').
  put('quantum');
  clock.advance(2_500);
  await store.tick();
  assert.equal(store.snapshot().overlay?.state, 'degraded', 'the store keeps the last in-set state');
  assert.equal(served(), 'degraded', 'served: the last valid light, not ?');
  // The next valid state replaces it.
  put('ok');
  clock.advance(2_500);
  const t = await store.tick();
  assert.equal(t.overlay?.state, 'ok', 'a changed overlay is reported');
  assert.equal(served(), 'ok');
});
