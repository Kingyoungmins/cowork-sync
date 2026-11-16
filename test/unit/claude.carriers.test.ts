// test/unit/claude.carriers.test.ts — the packing and caps cells (06 §3.14.1, CCI-39, CCI-40, INV-CCI-CAP, R5-60,
// R2-E2, R2-E6, R2-G3, glossary §29.6). Synthetic templates are registered under test-only ids (T_FUZZ_*) so the
// rendered lengths are exact; every assertion is on codes, template ids, typed params and lengths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerClaudeCatalog, renderClaude } from '../../src/i18n/claude.js';
import { claudeLang, resolveHumanLang } from '../../src/i18n/locale.js';
import { composeReply, finishReply, eventDeliverStep, carrierContextStep, CARRIER_CAPS, CarrierCodeRefused, codeOnlyDigest, codeOnlyDigestOf, dropDigestSeat, type CarrierItem, type CarrierKind, type DigestPort, type ReplyOutcome, type SlotExtraPort } from '../../src/claude/daemon/carriers.js';
import { TurnItems } from '../../src/claude/daemon/stop.js';
import { guardRow, type HoldRecord } from '../../src/holds/record.js';
import type { DaemonCtx, HookRequest, ReplyDraft } from '../../src/claude/daemon/ctx.js';
import { STEP_ORDER } from '../../src/claude/daemon/pipeline.js';
import { encodeOutput, type HookOutput } from '../../src/claude/client/output.js';
import type { HookEvent, ReplyFrame } from '../../src/claude/wire/frames.js';
import { CCI_CODES, ROUTED_CODES, PULL_MODE_SUPPRESSED } from '../../src/claude/wire/codes.js';
import { C } from '../../src/claude/wire/constants.js';
import { BudgetMeter } from '../../src/claude/daemon/meter.js';
import { EventStore } from '../../src/claude/daemon/events.js';
import { VirtualClock } from '../sim/vclock.js';
import { TraceRecorder } from '../sim/traceRecorder.js';
import { noDueRequests } from '../../src/claude/daemon/claudeDaemon.js';
import { seededRandom } from '../../src/ports/random.js';
import type { Seat } from '../../src/claude/daemon/seats.js';

// The overflow rows of 07 (the test rows the plan pins; an identical re-registration is a no-op) and the exact-length
// synthetics this file packs with.
registerClaudeCatalog('en', {
  'T-MORE': { text: 'and {k} more: {where}', params: { k: 'n', where: 'label' } },
  'T-STOP.more': { text: 'and {k} more: cowork_status', params: { k: 'n' } },
  'T-AHEAD.more': { text: 'and {k} more: {file}', params: { k: 'n', file: 'path' } },
  T_FUZZ_45: { text: 'y'.repeat(45) },
  T_FUZZ_100: { text: 'z'.repeat(100) },
  T_FUZZ_EXTRA: { text: 'e'.repeat(300) },
  T_FUZZ_240: { text: 'b'.repeat(240) },
  T_FUZZ_300: { text: 'f'.repeat(300) },
  T_FUZZ_900: { text: 'k'.repeat(900) },
  T_FUZZ_700: { text: 'c'.repeat(700) },
  T_FUZZ_1000: { text: 's'.repeat(1000) },
  T_FUZZ_1100: { text: 'q'.repeat(1100) },
  T_FUZZ_120: { text: 'g'.repeat(120) },
  T_FUZZ_99: { text: 'm'.repeat(99) },
  STANDING_RULES: { text: 'r'.repeat(1000) },
  HELDREG: { text: '[cowork-sync] HELDREG {reason}', params: { reason: 'note' } },
  'T-NOTE': { text: 'note: {t}', params: { t: 'note' } },
  T_FUZZ_LANG: { text: 'the lang line' },
});

// I9 (X-53, F2 #41 #56): the lang cell needs both halves of one template — the same id under the two Claude-facing languages.
registerClaudeCatalog('ko', {
  T_FUZZ_LANG: { text: '언어 줄' },
});

const noOpts = { pullMode: false, deny: null, block: null };

/** Every composeReply call of this file goes through pack, which records the outcome for the last test's sweep
 *  ("no carrier item carries an unregistered code", plan:2859; F2 #38). */
const OUTCOMES: ReplyOutcome[] = [];
const pack = (...a: Parameters<typeof composeReply>): ReplyOutcome => {
  const r = composeReply(...a);
  OUTCOMES.push(r);
  return r;
};

const SEAT_A = 'a'.repeat(32);

const item = (o: Partial<CarrierItem> & { code?: string }): CarrierItem => ({
  code: o.code ?? '', params: o.params ?? {}, eventId: o.eventId ?? null, family: o.family ?? 'note',
  mandatory: o.mandatory ?? false, slot: o.slot ?? 'digest', tier: o.tier ?? 0, template: o.template,
});

const fuzzN = (len: number, o: Partial<CarrierItem> = {}): CarrierItem =>
  item({ template: `T_FUZZ_${len}`, ...o });

const denyOf = (form: 'T1' | 'T1R' | 'other', code = 'HELDREG', params: Record<string, string | number | null> = { reason: 'x' }): ReplyDraft['deny'] => ({ code, params, form });

/** An ATTRIBUTION slot item whose code line is 31 + vLen chars ('[cowork-sync] ATTRIBUTION peer=' + the value). */
const attribution = (vLen: number, o: Partial<CarrierItem> = {}): CarrierItem =>
  item({ code: 'ATTRIBUTION', params: { peer: 'x'.repeat(vLen) }, slot: 'attribution', eventId: null, ...o });

/** The two parts of a plain post text, rebuilt from packed (output order): the coordination block (every non-slot
 *  line and its MORE) and the attribution slot. */
function postParts(r: { packed: readonly CarrierItem[] }): { event: string; slot: string } {
  const line = (i: CarrierItem): string => (i.template !== undefined ? renderClaude(i.template, i.params, 'en') : renderClaude(i.code, i.params, 'en'));
  const text = r.packed.filter((i) => i.slot !== 'system');
  return { event: text.filter((i) => i.slot !== 'attribution').map(line).join('\n'), slot: text.filter((i) => i.slot === 'attribution').map(line).join('\n') };
}

