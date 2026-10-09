// Plan 8a Task 13: the log model (12 §3.8 "Cards", "Activity cards", "Card content", "Filters", "Memory"; VIZ-11, VIZ-24,
// VIZ-25; R-V28): the card list, request_status chips, merged publishes, AND-combined filters, the 2,000-card memory, seen
// labels, and teammate text kept out of every template.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWith, type Catalog } from '../../../src/i18n/render.js';
import { EN_VIZ } from '../../../src/viz/i18n/en.js';
import { REASON_CODES } from '../../../src/viz/i18n/codes.js';
import type { ActorVM, CardVM, EventVM } from '../../../src/viz/server/viewModel.js';
import { CARDS_MAX, CHIPS_MAX, cardText, LogModel, type LogFilter, type LogRow } from '../../../src/viz/ui/logModel.js';

const HA = 'a1a1a1', HB = 'b2b2b2';
let seq = 0;
function card(h: number, sub: number, code: string, group: CardVM['group'], o: Partial<CardVM> = {}): CardVM {
  seq++;
  return {
    id: `${h}.${sub}.0`, at: [h, sub, 0], group, code, actor: { peer: HA }, target: null, paths: [], n: 0, desks: [], displayId: null, parent: null,
    label: null, text: null, detail: null, seen_ms: null, ...o,
  };
}
const publish = (h: number, actor: string, paths: string[], o: Partial<CardVM> = {}): CardVM =>
  card(h, 1_001, 'UI_VIZ_CARD_PUBLISH', 'activity', { actor: { peer: actor }, paths, n: paths.length, desks: [1], ...o });

const C1 = card(0, 0, 'UI_VIZ_CARD_ROOM_OPEN', 'system', { actor: null });
const C2 = card(1, 1, 'UI_VIZ_CARD_JOIN', 'conversation');
const C3 = publish(2, HA, ['p1', 'p2', 'p3'], { desks: [1, 2] });
const C4 = publish(3, HA, ['p3', 'p4', 'p5', 'p6']);
const C5 = card(4, 1, 'UI_VIZ_CARD_FREEZE', 'system', { actor: { peer: HB }, detail: 'PAUSED' });
const C6 = publish(5, HA, ['p7'], { n: 3 });                       // two of its three paths were not served (R-V50)
const C7 = publish(6, HB, ['p1']);
const C8 = card(7, 1, 'UI_VIZ_CARD_REQUEST', 'conversation', { actor: { peer: HB }, target: { peer: HA }, paths: ['src/a.ts'], n: 1, desks: [1], displayId: 'R00000001' });
const C9 = card(8, 1, 'UI_VIZ_CARD_ANSWER', 'conversation', { actor: { peer: HA }, target: { peer: HB }, displayId: 'R00000001', parent: 'R00000001', detail: 'accept' });
const C10 = card(9, 1, 'UI_VIZ_CARD_K4', 'conflict', { actor: { peer: HB }, desks: [2], paths: ['src/b.ts'], n: 1, displayId: 'H0000001' });
const C11 = publish(10, HA, ['p8']);
const ALL = [C1, C2, C3, C4, C5, C6, C7, C8, C9, C10, C11];
const GROUPS = new Set<CardVM['group']>(['conversation', 'activity', 'conflict']);
const filter = (o: Partial<LogFilter> = {}): LogFilter => ({ peer: null, desk: null, groups: GROUPS, system: false, ...o });
const status = (h: number, s: 'asked' | 'queued_until_turn_end' | 'returned', request = 'R00000001'): EventVM =>
  ({ at: [h, 1, 0], seed: 0, kind: 'request_status', request, holder: { peer: HA }, status: s });

/** A row as [kind, card ids, chips, more | answers]. */
function shape(rows: readonly LogRow[]): unknown[] {
  return rows.map((r) => (r.kind === 'card' ? ['card', r.card.id, r.chips, r.answers.map((a) => a.id)] : ['merged', r.cards.map((c) => c.id), r.chips, r.more]));
}

