// The local overlay (Plan 8a Task 7; 12 §3.3.6, §3.4 "Local overlay", §6; VIZ-13; rulings R-V24, R-V46; V18, F5): readStatus
// over an in-memory Fs through fsBoundedReader, overlayOf at given machine-monotonic times, youOf, and the proof that no
// overlay value reaches a serialized timeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { initialFoldState } from '../../../src/board/fold.js';
import { ZERO_PEER, type Frame } from '../../../src/viz/model/frame.js';
import { buildTimeline, serializeTimeline } from '../../../src/viz/model/timeline.js';
import { fsBoundedReader } from '../../../src/viz/source/boundedRead.js';
import { DemoRoomSource, parseDemoLog, type DemoLog } from '../../../src/viz/source/demo.js';
import { overlayOf, readStatus, youOf, type StatusRead } from '../../../src/viz/source/status.js';
import { CAPTION_CODES, DEMO_PROTOCOL, demoBuffer, headerLine, storyLines } from '../../helpers/vizDemo.js';
import { memFs, statusBytes, type MemFile } from '../../helpers/vizStatus.js';

const GITDIR = join('/', 'work', 'repo', '.git');
const STATUS = join(GITDIR, 'cowork', 'status.json');
const HEARTBEAT = 1_000_000;
const PERIOD = 2_500;

/** readStatus over an in-memory status.json (absent when `bytes` is null), each call with a new mtime. */
function harness(): { put(bytes: Buffer | null): void; read(prev: StatusRead | null): Promise<StatusRead> } {
  const files = new Map<string, MemFile>();
  const fs = memFs(files);
  let mtime = 1n;
  return {
    put(bytes) {
      if (bytes === null) files.delete(STATUS);
      else files.set(STATUS, { data: bytes, mtimeNs: (mtime += 1_000_000n) });
    },
    read: (prev) => readStatus(GITDIR, prev, { fs, reader: fsBoundedReader(fs) }),
  };
}