test('composeReply applies each carrier cap of 06 §3.14.1 and the 2,000-char preview', () => {
  // One row per kind: feed items whose total is the cap + 1 char; every result stays under the cap and the
  // returned chars equals text.length + (system?.length ?? 0).
  const rows: ReadonlyArray<{ kind: CarrierKind; cap: number; deny?: ReplyDraft['deny']; block?: ReplyDraft['block'] }> = [
    { kind: 'session_start', cap: C.CAPS.PREVIEW },
    { kind: 'subagent_start', cap: C.CAPS.PREVIEW },
    { kind: 'ups', cap: C.CAPS.UPS_DELTA },
    { kind: 'pre_deny', cap: C.CAPS.T1, deny: denyOf('T1') },
    { kind: 'pre_deny', cap: C.CAPS.DENY, deny: denyOf('other') },
    { kind: 'pre_deny', cap: C.CAPS.T1R, deny: denyOf('T1R') },
    { kind: 'pre_context', cap: C.CAPS.G2G3 },
    { kind: 'post', cap: C.CAPS.POST_EVENT },
    { kind: 'post', cap: C.CAPS.K2, block: { code: 'HELD_CS', params: {} } },
    { kind: 'post_failure', cap: C.CAPS.POST_EVENT },
    { kind: 'stop', cap: C.CAPS.STOP, block: { code: 'STOP_SUMMARY', params: { items: '[]' } } },
  ];
  for (const row of rows) {
    // One 100-char line plus filler so the offered total crosses the cap by 1: the packer must stay under it.
    const per = 100;
    const need = row.cap + 1 - (row.deny !== null && row.deny !== undefined || row.block !== null && row.block !== undefined ? 2 : 0);
    const count = Math.ceil(need / (per + 1)) + 1;
    const items: CarrierItem[] = [];
    for (let i = 0; i < count; i++) items.push(fuzzN(100, { eventId: `ev${i}`, tier: i }));
    const deny = row.deny !== null && row.deny !== undefined ? { ...row.deny, params: { reason: 'x'.repeat(50) } } : null;
    const r = pack(row.kind, items, 'en', { pullMode: false, deny, block: row.block ?? null });
    assert.ok(r.text.length <= row.cap, `${row.kind}: text ${r.text.length} > ${row.cap}`);
    if (row.block === null || row.block === undefined) assert.ok(r.system === null || r.system.length <= CARRIER_CAPS[row.kind].system);
    assert.equal(r.chars, r.text.length + (r.system?.length ?? 0));
  }
  // session_start / subagent_start: the 2,500 row is bounded by the 2,000 preview (A7-8).
  assert.equal(CARRIER_CAPS.session_start.text, 2500);
  const big = Array.from({ length: 30 }, (_, i) => fuzzN(100, { eventId: `e${i}`, tier: i }));
  const ss = pack('session_start', big, 'en', noOpts);
  assert.ok(ss.text.length <= C.CAPS.PREVIEW);
  // RULES block ≤ 1,000, digest block ≤ 1,500 inside the session packing.
  const rules = item({ code: 'STANDING_RULES', slot: 'rules' });
  const r2 = pack('session_start', [rules, ...Array.from({ length: 40 }, (_, i) => fuzzN(100, { eventId: `d${i}`, tier: i }))], 'en', noOpts);
  assert.ok(r2.text.length <= C.CAPS.PREVIEW);
  // post with the attribution slot (F2 #12, plan:2856): event items crossing 1,000 plus slot items totalling 601 —
  // the coordination block ≤ 1,000 and the slot ≤ 600, the slot after the block.
  const events = Array.from({ length: 10 }, (_, i) => fuzzN(100, { eventId: `p${i}`, tier: i + 1 }));
  const slotItems = [attribution(269, { tier: 0 }), fuzzN(300, { slot: 'attribution', eventId: 'x1', tier: 0 })];   // 300 + 1 + 300 = 601
  const rp = pack('post', [...slotItems, ...events], 'en', noOpts);
  const parts = postParts(rp);
  assert.ok(parts.event.length <= C.CAPS.POST_EVENT, `post event part ${parts.event.length}`);
  assert.ok(parts.slot.length <= C.CAPS.POST_SLOT, `post slot part ${parts.slot.length}`);
  assert.equal(rp.text, [parts.event, parts.slot].filter((s) => s !== '').join('\n'), 'the slot follows the coordination block');
  assert.equal(rp.chars, rp.text.length + (rp.system?.length ?? 0));
});

test('overflow becomes one template-only item naming the dropped count; dropped events stay pending', () => {
  // 12 bystander items of 240 rendered chars into a ups delta (cap 1,500): 6 items take 1,445 chars and fit beside
  // the overflow line (25 chars, total 1,471); a seventh would pass 1,500.
  const items = Array.from({ length: 12 }, (_, i) => fuzzN(240, { eventId: `e${i}`, family: 'bystander', tier: i }));
  const r = pack('ups', items, 'en', noOpts);
  assert.equal(r.more?.template, 'T-MORE');                                  // template-only, no message code (R5-60)
  assert.deepEqual(r.more?.params, { k: 6, where: 'cowork_status' });
  assert.deepEqual(r.eventIds, ['e0', 'e1', 'e2', 'e3', 'e4', 'e5']);      // only the included events are listed
  assert.equal(r.overflow, 6);                                             // the other 6 stay pending in the store
  assert.equal(r.text.length, 1471);                                       // 1,445 + the 25-char MORE line + 1
  assert.ok(r.text.length <= C.CAPS.UPS_DELTA);
  assert.ok(r.text.endsWith('and 6 more: cowork_status'));
  // On stop the overflow item is T-STOP.more {k} (R2-E2); the riders are digest-family items (a note never rides).
  const stop = pack('stop', Array.from({ length: 12 }, (_, i) => fuzzN(240, { eventId: `s${i}`, family: 'digest', tier: i })), 'en',
    { pullMode: false, deny: null, block: { code: 'STOP_SUMMARY', params: { items: '[]' } } });
  assert.equal(stop.more?.template, 'T-STOP.more');
  assert.deepEqual(stop.more?.params, { k: 8 });   // the stop cap is 1,200: four 240-char lines plus the MORE
  assert.equal(stop.overflow, 8);
  assert.ok(stop.text.length <= C.CAPS.STOP);
});

test('a CLAIM_AHEAD overflow points to cowork_show({file}) instead of cowork_status', () => {
  // The compose-level row pins the T-AHEAD.more row (the slot collapse itself is exercised at finishReply below).
  const r = pack('post', [item({ code: '', template: 'T-AHEAD.more', params: { k: 2, file: 'billing/tax.ts' }, slot: 'attribution' })], 'en', noOpts);
  assert.ok(r.text.includes('and 2 more: billing/tax.ts'));
});

test('the attribution slot carries ATTRIBUTION first and a SlotExtraPort item only when both fit in 600', () => {
  // finishReply-level: the slot of a post reply. The doubles record the calls.
  type Call = { seatId: string; agentId: string | null; charsLeft: number; held: readonly string[] };
  const makeCtx = (calls: Call[], ret: (c: Call) => CarrierItem | null) => ctxDouble({ postExtra: (seatId, agentId, charsLeft, held) => { const c = { seatId, agentId, charsLeft, held }; calls.push(c); return ret(c); } });
  const attrLen = (vLen: number): CarrierItem => item({ code: 'ATTRIBUTION', params: { peer: 'x'.repeat(vLen) }, slot: 'attribution', eventId: null });
  // '[cowork-sync] ATTRIBUTION peer=' = 31 chars; 330 → 361, 169 → 200.
  assert.equal(31 + 330, 361);
  {
    const calls: Call[] = [];
    const ctx = makeCtx(calls, () => fuzzN(300, { slot: 'attribution' }));
    const frame = finishPost(ctx, [attrLen(330)]);
    assert.deepEqual(calls[0]?.charsLeft, 239);                              // 600 − 361
    assert.deepEqual(calls[0]?.held, []);
    assert.ok(frame.text.includes('[cowork-sync] ATTRIBUTION'));             // ATTRIBUTION first
    assert.ok(!frame.text.includes('fff'));                                  // the 300-char item is left out
  }
  {
    const calls: Call[] = [];
    const ctx = makeCtx(calls, () => fuzzN(300, { slot: 'attribution' }));
    const frame = finishPost(ctx, [attrLen(169)]);
    assert.deepEqual(calls[0]?.charsLeft, 400);                              // 600 − 200: both ride
    const slot = frame.text.split('\n').slice(0, 2).join('\n');
    assert.ok(slot.length <= C.CAPS.POST_SLOT);
    assert.ok(frame.text.includes('fff'));                                   // the extra item rides
  }
  {
    const calls: Call[] = [];
    const ctx = makeCtx(calls, () => fuzzN(300, { slot: 'attribution' }));
    finishPost(ctx, []);                                                     // no ATTRIBUTION: charsLeft 600, held []
    assert.deepEqual(calls[0]?.charsLeft, 600);
    assert.deepEqual(calls[0]?.held, []);
  }
  {
    const calls: Call[] = [];
    const ctx = makeCtx(calls, () => fuzzN(300, { slot: 'attribution' }));
    finishPost(ctx, [item({ code: 'ATTRIBUTION', params: { peer: 'x'.repeat(169), claims: 'c1' }, slot: 'attribution' })]);
    assert.deepEqual(calls[0]?.held, ['c1']);                                // the held variant names its claims (V-10, O-7)
  }
  {
    const calls: Call[] = [];
    const ctx = ctxDouble({ postExtra: null });
    const frame = finishPost(ctx, [attrLen(169)]);
    assert.equal(calls.length, 0);                                           // slotExtra bound to null: no call (F05-04)
    assert.ok(frame.text.includes('[cowork-sync] ATTRIBUTION'));
  }
});

