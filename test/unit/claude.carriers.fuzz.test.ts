// test/unit/claude.carriers.fuzz.test.ts — the 500-run property over composeReply (plan 5 §Single-Writer fuzz):
// under every random instance the result stays under its carrier cap (the session rows under the 2,000 preview, a
// deny under its form cap), the meter-accounting figures match the reply, the one overflow line names exactly the
// dropped count, and the suppressed families never appear under PULL_MODE. Deny rides pre_deny and a block rides
// post/post_failure (K2) or stop (STOP_SUMMARY), the real pairings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { registerClaudeCatalog, renderClaude } from '../../src/i18n/claude.js';
import { composeReply, CARRIER_CAPS, type CarrierItem, type CarrierKind } from '../../src/claude/daemon/carriers.js';
import type { ReplyDraft } from '../../src/claude/daemon/ctx.js';
import { PULL_MODE_SUPPRESSED, MANDATORY_FAMILIES, CCI_CODES, ROUTED_CODES } from '../../src/claude/wire/codes.js';
import { C } from '../../src/claude/wire/constants.js';

registerClaudeCatalog('en', {
  'T-MORE': { text: 'and {k} more: {where}', params: { k: 'n', where: 'label' } },
  'T-STOP.more': { text: 'and {k} more: cowork_status', params: { k: 'n' } },
  T_FUZZ_45: { text: 'y'.repeat(45) },
  T_FUZZ_100: { text: 'z'.repeat(100) },
  T_FUZZ_240: { text: 'b'.repeat(240) },
  T_FUZZ_300: { text: 'f'.repeat(300) },
  HELDREG: { text: '[cowork-sync] HELDREG {reason}', params: { reason: 'note' } },
});

const TEMPLATES = ['T_FUZZ_45', 'T_FUZZ_100', 'T_FUZZ_240', 'T_FUZZ_300'] as const;
const FAMILIES = ['bystander', 'digest', 'conflict', 'held', 'note', 'transition', 'rules'] as const;
const SLOTS = ['digest', 'context', 'system', 'attribution', 'rules'] as const;
const CODES = ['', 'ATTRIBUTION', 'CLAIM_AHEAD', 'SINCE_POINTER', 'CS_READY_CANCELLED', 'STANDING_RULES'] as const;

const itemArb: fc.Arbitrary<CarrierItem> = fc.record({
  code: fc.constantFrom(...CODES),
  template: fc.option(fc.constantFrom(...TEMPLATES), { nil: undefined }),
  params: fc.constant({}),
  eventId: fc.option(fc.string({ minLength: 2, maxLength: 4 }), { nil: null }),
  family: fc.constantFrom(...FAMILIES),
  mandatory: fc.boolean(),
  slot: fc.constantFrom(...SLOTS),
  tier: fc.nat(30),
}).filter((i) => i.code !== '' || i.template !== undefined);

const capOf = (kind: CarrierKind, deny: ReplyDraft['deny'], pullMode: boolean): number => {
  if (kind === 'none') return 0;
  if (deny !== null) {
    const form = deny.form === 'T1' && pullMode ? 'T1R' : deny.form;
    return form === 'T1' ? C.CAPS.T1 : form === 'T1R' ? C.CAPS.T1R : C.CAPS.DENY;
  }
  if (kind === 'session_start' || kind === 'subagent_start') return C.CAPS.PREVIEW;
  return CARRIER_CAPS[kind].text;
};

const REGISTERED: ReadonlySet<string> = new Set<string>([...CCI_CODES, ...ROUTED_CODES]);
/** plan:2859 (R5-60): every packed item's code is '' with a template set, or a registered code. */
function assertRegistered(packed: readonly CarrierItem[]): void {
  for (const it of packed) assert.ok(it.code === '' ? it.template !== undefined : REGISTERED.has(it.code), `unregistered carrier code: ${JSON.stringify(it.code)}`);
}

