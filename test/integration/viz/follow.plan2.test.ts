// Plan 8a Task 19: T-VIZ-follow-plan2 (12 §3.8.1 "What shows when", §3.9.3; FEAT-F32-06, -07). The bundled Plan 2 storyboard demo,
// served by the viewer in-process and read as the page reads it — the world's head scene and layout, then the timeline pages of the
// whole window through the page's own RoomView, every id a handle (VIZ-26) — followed person by person over every height: Plan 2
// boards fold no claims or requests and have no pets, so only the header, last-shared, empty and not-here rows appear, and the
// last-shared row names the target desk and the height of that person's newest publish event in the segment of the drawn height.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SceneEvent } from '../../../src/viz/model/events.js';
import type { LayoutVM, TimelinePage } from '../../../src/viz/server/viewModel.js';
import { nowCard, nowRows, type NowRow } from '../../../src/viz/ui/follow.js';
import { RoomView } from '../../../src/viz/ui/roomView.js';
import { applyLayoutDeltaVM, unprojectEvent, unprojectLayout, unprojectScene } from '../../../src/viz/ui/unproject.js';
import { apiGet, startTestViewer, worldOf } from '../../helpers/vizViewer.js';

const PLAN2_ROWS: ReadonlySet<NowRow['row']> = new Set(['header', 'last_shared', 'nothing', 'not_here']);

/** The text 12 §3.8.1 names a desk by in the last-shared row, read from the served layout (LayoutVM.desks carries no desk key). */
function deskText(l: LayoutVM, d: number): string | null {
  const desk = l.desks[d];
  assert.ok(desk !== undefined, `desk ${d} is in the served layout`);
  switch (desk.kind) {
    case 'big_table': return null;
    case 'file': return desk.path;
    case 'folder': return desk.plaque;
    case 'shelf': return `${l.zones[desk.zone!]!.sign}/\u{2026}`;
  }
}

test('T-VIZ-follow-plan2: following each storyboard person shows only Plan 2 rows', { timeout: 60_000 }, async () => {
  const v = await startTestViewer({ demo: true });
  try {
    const session = await v.session();
    const w = await worldOf(v.port, session);
    assert.equal(w.demo, true);
    const room = w.rooms[0]!;
    let layoutVM = room.layout;
    // The page's view: the head scene at h1, and every timeline page below it down to h0 (RoomView plans the requests, R-V29).
    const view = new RoomView(room.room_id, unprojectScene(room.scene), room.window, unprojectLayout(layoutVM), {
      page: async (from, to) => {
        const res = await apiGet(v.port, session, `/api/v1/rooms/${room.room_id}/timeline?from=${from}&to=${to}`);
        if (res.status !== 200) return null;
        const p = JSON.parse(res.body.toString('utf8')) as TimelinePage;
        return { room: p.room_id, from: p.from, to: p.to, start: unprojectScene(p.scene), events: p.events.map(unprojectEvent), vm: p };
      },
      merged: (pages) => {
        for (const p of pages) {
          if (p.vm.layout === null) continue;
          const l = applyLayoutDeltaVM(layoutVM, p.vm.layout);
          assert.notEqual(l, 'reload');
          layoutVM = l as LayoutVM;
          view.setLayout(unprojectLayout(layoutVM));
        }
      },
      changed: () => undefined,
    });
    const { h0, h1 } = room.window;
    await view.want(h0);
    for (let h = h0; h <= h1; h++) assert.ok(view.holds(h), `the page holds height ${h}`);
    const events: readonly SceneEvent[] = view.view().events;
    const segments = view.view().segments;
    const names = new Map(room.characters.map((c) => [c.handle, c.name]));
    assert.equal(room.characters.length, 3, 'the storyboard has three people');
    const seen = { header: 0, last_shared: 0, last_shared_table: 0, nothing: 0, not_here: 0 };
    const respawns = events.filter((e) => e.kind === 'person_respawn').length;

    for (const c of room.characters) {
      for (let h = h0; h <= h1; h++) {
        const s = view.sceneAt(h)!;
        const card = nowCard(s, view.layout, c.handle);
        const rows = nowRows(card, s, (p) => names.get(p) ?? p);
        const at = `${c.name} at #${h}`;
        // Plan 2 rows only (12 §3.8.1 "What shows when"): no claim, request or pet ever fills a holding, asks or asked-by row.
        assert.deepEqual([card.holding, card.asks, card.askedBy, card.more], [[], [], [], { holding: 0, asks: 0, askedBy: 0 }], at);
        assert.ok(rows.every((r) => PLAN2_ROWS.has(r.row)), `${at}: ${rows.map((r) => r.row).join(', ')}`);
        assert.deepEqual(rows[0], { row: 'header', code: 'UI_VIZ_FOLLOWING', params: { name: c.name }, label: rows[0]!.label, link: null }, at);
        if (!s.characters.has(c.handle)) {
          assert.deepEqual(rows.slice(1).map((r) => r.row), ['not_here'], at);
          seen.not_here++;
          continue;
        }
        // The newest publish event of this person in the segment of h (12 §3.3.5: segment i holds the heights (hs_i, hs_i+1]; a
        // start scene carries no publish history), at or below h — and after the person's last entry: a person_enter or
        // person_respawn (a new epoch) starts a new stay and clears ActorState.lastPublish (12 §3.4, R-V25), the source of the row.
        let i = 0;
        for (let j = 0; j < segments.length; j++) if (segments[j]!.hs < h) i = j;
        const hs = segments[i]!.hs;
        const mine = events.filter((e) => ('peer' in e && e.peer === c.handle) || (e.kind === 'publish' && 'peer' in e.actor && e.actor.peer === c.handle));
        let newest: SceneEvent | undefined;
        for (const e of mine) {
          if (e.height > h || (i > 0 && e.height <= hs)) continue;
          if (e.kind === 'person_enter' || e.kind === 'person_respawn') newest = undefined;
          else if (e.kind === 'publish') newest = e;
        }
        if (newest === undefined || newest.kind !== 'publish') {
          assert.deepEqual(rows.slice(1).map((r) => r.row), ['nothing'], at);
          seen.nothing++;
          continue;
        }
        const path = deskText(layoutVM, newest.target);
        assert.deepEqual(rows.slice(1), [path === null
          ? { row: 'last_shared', code: 'UI_VIZ_NOW_LAST_SHARED_TABLE', params: { height: newest.height }, label: null, link: null }
          : { row: 'last_shared', code: 'UI_VIZ_NOW_LAST_SHARED', params: { path, height: newest.height }, label: null, link: null }], at);
        seen[path === null ? 'last_shared_table' : 'last_shared']++;
      }
    }
    // The storyboard exercises every Plan 2 row: people not yet in the room, people who have not shared yet, and shares.
    assert.ok(seen.not_here > 0 && seen.nothing > 0 && seen.last_shared > 0, JSON.stringify(seen));
    assert.ok(respawns > 0, 'the storyboard has a respawn, after which the row starts over');
  } finally {
    await v.stop('VIZ_EXIT_SIGNAL');
  }
});
