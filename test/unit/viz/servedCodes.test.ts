// Plan 8a Task 9: closed code sets at projection (R-V43, S2; VIZ-25, VIZ-36, INV-VIZ-TEXT): a board code in a code slot is
// served only when it is in that slot's set, so a forged reason equal to one of the viewer's own page-state, RF_ or SEC_
// codes never prints the viewer's alarm text as teammate data; projectEvent and projectScene map alike (VIZ-26).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWith } from '../../../src/i18n/render.js';
import { EN_VIZ } from '../../../src/viz/i18n/en.js';
import { REASON_CODES, VIZ_CODES } from '../../../src/viz/i18n/codes.js';
import { createHandleTable, projectCard, projectEvent, projectScene } from '../../../src/viz/server/project.js';
import type { EventVM, SceneVM } from '../../../src/viz/server/viewModel.js';
import { ev } from '../../helpers/vizEvents.js';
import { cardOf, layoutOf, PA, PB, projectedReduction, SA, sceneAfter } from '../../helpers/vizModels.js';

/** Every page-state code, every RF_ code and every SEC_ code of the 12 §3.11 table. */
const FORGED: readonly string[] = [
  ...VIZ_CODES.page,
  ...Object.values(VIZ_CODES).flat().filter((c) => c.startsWith('RF_') || c.startsWith('SEC_')),
];

/** The en template of a code (null when the catalog has none, or when it is too short to be told apart inside served JSON). */
const templateOf = (code: string): string | null => {
  const t = EN_VIZ[code]?.text;
  return t !== undefined && t.length >= 12 ? t : null;
};