test('T-VIZ-overlay: each status state maps to its light; a heartbeat 3 loop periods + 1 ms old → down; a missing status.json → down (R-V24); a 2 MiB or unparseable file → unreadable with the previous values and never down; the offline age is last_fetch_age_ms + Δ machine mono in whole minutes', async () => {
  const h = harness();
  const fresh = HEARTBEAT + 1;
  // Every glossary §14 state is carried as the light; only `down` (the orderly exit's last write) is down by itself.
  for (const state of ['ok', 'degraded', 'offline', 'frozen', 'incident', 'paused', 'refused', 'down']) {
    h.put(statusBytes({ state, heartbeat_mono_ms: HEARTBEAT, loop_period_ms: PERIOD }));
    const o = overlayOf(await h.read(null), fresh, '0.0.0', null);
    assert.equal(o.state, state, `${state}: the light`);
    assert.equal(o.down, state === 'down', `${state}: down`);
    assert.equal(o.unreadable, false);
  }

  // The heartbeat: exactly 3 loop periods old is alive, 1 ms more is down (machine-monotonic, R-35).
  h.put(statusBytes({ state: 'ok', heartbeat_mono_ms: HEARTBEAT, loop_period_ms: PERIOD }));
  const ok = await h.read(null);
  assert.equal(overlayOf(ok, HEARTBEAT + 3 * PERIOD, '0.0.0', null).down, false, '3 loop periods old');
  assert.equal(overlayOf(ok, HEARTBEAT + 3 * PERIOD + 1, '0.0.0', null).down, true, '3 loop periods + 1 ms old');

  // A missing status.json is down for a --repo room (R-V24: the argument stands in for the live marker).
  h.put(null);
  const missing = await h.read(ok);
  assert.equal(missing.present, false);
  assert.equal(overlayOf(missing, fresh, '0.0.0', null).down, true, 'a missing status.json → down');
  assert.equal(overlayOf(await h.read(null), fresh, '0.0.0', null).down, true, 'missing from the start → down');

  // 2 MiB and unparseable files: unreadable, the previous values kept, never down — even long after the old heartbeat.
  const last = statusBytes({ state: 'degraded', heartbeat_mono_ms: HEARTBEAT, loop_period_ms: PERIOD, pending: { cs_ready: 3, cs_open: 0, holds_active: 2, holds_local_only: 0, incoming: 1, not_converged: [] } });
  for (const [label, bytes] of [['2 MiB', Buffer.alloc(2 * 1024 * 1024, 0x20)], ['unparseable', Buffer.from('{"v":1,"state":', 'utf8')], ['wrong schema', statusBytes({ state: 7 })], ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d])]] as const) {
    h.put(last);
    const prev = await h.read(null);
    h.put(bytes);
    const bad = await h.read(prev);
    assert.equal(bad.unreadable, true, `${label}: unreadable`);
    assert.deepEqual(bad.fields, prev.fields, `${label}: the previous values stay`);
    const o = overlayOf(bad, HEARTBEAT + 100 * PERIOD, '0.0.0', null);
    assert.deepEqual([o.unreadable, o.down, o.state, o.ready, o.holds, o.incoming], [true, false, 'degraded', 3, 2, 1], `${label}: never down, previous light and counts`);
  }

  // The offline age: last_fetch_age_ms + (machineMonoMs() − heartbeat_mono_ms), in whole minutes, only while offline.
  h.put(statusBytes({ state: 'offline', heartbeat_mono_ms: HEARTBEAT, loop_period_ms: PERIOD, last_fetch_age_ms: 90_000 }));
  const offline = await h.read(null);
  assert.equal(overlayOf(offline, HEARTBEAT + 5_000, '0.0.0', null).offlineMin, 1, '95 s → 1 min');
  assert.equal(overlayOf(offline, HEARTBEAT + 7_499, '0.0.0', null).offlineMin, 1, '97.499 s → 1 min');
  h.put(statusBytes({ state: 'offline', heartbeat_mono_ms: HEARTBEAT, loop_period_ms: 60_000, last_fetch_age_ms: 90_000 }));
  assert.equal(overlayOf(await h.read(null), HEARTBEAT + 45_000, '0.0.0', null).offlineMin, 2, '135 s → 2 min');
  h.put(statusBytes({ state: 'offline', heartbeat_mono_ms: HEARTBEAT, last_fetch_age_ms: null }));
  assert.equal(overlayOf(await h.read(null), fresh, '0.0.0', null).offlineMin, null, 'never fetched: no age');
  assert.equal(overlayOf(ok, fresh, '0.0.0', null).offlineMin, null, 'not offline: no age');

  // The rest of the overlay: freeze reasons, publish pause, counts, version skew.
  h.put(statusBytes({ state: 'frozen', freeze_reasons: ['EPOCH', 'MASS'], publish_pause: 'AUTH', plugin_version: '9.9.9', heartbeat_mono_ms: HEARTBEAT }));
  const frozen = overlayOf(await h.read(null), fresh, '0.0.0', null);
  assert.deepEqual([frozen.freezeReasons, frozen.publishPause, frozen.versionSkew], [['EPOCH', 'MASS'], 'AUTH', true]);
  assert.equal(overlayOf(ok, fresh, '0.0.0', null).versionSkew, false);
});

test('T-VIZ-overlay (reboot): a heartbeat ahead of this boot\'s machine-monotonic clock by more than one loop period → down, the light keeps the last state; an unreadable file still never goes down', async () => {
  const h = harness();
  // A daemon that was not restarted after a reboot: its last heartbeat was taken at the old boot's uptime (50 h), this
  // boot's clock reads 5 min. machineMonoMs restarts at boot on every OS (CLOCK_MONOTONIC, QPC, mach time).
  const oldUptime = 180_000_000;
  const now = 300_000;
  h.put(statusBytes({ state: 'ok', heartbeat_mono_ms: oldUptime, loop_period_ms: PERIOD }));
  const stale = await h.read(null);
  const o = overlayOf(stale, now, '0.0.0', null);
  assert.deepEqual([o.down, o.state, o.unreadable], [true, 'ok', false], 'a pre-reboot heartbeat is down; the light shows the last state');
  // The boundary: at most one loop period ahead is alive (rounding of either side), one ms more is down.
  h.put(statusBytes({ state: 'ok', heartbeat_mono_ms: now + PERIOD, loop_period_ms: PERIOD }));
  const edge = await h.read(null);
  assert.equal(overlayOf(edge, now, '0.0.0', null).down, false, 'one loop period ahead: alive');
  h.put(statusBytes({ state: 'ok', heartbeat_mono_ms: now + PERIOD + 1, loop_period_ms: PERIOD }));
  assert.equal(overlayOf(await h.read(null), now, '0.0.0', null).down, true, 'one loop period + 1 ms ahead: down');
  // The offline age never goes negative across a reboot.
  h.put(statusBytes({ state: 'offline', heartbeat_mono_ms: oldUptime, loop_period_ms: PERIOD, last_fetch_age_ms: 120_000 }));
  const off = overlayOf(await h.read(null), now, '0.0.0', null);
  assert.deepEqual([off.down, off.offlineMin], [true, 2]);
  // An unreadable file keeps the previous values and never makes down, whatever its heartbeat.
  h.put(statusBytes({ state: 'ok', heartbeat_mono_ms: oldUptime, loop_period_ms: PERIOD }));
  const prev = await h.read(null);
  h.put(Buffer.from('{"v":1,', 'utf8'));
  const bad = await h.read(prev);
  assert.deepEqual([bad.unreadable, overlayOf(bad, now, '0.0.0', null).down], [true, false], 'unreadable: never down');
});