test('the 500-run packing property', () => {
  const prop = fc.property(
    fc.integer({ min: 0, max: 14 }).chain((n) => fc.tuple(fc.constant(n), fc.array(itemArb, { minLength: n, maxLength: n }))),
    fc.constantFrom<CarrierKind>('session_start', 'subagent_start', 'ups', 'pre_deny', 'pre_context', 'post', 'post_failure', 'stop', 'none'),
    fc.constantFrom<'plain' | 'deny' | 'block'>('plain', 'deny', 'block'),
    fc.constantFrom<'T1' | 'T1R' | 'other'>('T1', 'T1R', 'other'),
    fc.nat(400),
    fc.constantFrom<CarrierKind>('post', 'post_failure', 'stop'),
    fc.boolean(),
    ([_n, items0], kind0, mode, form, reasonLen, blockKind, pullMode) => {
      // Real callers hand each item its own event id, so the property normalizes ids to be unique by position
      // (a duplicated id in the reply would then mean a listed-twice item, never a shared input id).
      const items = items0.map((it, i) => (it.eventId !== null ? { ...it, eventId: `e${i}` } : it));
      let kind: CarrierKind = kind0;
      let deny: ReplyDraft['deny'] = null;
      let block: ReplyDraft['block'] = null;
      if (mode === 'deny') { kind = 'pre_deny'; deny = { code: 'HELDREG', params: { reason: 'x'.repeat(reasonLen) }, form }; }
      else if (mode === 'block') { kind = blockKind; block = { code: kind === 'stop' ? 'STOP_SUMMARY' : 'HELD_CS', params: { items: '[]' } }; }
      const r = composeReply(kind, items, 'en', { pullMode, deny, block });
      // A plain post is the coordination block (≤ 1,000) + '\n' + the attribution slot (≤ 600), 06:618 (F2 #12): each
      // part is bounded on its own, split through r.packed (output order).
      const plainPost = kind === 'post' && deny === null && block === null;
      const cap = plainPost ? C.CAPS.POST_EVENT + 1 + C.CAPS.POST_SLOT : capOf(kind, deny, pullMode);
      if (kind === 'none') {
        assert.equal(r.text, ''); assert.equal(r.system, null); assert.equal(r.overflow, 0); assert.equal(r.more, null);
        assert.equal(r.decision, 'none');
        return;
      }
      assert.ok(r.text.length <= cap, `${kind}: ${r.text.length} > ${cap}`);
      if (plainPost) {
        const line = (m: CarrierItem): string => (m.template !== undefined ? renderClaude(m.template, m.params, 'en') : renderClaude(m.code, m.params, 'en'));
        const textItems = r.packed.filter((m) => m.slot !== 'system');
        const eventPart = textItems.filter((m) => m.slot !== 'attribution').map(line).join('\n');
        const slotPart = textItems.filter((m) => m.slot === 'attribution').map(line).join('\n');
        assert.ok(eventPart.length <= C.CAPS.POST_EVENT, `post event part ${eventPart.length}`);
        assert.ok(slotPart.length <= C.CAPS.POST_SLOT, `post slot part ${slotPart.length}`);
        assert.equal(r.text, [eventPart, slotPart].filter((s) => s !== '').join('\n'));
      }
      assert.equal(r.chars, r.text.length + (r.system?.length ?? 0));
      assert.ok(r.system === null || r.system.length <= 1050);
      // The overflow bookkeeping: a dropped item exists iff the reply names the count, and the count matches
      // (the session rows' others' MORE is best-effort, so the iff holds for the other kinds only).
      if (!(kind === 'session_start' || kind === 'subagent_start')) assert.equal(r.more !== null, r.overflow > 0);
      if (r.more !== null) {
        assert.ok(r.more.template === 'T-MORE' || r.more.template === 'T-STOP.more');
        assert.deepEqual(r.more.params.k, r.overflow);
      }
      // Decision sanity: a deny's text is the reason only; a block's first line is the reason; a 'none' is empty.
      if (deny !== null) assert.equal(r.decision, 'deny');
      else if (block !== null) assert.equal(r.decision, 'block');
      else assert.ok(r.decision === 'context' || r.decision === 'none');
      if (r.decision === 'none') assert.equal(r.text, '');
      // No terminal sequence ever rides.
      assert.ok(!r.text.includes('\u001b]') && (r.system === null || !r.system.includes('\u001b]')));
      // PULL_MODE drops exactly the suppressed families; a mandatory item (or one of the mandatory families)
      // never drops (CCI-46). A kept item renders its code line and, when it has a template, its digest line
      // too — both are legal; only a line no kept item renders is evidence of a failed drop.
      if (pullMode && deny === null) {
        const suppressedOf = (m: CarrierItem): boolean =>
          !m.mandatory && !(MANDATORY_FAMILIES as readonly string[]).includes(m.family) &&
          ((m.code !== '' && (PULL_MODE_SUPPRESSED as readonly string[]).includes(m.code)) || m.family === 'bystander');
        const linesOf = (m: CarrierItem): string[] => {
          const out: string[] = [];
          if (m.code !== '') out.push(renderClaude(m.code, m.params, 'en'));
          if (m.template !== undefined) out.push(renderClaude(m.template, m.params, 'en'));
          return out;
        };
        const keptLines = new Set(items.filter((m) => !suppressedOf(m)).flatMap(linesOf));
        for (const it of items) {
          if (!suppressedOf(it)) continue;
          for (const line of linesOf(it)) {
            if (line === '' || keptLines.has(line)) continue;
            assert.ok(!r.text.split('\n').includes(line), `a suppressed line must be dropped under PULL_MODE: ${line.slice(0, 30)}`);
          }
        }
      }
      // Event ids listed at most once each.
      assert.equal(new Set(r.eventIds).size, r.eventIds.length);
      // plan:2859: no carrier item carries an unregistered code (F2 #38).
      assertRegistered(r.packed);
    },
  );
  fc.assert(prop, { numRuns: 500, seed: 0x7a5f, verbose: false });
});