test("T-VIZ-text: a forged code in a code slot is never a page-state, RF_ or SEC_ code", () => {
  assert.ok(FORGED.length > 30 && FORGED.includes('UI_VIZ_LINK_REUSED') && FORGED.includes('RF_VIZ_START_FAILED') && FORGED.includes('SEC_VIZ_BAD_HOST'));
  const layout = layoutOf();
  for (const code of FORGED) {
    const h = createHandleTable();
    const freeze = projectEvent(ev('person_freeze', [5, 1, 0], { peer: PA, reasonCode: code }), h) as Extract<EventVM, { kind: 'person_freeze' }>;
    assert.equal(freeze.reasonCode, '?', code);
    const badge = projectEvent(ev('person_badge', [5, 2, 0], { actor: { peer: PA }, badge: 'health', on: true, code }), h) as Extract<EventVM, { kind: 'person_badge' }>;
    assert.equal(badge.code, null, code);
    const petBadge = projectEvent(ev('person_badge', [5, 3, 0], { actor: { seat: SA }, badge: 'health', on: true, code }), h) as Extract<EventVM, { kind: 'person_badge' }>;
    assert.equal(petBadge.code, null, code);
    const scene = sceneAfter([
      ev('person_enter', [1, 1, 0], { peer: PA }),
      ev('pet_spawn', [2, 1001, 0], { seat: SA, owner: PA }),
      ev('person_freeze', [5, 1, 0], { peer: PA, reasonCode: code }),
      ev('person_badge', [5, 3, 0], { actor: { seat: SA }, badge: 'health', on: true, code }),
    ], layout);
    const sv: SceneVM = projectScene(scene, h);
    assert.equal(sv.characters[0]![1].frozen, '?', `${code}: the character stays frozen, with no reason`);
    assert.equal(sv.pets[0]![1].ssCode, null, code);
    const cards = ['UI_VIZ_CARD_FREEZE', 'UI_VIZ_CARD_HEALTH', 'UI_VIZ_CARD_SLOWED', 'UI_VIZ_CARD_NONRETRYABLE', 'UI_VIZ_CARD_PUBLISH'].map((c) =>
      projectCard({ card: cardOf([5, 1, 0], { group: 'system', code: c, detail: code }), foldedAt: null }, 0, h));
    for (const c of cards) assert.equal(c.detail, '?', `${code} on ${c.code}`);
    // Its template is never rendered: not served, and a {reason} parameter nests only a registered reason code.
    const served = JSON.stringify([freeze, badge, petBadge, sv, cards]);
    assert.ok(!served.includes(code), `${code} is not served`);
    const template = templateOf(code);
    if (template !== null) assert.ok(!served.includes(template), `${code}'s template is not served`);
    const text = renderWith({ en: EN_VIZ }, REASON_CODES, 'PH_FROZEN', { reason: sv.characters[0]![1].frozen }, 'viz', 'en');
    assert.equal(text, 'paused (?)');
  }

  // The legitimate codes project unchanged.
  const h = createHandleTable();
  assert.equal((projectEvent(ev('person_freeze', [5, 1, 0], { peer: PA, reasonCode: 'EPOCH' }), h) as Extract<EventVM, { kind: 'person_freeze' }>).reasonCode, 'EPOCH');
  assert.equal((projectEvent(ev('person_badge', [5, 2, 0], { actor: { peer: PB }, badge: 'health', on: true, code: 'HOST_THROTTLED' }), h) as Extract<EventVM, { kind: 'person_badge' }>).code, 'HOST_THROTTLED');
  assert.equal((projectEvent(ev('person_badge', [5, 3, 0], { actor: { seat: SA }, badge: 'health', on: true, code: 'SS_NO_HOOKS' }), h) as Extract<EventVM, { kind: 'person_badge' }>).code, 'SS_NO_HOOKS');
  assert.equal(projectCard({ card: cardOf([5, 1, 0], { group: 'system', code: 'UI_VIZ_CARD_FREEZE', detail: 'EPOCH' }), foldedAt: null }, 0, h).detail, 'EPOCH');
  assert.equal(projectCard({ card: cardOf([5, 1, 0], { group: 'system', code: 'UI_VIZ_CARD_HEALTH', detail: 'HOST_THROTTLED' }), foldedAt: null }, 0, h).detail, 'HOST_THROTTLED');
  assert.equal(projectCard({ card: cardOf([5, 1, 0], { group: 'system', code: 'UI_VIZ_CARD_FREEZE', detail: 'HOST_THROTTLED' }), foldedAt: null }, 0, h).detail, '?', 'a code of another row');
  assert.equal(
    renderWith({ en: EN_VIZ }, REASON_CODES, 'PH_FROZEN', { reason: 'EPOCH' }, 'viz', 'en'),
    `paused (${renderWith({ en: EN_VIZ }, REASON_CODES, 'EPOCH', {}, 'viz', 'en')})`,
  );

  // The same mapping in projectEvent and projectScene: the page's reduction over projected events equals the projected server scene.
  const events = [
    ev('person_enter', [1, 1, 0], { peer: PA }),
    ev('person_enter', [1, 2, 0], { peer: PB }),
    ev('pet_spawn', [2, 1001, 0], { seat: SA, owner: PA }),
    ev('person_freeze', [3, 1, 0], { peer: PA, reasonCode: 'UI_VIZ_LINK_REUSED' }),
    ev('person_freeze', [3, 2, 0], { peer: PB, reasonCode: 'EPOCH' }),
    ev('person_badge', [4, 1, 0], { actor: { seat: SA }, badge: 'health', on: true, code: 'SS_NO_HOOKS' }),
    ev('person_badge', [5, 1, 0], { actor: { seat: SA }, badge: 'health', on: true, code: 'SEC_VIZ_BAD_HOST' }),
    ev('person_badge', [6, 1, 0], { actor: { seat: SA }, badge: 'health', on: true, code: 'SS_DEGRADED' }),
    ev('person_badge', [6, 2, 0], { actor: { peer: PB }, badge: 'health', on: true, code: 'RF_VIZ_START_FAILED' }),
    ev('person_thaw', [7, 1, 0], { peer: PA }),
  ];
  const { serverVM, server, page } = projectedReduction(events, layoutOf());
  assert.deepEqual(page, server);
  assert.equal(serverVM[4]!.characters.find(([, c]) => c.frozen === '?') !== undefined, true);
  assert.equal(serverVM[5]!.pets[0]![1].ssCode, 'SS_NO_HOOKS');
  assert.equal(serverVM[6]!.pets[0]![1].ssCode, null);
  assert.equal(serverVM[7]!.pets[0]![1].ssCode, 'SS_DEGRADED');
});