test('the PostToolUse attribution slot has its own 600 beside the 1,000 event block, ATTRIBUTION first in the slot (06 §3.14.1)', () => {
  // 06:618 "at most one coordination event + the attribution slot (600 in total): ATTRIBUTION first, then …
  // CLAIM_AHEAD / CLAIM_AHEAD_ENDED when both fit | 1,000 + 600"; plan:1566, plan:2856.
  const event = fuzzN(700, { family: 'digest', slot: 'context', tier: 1 });
  {   // (a) a 700-char event and a 361-char ATTRIBUTION: both ride (1,062 chars)
    const a361 = attribution(330);
    const frame = finishPost(ctxDouble({ postExtra: null }), [event, a361]);
    assert.equal(frame.text, 'c'.repeat(700) + '\n' + renderClaude('ATTRIBUTION', a361.params, 'en'));
    assert.equal(frame.text.length, 1062);
  }
  {   // (b) ATTRIBUTION (200, tier 5) and a 300-char SlotExtraPort item (tier 0): event, then ATTRIBUTION, then the extra
    const a200 = attribution(169, { tier: 5 });
    const ctx = ctxDouble({ postExtra: () => fuzzN(300, { slot: 'attribution', tier: 0 }) });
    const frame = finishPost(ctx, [event, a200]);
    assert.equal(frame.text, ['c'.repeat(700), renderClaude('ATTRIBUTION', a200.params, 'en'), 'f'.repeat(300)].join('\n'));
    assert.equal(frame.text.length, 1202);   // slot part 200 + 1 + 300 = 501 ≤ 600
  }
});

test('items are packed in DigestPort.rank order and a mandatory item is never displaced by a non-mandatory one', () => {
  const items = [
    item({ code: '', template: 'T_FUZZ_45', family: 'bystander', tier: 5, eventId: 'b1' }),
    item({ code: 'OWN_CHANGE_HELD', params: { reason: 'wake-scope' }, family: 'own_change_held_wake', mandatory: true, tier: 9, eventId: 'm1' }),
    item({ code: '', template: 'T_FUZZ_45', family: 'bystander', tier: 2, eventId: 'b2' }),
    item({ code: '', template: 'T_FUZZ_45', family: 'bystander', tier: 4, eventId: 'b3' }),
    item({ code: '', template: 'T_FUZZ_45', family: 'bystander', tier: 1, eventId: 'b4' }),
    item({ code: '', template: 'T_FUZZ_45', family: 'bystander', tier: 3, eventId: 'b5' }),
  ];
  const r = pack('post', items, 'en', { pullMode: false, deny: null, block: { code: 'HELD_CS', params: {} } });
  const lines = r.text.split('\n');
  assert.ok(lines[0]!.startsWith('[cowork-sync] HELD_CS'));                 // the block reason first
  assert.ok(r.text.includes('[cowork-sync] OWN_CHANGE_HELD'));            // the mandatory item kept whole
  assert.deepEqual(r.eventIds, ['m1', 'b4', 'b2', 'b5', 'b3', 'b1']);       // mandatory first, then rank order (b3 tier 4 crosses 1,000)
  // The packed result fingerprints the offered order: the reason, the mandatory line, then tier 1,2,3,4,5 lines.
  const fingerprint = r.text.split('\n').map((l) => (l.includes('OWN_CHANGE_HELD') ? 'm' : l.length === 45 ? 'y' : 'x')).join('');
  assert.equal(fingerprint, ['x', 'm', 'y', 'y', 'y', 'y', 'y'].join(''));
});

test('a mandatory block rider that exactly fits is kept, and the MORE line never displaces it (F2 #15)', () => {
  // plan:2861 "the block reason and the mandatory item are kept whole"; MANDATORY_FAMILIES / 06:725 "never suppressed,
  // only shortened". The reason (900) + '\n' + the mandatory rider (99) is exactly the 1,000 K2 cap.
  const block = { code: 'T_FUZZ_900', params: {} };
  const m1 = fuzzN(99, { mandatory: true, family: 'own_change_held_wake', eventId: 'm1' });
  const a = pack('post', [m1], 'en', { pullMode: false, deny: null, block });
  assert.equal(a.text, 'k'.repeat(900) + '\n' + 'm'.repeat(99));
  assert.equal(a.text.length, C.CAPS.K2);
  assert.deepEqual(a.eventIds, ['m1']);
  assert.equal(a.overflow, 0);
  assert.equal(a.more, null);
  // A bystander that cannot fit: the MORE line is carried, the mandatory rider stays, the reason yields (874 chars).
  const b = pack('post', [m1, fuzzN(45, { family: 'bystander', eventId: 'b1' })], 'en', { pullMode: false, deny: null, block });
  assert.ok(b.text.includes('m'.repeat(99)), 'the mandatory rider is never popped for the MORE line');
  assert.deepEqual(b.eventIds, ['m1']);
  assert.ok(b.text.endsWith('and 1 more: cowork_status'));
  assert.equal(b.overflow, 1);
  assert.ok(b.text.length <= C.CAPS.K2, `text ${b.text.length}`);
  const first = b.text.split('\n')[0]!;
  assert.ok(first.startsWith('k'));
  assert.equal(first.length, 874, 'the reason is shortened to make room: 1,000 − (99 + 1) − (25 + 1)');
});

test('the block reason keeps its code line and the K2 cap holds when mandatory riders fill it: the last mandatory rider yields to the MORE line (F2 #15)', () => {
  // Found by the 06 test 31 fuzz (300 runs, 64/200-char params): mandatory riders that fill the K2 budget left no room
  // for the MORE line, the reason was cut to '' and the text passed 1,000 (INV-CCI-CAP). The reason is never cut below
  // its code line; a mandatory rider that does not fit beside it and the MORE line yields (counted in the MORE, its
  // store row not listed, so it stays pending for the next carrier).
  const block = { code: 'HELD_CS', params: {} };
  const reason = renderClaude('HELD_CS', {}, 'en');
  const budget = C.CAPS.K2 - reason.length;                      // the riders' room, each line + 1
  const ownLine = (len: number, eventId: string): CarrierItem =>   // '[cowork-sync] OWN_CHANGE_HELD rid=' is 34 chars
    item({ code: 'OWN_CHANGE_HELD', params: { rid: 'x'.repeat(len - 34) }, family: 'own_change_held_wake', mandatory: true, eventId });
  const m1 = ownLine(600, 'm1');
  const m2 = ownLine(budget - 601 - 1, 'm2');                     // m1 + m2 with their separators fill the budget exactly
  assert.equal(renderClaude(m1.code, m1.params, 'en').length, 600);
  const r = pack('post', [m1, m2, fuzzN(45, { family: 'bystander', eventId: 'b1' })], 'en', { pullMode: false, deny: null, block });
  assert.ok(r.text.length <= C.CAPS.K2, `text ${r.text.length} > ${C.CAPS.K2}`);
  const lines = r.text.split('\n');
  assert.equal(lines[0], reason, 'the reason code line is whole');
  assert.equal(lines[1], renderClaude(m1.code, m1.params, 'en'), 'the first mandatory rider rides');
  assert.deepEqual(r.eventIds, ['m1'], 'the yielded mandatory rider is not listed (it stays pending)');
  assert.equal(r.overflow, 2);
  assert.ok(r.text.endsWith('and 2 more: cowork_status'));
  assert.equal(lines.length, 3);
});

test('SessionStart and SubagentStart put every conflict and held line within the first 1,500 chars', () => {
  const conflict = (i: number): CarrierItem => fuzzN(45, { family: 'conflict', eventId: `c${i}`, tier: i });
  const held = (i: number): CarrierItem => fuzzN(45, { family: 'held', eventId: `h${i}`, tier: 100 + i });
  const other = (i: number): CarrierItem => fuzzN(45, { family: 'digest', eventId: `o${i}`, tier: 200 + i });
  const rules = item({ code: 'STANDING_RULES', slot: 'rules', eventId: null });
  // 30 conflict + 10 held + the 1,000-char RULES + 20 others: the block keeps 21 whole lines (965 chars) and ends
  // with its MORE; RULES follows whole; the total is 1,992 and no other digest line fits.
  const items = [...Array.from({ length: 30 }, (_, i) => conflict(i)), ...Array.from({ length: 10 }, (_, i) => held(i)), rules, ...Array.from({ length: 20 }, (_, i) => other(i))];
  const r = pack('session_start', items, 'en', noOpts);
  assert.equal(r.overflow, 19);                                             // 9 remaining conflicts + 10 held stay pending, named by the MORE
  assert.ok(r.text.length <= C.CAPS.PREVIEW);
  assert.ok(r.text.includes('and 19 more: cowork_status'));                 // the block's own MORE line
  assert.ok(r.text.indexOf('and 19 more: cowork_status') < r.text.indexOf('rrr'));   // the MORE ends the block, RULES follows
  assert.ok(r.text.includes('rrr'.repeat(1)));                              // RULES (1,000 r's) rides whole
  // With 4 conflict and 2 held instead: all 6 come first, RULES follows, and 15 of the 20 others fit — the
  // dropped five are named by the others' MORE (the block kept everything, so this one is the only overflow).
  const items2 = [...Array.from({ length: 4 }, (_, i) => conflict(i)), ...Array.from({ length: 2 }, (_, i) => held(i)), rules, ...Array.from({ length: 20 }, (_, i) => other(i))];
  const r2 = pack('session_start', items2, 'en', noOpts);
  assert.equal(r2.overflow, 5);
  assert.ok(r2.text.length <= C.CAPS.PREVIEW);
  assert.ok(r2.text.includes('and 5 more: cowork_status'));
  assert.ok(r2.text.endsWith('and 5 more: cowork_status'));                 // the others' MORE closes the reply
});

