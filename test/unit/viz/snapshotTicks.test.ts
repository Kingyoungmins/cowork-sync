// Plan 8a final review B1 and its room_snapshot minor (12 §3.9.2, §3.10.5; VIZ-26, VIZ-40): what the page does with a room_snapshot
// and the tick-only timeline parts that follow it. A tick-only part (no events, the snapshot's h1) changes nothing of the room's view
// or live queue — RoomView.append([], h1) and LivePlayer.push([]) are no-ops — so only its ticks land, appended; the page's
// room_snapshot handler appends its ticks (the newly folded heights') instead of replacing the window's, and in live mode updates
// the screen-reader summary and people list as a snap beat does. client/main.ts is DOM glue with no Node harness (R-V33): its
// handler is pinned on its source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { emptyScene, type Scene } from '../../../src/viz/model/scene.js';
import { LivePlayer, RoomView, type ViewPage } from '../../../src/viz/ui/roomView.js';
import { ev } from '../../helpers/vizEvents.js';
import { RANDOM_OFFICE } from '../../helpers/vizScene.js';

const ROOM = 'rABCDEFGH';
const MAIN = fileURLToPath(new URL('../../../src/viz/client/main.ts', import.meta.url));

test('B1 (page view): after a room_snapshot, a tick-only timeline part with the same h1 is a no-op for RoomView.append and LivePlayer.push', () => {
  const start: Scene = emptyScene({ height: 0, sub: 0, k: 0 });
  const io = { page: async (): Promise<ViewPage | null> => null, merged: (): void => {}, changed: (): void => {} };
  const view = new RoomView(ROOM, start, { h0: 0, h1: 10 }, RANDOM_OFFICE, io);
  view.append([ev('person_enter', [11, 1, 0], { peer: 'a1b2c3'.padEnd(32, '0') })], 11);
  const tip: Scene = { ...emptyScene({ height: 3_801, sub: 0, k: 0 }) };
  view.snapshot(tip, { h0: 256, h1: 3_801 });
  const live = new LivePlayer(start, () => RANDOM_OFFICE);
  live.reset(tip);
  const before = { head: view.head(), top: view.top(), h0: view.h0, h1: view.h1, holds: [3_800, 3_801, 3_802].map((h) => view.holds(h)), live: live.scene() };

  // The tick-only part: no events, the snapshot's h1.
  const added = view.append([], 3_801);
  live.push(added);
  assert.deepEqual(added, [], 'no event is newly held');
  assert.equal(live.queued(), 0, 'nothing is queued');
  assert.equal(live.beat(() => view.head()), null, 'no beat');
  const after = { head: view.head(), top: view.top(), h0: view.h0, h1: view.h1, holds: [3_800, 3_801, 3_802].map((h) => view.holds(h)), live: live.scene() };
  assert.deepEqual(after, before, 'the view and the live scene are unchanged');
  assert.deepEqual(before.holds, [false, true, false]);
});

/** The `case '<label>':` clause of onPayload's switch in client/main.ts, as source text. */
function caseText(label: string): { text: string; clause: ts.CaseClause; sf: ts.SourceFile } {
  const sf = ts.createSourceFile(MAIN, readFileSync(MAIN, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found: ts.CaseClause | null = null;
  const walk = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'onPayload') {
      const visit = (m: ts.Node): void => {
        if (ts.isCaseClause(m) && ts.isStringLiteral(m.expression) && m.expression.text === label) found = m;
        ts.forEachChild(m, visit);
      };
      visit(n);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  assert.ok(found !== null, `onPayload has a case '${label}'`);
  const clause = found as ts.CaseClause;
  return { text: clause.getText(sf), clause, sf };
}

test('B1 (page): the room_snapshot handler appends its ticks to the room\'s (never replaces them), as the timeline handler does for a tick-only part', () => {
  for (const label of ['room_snapshot', 'timeline']) {
    const { text } = caseText(label);
    assert.match(text, /\br\.ticks\.push\(\.\.\.p\.ticks\)/, `${label}: r.ticks.push(...p.ticks)`);
    assert.doesNotMatch(text, /\br\.ticks\s*=(?!=)/, `${label}: r.ticks is never reassigned`);
  }
});

test('room_snapshot (page, a11y): in live mode the handler updates the screen-reader summary and people list with the new scene, as a snap beat does', () => {
  const { clause, sf } = caseText('room_snapshot');
  let liveBranch: string | null = null;
  const visit = (n: ts.Node): void => {
    if (ts.isIfStatement(n) && n.expression.getText(sf) === 'mode.live') liveBranch = n.thenStatement.getText(sf);
    ts.forEachChild(n, visit);
  };
  visit(clause);
  assert.ok(liveBranch !== null, 'the handler has an `if (mode.live)` branch');
  assert.match(liveBranch as string, /\ba11y\.scene\(start,\s*\[\.\.\.r\.characters\.values\(\)\],\s*r\.layout\)/, 'a11y.scene(start, characters, layout)');
});