test('T-VIZ-log: the card list; request_status is a chip; consecutive publishes of one actor merge with ≤ 5 chips and +n after filtering; character, person, file and kind filters AND-combine; system cards only behind their filter; at most 2,000 cards', () => {
  assert.equal(CARDS_MAX, 2_000);
  assert.equal(CHIPS_MAX, 5);
  const log = new LogModel();
  // Out of order and twice: the model keeps one card per id in ascending board position.
  log.add([C6, C7, C8, C9, C10, C11], 0);
  log.add([C1, C2, C3, C4, C5], 0);
  log.add([C8], 0);
  log.status(status(7, 'asked'));
  log.status({ at: [7, 2, 0], seed: 0, kind: 'note', actor: { peer: HA }, target: null, text: 'not a status' });

  // System cards hidden; C4 and C6 merge across the hidden freeze card: 7 distinct paths + 2 unserved → 5 chips and +4.
  assert.deepEqual(shape(log.rows(filter())), [
    ['card', '1.1.0', [], []],
    ['merged', ['2.1001.0', '3.1001.0', '5.1001.0'], ['p1', 'p2', 'p3', 'p4', 'p5'], 4],
    ['merged', ['6.1001.0'], ['p1'], 0],
    ['card', '7.1.0', ['asked'], ['8.1.0']],
    ['card', '9.1.0', [], []],
    ['merged', ['10.1001.0'], ['p8'], 0],
  ]);
  // The system filter shows them, and the freeze card now splits A's publishes.
  log.status(status(7, 'queued_until_turn_end'));
  assert.deepEqual(shape(log.rows(filter({ system: true }))), [
    ['card', '0.0.0', [], []],
    ['card', '1.1.0', [], []],
    ['merged', ['2.1001.0', '3.1001.0'], ['p1', 'p2', 'p3', 'p4', 'p5'], 1],
    ['card', '4.1.0', [], []],
    ['merged', ['5.1001.0'], ['p7'], 2],
    ['merged', ['6.1001.0'], ['p1'], 0],
    ['card', '7.1.0', ['queued_until_turn_end'], ['8.1.0']],
    ['card', '9.1.0', [], []],
    ['merged', ['10.1001.0'], ['p8'], 0],
  ]);
  // A person (a clicked character, its name chip or the people list): the cards it acts in or is the target of.
  assert.deepEqual(shape(log.rows(filter({ peer: HA }))), [
    ['card', '1.1.0', [], []],
    ['merged', ['2.1001.0', '3.1001.0', '5.1001.0'], ['p1', 'p2', 'p3', 'p4', 'p5'], 4],
    ['card', '7.1.0', ['queued_until_turn_end'], ['8.1.0']],
    ['merged', ['10.1001.0'], ['p8'], 0],
  ]);
  // A desk (a clicked desk or file chip).
  assert.deepEqual(shape(log.rows(filter({ desk: 2 }))), [['merged', ['2.1001.0'], ['p1', 'p2', 'p3'], 0], ['card', '9.1.0', [], []]]);
  // Kinds.
  assert.deepEqual(shape(log.rows(filter({ groups: new Set(['conflict']) }))), [['card', '9.1.0', [], []]]);
  assert.deepEqual(shape(log.rows(filter({ groups: new Set() }))), []);
  assert.deepEqual(shape(log.rows(filter({ groups: new Set(), system: true }))), [['card', '0.0.0', [], []], ['card', '4.1.0', [], []]]);
  // AND: person and kind, person and desk, person and system.
  assert.deepEqual(shape(log.rows(filter({ peer: HB, groups: new Set(['activity']) }))), [['merged', ['6.1001.0'], ['p1'], 0]]);
  assert.deepEqual(shape(log.rows(filter({ peer: HB, desk: 2 }))), [['card', '9.1.0', [], []]]);
  assert.deepEqual(shape(log.rows(filter({ peer: HB, groups: new Set(), system: true }))), [['card', '4.1.0', [], []]]);
  // An answer whose request card is filtered out stands on its own.
  assert.deepEqual(shape(log.rows(filter({ peer: HA, desk: null, groups: new Set(['conversation']) })).filter((r) => r.kind === 'card')),
    [['card', '1.1.0', [], []], ['card', '7.1.0', ['queued_until_turn_end'], ['8.1.0']]]);
  const answersOnly = new LogModel();
  answersOnly.add([C9], 0);
  assert.deepEqual(shape(answersOnly.rows(filter())), [['card', '8.1.0', [], []]]);
  // request_status for a request the page has no card for yet: the chip appears when the card arrives.
  const late = new LogModel();
  late.status(status(7, 'asked', 'R00000002'));
  late.add([{ ...C8, displayId: 'R00000002' }], 0);
  assert.deepEqual(shape(late.rows(filter())), [['card', '7.1.0', ['asked'], []]]);

  // At most 2,000 cards: the oldest drop.
  const big = new LogModel();
  const many = Array.from({ length: 2_100 }, (_, i) => card(i + 1, 1, 'UI_VIZ_CARD_NOTE', 'conversation', { actor: { peer: i % 2 === 0 ? HA : HB }, text: 'x' }));
  big.add(many.slice(1_000), 0);
  big.add(many.slice(0, 1_000), 0);
  const rows = big.rows(filter());
  assert.equal(rows.length, 2_000);
  assert.equal((rows[0] as Extract<LogRow, { kind: 'card' }>).card.id, '101.1.0');
  assert.equal((rows.at(-1) as Extract<LogRow, { kind: 'card' }>).card.id, '2100.1.0');
  void seq;
});