test("the session block's MORE line counts inside the block bound: RULES rides whole and the text stays ≤ 2,000 (INV-CCI-CAP; F2 #38)", () => {
  // Found by the 06 test 31 fuzz (300 runs, 64/200-char params): block lines that filled min(1,500, 2,000 − RULES − 1)
  // left the block's MORE line outside that bound, so RULES pushed the text past the 2,000 preview. Here the block
  // keeps 900 + 46 + 46 = 992 ≤ 999 chars, a fourth conflict line cannot fit, and the MORE (+ 26) would end at 1,018.
  const rules = item({ code: 'STANDING_RULES', slot: 'rules', eventId: null });
  const items = [
    fuzzN(900, { family: 'conflict', eventId: 'c0', tier: 0 }),
    fuzzN(45, { family: 'conflict', eventId: 'c1', tier: 1 }),
    fuzzN(45, { family: 'held', eventId: 'c2', tier: 2 }),
    fuzzN(45, { family: 'held', eventId: 'c3', tier: 3 }),
    rules,
  ];
  for (const kind of ['session_start', 'subagent_start'] as const) {
    const r = pack(kind, items, 'en', noOpts);
    assert.ok(r.text.length <= C.CAPS.PREVIEW, `${kind}: text ${r.text.length} > ${C.CAPS.PREVIEW}`);
    const lines = r.text.split('\n');
    assert.equal(lines.at(-1), 'r'.repeat(1000), `${kind}: RULES rides whole, after the block`);
    const more = lines.indexOf('and 2 more: cowork_status');
    assert.ok(more > 0, `${kind}: the block's MORE names the two lines that yielded`);
    assert.ok(lines.slice(0, more).join('\n').length + 1 + lines[more]!.length <= C.CAPS.PREVIEW - 1000 - 1, `${kind}: the block and its MORE stay within 999`);
    assert.deepEqual(r.eventIds, ['c0', 'c1']);
    assert.equal(r.overflow, 2);
  }
});

test('two rules-slot items: the block bound counts the separator between the RULES lines, so the text stays ≤ 2,000 (INV-CCI-CAP; F2 #38 fix round 1)', () => {
  // Review finding (ROBUST r1): rulesLen summed the rendered RULES lengths without the '\n' between them, so two
  // 500-char rules items plus ten 99-char conflict lines reached 2,001. 2,000 − (500 + 1 + 500) − 1 = 998 leaves room
  // for nine block lines (9 × 99 + 8 = 899) and the MORE (+ 26), never ten.
  registerClaudeCatalog('en', { T_RULES_500: { text: 'u'.repeat(500) } });
  const items = [
    ...Array.from({ length: 10 }, (_, i) => fuzzN(99, { family: 'conflict', eventId: `c${i}`, tier: i })),
    item({ template: 'T_RULES_500', family: 'rules', slot: 'rules', tier: 20 }),
    item({ template: 'T_RULES_500', family: 'rules', slot: 'rules', tier: 20 }),
  ];
  for (const kind of ['session_start', 'subagent_start'] as const) {
    const r = pack(kind, items, 'en', noOpts);
    assert.ok(r.text.length <= C.CAPS.PREVIEW, `${kind}: text ${r.text.length} > ${C.CAPS.PREVIEW}`);
    const lines = r.text.split('\n');
    assert.deepEqual(lines.slice(-2), ['u'.repeat(500), 'u'.repeat(500)], `${kind}: both RULES lines ride whole, last`);
    assert.ok(r.overflow > 0, `${kind}: a block line that does not fit is named by the MORE`);
    assert.equal(r.eventIds.length + r.overflow, 10, `${kind}: every block line is shown or counted`);
  }
});

test('a Stop with thousands of STOP_SUMMARY entries finds its whole-entry fit without a quadratic scan (F2 #38 fix round 1)', () => {
  // Review finding (ROBUST r1): the fit walked n down from the last entry and rendered every prefix, ~N²/2 entry
  // renders (5,000 entries took 20.9 s on the daemon's one event loop). The search now renders O(log) prefixes of at
  // most about twice the cap. The bound below is ~6× under the old cost at this size and ~10× over the new one, so a
  // loaded PC cannot flip it either way. The fit is unchanged: the largest prefix that fits with its T-STOP.more line.
  const n = 4000;
  const entries = Array.from({ length: n }, (_, i) => ({ agent: null, kind: 'denied', id: 'SHD-' + String(i).padStart(5, '0') }));
  const params = { items: JSON.stringify(entries), asks: '[]' };
  const t0 = performance.now();
  const r = pack('stop', [], 'en', { pullMode: false, deny: null, block: { code: 'STOP_SUMMARY', params } });
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `composeReply took ${ms.toFixed(0)} ms for ${n} entries`);
  assert.ok(r.text.length <= C.CAPS.STOP, `text ${r.text.length} > ${C.CAPS.STOP}`);
  const [reason, moreLine] = r.text.split('\n');
  const shown = JSON.parse(reason!.slice(reason!.indexOf(' items=') + ' items='.length)) as unknown[];
  assert.ok(shown.length > 0, 'whole entries are shown');
  assert.equal(shown.length + r.overflow, n, 'the shown entries plus the MORE count are every entry');
  assert.equal(moreLine, `and ${r.overflow} more: cowork_status`);
  const nextLen = renderClaude('STOP_SUMMARY', { ...params, items: JSON.stringify(entries.slice(0, shown.length + 1)) }, 'en').length
    + 1 + `and ${r.overflow - 1} more: cowork_status`.length;
  assert.ok(nextLen > C.CAPS.STOP, 'one more entry would not fit: the fit is the largest whole-entry prefix');
});

test('PULL_MODE drops exactly the PULL_MODE_SUPPRESSED families and shortens a G1 to T1R', () => {
  const items = [
    item({ code: 'ATTRIBUTION', eventId: 'a1' }),
    item({ code: 'CLAIM_AHEAD', params: { file: 'a.ts', n: 1 }, eventId: 'a2' }),
    item({ code: 'CLAIM_AHEAD_ENDED', eventId: 'a3' }),
    item({ code: 'SINCE_POINTER', eventId: 'a4' }),
    item({ code: 'CS_UNPUBLISHED_NUDGE', params: { n: 1 }, eventId: 'a5' }),
    item({ code: '', template: 'T_FUZZ_45', family: 'bystander', eventId: 'a6' }),
    item({ code: 'OWN_CHANGE_HELD', params: { reason: 'wake-scope' }, family: 'own_change_held_wake', eventId: 'k1' }),
    item({ code: '', template: 'T_FUZZ_45', family: 'digest', eventId: 'g1' }),
  ];
  const r = pack('ups', items, 'en', { pullMode: true, deny: null, block: null });
  for (const code of PULL_MODE_SUPPRESSED) {
    if (code === 'bystander') assert.ok(!r.text.split('\n').filter((l) => l === 'yyy'.repeat(15)).some((_, i) => i > 0), 'bystander dropped: exactly the digest G1 line remains');
    else assert.ok(!r.text.includes(`[cowork-sync] ${code}`), `${code} dropped`);
  }
  assert.deepEqual(r.suppressed, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);      // their event ids, in offer order
  assert.ok(r.text.includes('[cowork-sync] OWN_CHANGE_HELD'));             // the wake-scope PIN stays (its registered code line)
  assert.ok(r.text.includes('yyy'.repeat(15)));                              // every G1 (digest) stays
  // A T1 deny is rendered with form T1R and ≤ 300 chars under PULL_MODE (CCI-46).
  const long = { code: 'HELDREG', params: { reason: 'w'.repeat(250) }, form: 'T1' as const };
  const rd = pack('pre_deny', [], 'en', { pullMode: true, deny: long, block: null });
  assert.ok(rd.text.length <= C.CAPS.T1R);
  assert.equal(rd.decision, 'deny');
});