// ---- 06 test 31 (plan:2868): the DigestPort-shaped worst case, en and ko --------------------------------------------------

// The rules item renders 1,000 chars through its own test template (code STANDING_RULES kept), so the 500-run
// property's STANDING_RULES code items keep their code-line rendering. The request template is registered in both
// Claude-facing languages; the overflow rows are en only (renderClaude falls back to en).
registerClaudeCatalog('en', {
  T_FUZZ_RULES: { text: 'r'.repeat(1000) },
  T_FUZZ_REQ: { text: '{name} asks about {label}', params: { name: 'name', label: 'label' } },
});
registerClaudeCatalog('ko', { T_FUZZ_REQ: { text: '{name} 님이 {label} 에 대해 묻습니다', params: { name: 'name', label: 'label' } } });

const WORST: Readonly<Record<'en' | 'ko', { name: string; label: string }>> = {
  en: { name: 'N'.repeat(64), label: 'L'.repeat(200) },
  ko: { name: '가'.repeat(64), label: '나'.repeat(200) },
};

const claimArb = fc.record({
  family: fc.constantFrom('conflict', 'held', 'bystander'),
  code: fc.constantFrom('HOLD_IN_FILE', 'OWN_CHANGE_HELD', 'CLAIM_AHEAD'),
  pathLen: fc.integer({ min: 1, max: 60 }),
  tier: fc.nat(30),
  mandatory: fc.boolean(),
  event: fc.boolean(),
});
const requestArb = fc.record({ tier: fc.nat(30), mandatory: fc.boolean(), event: fc.boolean() });
const scriptArb = fc.record({
  claims: fc.integer({ min: 0, max: 200 }).chain((n) => fc.array(claimArb, { minLength: n, maxLength: n })),
  requests: fc.integer({ min: 0, max: 50 }).chain((n) => fc.array(requestArb, { minLength: n, maxLength: n })),
  rules: fc.boolean(),
  supersedes: fc.boolean(),
  pullMode: fc.boolean(),
  form: fc.constantFrom<'T1' | 'T1R' | 'other'>('T1', 'T1R', 'other'),
  reasonLen: fc.nat(400),
});
type Script = typeof scriptArb extends fc.Arbitrary<infer T> ? T : never;

/** A scripted DigestPort digest: DIGEST_SUPERSEDES (optional), the claim items, the request items, RULES (optional). */
function digestItems(s: Script, lang: 'en' | 'ko'): CarrierItem[] {
  const w = WORST[lang];
  const out: CarrierItem[] = [];
  let id = 0;
  if (s.supersedes) out.push({ code: 'DIGEST_SUPERSEDES', params: {}, eventId: null, family: 'note', mandatory: false, slot: 'digest', tier: 0 });
  for (const c of s.claims) {
    out.push({ code: c.code, params: { name: w.name, label: w.label, path: `src/${'p'.repeat(c.pathLen)}.ts` }, eventId: c.event ? `e${id++}` : null,
      family: c.family, mandatory: c.mandatory, slot: 'digest', tier: c.tier });
  }
  for (const q of s.requests) {
    out.push({ code: '', template: 'T_FUZZ_REQ', params: { name: w.name, label: w.label }, eventId: q.event ? `e${id++}` : null,
      family: 'request', mandatory: q.mandatory, slot: 'digest', tier: q.tier });
  }
  if (s.rules) out.push({ code: 'STANDING_RULES', template: 'T_FUZZ_RULES', params: {}, eventId: null, family: 'rules', mandatory: false, slot: 'rules', tier: 20 });
  return out;
}

