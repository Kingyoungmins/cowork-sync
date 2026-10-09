// Plan 8a Task 15: the server-side failure signs end to end (12 §6, §3.3.6, §7 T-VIZ-failure-signs and T-VIZ-overlay; VIZ-13,
// VIZ-14, VIZ-15, VIZ-42). Each §6 row the viewer process detects reaches the world or the stream as its code (or, for the overlay
// rows the page labels, as the overlay fields its label comes from): a down daemon, an unreadable status.json, a missing board
// object, a gone gitdir, an incident, version skew, a newer protocol, a checkpoint mismatch, a demo run and a stopped viewer. The
// page-side signs (reconnecting, stopped after the retries) are Task 13's and Task 17's; the repos.json rows are Plan 8b's. And
// one room's overlay values never reach another room (F5).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOid, type Oid } from '../../../src/git/oid.js';
import type { RoomVM, StreamPayload, World } from '../../../src/viz/server/viewModel.js';
import { VirtualClock } from '../../sim/vclock.js';
import { hashRaw, mktree } from '../../helpers/vizBatchRead.js';
import { openStream, type OpenStream, type SseMessage } from '../../helpers/vizHttp.js';
import { deepFind, hideObject, pubs, writeStatus } from '../../helpers/vizStore.js';
import { gitRoomsFixture, startTestViewer, worldOf, type RoomClone, type RoomsFixture } from '../../helpers/vizViewer.js';

/** This PC's machine-wide monotonic clock as the overlay reads it (12 §3.3.6), moved by the test. */
const machine = { now: 50_000_000 };

/**
 * `n` board-only commits on the clone's board by one git fast-import, as a newer teammate build writes them: protocol.json with
 * proto 2 (the fold's protoMismatch) and a checkpoint/state.json this build never folds to (a PRO-28 mismatch at multiples of 256).
 */
async function newerTail(c: RoomClone, n: number): Promise<Oid> {
  const w = c.writer;
  const base = w.tip().oid;
  const fx = { repo: c.repo } as Parameters<typeof hashRaw>[0];
  const live = (await c.repo.readCommit(base)).parents[1]!;
  const ops = await hashRaw(fx, 'blob', Buffer.alloc(0));
  const protocol = await hashRaw(fx, 'blob', Buffer.from('{"G_s":5,"S_s":1.5,"budget":12,"proto":2,"regionSpec":"rs-1"}', 'utf8'));
  const state = await hashRaw(fx, 'blob', Buffer.from('{"v":2,"from":"a newer build"}\n', 'utf8'));
  const checkpoint = await mktree(fx, [['100644', 'state.json', state]]);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const msg = `newer ${i}\n`;
    parts.push(`commit ${w.ref}\nmark :${i + 1}\ncommitter F <f@cowork.invalid> 1700000000 +0000\ndata ${Buffer.byteLength(msg, 'utf8')}\n${msg}`);
    parts.push(`from ${i === 0 ? base : `:${i}`}\nmerge ${live}\ndeleteall\n`);
    parts.push(`M 100644 ${ops} ops.jsonl\nM 100644 ${protocol} protocol.json\nM 040000 ${checkpoint} checkpoint\n\n`);
  }
  parts.push(`get-mark :${n}\ndone\n`);
  const r = await c.repo.run(['fast-import', '--quiet', '--done'], { stdin: Buffer.from(parts.join(''), 'utf8') });
  return parseOid(r.stdout.toString('utf8').trim());
}

let f: RoomsFixture;
before(async () => {
  f = await gitRoomsFixture('viz-signs', 4);
  const [p1, p2, p3, p4] = f.clones as [RoomClone, RoomClone, RoomClone, RoomClone];
  await p1.writer.commitMany(pubs(10, 'a'));
  // p2: version skew; then a newer build's tail across the checkpoint height 256 (newer protocol, checkpoint mismatch).
  await p2.writer.commitMany(pubs(250, 'b'));
  await newerTail(p2, 10);
  // p3: a later commit's live commit will be missing from the clone (a partial clone; transports are disabled).
  await p3.writer.commitMany(pubs(8, 'c'));
  await p4.writer.commitMany(pubs(12, 'd'));
  // Overlays: p1 down (a heartbeat 3 loop periods + 1 ms old), p2 skewed, p3 and p4 fine.
  writeStatus(p1.paths.gitDir, { heartbeat_mono_ms: machine.now - 3 * 2_500 - 1, loop_period_ms: 2_500 });
  writeStatus(p2.paths.gitDir, { plugin_version: 'skewed-9.9.9', heartbeat_mono_ms: machine.now });
  writeStatus(p3.paths.gitDir, { heartbeat_mono_ms: machine.now });
  writeStatus(p4.paths.gitDir, { heartbeat_mono_ms: machine.now });
});
after(async () => { await f.cleanup(); });