test('sanitize truncates placeholders, never whole templates', () => {
  // A HELDREG deny whose {reason} param is 5,000 chars: the rendered reason still starts with the HELDREG code
  // line and the param is cut (note cap), total ≤ 800.
  const r = pack('pre_deny', [], 'en', { pullMode: false, deny: { code: 'HELDREG', params: { reason: 'w'.repeat(5000) }, form: 'other' }, block: null });
  assert.ok(r.text.startsWith('[cowork-sync] HELDREG'));
  assert.ok(r.text.length <= C.CAPS.DENY);
  assert.ok(r.text.length < 500);
});

test('teammate free text never reaches a deny or block reason', () => {
  const note = item({ code: '', template: 'T-NOTE', params: { t: 'm'.repeat(280) }, family: 'note', eventId: 'n1' });
  for (const [kind, o] of [
    ['pre_deny', { pullMode: false, deny: denyOf('other'), block: null }],
    ['post', { pullMode: false, deny: null, block: { code: 'HELD_CS', params: {} } }],
    ['stop', { pullMode: false, deny: null, block: { code: 'STOP_SUMMARY', params: { items: '[]' } } }],
  ] as const) {
    const r = pack(kind, [note], 'en', o);
    assert.ok(!r.text.includes('mmm'), `${kind}: the note never rides a deny/block`);
    assert.equal(r.overflow, 0);                                            // it is not counted as overflow either
  }
  const ups = pack('ups', [note], 'en', noOpts);
  assert.ok(ups.text.startsWith('note: mmm'));                              // on ups it rides as context
  assert.ok(ups.text.length <= 286);                                        // 'note: ' + the 280-char capped note
});

test('no reply carries an OSC 9 terminal sequence', () => {
  for (const kind of ['session_start', 'subagent_start', 'ups', 'pre_context', 'post', 'post_failure', 'stop'] as const) {
    const r = pack(kind, [item({ code: 'ATTRIBUTION', params: { peer: 'p' }, eventId: null }), item({ code: '', template: 'T_FUZZ_45' })], 'en', noOpts);
    assert.ok(!r.text.includes('\u001b]9;'));
    assert.ok(!r.text.includes('\u001b]'));
    assert.ok(r.system === null || !r.system.includes('\u001b]9;'));
  }
});

test('no edit-check family exists on any carrier', () => {
  // PULL_MODE_SUPPRESSED ∩ {every UI_FLOW_LAST_* code} = ∅.
  for (const s of PULL_MODE_SUPPRESSED) assert.ok(!s.startsWith('UI_FLOW_LAST_'));
  assert.throws(() => pack('post', [item({ code: 'UI_FLOW_LAST_FAIL' })], 'en', noOpts), CarrierCodeRefused);
});

// ---- codeOnlyDigest over the registry and the read sets (plan:1593, plan:2915–2918, HLD-22; F2 #2 #33) -------------------

const SEAT_T = 'b'.repeat(32);
const REVERT = guardRow('revert')!;
/** A HoldRecord (src/holds/record.ts) with one Table 3 'revert' guard, ON_DISK ACTIVE on one path. */
const hold = (id: string, kind: HoldRecord['kind'], origin: string, path: string): HoldRecord => ({
  id, rev: 1, owner: 'peer-1' as HoldRecord['owner'], kind, residence: 'ON_DISK', state: 'ACTIVE', offer: 'none', declines: 0, displaced_by: null,
  paths: [path], blobs: { h0: {}, h1: {} }, guards: [{ name: 'revert', class: REVERT.cls, owner: REVERT.owner }],
  origin, cs_ids: [], peer_authors: [], local_only: false, age_anchor: { since_rev: 1, anchor_wall_ms: 0, mono_accum_ms: 0 }, proto: 1,
});
const H1 = hold('01JAXZ000000000000000000H1', 'PIN', SEAT_A, 'src/a.ts');     // S's own record
const H2 = hold('01JAXZ000000000000000000H2', 'PIN', SEAT_T, 'src/c.ts');     // T's, on a file S has not read
const H3 = hold('01JAXZ000000000000000000H3', 'PATCH', SEAT_T, 'src/b.ts');   // T's, on a file in S's full-read set

/** The ctx the digest reads: a registry double over `records` (read live), S's full-read set {src/b.ts}, TurnItems. */
function digestCtx(records: HoldRecord[], digest: DigestPort = codeOnlyDigest): DaemonCtx {
  const base = ctxDouble({ postExtra: null });
  const registry = { nonTerminal: () => records, get: (id: string) => records.find((x) => x.id === id) };
  return {
    ...base,
    engine: { peer: () => 'peer-1', teamLanguage: () => null, registry: () => registry } as never,
    readSets: { fullReadSet: (s: string) => (s === SEAT_A ? new Set(['src/b.ts']) : new Set<string>()) } as never,
    items: new TurnItems(),
    bindings: { ...base.bindings, digest } as never,
  } as DaemonCtx;
}

const sessionStart = (source: string, seatId = SEAT_A) =>
  requestFor('SessionStart', [], { seatId, payload: { event: 'SessionStart', source, transcript_path: null, messaging_present: true, static_policy_hits: [] } });
const ownLine = (h: HoldRecord): string => renderClaude('OWN_CHANGE_HELD', { rid: h.id, path: h.paths[0]!, reason: 'revert' }, 'en');

test('SessionStart compact|clear|resume|fork starts the digest with DIGEST_SUPERSEDES', async () => {
  // plan:2915, CCI-40 "prefixed by DIGEST_SUPERSEDES for compact, clear, resume and fork"; startup → none.
  const sup = renderClaude('DIGEST_SUPERSEDES', {}, 'en');
  const rulesLine = renderClaude('STANDING_RULES', {}, 'en');
  for (const source of ['compact', 'clear', 'resume', 'fork', 'startup']) {
    const ctx = digestCtx([H1]);
    const { r, d } = sessionStart(source);
    await carrierContextStep(r, d, ctx);
    const f = finishReply(r, d, ctx);
    const lines = f.text.split('\n');
    if (source === 'startup') { assert.ok(!f.text.includes('DIGEST_SUPERSEDES'), 'startup: no supersedes pointer'); continue; }
    assert.equal(lines[0], sup, `${source}: the first digest line is DIGEST_SUPERSEDES`);
    const iOwn = lines.indexOf(ownLine(H1));
    const iRules = lines.indexOf(rulesLine);
    assert.ok(iOwn > 0 && iRules > iOwn, `${source}: the OWN_CHANGE_HELD line follows it, before STANDING_RULES (own ${iOwn}, rules ${iRules})`);
  }
});

test("codeOnlyDigest lists STANDING_RULES as a code line, this seat's own held records and HOLD_IN_FILE for its read files, nothing else", async () => {
  // plan:2916 (R5-11, HLD-22 SessionStart half). The rules/rank cells of the replaced Task 7 test are kept.
  const rules = codeOnlyDigest.rules('s1');
  assert.deepEqual(rules.map((i) => i.code), ['STANDING_RULES']);
  assert.equal(rules[0]!.slot, 'rules');
  const ranked = codeOnlyDigest.rank([item({ tier: 2, eventId: 'x2' }), item({ tier: 1, eventId: 'x1' })]);
  assert.deepEqual(ranked.map((i) => i.eventId), ['x1', 'x2']);
  const ctx = digestCtx([H1, H2, H3]);
  const s = sessionStart('startup');
  await carrierContextStep(s.r, s.d, ctx);
  assert.deepEqual(s.d.items.map((i) => i.code), ['STANDING_RULES', 'OWN_CHANGE_HELD', 'HOLD_IN_FILE']);
  assert.deepEqual(s.d.items[1]!.params, { rid: H1.id, path: 'src/a.ts', reason: 'revert' });
  assert.deepEqual(s.d.items[2]!.params, { path: 'src/b.ts', rid: H3.id, reason: 'revert' });
  assert.deepEqual(s.d.items.slice(1).map((i) => i.family), ['held', 'held']);
  assert.ok(!JSON.stringify(s.d.items).includes(H2.id), 'nothing names H2 for S');
  // T owns H2 and H3 and has an empty read set: its own records are told whatever the read set, no HOLD_IN_FILE.
  const t = sessionStart('startup', SEAT_T);
  await carrierContextStep(t.r, t.d, ctx);
  assert.deepEqual(t.d.items.map((i) => i.code), ['STANDING_RULES', 'OWN_CHANGE_HELD', 'OWN_CHANGE_HELD']);
  assert.deepEqual(t.d.items.slice(1).map((i) => i.params['rid']), [H2.id, H3.id]);
  // The A7-11 binding directly: DIGEST_SUPERSEDES first when asked, then the held items.
  assert.deepEqual(codeOnlyDigestOf(ctx).digest(SEAT_A, 'full', { supersedes: true }).map((i) => i.code), ['DIGEST_SUPERSEDES', 'OWN_CHANGE_HELD', 'HOLD_IN_FILE']);
});