test('T-VIZ-log: a live card the viewer saw arrive shows UI_VIZ_SEEN_AGO from seen_ms plus the page\'s own Δmono, a card with seen_ms null shows #height and UI_VIZ_SEEN_BEFORE_OPEN, replay shows #height, and a reload keeps both', () => {
  const seen = card(40, 1_001, 'UI_VIZ_CARD_PUBLISH', 'activity', { seen_ms: 120_000, paths: ['a'], n: 1 });
  const before = card(12, 1, 'UI_VIZ_CARD_JOIN', 'conversation', { seen_ms: null });
  const log = new LogModel();
  log.add([seen, before], 1_000);                         // the response arrived at the page's mono 1,000
  assert.deepEqual(log.seenLabel(seen, 1_000, false), { kind: 'seen_ago', n: 2 });
  assert.deepEqual(log.seenLabel(seen, 61_000, false), { kind: 'seen_ago', n: 3 });
  assert.deepEqual(log.seenLabel(seen, 60_999 + 60_000, false), { kind: 'seen_ago', n: 3 });
  assert.deepEqual(log.seenLabel(before, 61_000, false), { kind: 'before_open', height: 12 });
  // Replay: every card shows its height.
  assert.deepEqual(log.seenLabel(seen, 61_000, true), { kind: 'height', height: 40 });
  assert.deepEqual(log.seenLabel(before, 61_000, true), { kind: 'height', height: 12 });
  // A card that arrives on the stream as it is folded (seen_ms 0) ages with the page's own clock.
  const fresh = card(41, 1_001, 'UI_VIZ_CARD_PUBLISH', 'activity', { seen_ms: 0 });
  log.add([fresh], 5_000);
  assert.deepEqual(log.seenLabel(fresh, 5_000 + 59_999, false), { kind: 'seen_ago', n: 0 });
  assert.deepEqual(log.seenLabel(fresh, 5_000 + 120_000, false), { kind: 'seen_ago', n: 2 });
  // A reload at the page's mono 61,000: the server serves seen_ms relative to its new response, the page starts a new model; both
  // labels are unchanged.
  const reloaded = new LogModel();
  reloaded.add([{ ...seen, seen_ms: 180_000 }, before], 61_000);
  assert.deepEqual(reloaded.seenLabel({ ...seen, seen_ms: 180_000 }, 61_000, false), { kind: 'seen_ago', n: 3 });
  assert.deepEqual(reloaded.seenLabel(before, 61_000, false), { kind: 'before_open', height: 12 });
  // The labels render through the page subset: "seen {n} min ago", "#<height>" and "before this view opened".
  const en: Catalog = EN_VIZ;
  assert.equal(renderWith({ en }, REASON_CODES, 'UI_VIZ_SEEN_AGO', { n: 3 }, 'viz', 'en'), 'seen 3 min ago');
  assert.equal(renderWith({ en }, REASON_CODES, 'UI_VIZ_SEEN_BEFORE_OPEN', {}, 'viz', 'en'), 'before this view opened');
});

test('T-VIZ-notes (page): teammate text is placed only in the quoted frame and never passed to renderWith as a code or a template', () => {
  const HOSTILE = ['UI_VIZ_LINK_REUSED', '{name} {path} {id}', '<img src=x onerror=alert(1)>', 'UI_VIZ_STOPPED {n}', 'RF_VIZ_START_FAILED'];
  const names = new Map<string, string>([[HA, 'Ann'], [HB, 'UI_VIZ_NEED_LINK']]);   // a teammate named like a code is still a name
  const nameOf = (a: ActorVM): string => ('peer' in a ? names.get(a.peer) ?? a.peer : a.seat);
  const en: Catalog = EN_VIZ;
  for (const text of HOSTILE) {
    for (const c of [
      card(5, 1, 'UI_VIZ_CARD_NOTE', 'conversation', { text }),
      card(6, 1, 'UI_VIZ_CARD_REQUEST', 'conversation', { actor: { peer: HB }, target: { peer: HA }, paths: ['src/a.ts'], n: 1, displayId: 'R00000001', text }),
      card(7, 1, 'UI_VIZ_CARD_ANSWER', 'conversation', { displayId: 'R00000001', parent: 'R00000001', text }),
    ]) {
      const t = cardText(c, nameOf);
      assert.equal(t.code, c.code);
      assert.equal(t.quoted, text, 'the teammate text is the quoted frame');
      for (const v of Object.values(t.params)) assert.notEqual(v, text, 'never a template parameter');
      const out = renderWith({ en }, REASON_CODES, t.code, t.params, 'viz', 'en');
      assert.ok(!out.includes(text), out);
      assert.ok(!out.includes('This link was opened twice') && !out.includes('The viewer stopped'), out);
    }
  }
  // A card whose code is not a card code (a forged code slot) renders no page-state text; the name of a teammate stays a name.
  const forged = cardText(card(8, 1, 'UI_VIZ_LINK_REUSED', 'conversation', { text: 'x' }), nameOf);
  assert.notEqual(forged.code, 'UI_VIZ_LINK_REUSED');
  assert.ok(!renderWith({ en }, REASON_CODES, forged.code, forged.params, 'viz', 'en').includes('opened twice'));
  const named = cardText(card(9, 1, 'UI_VIZ_CARD_JOIN', 'conversation', { actor: { peer: HB } }), nameOf);
  assert.equal(named.params['name'], 'UI_VIZ_NEED_LINK');
  assert.equal(named.quoted, null);
  assert.equal(renderWith({ en }, REASON_CODES, named.code, named.params, 'viz', 'en'), 'UI_VIZ_NEED_LINK joined');
  // The publish card: name and count only (activity cards carry trailer facts only).
  const pub = cardText(publish(10, HA, ['a', 'b'], { n: 2 }), nameOf);
  assert.equal(renderWith({ en }, REASON_CODES, pub.code, pub.params, 'viz', 'en'), 'Ann shared 2 files');
});

