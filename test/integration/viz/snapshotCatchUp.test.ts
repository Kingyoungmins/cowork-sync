// Plan 8a final review B1 (12 §3.9.2, §3.10.5, §3.10.6; VIZ-34): a laptop that wakes to a big catch-up on a long window gets one
// room_snapshot — the scene at the tip, its newest cards and the ticks of the newly folded heights, the ticks that do not fit
// following as tick-only timeline parts with the snapshot's h1 — and never a reset while the scene alone fits in 64 KiB. A real
// RoomStore over a real board in a clone on a file:// remote, its deltas sent through pollSinkFor and the StreamHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorldApi, pollSinkFor } from '../../../src/viz/server/api.js';
import { createHandleTable } from '../../../src/viz/server/project.js';
import { SSE_MAX_BYTES, StreamHub, type SseSink } from '../../../src/viz/server/stream.js';
import type { StreamPayload, Tick } from '../../../src/viz/server/viewModel.js';
import { BoardWriter } from '../../../tools/viz/boardWriter.js';
import { VirtualClock } from '../../sim/vclock.js';
import { makeRepoFixture } from '../../helpers/repoFixture.js';
import { gitRoom, pubs } from '../../helpers/vizStore.js';

interface Msg { id: number; event: string; data: StreamPayload; bytes: number; }

/** Every SSE message written to it, parsed (comment lines dropped). */
class RecordingSink implements SseSink {
  private text = '';
  write(chunk: string): boolean { this.text += chunk; return true; }
  end(): void {}
  onClose(): void {}
  messages(): Msg[] {
    const out: Msg[] = [];
    for (const block of this.text.split('\n\n')) {
      if (block === '' || block.startsWith(':')) continue;
      const lines = block.split('\n');
      const field = (k: string): string => lines.find((l) => l.startsWith(`${k}: `))!.slice(k.length + 2);
      out.push({ id: Number(field('id')), event: field('event'), data: JSON.parse(field('data')) as StreamPayload, bytes: Buffer.byteLength(`${block}\n\n`, 'utf8') });
    }
    return out;
  }
}

test('B1: a +2,000-height catch-up on a window of more than 3,000 ticks is one room_snapshot and tick-only timeline parts through pollSinkFor and the StreamHub, never a reset; the ticks it sends are the newly folded heights\' and append to the world\'s', { timeout: 300_000 }, async () => {
  const fx = await makeRepoFixture('viz-snapshot-catch-up');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'snapshot-catch-up' });
    await w.genesis('ann');
    await w.join('bob');
    await w.commitMany(pubs(1_300));                       // tip 1,301: the window (256, 1,301], two ticks per height
    const clock = new VirtualClock();
    const r = gitRoom(fx, w.ref, { clock });
    await r.store.init();
    const handles = createHandleTable();
    const hub = new StreamHub(clock);
    const api = createWorldApi({ stores: [r.store], handles, hub, clock, demo: false, captions: [] });
    const sink = pollSinkFor(api, hub, handles, clock);
    const world = await api.world();
    const page = new RecordingSink();
    hub.attach(page, String(world.cursor));
    // The page's own copy of the room's ticks: the world's, then every stream message's appended (client/main.ts).
    const held: Tick[] = [...world.rooms[0]!.ticks];

    /** One live tick after `n` new commits, sent through the poll sink: the messages it produced. */
    const catchUp = async (n: number, dir: string): Promise<{ before: number; after: number; msgs: Msg[] }> => {
      const before = r.store.snapshot().window.h1;
      await w.commitMany(pubs(n, dir));
      clock.advance(2_500);
      const t = await r.store.tick();
      assert.ok(t.delta !== null && t.delta.kind === 'snapshot', `${n} new commits: a snapshot delta`);
      const seen = page.messages().length;
      sink.delta(t.delta);
      const msgs = page.messages().slice(seen);
      for (const m of msgs) {
        assert.ok(m.bytes <= SSE_MAX_BYTES, `a message of ${m.bytes} bytes`);
        if (m.data.type === 'timeline' || m.data.type === 'room_snapshot') held.push(...m.data.ticks);
      }
      return { before, after: r.store.snapshot().window.h1, msgs };
    };

    // A live extension of 500 heights (itself a snapshot) takes the window past 3,000 ticks.
    const ext = await catchUp(500, 'ext');
    assert.equal(ext.after, 1_801);
    assert.ok(!ext.msgs.some((m) => m.event === 'reset'), 'the extension: no reset');
    const before = r.store.snapshot().ticks.length;
    assert.ok(before >= 3_000, `the window holds ${before} ticks`);

    // The laptop wakes to 2,000 new commits.
    const wake = await catchUp(2_000, 'wake');
    assert.equal(wake.after, 3_801);
    const events = wake.msgs.map((m) => m.event).filter((e) => e !== 'layout');
    assert.ok(!events.includes('reset'), `no reset: ${events.join(', ')}`);
    assert.equal(events[0], 'room_snapshot', 'one room_snapshot first');
    assert.equal(events.filter((e) => e === 'room_snapshot').length, 1, 'exactly one room_snapshot');
    const snap = wake.msgs.find((m) => m.event === 'room_snapshot')!.data as Extract<StreamPayload, { type: 'room_snapshot' }>;
    assert.deepEqual(snap.window, { h0: 256, h1: 3_801 });
    assert.ok(snap.cards.length > 0, 'its newest cards');
    const parts = wake.msgs.filter((m) => m.event === 'timeline').map((m) => m.data as Extract<StreamPayload, { type: 'timeline' }>);
    assert.ok(parts.length >= 1, 'the ticks that do not fit follow as tick-only parts');
    for (const p of parts) {
      assert.deepEqual([p.h1, p.events, p.cards, p.characters, p.pets], [3_801, [], [], [], []], 'a tick-only part with the snapshot h1');
      assert.ok(p.ticks.length > 0);
    }
    const sent = [...snap.ticks, ...parts.flatMap((p) => p.ticks)];
    const all = r.store.snapshot().ticks;
    assert.deepEqual(sent, all.filter((k) => k.h > wake.before), 'the ticks of the newly folded heights, each once, in order');
    assert.equal(sent.length, 4_000);
    // The page appended them to what it held: the world's ticks of the whole window, as a fresh world serves them.
    assert.deepEqual(held, all, 'the page\'s ticks equal the window\'s');
  } finally {
    await fx.cleanup();
  }
});