test('UserPromptSubmit carries the digest delta only when it differs from the last digest this seat saw', async () => {
  // plan:2917 (CCI-39, 06 §3.14.1 row 2): a doorbell (nonce) UserPromptSubmit carries no digest.
  const records = [H1];
  const ctx = digestCtx(records);
  const s = sessionStart('startup');
  await carrierContextStep(s.r, s.d, ctx);                                  // the full digest this seat saw
  const ups = async (doorbell: boolean): Promise<CarrierItem[]> => {
    const u = requestFor('UserPromptSubmit', [], { turn: { newTurn: true, doorbell, origin: doorbell ? 'wake' : 'human' } });
    await carrierContextStep(u.r, u.d, ctx);
    return u.d.items;
  };
  assert.deepEqual(await ups(false), [], 'the same digest: no digest item');
  const H4 = hold('01JAXZ000000000000000000H4', 'PIN', SEAT_A, 'src/d.ts');
  records.push(H4);
  const delta = await ups(false);
  assert.deepEqual(delta.map((i) => [i.code, i.params['rid']]), [['OWN_CHANGE_HELD', H4.id]], 'a changed digest: its delta');
  assert.deepEqual(await ups(false), [], 'seen: no digest item');
  const H5 = hold('01JAXZ000000000000000000H5', 'PIN', SEAT_A, 'src/e.ts');
  records.push(H5);
  assert.deepEqual(await ups(true), [], 'a doorbell prompt carries no digest');
  assert.deepEqual((await ups(false)).map((i) => [i.code, i.params['rid']]), [['OWN_CHANGE_HELD', H5.id]], 'the next prompt carries it');
});

test("dropDigestSeat forgets an ended seat's digest seen set; other seats keep theirs (F2 fix round 1)", () => {
  // Review finding (ROBUST r1): the codeOnlyDigestOf seen map was never pruned. After the drop the seat has seen
  // nothing, so a delta lists every item again; a seat that was not dropped still sees only what changed.
  const ctx = digestCtx([H1, H2, H3]);
  const port = codeOnlyDigestOf(ctx);
  const rids = (xs: CarrierItem[]): unknown[] => xs.map((i) => i.params['rid']);
  port.digest(SEAT_A, 'full', { supersedes: false });
  port.digest(SEAT_T, 'full', { supersedes: false });
  assert.deepEqual(port.digest(SEAT_A, 'delta', { supersedes: false }), [], 'seen: an empty delta');
  dropDigestSeat(ctx, SEAT_A);
  assert.deepEqual(rids(port.digest(SEAT_A, 'delta', { supersedes: false })), [H1.id, H3.id], 'dropped: nothing is seen any more');
  assert.deepEqual(port.digest(SEAT_T, 'delta', { supersedes: false }), [], 'the other seat keeps its seen set');
  dropDigestSeat(ctx, 'f'.repeat(32));   // a seat never digested: a no-op
});

test('Claude-facing text follows ctx.osLocale when no user or team language is set (X-53; F2 #41 #56)', async () => {
  // plan:1326-1327: osLocale feeds resolveHumanLang; the daemon's member is read once at start by src/daemon/run.ts —
  // claudeLangOf must never call Intl per reply (the defect read the test machine's locale, so the language followed it).
  const en = renderClaude('T_FUZZ_LANG', {}, 'en');
  const ko = renderClaude('T_FUZZ_LANG', {}, 'ko');
  assert.notEqual(en, ko, 'the two halves differ, so neither assertion can pass vacuously');
  for (const [osLocale, expected] of [
    ['ko-KR', ko], ['en-US', en],
    [null, renderClaude('T_FUZZ_LANG', {}, claudeLang(resolveHumanLang({ user: null, team: null, osLocale: null }).lang))],
  ] as const) {
    const ctx = { ...ctxDouble({ postExtra: null }), osLocale } as DaemonCtx;
    const { r, d } = requestFor('UserPromptSubmit', [item({ template: 'T_FUZZ_LANG' })]);
    const f = finishReply(r, d, ctx);
    assert.ok(f.text.includes(expected), `osLocale ${String(osLocale)}: the reply carries the ${osLocale === null ? 'fallback-locale' : osLocale.slice(0, 2)} line`);
  }
});

test('SubagentStart injects RULES and the subagent digest with conflict lines first', async () => {
  // plan:2918 (CCI-40, R2-A1 item 3).
  const calls: Array<{ seatId: string; kind: string }> = [];
  const recording: DigestPort = {
    rules: () => [item({ code: 'STANDING_RULES', slot: 'rules', family: 'rules', tier: 20 })],
    digest: (seatId, kind) => { calls.push({ seatId, kind }); return []; },
    rank: (xs) => [...xs],
  };
  const a = requestFor('SubagentStart');
  await carrierContextStep(a.r, a.d, digestCtx([H1], recording));
  assert.deepEqual(calls, [{ seatId: SEAT_A, kind: 'subagent' }], 'the subagent digest is requested once');
  const ctx = digestCtx([H1]);
  const b = requestFor('SubagentStart');
  await carrierContextStep(b.r, b.d, ctx);
  const f = finishReply(b.r, b.d, ctx);
  const lines = f.text.split('\n');
  const iOwn = lines.indexOf(ownLine(H1));
  const iRules = lines.indexOf(renderClaude('STANDING_RULES', {}, 'en'));
  assert.ok(iOwn >= 0 && iRules > iOwn, `the held line precedes RULES (own ${iOwn}, rules ${iRules})`);
  assert.ok(f.text.length <= C.CAPS.PREVIEW);
});

test('every listed event is printed: finishReply + encodeOutput round-trip over every HookEvent (INV-NOSILENT)', () => {
  // F2 #1 (06 §3.4.5, §3.14.3, INV-NOSILENT): a reply's events are marked delivered on printed, so every listed row must
  // be in what the host prints for that event — stderr for a G1, additionalContext / systemMessage / reason otherwise.
  const S = SEAT_A;
  const variants: Array<{ label: string; event: HookEvent; deny?: ReplyDraft['deny']; block?: ReplyDraft['block'] }> = [
    ...(Object.keys(STEP_ORDER) as HookEvent[]).map((event) => ({ label: event as string, event })),
    { label: 'PreToolUse deny', event: 'PreToolUse', deny: { code: 'HELDREG', params: { reason: 'x' }, form: 'other' } },
    { label: 'PostToolUse K2', event: 'PostToolUse', block: { code: 'HELD_CS', params: {} } },
    { label: 'Stop block', event: 'Stop', block: { code: 'STOP_SUMMARY', params: { items: '[]' } } },
  ];
  const problems: string[] = [];
  for (const v of variants) {
    const ctx = ctxDouble({ postExtra: null });
    const [A] = ctx.events.queueSeatContext(S, 'HOOK_ONLY', { cause: 'no_messaging' });   // a family note context row, carriers null
    const [B] = ctx.events.add(S, { code: 'WT_NOTE', params: { path: 'src/a.ts' }, family: 'digest', mandatory: false, slot: 'context' });
    const [Cs] = ctx.events.add(S, { code: 'WT_NOTE', params: { path: 'src/sys.ts' }, family: 'note', mandatory: false, slot: 'system' });
    const rows = new Map(ctx.events.pending(S).map((e) => [e.id, e]));
    const { r, d } = requestFor(v.event, [], { deny: v.deny, block: v.block });
    const reply = finishReply(r, d, ctx);
    const printed = printedOf(encodeOutput(v.event, reply));
    for (const id of reply.events) {
      const row = rows.get(id);
      if (row === undefined) { problems.push(`${v.label}: lists an unknown id`); continue; }
      if (!printed.includes(renderClaude(row.code, row.params, 'en'))) problems.push(`${v.label}: lists ${row.code} ${JSON.stringify(row.params)} (slot ${row.slot}) but does not print it`);
    }
    const pendingIds = ctx.events.pending(S).map((e) => e.id);
    if (v.label === 'Stop') {
      if (reply.events.length !== 0) problems.push(`Stop: reply.events has ${reply.events.length} ids, expected none`);
      if (reply.batch_id !== '') problems.push('Stop: a batch id without a printed row');
      if (JSON.stringify(pendingIds) !== JSON.stringify([A, B, Cs])) problems.push('Stop: A, B and Cs are not all still pending');
    }
    if (v.label === 'PostToolUseFailure') {
      if (reply.events.includes(Cs!)) problems.push('PostToolUseFailure: lists the system row Cs');
      if (!pendingIds.includes(Cs!)) problems.push('PostToolUseFailure: Cs is not pending');
    }
    if (v.label === 'PreToolUse deny' && reply.events.length !== 0) problems.push('PreToolUse deny: lists store rows');
  }
  assert.deepEqual(problems, []);
});