test('T-VIZ-log: the rewind tick\'s card comes from the log\'s own 2,000 cards (the oldest dropped first, whatever the order they arrived in), and the rows\' render key changes exactly when a row, a chip or a position label would', () => {
  // The cards at a height (a tick's hover text): in board position order, from the one store of the page.
  const log = new LogModel();
  log.add([C3, C2, C8, C9, C11], 0);
  assert.deepEqual(log.at(2).map((c) => c.id), ['2.1001.0']);
  assert.deepEqual(log.at(5), []);
  const two = card(7, 2, 'UI_VIZ_CARD_NOTE', 'conversation', { text: 'x' });
  log.add([two], 0);
  assert.deepEqual(log.at(7).map((c) => c.id), ['7.1.0', '7.2.0']);
  // At most 2,000: newest heights first, then a "load earlier" page of older ones — the lowest heights drop, never the newest.
  const big = new LogModel();
  const at = (h: number): CardVM => ({ ...card(h, 1, 'UI_VIZ_CARD_NOTE', 'conversation', { text: 'x' }), id: `${h}.1.0` });
  big.add(Array.from({ length: 1_990 }, (_, i) => at(1_000 + i)), 0);
  big.add(Array.from({ length: 30 }, (_, i) => at(100 + i)), 0);
  assert.equal(big.at(2_989).length, 1, 'the newest height is kept');
  assert.equal(big.at(1_000).length, 1);
  assert.deepEqual(big.at(100), [], 'the oldest dropped first');
  assert.deepEqual(big.at(119), []);
  assert.equal(big.at(120).length, 1);
  assert.equal(big.rows(filter({ system: true })).length, 2_000);

  // The render key (the panel rebuilds its DOM only when it changes): stable for the same rows and labels.
  const k = new LogModel();
  k.add([C2, C3, C4, C8], 1_000);
  const key = (nowMono: number, replay = false, f: LogFilter = filter()): string => k.key(k.rows(f), nowMono, replay);
  assert.equal(key(1_000), key(1_000));
  assert.equal(key(1_000), key(30_000), 'no label changed (no card was seen arriving)');
  const before = key(1_000);
  k.status(status(7, 'asked'));
  const chip = key(1_000);
  assert.notEqual(chip, before, 'a status chip');
  k.add([C11], 1_000);
  assert.notEqual(key(1_000), chip, 'a new card');
  assert.notEqual(key(1_000), key(1_000, true), 'replay labels');
  assert.notEqual(key(1_000), key(1_000, false, filter({ groups: new Set(['conversation']) })), 'other rows');
  // A card seen arriving: its "seen {n} min ago" label changes once a minute, and so does the key.
  k.add([card(12, 1, 'UI_VIZ_CARD_NOTE', 'conversation', { text: 'y', seen_ms: 0 })], 1_000);
  assert.equal(key(1_000), key(60_999));
  assert.notEqual(key(1_000), key(61_000));
  // A merged row's chips and "+n" are part of the key.
  const m1 = new LogModel(), m2 = new LogModel();
  m1.add([C3, C4], 0);
  m2.add([C3, { ...C4, paths: ['p3', 'p4', 'p5', 'p6', 'p9'], n: 5 }], 0);
  assert.notEqual(m1.key(m1.rows(filter()), 0, false), m2.key(m2.rows(filter()), 0, false));
});
