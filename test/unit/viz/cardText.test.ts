// Plan 8a final review §4a (Group B): a card's template placeholders come from the card (12 §3.3.7 "Card templates take only
// {name}, {target}, {n}, {path}, {id} and {label}; the page resolves them from the card and the character table"). For every
// §3.4 row whose Card column is a card (cardFor over a representative event of that row), the placeholders of its UI_VIZ_CARD_*
// template are a subset of the parameters ui/logModel.ts cardText supplies — {id} is the display id or, for an answer, its
// request's (parent); {path} is the first file chip or, with none, the name of the card's first desk by kind (model/labels.ts
// deskName) — except the pinned gaps of rows whose event names no such fact yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWith, type CatalogEntry } from '../../../src/i18n/render.js';
import { REASON_CODES } from '../../../src/viz/i18n/codes.js';
import { EN_VIZ } from '../../../src/viz/i18n/en.js';
import { cardFor, type Card, type SceneRow } from '../../../src/viz/model/cards.js';
import type { SceneEvent } from '../../../src/viz/model/events.js';
import { deskName } from '../../../src/viz/model/labels.js';
import { BIG_TABLE } from '../../../src/viz/model/layout.js';
import type { ActorVM, CardVM } from '../../../src/viz/server/viewModel.js';
import { cardText } from '../../../src/viz/ui/logModel.js';
import { ev } from '../../helpers/vizEvents.js';
import { A, B, D1, D2, OFFICE, SA1 } from '../../helpers/vizScene.js';

const REQ = 'R7K2M9QXZ';
const conflict = (row: 'k4' | 'claim' | 'k7' | 'breach' | 'generic', source: 'hold' | 'event'): SceneEvent => ev('conflict', [5, 1, 0], {
  conflict: row, source, on: source === 'hold' ? { seat: SA1 } : { peer: A }, desk: source === 'hold' ? D2 : null,
  holdId: source === 'hold' ? 'H0000001ABCDEFGH' : null, cid: source === 'event' ? 'BCDEFGHJ' : null, eventKind: source === 'event' ? (row === 'breach' ? 'breach' : 'K4') : null,
  line: row === 'claim' || row === 'breach' ? { claimId: 'cl-x' } : null,
});
const publish = (target: number, paths: string[], n: number): SceneEvent =>
  ev('publish', [3, 1001, 0], { actor: { peer: A }, target, others: [], paths, n, state: 'closed', checks: 'pass', origin: 'human' });