const room = (m: SseMessage): string | undefined => (m.data as { room_id?: string } | null)?.room_id;

async function until(clock: VirtualClock, pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 16 && !pred(); i++) {
    clock.advance(2_500);
    for (let j = 0; j < 30 && !pred(); j++) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(pred(), what);
}

test('T-VIZ-failure-signs (server): down, unreadable, no board, gone, incident, version skew, newer protocol, checkpoint mismatch, demo banner and stopped each reach the world or the stream as their code', { timeout: 120_000 }, async () => {
  const [p1, p2, p3, p4] = f.clones as [RoomClone, RoomClone, RoomClone, RoomClone];
  let restore = (): void => {};
  const clock = new VirtualClock();
  const v = await startTestViewer({ repos: f.clones.map((c) => c.dir) }, { clock, machineMonoMs: () => machine.now });
  let st: OpenStream | null = null;
  try {
    const s = await v.session();
    const world: World = await worldOf(v.port, s);
    const by = new Map(world.rooms.map((r) => [r.label, r]));
    const r1 = by.get('p1')!, r2 = by.get('p2')!, r3 = by.get('p3')!, r4 = by.get('p4')!;
    // In the world: down (the overlay the page labels UI_VIZ_ROOM_DOWN), version skew, newer protocol, checkpoint mismatch.
    assert.equal(r1.overlay?.down, true);
    assert.deepEqual(r2.badges, ['UI_VIZ_VERSION_SKEW', 'UI_VIZ_NEWER_PROTOCOL', 'UI_VIZ_CHECKPOINT_MISMATCH']);
    assert.deepEqual([r1.badges, r3.badges, r4.badges], [[], [], []]);
    assert.equal(r3.window.h1, 9);
    st = await openStream(v.port, { 'x-cowork-session': s });
    const stream = st;
    const payloads = (type: StreamPayload['type'], id: string): StreamPayload[] =>
      stream.messages().filter((m) => m.event === type && room(m) === id).map((m) => m.data as StreamPayload);

    // No board: a commit whose live commit the clone lacks arrives → UI_VIZ_NO_BOARD, the room stays at its last folded scene.
    await p3.writer.commit({ writer: 'ann', cs: [{ paths: ['c/late.txt'] }] });
    restore = hideObject(p3.paths.gitDir, (await p3.repo.readCommit(p3.writer.tip().oid)).parents[1]!);
    await until(clock, () => payloads('room', r3.room_id).some((p) => p.type === 'room' && p.badges.includes('UI_VIZ_NO_BOARD')), 'no board on the stream');
    const nb = (await worldOf(v.port, s)).rooms.find((r) => r.label === 'p3')!;
    assert.deepEqual([nb.badges, nb.window.h1], [['UI_VIZ_NO_BOARD'], 9], 'the room stays at its last folded scene');

    // Unreadable: a status.json that does not parse → the overlay the page labels UI_VIZ_STATUS_UNREADABLE (never down from it).
    writeFileSync(join(p4.paths.gitDir, 'cowork', 'status.json'), '{"v":1, this is not json');
    // Incident: status.json state incident and a rewritten board → the room freezes with its badge.
    writeStatus(p1.paths.gitDir, { state: 'incident', heartbeat_mono_ms: machine.now });
    await p1.writer.rewrite(5);
    // Gone: p3's gitdir moves away.
    renameSync(p3.paths.gitDir, `${p3.paths.gitDir}-moved`);
    await until(clock, () =>
      payloads('overlay', r4.room_id).some((p) => p.type === 'overlay' && p.overlay.unreadable && !p.overlay.down)
      && payloads('room', r1.room_id).some((p) => p.type === 'room' && p.badges.includes('UI_VIZ_INCIDENT_FROZEN'))
      && payloads('room', r3.room_id).some((p) => p.type === 'room' && p.gone), 'unreadable, incident and gone on the stream');
    const again = await worldOf(v.port, s);
    const a = new Map(again.rooms.map((r) => [r.label, r]));
    assert.equal(a.get('p4')!.overlay?.unreadable, true);
    assert.ok(a.get('p1')!.badges.includes('UI_VIZ_INCIDENT_FROZEN'));
    assert.equal(a.get('p3')!.gone, true);
    assert.equal(a.get('p3')!.window.h1, 9, 'a gone room keeps its folded history');

    // Stopped: bye on the stream (the page shows UI_VIZ_STOPPED).
    await v.stop('VIZ_EXIT_SIGNAL');
    await st.waitFor((m) => m.event === 'bye', 10_000);
  } finally {
    st?.close();
    await v.stop('VIZ_EXIT_SIGNAL');
    if (existsSync(`${p3.paths.gitDir}-moved`)) renameSync(`${p3.paths.gitDir}-moved`, p3.paths.gitDir);
    restore();
  }

  // Demo: the world carries the demo flag (the page's UI_VIZ_DEMO_BANNER) and no overlay.
  const d = await startTestViewer({ demo: true });
  try {
    const w = await worldOf(d.port, await d.session());
    assert.equal(w.demo, true);
    assert.ok(w.rooms.every((r) => r.overlay === null));
  } finally {
    await d.stop('VIZ_EXIT_SIGNAL');
  }
});

