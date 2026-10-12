// The page's controls (Plan 8a final review, fix group C): the live pill on a stale stream (VIZ-42; 12 §3.10.5, §6), the rewind keys
// at the live tip (12 §3.9.1), the room status lamp's text (VIZ-19), and the page wiring of the zoom buttons' names, the log filters
// after a world reload (R-V22, 12 §3.8.1), the paused auto-scroll and the now card's display-id link. The decisions are pure ui/**
// helpers tested here for real; src/viz/client/** is browser-only (outside the Node program, R-V35), so its wiring is pinned by its
// source, as ui.follow.test.ts does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lampCode, livePillState, stepBy, streamStale, type KeyAction } from '../../../src/viz/ui/a11y.js';
import type { ConnState } from '../../../src/viz/ui/conn.js';
import { headerLamp } from '../../../src/viz/ui/map.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, ...rel.split('/')), 'utf8');

const CONN_STATES: readonly ConnState[] = ['booting', 'live', 'reconnecting', 'stopped', 'link_reused', 'link_expired', 'need_link'];

test('VIZ-42: the live pill looks live and is pressed only on a live stream; live, then reconnecting, then stopped greys it (also after bye, and on a lost session)', () => {
  // The stream is known not to be live in every state but live and booting.
  assert.deepEqual(CONN_STATES.map(streamStale), [false, false, true, true, true, true, true]);
  // The bar's live pill as main.ts's updateRewind feeds it (live = the page shows the tip, stale = streamStale(connState)).
  const pill = (live: boolean, c: ConnState): { on: boolean; off: boolean; pressed: boolean } => livePillState({ live, stale: streamStale(c) });
  const ON = { on: true, off: false, pressed: true }, GREY = { on: false, off: true, pressed: false }, PLAIN = { on: false, off: false, pressed: false };
  // A broken stream: reconnecting, then the 30 s retry and the world reload both fail → stopped. Never the healthy look again.
  assert.deepEqual((['booting', 'live', 'reconnecting', 'stopped'] as const).map((c) => pill(true, c)), [ON, ON, GREY, GREY]);
  // Live, then bye (another tab reused the link, the 24 h lifetime, a plugin update, a signal) → stopped.
  assert.deepEqual((['live', 'stopped'] as const).map((c) => pill(true, c)), [ON, GREY]);
  // A 401 on a mid-session world reload → need_link; and the two refused links.
  for (const c of ['need_link', 'link_reused', 'link_expired'] as const) assert.deepEqual(pill(true, c), GREY, c);
  // A reconnect that works is live again.
  assert.deepEqual((['reconnecting', 'live'] as const).map((c) => pill(true, c)), [GREY, ON]);
  // In replay the pill is not pressed (it returns to the tip); a stale stream greys it there too.
  assert.deepEqual(pill(false, 'live'), PLAIN);
  for (const c of ['reconnecting', 'stopped'] as const) assert.deepEqual(pill(false, c), GREY, c);
  for (const c of CONN_STATES) {
    for (const live of [true, false]) {
      const p = pill(live, c);
      assert.ok(!(p.on && p.off), `${c} ${live}: never both looks`);
      assert.equal(p.pressed, p.on, `${c} ${live}: aria-pressed only with the live look`);
    }
  }
  // The page takes that path: the rewind bar sets the pill from livePillState alone, and main.ts passes the stale state on every
  // connection state change.
  const rewind = read('src/viz/client/rewind.ts');
  assert.match(rewind, /const pill = livePillState\(s\);\s*setPressed\(livePill, pill\.pressed\);\s*livePill\.classList\.toggle\(CLS\.liveOn, pill\.on\);\s*livePill\.classList\.toggle\(CLS\.liveOff, pill\.off\);/u);
  assert.doesNotMatch(rewind, /setPressed\(livePill, s\.live\)|s\.reconnecting/u);
  const main = read('src/viz/client/main.ts');
  assert.match(main, /rewind\.update\(\{[^}]*\bstale: streamStale\(connState\),/u);
  assert.match(main, /state: \(s\) => \{\s*connState = s;[^}]*renderHeader\(\);\s*updateRewind\(\);/u);
});

test('12 §3.9.1: a forward arrow or page key at the live tip does nothing — it never turns live into a replay of the tip; back keys step −1 and −64, and in replay every step key moves', () => {
  const STEPS = ['step_back', 'step_fwd', 'page_back', 'page_fwd'] as const;
  assert.deepEqual(STEPS.map((a) => stepBy(a, true)), [-1, null, -64, null]);
  assert.deepEqual(STEPS.map((a) => stepBy(a, false)), [-1, 1, -64, 64]);
  for (const a of ['live', 'clear_filters', 'zoom_in', 'zoom_out', 'select', 'follow'] satisfies KeyAction[]) assert.equal(stepBy(a, false), null, a);
  // The page's keys: at the tip shown live (no seek waiting) a forward key does nothing; otherwise it seeks from the position on screen.
  const main = read('src/viz/client/main.ts');
  assert.match(main, /case 'step_back': case 'step_fwd': case 'page_back': case 'page_fwd': \{\s*if \(r === null\) return;\s*(?:\/\/[^\n]*\n\s*)*const by = stepBy\(action, mode\.live && pending === null\);\s*if \(by === null\) return;[^}]*seek\(from \+ by\);/u);
  // The slider's own PageUp/PageDown take the same rule (its arrows are the range input's own, which cannot pass the tip).
  const rewind = read('src/viz/client/rewind.ts');
  assert.match(rewind, /const by = stepBy\(action, state\.live && state\.at === state\.h1\);\s*if \(by !== null\) deps\.seek\(Math\.min\(state\.h1, Math\.max\(state\.h0, state\.at \+ by\)\)\);/u);
  for (const src of [main, rewind]) assert.doesNotMatch(src, /PAGE_HEIGHTS/u, 'the ±64 lives in stepBy alone');
});

test('VIZ-19: the room status lamp is not colour alone — a down or unreadable room names its state in its map button and in the header lamp\'s label', () => {
  // lampCode reads headerLamp's light (ui/map.ts): none for a room without an overlay.
  assert.equal(lampCode(headerLamp(null)), null);
  assert.equal(lampCode({ down: false, unreadable: false }), null);
  assert.equal(lampCode({ down: true, unreadable: false }), 'UI_VIZ_ROOM_DOWN');
  assert.equal(lampCode({ down: false, unreadable: true }), 'UI_VIZ_STATUS_UNREADABLE');
  assert.equal(lampCode({ down: true, unreadable: true }), 'UI_VIZ_ROOM_DOWN', 'down wins, as the lamp\'s colour does');
  const main = read('src/viz/client/main.ts');
  // The map's room buttons (the screen reader's and the keyboard's way to the rooms) carry the code's text after the label.
  assert.match(main, /const code = lampCode\(headerLamp\(r\.overlay\)\);\s*return \{ id: r\.id, text: code === null \|\| !hasStrings\(\) \? name : `\$\{name\} \\u\{00B7\} \$\{t\(code\)\}`, current: r\.id === selected \};/u);
  // The header lamp is an image with a label: its state, and the code's text when down or unreadable.
  assert.match(main, /lamp\.setAttribute\('role', 'img'\);/u);
  assert.match(main, /const lampWord = lampCode\(lampState\);[^\n]*\n\s*lamp\.setAttribute\('aria-label', lampWord === null \? lampState\.state : `\$\{lampState\.state\} \\u\{00B7\} \$\{t\(lampWord\)\}`\);/u);
});

test('12 §3.11: the two zoom buttons have distinct accessible names (zoom −, zoom +)', () => {
  const main = read('src/viz/client/main.ts');
  assert.match(main, /zoomOut\.setAttribute\('aria-label', `\$\{t\('UI_VIZ_CTRL_ZOOM'\)\} \\u\{2212\}`\);/u);
  assert.match(main, /zoomIn\.setAttribute\('aria-label', `\$\{t\('UI_VIZ_CTRL_ZOOM'\)\} \+`\);/u);
  assert.doesNotMatch(main, /setAttribute\('aria-label', t\('UI_VIZ_CTRL_ZOOM'\)\)/u);
});

test('R-V22, 12 §3.8.1: after a world reload the selected room\'s kept follow pins the person filter; a person filter on a handle the room no longer lists, or a file filter beyond its layout, is cleared', () => {
  const main = read('src/viz/client/main.ts');
  // onWorld re-reads the filters once the rooms and the selection are rebuilt (after the follow set ended the vanished follows).
  assert.match(main, /selected = firstRoom\(w, prev \?\? io\.storage\.get\(\)\.room\);\s*keepFilters\(\);/u);
  const body = /function keepFilters\(\): void \{([\s\S]*?)\n {2}\}/u.exec(main)?.[1] ?? '';
  assert.match(body, /const pinned = selected === null \? null : follows\.get\(selected\);\s*if \(pinned !== null\) logPanel\.person\(pinned\);\s*else if \(f\.peer !== null && \(r === null \|\| !r\.characters\.has\(f\.peer\)\)\) logPanel\.person\(null\);/u);
  assert.match(body, /if \(f\.desk !== null && \(r === null \|\| f\.desk >= r\.layout\.desks\.length\)\) logPanel\.desk\(null\);/u);
});

test('12 §3.8.1 pause, §3.5.3: the 30 s auto-scroll scrolls nothing while paused', () => {
  assert.match(read('src/viz/client/office.ts'), /follow\(desk\): void \{\s*(?:\/\/[^\n]*\n\s*)*if \(deps\.paused\(\)\) return;/u);
});

test('12 §3.8 "Card content": a display id on the now card scrolls the log list itself so its card\'s top is at the list\'s top', () => {
  const log = read('src/viz/client/log.ts');
  assert.match(log, /const li = cardsById\.get\(link\);\s*(?:\/\/[^\n]*\n\s*)*if \(li !== undefined\) list\.scrollTop \+= li\.getBoundingClientRect\(\)\.top - list\.getBoundingClientRect\(\)\.top - list\.clientTop;/u);
  assert.doesNotMatch(log, /offsetTop/u, 'no offsetParent arithmetic');
});