/** One representative event per 12 §3.4 row (every SceneRow: a missing one fails the typecheck). */
const ROWS = {
  genesis: ev('room_open', [0, 0, 0], {}),
  join_new: ev('person_enter', [1, 1, 0], { peer: A }),
  join_back: ev('person_enter', [1, 1, 0], { peer: A }),
  join_epoch: ev('person_respawn', [1, 1, 0], { peer: A }),
  join_version: ev('person_badge', [1, 1, 0], { actor: { peer: A }, badge: 'version', on: true, code: null }),
  join_rules: ev('person_badge', [1, 1, 0], { actor: { peer: A }, badge: 'rules', on: true, code: null }),
  rules_change: ev('person_badge', [1, 1002, 0], { actor: { peer: A }, badge: 'rules', on: true, code: null }),
  join_credit: ev('person_badge', [1, 1, 0], { actor: { peer: A }, badge: 'credit', on: true, code: null }),
  leave: ev('person_exit', [1, 1, 0], { peer: A }),
  seat_start: ev('pet_spawn', [2, 1, 0], { seat: SA1, owner: A }),
  seat_footprint: ev('pet_spawn', [2, 1001, 0], { seat: SA1, owner: A }),
  seat_end: ev('pet_poof', [2, 1, 0], { seat: SA1, owner: A }),
  publish_cs: publish(D1, ['src/a.ts'], 1),
  publish_big: publish(BIG_TABLE, [], 300),
  publish_nocs: publish(BIG_TABLE, [], 0),
  base_move: ev('room_sign', [3, 1001, 0], { sign: 'branch_moved' }),
  freeze: ev('person_freeze', [4, 1, 0], { peer: A, reasonCode: 'PAUSED' }),
  unfreeze: ev('person_thaw', [4, 1, 0], { peer: A }),
  slowed: ev('person_slowed', [4, 1, 0], { peer: A, until: 184 }),
  board_full: ev('room_badge', [4, 1, 0], { level: 'full' }),
  health_other: ev('person_badge', [4, 1, 0], { actor: { peer: A }, badge: 'health', on: true, code: 'BRANCH_ESCAPE' }),
  nonretryable: ev('person_bang', [4, 1, 0], { peer: A, bang: 'host' }),
  hold_k4: conflict('k4', 'hold'),
  hold_claim: conflict('claim', 'hold'),
  hold_t0: conflict('k7', 'hold'),
  hold_breach: conflict('breach', 'hold'),
  hold_other: ev('box', [5, 1, 1], { holdId: 'H0000001ABCDEFGH', owner: { seat: SA1 }, holdKind: 'PIN', residence: 'ON_DISK', state: 'CONFLICTED', offer: 'none', desk: D2, localOnly: false, terminal: false }),
  event_breach: conflict('breach', 'event'),
  event_k: conflict('generic', 'event'),
  claim_new: ev('claim_take', [6, 1, 0], { claimId: 'cl-x', seat: SA1, desk: D1, order: 4, label: null, granularity: 'file', lines: null, otherRules: false }),
  claim_reanchor: ev('claim_move', [6, 1, 0], { claimId: 'cl-x', seat: SA1, desk: D1, order: 4, label: null, granularity: 'file', lines: null, otherRules: false }),
  claim_stale: ev('claim_stale', [6, 1, 0], { claimId: 'cl-x' }),
  release: ev('claim_release', [6, 1, 0], { claimId: 'cl-x', reason: 'explicit' }),
  reserve: ev('claim_reserve', [6, 1, 0], { claimId: 'cl-x', request: REQ, requester: { peer: B } }),
  grant: ev('grant_start', [6, 1, 0], { claimId: 'cl-x', grantee: { peer: B } }),
  request: ev('request_open', [7, 1, 0], { request: REQ, from: { peer: B }, holder: { seat: SA1 }, desk: D1, requestKind: 'handoff', estMinutes: null, attempt: 1, note: 'please' }),
  request_status: ev('request_status', [7, 1, 1], { request: REQ, holder: { seat: SA1 }, status: 'asked' }),
  answer: ev('answer', [8, 1, 0], { request: REQ, holder: { seat: SA1 }, verb: 'accept', by: 'human', note: null }),
  note: ev('note', [8, 1, 1], { actor: { peer: B }, target: { request: REQ }, text: 'thanks' }),
  presume_absent: ev('person_absent', [9, 1, 0], { peer: B }),
  save: ev('save', [9, 1, 1], { peer: A, desks: [D1, D2] }),
  ghost: ev('person_ghost', [10, 1002, 0], { peer: B }),
  relaxed: ev('pose_relaxed', [10, 1002, 1], { actor: { peer: A } }),
} as const satisfies Record<SceneRow, SceneEvent>;

/**
 * Rows whose event names no such fact yet, so their template keeps the renderer's '?' there (a representation decision for the
 * spec batch, not a cardText mapping): an event{breach} or event{K*} names neither the holder nor a desk until Plan 4 folds claims
 * (R-V44; 12 §3.4 rows "event{kind: breach}", "event{kind: K1..K7}"), and a claim-breach hold's conflict names its causer, not the
 * claim's holder. Pinned exactly, so a later plan that fills one fails here and drops it.
 */
const KNOWN_GAPS: Readonly<Partial<Record<SceneRow, readonly string[]>>> = {
  event_breach: ['path', 'target'],
  event_k: ['path'],
  hold_breach: ['target'],
};