test('a Stop without a block leaves a HOOK_ONLY row pending and the next carrier prints it', async () => {
  const S = SEAT_A;
  const ctx = ctxDouble({ postExtra: null });
  const [A] = ctx.events.queueSeatContext(S, 'HOOK_ONLY', { cause: 'no_messaging' });
  const stop = requestFor('Stop');
  await eventDeliverStep(stop.r, stop.d, ctx);   // the pipeline's last step before finishReply
  const stopReply = finishReply(stop.r, stop.d, ctx);
  assert.deepEqual(stopReply.events, [], 'a plain Stop prints nothing, so it lists nothing');
  assert.equal(stopReply.batch_id, '');
  assert.deepEqual(ctx.events.pending(S).map((e) => e.id), [A]);
  const post = requestFor('PostToolUse');
  await eventDeliverStep(post.r, post.d, ctx);
  const postReply = finishReply(post.r, post.d, ctx);
  assert.deepEqual(postReply.events, [A]);
  const row = { code: 'HOOK_ONLY', params: { cause: 'no_messaging' } };
  assert.ok(printedOf(encodeOutput('PostToolUse', postReply)).includes(renderClaude(row.code, row.params, 'en')), 'the HOOK_ONLY line is printed by the next carrier');
});

const printedLen = (f: ReplyFrame): number => f.text.length + (f.system?.length ?? 0);
const carrierEvents = (ctx: DaemonCtx) => (ctx.trace as TraceRecorder).ofKind('carrier');

test('the meter is charged exactly what the reply prints: cap overflow, PULL_MODE, a deny, the claim-ahead slot (F2 #6)', () => {
  // 06:723 / R5-43: the meter counts every character cowork causes to be injected — what the reply prints, no more.
  const S = SEAT_A;
  const run = (ctx: DaemonCtx, req: { r: HookRequest; d: ReplyDraft }): { f: ReplyFrame; delta: number } => {
    const before = ctx.meter.usage(S).injected;
    const f = finishReply(req.r, req.d, ctx);
    const delta = ctx.meter.usage(S).injected - before;
    assert.equal(carrierEvents(ctx).at(-1)!.metered, delta, 'the carrier trace names the charged chars');   // (e)
    return { f, delta };
  };
  {   // (a) a UserPromptSubmit delta whose items pass the cap: only the six packed lines and the MORE are charged
    const ctx = ctxDouble({ postExtra: null });
    const { f, delta } = run(ctx, requestFor('UserPromptSubmit', Array.from({ length: 12 }, () => fuzzN(240, { family: 'bystander' }))));
    assert.equal(printedLen(f), 1471);
    assert.equal(delta, 1471);
  }
  {   // (b) PULL_MODE: the suppressed SINCE_POINTER is not printed, so it is not charged
    const ctx = ctxDouble({ postExtra: null });
    ctx.meter.touch(S);
    ctx.meter.charge(S, 'inject', 20001);
    assert.ok(ctx.meter.inPullMode(S));
    const { f, delta } = run(ctx, requestFor('PostToolUse', [item({ code: 'SINCE_POINTER', params: { k: 3 } }), fuzzN(45, { family: 'digest' })]));
    assert.equal(f.text, 'y'.repeat(45));
    assert.equal(delta, printedLen(f));
  }
  {   // (c) a G1 deny prints its reason only: the items under it are not charged
    const ctx = ctxDouble({ postExtra: null });
    const { f, delta } = run(ctx, requestFor('PreToolUse', [fuzzN(300)], { deny: denyOf('other') }));
    assert.ok(f.text.startsWith('[cowork-sync] HELDREG'));
    assert.equal(delta, f.text.length);
  }
  {   // (d) the claim-ahead slot item is charged to its 5,000 share (CCI-61)
    const ahead = item({ code: 'CLAIM_AHEAD', params: { file: 'billing/tax.ts', n: 1 }, slot: 'attribution' });
    const ctx = ctxDouble({ postExtra: () => ahead });
    const { f, delta } = run(ctx, requestFor('PostToolUse', []));
    const line = renderClaude('CLAIM_AHEAD', ahead.params, 'en');
    assert.ok(f.text.includes(line));
    assert.equal(ctx.meter.usage(S).claimAhead, line.length);
    assert.equal(ctx.meter.shareLeft(S, 'claim_ahead'), C.CLAIM_AHEAD_SHARE_CHARS - line.length);
    assert.equal(delta, printedLen(f));
  }
});

test('every reply emits one carrier trace event', () => {
  // plan:2921: {kind: 'carrier', peer, seat, event, chars, metered, codes, eventIds}; chars = rendered length,
  // metered = chars charged, codes in packing order (the deny/block reason code first, then each packed item's code,
  // or its template id for a template-only item); no duration or wall-time field (TST-03).
  const S = SEAT_A;
  const cases: Array<{ label: string; req: { r: HookRequest; d: ReplyDraft }; codes: string[] }> = [
    { label: 'ups', req: requestFor('UserPromptSubmit', Array.from({ length: 12 }, () => fuzzN(240, { family: 'bystander' }))),
      codes: [...Array.from({ length: 6 }, () => 'T_FUZZ_240'), 'T-MORE'] },
    { label: 'K2', req: requestFor('PostToolUse', [item({ code: 'OWN_CHANGE_HELD', params: { reason: 'wake-scope' }, family: 'own_change_held_wake', mandatory: true, eventId: 'm1' })], { block: { code: 'HELD_CS', params: {} } }),
      codes: ['HELD_CS', 'OWN_CHANGE_HELD'] },
  ];
  for (const c of cases) {
    const ctx = ctxDouble({ postExtra: null });
    const n0 = carrierEvents(ctx).length;
    const before = ctx.meter.usage(S).injected;
    const f = finishReply(c.req.r, c.req.d, ctx);
    const evs = carrierEvents(ctx).slice(n0);
    assert.equal(evs.length, 1, `${c.label}: one carrier event per reply`);
    const ev = evs[0]!;
    assert.deepEqual(Object.keys(ev).sort(), ['chars', 'codes', 'event', 'eventIds', 'kind', 'metered', 'peer', 'seat'], `${c.label}: the eight plan keys`);
    assert.equal(ev.peer, 'peer-1');
    assert.equal(ev.seat, S);
    assert.equal(ev.event, c.req.r.frame.event);
    assert.equal(ev.chars, printedLen(f), `${c.label}: chars`);
    assert.equal(ev.metered, ctx.meter.usage(S).injected - before, `${c.label}: metered`);
    assert.deepEqual(ev.codes, c.codes, `${c.label}: codes in packing order`);
    assert.deepEqual(ev.eventIds, f.events);
  }
});

/** Wraps ctx.meter.charge to record every (kind, chars) call. */
function chargeSpy(ctx: DaemonCtx): Array<[string, number]> {
  const calls: Array<[string, number]> = [];
  const meter = ctx.meter;
  const charge = meter.charge.bind(meter);
  meter.charge = (seatId, kind, chars) => { calls.push([kind, chars]); charge(seatId, kind, chars); };
  return calls;
}