const lineOf = (m: CarrierItem, lang: 'en' | 'ko'): string => (m.template !== undefined ? renderClaude(m.template, m.params, lang) : renderClaude(m.code, m.params, lang));

test('fuzz (200 claims, 50 requests, 64-char names, 200-char labels, en/ko): every carrier under its cap and the 2,000 preview; every conflict and held line within the first 1,500 chars of SessionStart', () => {
  // plan:2868, 06:1072 test 31 (INV-CCI-CAP, CCI-39, CCI-40). The six-language systemMessage mirror half is Plan 7's.
  const prop = fc.property(scriptArb, (s) => {
    for (const lang of ['en', 'ko'] as const) {
      const items = digestItems(s, lang);
      const cells: Array<{ kind: CarrierKind; deny: ReplyDraft['deny']; block: ReplyDraft['block'] }> = [
        ...(['session_start', 'subagent_start', 'ups', 'pre_context', 'post', 'post_failure', 'stop', 'none'] as const).map((kind) => ({ kind, deny: null, block: null })),
        { kind: 'pre_deny', deny: { code: 'HELDREG', params: { reason: 'x'.repeat(s.reasonLen) }, form: s.form }, block: null },
        { kind: 'post', deny: null, block: { code: 'HELD_CS', params: {} } },
        { kind: 'post_failure', deny: null, block: { code: 'HELD_CS', params: {} } },
        { kind: 'stop', deny: null, block: { code: 'STOP_SUMMARY', params: { items: '[]' } } },
      ];
      for (const c of cells) {
        const r = composeReply(c.kind, items, lang, { pullMode: s.pullMode, deny: c.deny, block: c.block });
        const where = `${lang} ${c.kind}${c.deny !== null ? ' deny' : c.block !== null ? ' block' : ''}`;
        assert.equal(r.chars, r.text.length + (r.system?.length ?? 0), `${where}: chars`);
        assert.ok(r.system === null || r.system.length <= CARRIER_CAPS[c.kind].system, `${where}: system ${r.system?.length}`);
        assert.equal(new Set(r.eventIds).size, r.eventIds.length, `${where}: event ids unique`);
        assertRegistered(r.packed);
        if (c.kind === 'none') { assert.equal(r.text, ''); continue; }
        const session = c.kind === 'session_start' || c.kind === 'subagent_start';
        const plainPost = c.kind === 'post' && c.deny === null && c.block === null;
        const cap = c.deny !== null ? capOf(c.kind, c.deny, s.pullMode)
          : c.block !== null ? (c.kind === 'stop' ? C.CAPS.STOP : C.CAPS.K2)
            : session ? C.CAPS.PREVIEW : plainPost ? C.CAPS.POST_EVENT + 1 + C.CAPS.POST_SLOT : CARRIER_CAPS[c.kind].text;
        assert.ok(r.text.length <= cap, `${where}: text ${r.text.length} > ${cap}`);
        const textItems = r.packed.filter((m) => m.slot !== 'system');
        if (plainPost) {
          const ev = textItems.filter((m) => m.slot !== 'attribution').map((m) => lineOf(m, lang)).join('\n');
          const sl = textItems.filter((m) => m.slot === 'attribution').map((m) => lineOf(m, lang)).join('\n');
          assert.ok(ev.length <= C.CAPS.POST_EVENT && sl.length <= C.CAPS.POST_SLOT, `${where}: parts ${ev.length} + ${sl.length}`);
        }
        if (session) {
          // packed is in text order there: each line is its item's rendering, so the line offsets are exact.
          const lines = r.text === '' ? [] : r.text.split('\n');
          assert.equal(lines.length, textItems.length, `${where}: one line per packed item`);
          let start = 0;
          for (const [i, m] of textItems.entries()) {
            assert.equal(lines[i], lineOf(m, lang), `${where}: line ${i} is its item`);
            const end = start + lines[i]!.length;
            if (m.family === 'conflict' || m.family === 'held') assert.ok(end <= C.CAPS.DIGEST, `${where}: a ${m.family} line ends at ${end} > 1,500`);
            start = end + 1;
          }
          const sup = textItems.findIndex((m) => m.code === 'DIGEST_SUPERSEDES');
          if (s.supersedes) assert.equal(sup, 0, `${where}: DIGEST_SUPERSEDES is the first line`);
        }
      }
    }
  });
  fc.assert(prop, { numRuns: 300, seed: 0x7a60, verbose: false });
});