const vmOf = (c: Card): CardVM => ({
  id: c.id, at: [c.at.height, c.at.sub, c.at.k], group: c.group, code: c.code, actor: c.actor, target: c.target, paths: [...c.paths], n: c.n,
  desks: [...c.desks], displayId: c.displayId, parent: c.parent, label: c.label, text: c.text, detail: c.detail, seen_ms: null,
});
const nameOf = (a: ActorVM): string => ('peer' in a ? `name-${a.peer.slice(0, 4)}` : `pet-${a.seat.slice(0, 4)}`);
const deskNameOf = (d: number): string | null => deskName(OFFICE, d);
const templatesOf = (e: CatalogEntry): string[] => [e.text, ...Object.values(e.forms ?? {}).filter((x): x is string => typeof x === 'string')];
const placeholdersOf = (s: string): string[] => [...s.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1] as string);
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

test('cards: every carded §3.4 row\'s template placeholders are a subset of the parameters cardText supplies ({id} = the display id, else the request it answers; {path} = the first file chip, else the first desk named by kind), but for the pinned rows whose event names no such fact yet', () => {
  const carded: string[] = [];
  const uncarded: string[] = [];
  for (const [row, e] of Object.entries(ROWS) as Array<[SceneRow, SceneEvent]>) {
    const card = cardFor(e, row);
    if (card === null) {
      uncarded.push(row);
      continue;
    }
    carded.push(row);
    const t = cardText(vmOf(card), nameOf, deskNameOf);
    assert.equal(t.code, card.code, row);
    const entry = EN_VIZ[card.code];
    assert.ok(entry !== undefined, `${row}: ${card.code} has an en template`);
    const missing = sorted(templatesOf(entry).flatMap(placeholdersOf).filter((p) => !Object.hasOwn(t.params, p)));
    assert.deepEqual(missing, KNOWN_GAPS[row] ?? [], `${row} (${card.code}): placeholders cardText does not supply`);
    const out = renderWith({ en: EN_VIZ }, REASON_CODES, t.code, t.params, 'viz', 'en');
    if (KNOWN_GAPS[row] === undefined) assert.ok(!out.includes('?'), `${row}: "${out}"`);
  }
  assert.deepEqual(sorted(uncarded), sorted(['join_credit', 'seat_footprint', 'hold_other', 'claim_new', 'claim_reanchor', 'claim_stale', 'release', 'reserve', 'grant', 'request_status', 'ghost', 'relaxed']));
  assert.equal(carded.length, Object.keys(ROWS).length - uncarded.length);
  for (const row of Object.keys(KNOWN_GAPS)) assert.ok(carded.includes(row), `${row} is carded`);

  // The values: a request card names its desk (it carries no file chip), an answer its request, a hold card its desk and hold id.
  const text = (row: SceneRow): string => {
    const t = cardText(vmOf(cardFor(ROWS[row], row)!), nameOf, deskNameOf);
    return renderWith({ en: EN_VIZ }, REASON_CODES, t.code, t.params, 'viz', 'en');
  };
  assert.equal(text('request'), `name-${B.slice(0, 4)} asked pet-${SA1.slice(0, 4)} about src/a.ts (${REQ})`);
  assert.equal(text('answer'), `pet-${SA1.slice(0, 4)} answered ${REQ}`);
  assert.equal(text('hold_k4'), `pet-${SA1.slice(0, 4)}'s change to src/b.ts could not be applied and is kept aside (H0000001)`);
  assert.equal(text('hold_t0'), `pet-${SA1.slice(0, 4)}'s change to src/b.ts is held (H0000001)`);
  // A file chip wins over the desk's name; a desk the page cannot name (the big table) gives no {path}; without a desk namer, no
  // desk name either (the default: a card's own paths only).
  const base = vmOf(cardFor(ROWS.hold_k4, 'hold_k4')!);
  assert.equal(cardText({ ...base, paths: ['src/c.ts'] }, nameOf, deskNameOf).params['path'], 'src/c.ts');
  assert.equal(Object.hasOwn(cardText({ ...base, desks: [BIG_TABLE] }, nameOf, deskNameOf).params, 'path'), false);
  assert.equal(Object.hasOwn(cardText(base, nameOf).params, 'path'), false);
  // A display id wins over the parent.
  assert.equal(cardText({ ...vmOf(cardFor(ROWS.answer, 'answer')!), displayId: 'R00000001' }, nameOf).params['id'], 'R00000001');
});