test('youOf: the peer file, else status.json\'s peer_id when it is 32 lowercase hex, else null', async () => {
  const h = harness();
  const fromStatus = 'c3'.repeat(16);
  const fromFile = 'd4'.repeat(16);
  h.put(statusBytes({ peer_id: fromStatus }));
  const s = await h.read(null);
  assert.equal(youOf(fromFile, s), fromFile, 'the peer file wins');
  assert.equal(youOf(null, s), fromStatus, 'a Plan 2 clone (no peer file): status.json peer_id (R-V46)');
  assert.equal(overlayOf(s, HEARTBEAT, '0.0.0', youOf(null, s)).you, fromStatus, 'a Plan 2 clone shows "you"');
  for (const bad of ['C3'.repeat(16), 'c3'.repeat(15), `${'c3'.repeat(16)}0`, 'g'.repeat(32), '']) {
    h.put(statusBytes({ peer_id: bad }));
    assert.equal(youOf(null, await h.read(null)), null, `peer_id ${JSON.stringify(bad)}`);
  }
  assert.equal(youOf(null, null), null, 'no status.json read');
  h.put(null);
  assert.equal(youOf(null, await h.read(null)), null, 'missing status.json');
});

/** The serialized timeline of a demo room's whole window, folded with `self`. */
async function timelineOf(log: DemoLog, self: string): Promise<string> {
  const room = log.rooms[0]!;
  const src = new DemoRoomSource(room, log.commits.get(room.room)!);
  const tip = (await src.tip())!;
  const start = await src.startAt(0);
  assert.deepEqual(start, initialFoldState(DEMO_PROTOCOL), 'startAt(0) is the state before B0');
  const frames: Frame[] = [];
  for await (const f of src.frames(start, 0, tip.height, self)) frames.push(f);
  return serializeTimeline(buildTimeline({ h0: 0, start, frames }));
}

test('T-VIZ-overlay: a serialized timeline holds no overlay value', async () => {
  const log = parseDemoLog(demoBuffer([headerLine([{ room: 'a', name: 'shop-app', branch: 'main' }]), ...storyLines('a')]), CAPTION_CODES);
  assert.ok('rooms' in log, JSON.stringify(log));
  const parsed = log;
  // Canary values in every overlay field a status.json carries.
  const canary = {
    state: 'degraded', freeze_reasons: ['CANARYREASON'], publish_pause: 'CANARYPAUSE', branch: 'canary-branch', peer_id: 'ce'.repeat(16),
    plugin_version: '7.7.7-canary', heartbeat_mono_ms: 4242424242, loop_period_ms: 4343, last_fetch_age_ms: 4444444,
    pending: { cs_ready: 9191, cs_open: 0, holds_active: 9292, holds_local_only: 0, incoming: 9393, not_converged: ['canary/path.ts'] },
  };
  const h = harness();
  h.put(statusBytes(canary));
  const s = await h.read(null);
  const overlay = overlayOf(s, 4242424242 + 1, '0.0.0', youOf(null, s));
  assert.equal(overlay.you, canary.peer_id);
  const withStatus = await timelineOf(parsed, youOf(null, s) ?? ZERO_PEER);
  h.put(null);
  const without = await timelineOf(parsed, youOf(null, await h.read(null)) ?? ZERO_PEER);
  assert.equal(withStatus, without, 'the same window with and without status.json serializes byte-identically');
  for (const v of ['CANARYREASON', 'CANARYPAUSE', 'canary-branch', canary.peer_id, '7.7.7-canary', '4242424242', '4343', '4444444', '9191', '9292', '9393', 'canary/path.ts']) {
    assert.ok(!withStatus.includes(v), `the timeline holds the overlay value ${v}`);
  }
});