test('T-VIZ-overlay (process): room B\'s RoomVM and stream payloads contain none of room A\'s overlay values', { timeout: 60_000 }, async () => {
  const [pa, pb] = f.clones as [RoomClone, RoomClone];
  const A = { holds: 7_771, incoming: 7_772, ready: 7_773, offline: 7_774 };
  const B = { holds: 8_881, incoming: 8_882, ready: 8_883, offline: 8_884 };
  const statusOf = (x: typeof A, extra: Record<string, unknown>): Record<string, unknown> => ({
    state: 'offline', last_fetch_age_ms: x.offline * 60_000, heartbeat_mono_ms: machine.now,
    pending: { cs_ready: x.ready, cs_open: 0, holds_active: x.holds, holds_local_only: 0, incoming: x.incoming, not_converged: [] }, ...extra,
  });
  writeStatus(pa.paths.gitDir, statusOf(A, { publish_pause: 'AUTH', freeze_reasons: ['PAUSED'] }));
  writeStatus(pb.paths.gitDir, statusOf(B, {}));
  const clock = new VirtualClock();
  const v = await startTestViewer({ repos: [pa.dir, pb.dir] }, { clock, machineMonoMs: () => machine.now });
  try {
    const s = await v.session();
    const st = await openStream(v.port, { 'x-cowork-session': s });
    const world = await worldOf(v.port, s);
    const [ra, rb] = world.rooms as [RoomVM, RoomVM];
    assert.deepEqual([ra.overlay?.holds, ra.overlay?.incoming, ra.overlay?.ready, ra.overlay?.offline_min], [A.holds, A.incoming, A.ready, A.offline]);
    assert.deepEqual([rb.overlay?.holds, rb.overlay?.incoming, rb.overlay?.ready, rb.overlay?.offline_min], [B.holds, B.incoming, B.ready, B.offline]);
    // New values in both rooms reach the stream as overlay payloads.
    const A2 = { holds: 7_781, incoming: 7_782, ready: 7_783, offline: 7_784 };
    const B2 = { holds: 8_891, incoming: 8_892, ready: 8_893, offline: 8_894 };
    writeStatus(pa.paths.gitDir, statusOf(A2, { publish_pause: 'AUTH', freeze_reasons: ['PAUSED'] }));
    writeStatus(pb.paths.gitDir, statusOf(B2, {}));
    await until(clock, () => st.messages().filter((m) => m.event === 'overlay').length >= 2, 'both overlays on the stream');
    const aNumbers = [...Object.values(A), ...Object.values(A2)];
    const bNumbers = [...Object.values(B), ...Object.values(B2)];
    const check = (where: string, v: unknown, mine: 'A' | 'B'): void => {
      const foreign = mine === 'A' ? bNumbers : aNumbers;
      const strings = mine === 'A' ? [] : ['AUTH', 'PAUSED'];
      assert.deepEqual(deepFind(v, strings, foreign), [], `${where}: none of the other room's overlay values`);
    };
    for (const w of [world, await worldOf(v.port, s)]) {
      check('room A', w.rooms[0], 'A');
      check('room B', w.rooms[1], 'B');
      // Room A's values appear only in its overlay.
      assert.deepEqual(deepFind({ ...w.rooms[0], overlay: null }, ['AUTH'], aNumbers), [], 'room A outside its overlay');
    }
    for (const m of st.messages().filter((x) => !x.comment)) {
      const id = room(m);
      if (id === undefined) continue;
      check(`stream ${m.event}`, m.data, id === ra.room_id ? 'A' : 'B');
      if (m.event !== 'overlay') assert.deepEqual(deepFind(m.data, ['AUTH'], [...aNumbers, ...bNumbers]), [], `stream ${m.event}`);
    }
    st.close();
  } finally {
    await v.stop('VIZ_EXIT_SIGNAL');
  }
});
