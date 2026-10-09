// Plan 8a Task 13: the map of rooms and the local overlay on the page (12 §3.5.1, §3.3.6; VIZ-13): room dots, grey cells, the
// header lamp, and no overlay element on a past scene.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene, type CharacterState, type Scene } from '../../../src/viz/model/scene.js';
import type { OverlayVM } from '../../../src/viz/server/viewModel.js';
import { headerLamp, MAP_DOTS_MAX, MAP_SCROLL_AFTER, roomDots, sceneOverlayMarks } from '../../../src/viz/ui/map.js';

const handle = (i: number): string => i.toString(16).padStart(6, '0');
function character(o: Partial<CharacterState> = {}): CharacterState {
  return { place: { at: 'home', spot: 0 }, pose: 'idle', lastPublish: null, lastDesk: null, lastClaimOp: null, ghost: false, absent: false, frozen: null, slowedUntil: null, rules: false, credit: false, ...o };
}
const OK = { down: false, noBoard: false, gone: false };

test('map: roomDots gives ≤ 16 dots, ranked characters first, ghosts grey, absent hollow, and a grey cell for a down, board-less or gone room; MAP_SCROLL_AFTER is 8', () => {
  assert.equal(MAP_DOTS_MAX, 16);
  assert.equal(MAP_SCROLL_AFTER, 8);
  // 20 present characters: every third a ghost, h3 and h4 absent; homeOrder lists them in reverse, plus a peer who left.
  const s: Scene = emptyScene({ height: 9, sub: 0, k: 0 });
  const ids = Array.from({ length: 20 }, (_, i) => handle(i + 1));
  for (const [i, id] of ids.entries()) s.characters.set(id, character({ ghost: i % 3 === 0, absent: i === 2 || i === 3 }));
  const homeOrder = ['ffffff', ...[...ids].reverse()];
  const looks = new Map(ids.map((id, i) => [id, { hue: i % 7, accessory: i % 8 }]));
  const { grey, dots } = roomDots(s, looks, homeOrder, OK);
  assert.equal(grey, false);
  assert.equal(dots.length, 16);
  const ranked = [...ids].reverse().filter((id) => !s.characters.get(id)!.ghost);
  const ghosts = [...ids].reverse().filter((id) => s.characters.get(id)!.ghost);
  assert.deepEqual(dots.map((d) => d.actor), [...ranked, ...ghosts].slice(0, 16));
  for (const d of dots) {
    const c = s.characters.get(d.actor)!;
    assert.equal(d.hue, c.ghost ? null : looks.get(d.actor)!.hue, d.actor);
    assert.equal(d.hollow, c.absent, d.actor);
  }
  // A character the layout has no home entry for comes after the listed ones; a character missing from the looks has no hue.
  const t: Scene = emptyScene({ height: 9, sub: 0, k: 0 });
  t.characters.set('aaaaaa', character());
  t.characters.set('bbbbbb', character({ ghost: true }));
  t.characters.set('cccccc', character());
  const few = roomDots(t, new Map([['cccccc', { hue: 3, accessory: 0 }]]), ['cccccc', 'bbbbbb'], OK);
  assert.deepEqual(few.dots, [
    { actor: 'cccccc', hue: 3, hollow: false },
    { actor: 'aaaaaa', hue: null, hollow: false },
    { actor: 'bbbbbb', hue: null, hollow: false },
  ]);
  // Grey cells: down, board ref vanished, gone; an empty room has no dots.
  for (const room of [{ ...OK, down: true }, { ...OK, noBoard: true }, { ...OK, gone: true }]) assert.equal(roomDots(t, new Map(), [], room).grey, true);
  assert.deepEqual(roomDots(emptyScene({ height: 0, sub: 0, k: 0 }), new Map(), [], OK), { grey: false, dots: [] });
});

const OVERLAY: OverlayVM = { state: 'ok', freeze_reasons: [], publish_pause: null, down: false, unreadable: false, offline_min: null, holds: 2, incoming: 1, ready: 3, you: 'a1a1a1' };

test('T-VIZ-overlay (page): in replay at h1 − 10 sceneOverlayMarks is null — no lamp on the scene, no count chip and no you marker — while headerLamp still shows the own room\'s light', () => {
  // Live: the parcels at "you", the delivery cart and the packed boxes at the door, the "you" marker.
  assert.deepEqual(sceneOverlayMarks(OVERLAY, false), { you: 'a1a1a1', parcels: 2, cart: 1, boxes: 3 });
  // Replay (a seek to h1 − 10): nothing of the overlay is drawn on the past scene.
  assert.equal(sceneOverlayMarks(OVERLAY, true), null);
  // The header lamp shows the own room's light in both modes.
  assert.deepEqual(headerLamp(OVERLAY), { state: 'ok', unreadable: false, down: false });
  assert.deepEqual(headerLamp({ ...OVERLAY, state: 'frozen', unreadable: true }), { state: 'frozen', unreadable: true, down: false });
  assert.deepEqual(headerLamp({ ...OVERLAY, down: true }), { state: 'ok', unreadable: false, down: true });
  // A room with no overlay (a demo room, or another room's scene): no lamp and no marks.
  assert.equal(headerLamp(null), null);
  assert.equal(sceneOverlayMarks(null, false), null);
  assert.equal(sceneOverlayMarks(null, true), null);
  // No "you" known: the counts still show live, the marker does not.
  assert.deepEqual(sceneOverlayMarks({ ...OVERLAY, you: null }, false), { you: null, parcels: 2, cart: 1, boxes: 3 });
});