test('the F04 recap and every systemMessage mirror are metered in full', () => {
  // plan:2894 (R5-43, OQ-07 (r2), F04-07, CCI-46 rev 2.5).
  const S = SEAT_A;
  {
    const ctx = ctxDouble({ postExtra: null });
    const calls = chargeSpy(ctx);
    const since = item({ code: 'SINCE_POINTER', params: { k: 'x'.repeat(270) }, slot: 'context' });
    assert.equal(renderClaude('SINCE_POINTER', since.params, 'en').length, 300);   // the code line padded to 300
    const before = ctx.meter.usage(S).injected;
    const { r, d } = requestFor('UserPromptSubmit', [fuzzN(1000, { family: 'recap', slot: 'system' }), since]);
    const f = finishReply(r, d, ctx);
    assert.equal(f.system, 's'.repeat(1000));
    assert.equal(ctx.meter.usage(S).injected - before, 1300);
    assert.deepEqual(calls, [['recap', 1000], ['inject', 300]]);
  }
  {
    const ctx = ctxDouble({ postExtra: null });
    const calls = chargeSpy(ctx);
    const before = ctx.meter.usage(S).injected;
    const { r, d } = requestFor('UserPromptSubmit', [fuzzN(120, { family: 'transition', slot: 'system' })]);
    finishReply(r, d, ctx);
    assert.equal(ctx.meter.usage(S).injected - before, 120);
    assert.deepEqual(calls, [['system', 120]]);
  }
});

test('doorbell text and Stop blocks are counted; idle seats cost nothing', () => {
  // plan:2895, the finishReply half (CCI-46; the doorbell charge itself is claude.meter.test.ts's).
  const S = SEAT_A;
  const ctx = ctxDouble({ postExtra: null });
  const before = ctx.meter.usage(S).injected;
  const { r, d } = requestFor('Stop', [], { block: { code: 'T_FUZZ_1100', params: {} } });
  const f = finishReply(r, d, ctx);
  assert.equal(f.decision, 'block');
  assert.equal(f.text, 'q'.repeat(1100));
  assert.equal(ctx.meter.usage(S).injected - before, 1100);
  assert.equal(ctx.meter.usage('c'.repeat(32)).injected, 0, 'a seat with no hook costs nothing');
});

// ---- finishReply doubles (the attribution slot cells run through the one reply assembler) --------------------------------

function ctxDouble(o: { postExtra: SlotExtraPort['postExtra'] | null }): DaemonCtx {
  const clock = new VirtualClock({ startMono: 0 });
  const events = new EventStore(clock, seededRandom('carriers-unit'), new TraceRecorder());   // distinct ids per row (an all-zero random mints one id)
  return {
    repo: { root: '/r', gitdir: '/r/.git', coworkDir: '/r/.git/cowork', dataDir: '/r/.git/cowork/data', endpointRoot: '/e' },
    ports: {} as DaemonCtx['ports'], log: {} as DaemonCtx['log'], security: {} as DaemonCtx['security'], trace: new TraceRecorder(),
    engine: { peer: () => 'peer-1', teamLanguage: () => null } as never,
    bindings: { slotExtra: o.postExtra === null ? null : { postExtra: o.postExtra }, digest: codeOnlyDigest, dueRequests: noDueRequests } as never,
    prefs: () => ({ language: null }) as never, versions: {} as never, seats: {} as never, seatLease: {} as never,
    turns: {} as never, items: {} as never, signals: {} as never, ring: {} as never,
    events, meter: new BudgetMeter(clock, () => undefined), transitions: {} as never,
    reads: {} as never, leases: {} as never, defer: {} as never, windows: {} as never,
    health: {} as never, liveness: {} as never, shadows: {} as never, views: {} as never, readSets: {} as never,
    journal: {} as never, checkpoints: {} as never, evidence: {} as never, acting: {} as never, activity: {} as never,
  } as DaemonCtx;
}

const seatDouble = (seatId: string): Seat => ({
  seatId, seatKey: 'k'.repeat(64), claudePid: 1, number: 1, aliases: [], sessionIds: new Set(), createdMono: 0,
  wiring: 'FULL', flags: new Set(), wiringCause: null, activity: 'MID_TURN', lastHookMono: 0, lastHeartbeatMono: 0,
  mcpConnected: true, ccVersion: null, pluginVersion: '0.0.0', hookProto: 3, permissionMode: 'default',
  turn: { promptId: 'p1', origin: 'human', recordedPromptId: 'p1', pending: [], lastHumanPromptMono: 0, wakeTurnStartMono: null }, ended: false,
}) as unknown as Seat;

/** A hook request for any event (the header's agent_id null); PostToolUse keeps its full payload, the other events carry
 *  the event tag only (finishReply reads the event, the seat and the header). */
function requestFor(event: HookEvent, items: CarrierItem[] = [], o: { deny?: ReplyDraft['deny']; block?: ReplyDraft['block']; seatId?: string; payload?: Record<string, unknown>; turn?: HookRequest['turn'] } = {}): { r: HookRequest; d: ReplyDraft } {
  const h = { seat_key: 'k'.repeat(64), claude_pid: 1, session_id: 's', prompt_id: null, agent_id: null, agent_type: null, permission_mode: 'default', repo_root: '/r', plugin_version: '0.0.0', hook_proto: 3 };
  const payload = o.payload ?? (event === 'PostToolUse'
    ? { event: 'PostToolUse', tool_name: 'Read', tool_use_id: 't1', path: null, read: null, exit_status: 0, command: null }
    : { event });
  return {
    r: { frame: { t: 'hook', event, h, payload } as never, seat: seatDouble(o.seatId ?? SEAT_A), startedMono: 0, extend: () => false, turn: o.turn ?? null, trigger: null },
    d: { carrier: event === 'PostToolUse' ? 'post' : 'none', items, deny: o.deny ?? null, block: o.block ?? null, done: false },
  };
}

function postRequest(items: CarrierItem[]): { r: HookRequest; d: ReplyDraft } {
  return requestFor('PostToolUse', items);
}

/** What the host shows Claude from one encoded hook output: stderr, plus additionalContext, systemMessage and reason. */
function printedOf(out: HookOutput): string {
  const parts: string[] = [out.stderr];
  if (out.stdout !== '') {
    const o = JSON.parse(out.stdout) as { hookSpecificOutput?: { additionalContext?: string }; systemMessage?: string; reason?: string };
    for (const s of [o.hookSpecificOutput?.additionalContext, o.systemMessage, o.reason]) if (typeof s === 'string') parts.push(s);
  }
  return parts.join('\n');
}

function finishPost(ctx: DaemonCtx, items: CarrierItem[]): ReturnType<typeof finishReply> {
  const { r, d } = postRequest(items);
  return finishReply(r, d, ctx);
}

// ---- the last test of the file: the sweep over every composeReply result above (node:test runs a file's top-level
// tests in order) ------------------------------------------------------------------------------------------------------

test('no carrier item carries an unregistered code', () => {
  // plan:2859 (R5-60, glossary §19): over every result of this file's packing tests (routed through pack) plus this
  // row, each packed item's code is '' (then template is set) or a member of CCI_CODES ∪ ROUTED_CODES.
  const r = pack('ups', [item({ code: 'ATTRIBUTION', eventId: null }), item({ code: '', template: 'T-MORE', params: { k: 1, where: 'cowork_status' } })], 'en', noOpts);
  for (const line of r.text.split('\n')) assert.ok(line === '' || line.startsWith('[cowork-sync] ATTRIBUTION') || line.startsWith('and 1 more'));
  assert.ok(CCI_CODES.includes('ATTRIBUTION'));
  assert.ok(ROUTED_CODES.includes('STANDING_RULES'));
  const registered = new Set<string>([...CCI_CODES, ...ROUTED_CODES]);
  assert.ok(OUTCOMES.length > 30, `the sweep covers the file's packing results (${OUTCOMES.length})`);
  const bad: string[] = [];
  for (const o of OUTCOMES) {
    for (const it of o.packed) {
      if (it.code === '' ? it.template === undefined : !registered.has(it.code)) bad.push(it.code === '' ? '(no code, no template)' : it.code);
    }
  }
  assert.deepEqual([...new Set(bad)], []);
});
