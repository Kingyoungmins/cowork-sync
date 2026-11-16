// src/claude/daemon/carriers.ts — carriers, caps and packing (CCI-39, CCI-40, glossary §19, §29.6, 06 §3.14.1–§3.14.5).
// Task 7: composeReply (the one packer, A7-3), finishReply (the one place a hook reply is assembled, A7-4),
// codeOnlyDigest (R5-11's Plan 5 binding) and the steps carrier.context and event.deliver (A7-7).
import { C } from '../wire/constants.js';
import { renderClaude } from '../../i18n/claude.js';
import { claudeLang, resolveHumanLang } from '../../i18n/locale.js';
import type { Params, ClaudeLang } from './claudeDaemon.js';
import type { ReplyDraft, HookRequest, DaemonCtx } from './ctx.js';
import type { ReplyFrame, CarrierDecision } from '../wire/frames.js';
import { CCI_CODES, ROUTED_CODES, PULL_MODE_SUPPRESSED, MANDATORY_FAMILIES } from '../wire/codes.js';
import { registerStep } from './pipeline.js';
import { reasonKey } from '../../holds/record.js';

export type CarrierKind = 'session_start' | 'subagent_start' | 'ups' | 'pre_deny' | 'pre_context' | 'post' | 'post_failure' | 'stop' | 'none';

export interface CarrierItem { code: string; params: Params; eventId: string | null; family: string; mandatory: boolean;
  slot: 'context' | 'system' | 'attribution' | 'rules' | 'digest'; tier: number;    // tier = COO's priority rank from DigestPort.rank
  template?: string; }   // R5-60: a template-only item (code '') renders renderClaude(template, params)

/** A7-3 (additive, F2 #6 #16): packed = the items whose lines the reply carries, in output order — the text's items
 *  (block riders then their MORE; the session packing's included lines; the generic packer's fitted items then their
 *  MORE; post: the event items, their MORE, then the attribution slot), then the system slot's items; [] for a deny
 *  (its reason is no item) and for a reply that carries nothing. The one source for the meter, the carrier trace
 *  codes and the unregistered-code sweep. */
export interface ReplyOutcome { decision: CarrierDecision; text: string; system: string | null; eventIds: string[]; overflow: number; chars: number; suppressed: string[]; more: CarrierItem | null; packed: CarrierItem[]; }

/** A7-8: per-carrier caps of 06 §3.14.1. The effective text cap of session_start / subagent_start is the host's
 *  2,000-char preview, not the 2,500 row ("all carriers stay under the host's 2,000-char preview"; a reading flagged for
 *  reconciliation, not a spec change). Packing order there: conflict and held items first, bounded by min(CAPS.DIGEST,
 *  CAPS.PREVIEW − RULES length − 1) with their own MORE, then RULES whole (never cut), then the other digest items to
 *  CAPS.PREVIEW. A system cap of 0 means the carrier's output has no systemMessage (06 §3.4.5: a G1 deny prints stderr
 *  only, PostToolUseFailure additionalContext only, Stop a block reason only): the system slot packs nothing there and
 *  its rows stay pending for the next carrier that prints a systemMessage (INV-NOSILENT, F2 #1). */
export const CARRIER_CAPS: Readonly<Record<CarrierKind, { text: number; system: number }>> = Object.freeze({
  session_start: { text: 2500, system: 1050 },
  subagent_start: { text: 2500, system: 1050 },
  ups: { text: 1500, system: 1050 },
  pre_deny: { text: 1050, system: 0 },        // T1 ≤ 1,050 / other ≤ 800 / T1R ≤ 300 are form caps inside the compose; 06 §3.4.5: this output carries no systemMessage (F2 #1)
  pre_context: { text: 800, system: 1050 },
  post: { text: 1000, system: 1050 },          // the coordination block; + the 600 attribution slot packed after it (ATTRIBUTION first, then a SlotExtraPort item when both fit; F2 #12)
  post_failure: { text: 1000, system: 0 },     // 06 §3.4.5: this output carries no systemMessage (F2 #1)
  stop: { text: 1200, system: 0 },             // 06 §3.4.5: this output carries no systemMessage (F2 #1); text only with a block
  none: { text: 0, system: 0 },
} as const);

// P5-EC-4: the test-build flag (the build defines it; a source run under tsx is a test build).
declare const __COWORK_TEST_BUILD__: boolean | undefined;
const isTestBuild = (): boolean => typeof __COWORK_TEST_BUILD__ === 'undefined' || __COWORK_TEST_BUILD__;

/** The rendered text of one item: a template-only item renders its template, a code item renders the code line. */
function renderOf(it: CarrierItem, lang: ClaudeLang, channel: 'claude' | 'deny' = 'claude'): string {
  return it.template !== undefined ? renderClaude(it.template, it.params, lang, channel) : renderClaude(it.code, it.params, lang, channel);
}

/** R5-60's unregistered-code rule is the tests' invariant over composeReply's results; the runtime refuses only the
 *  edit-check codes: UI_FLOW_LAST_ throws in test builds and drops the item silently in production (A7-10). */
function checkCode(it: CarrierItem): void {
  if (!it.code.startsWith('UI_FLOW_LAST_')) return;
  if (isTestBuild()) throw new CarrierCodeRefused(it.code);
}

/** The PULL_MODE suppression test: the code (or the bystander family tag) is in the list (CCI-46). */
function suppressedItem(it: CarrierItem): boolean {
  return PULL_MODE_SUPPRESSED.some((s) => s === it.code || (s === 'bystander' && it.family === 'bystander'));
}

/** The overflow row per carrier kind (R5-60): T-MORE {k, where: 'cowork_status'}, T-STOP.more {k} on stop. */
function moreRow(kind: CarrierKind): { template: string; where: string | null } {
  return kind === 'stop' ? { template: 'T-STOP.more', where: null } : { template: 'T-MORE', where: 'cowork_status' };
}

const overflowItem = (kind: CarrierKind, k: number): CarrierItem => {
  const row = moreRow(kind);
  const params: Params = row.where === null ? { k } : { k, where: row.where };
  return { code: '', params, eventId: null, family: 'note', mandatory: false, slot: 'digest', tier: 0, template: row.template };
};

const CONFLICT_OR_HELD = new Set(['conflict', 'held']);

/** SessionStart/SubagentStart packing (06 test 31): the conflict and held block first, bounded by
 *  min(CAPS.DIGEST, CAPS.PREVIEW − RULES length − 1) with its one MORE naming every dropped block line, then
 *  RULES whole (never cut), then the other digest items to CAPS.PREVIEW (their MORE only when the block fit).
 *  F2 #2 (CCI-40 "prefixed by DIGEST_SUPERSEDES"): DIGEST_SUPERSEDES items are a prefix — placed first, never cut,
 *  never in the block; a prefix of length P bounds the block by min(CAPS.DIGEST − P − 1, CAPS.PREVIEW − RULES length
 *  − 1 − P − 1), so every conflict and held line still ends within the first 1,500 chars (CCI-39). */
function packSession(items: readonly CarrierItem[], lang: ClaudeLang, kind: CarrierKind): { lines: string[]; included: CarrierItem[]; overflow: number; more: CarrierItem | null } {
  const prefix = items.filter((i) => i.code === 'DIGEST_SUPERSEDES' && i.slot !== 'rules');
  const body = items.filter((i) => !(i.code === 'DIGEST_SUPERSEDES' && i.slot !== 'rules'));
  const block = body.filter((i) => CONFLICT_OR_HELD.has(i.family) && i.slot !== 'rules');   // a rules-slot item rides RULES, never twice
  const rulesItems = body.filter((i) => i.slot === 'rules');
  const others = body.filter((i) => !CONFLICT_OR_HELD.has(i.family) && i.slot !== 'rules');
  const lines: string[] = [];
  const included: CarrierItem[] = [];
  for (const p of prefix) { lines.push(renderOf(p, lang)); included.push(p); }
  const prefixLen = lines.join('\n').length;
  // The RULES lines as they print: their rendered lengths plus one separator between each two (F2 #38 fix round 1:
  // several rules-slot items, a Plan 6 DigestPort.rules, must not push the text past CAPS.PREVIEW).
  let rulesLen = 0;
  for (const [i, r] of rulesItems.entries()) rulesLen += renderOf(r, lang).length + (i > 0 ? 1 : 0);
  const blockCap = prefix.length === 0
    ? Math.max(0, Math.min(C.CAPS.DIGEST, C.CAPS.PREVIEW - rulesLen - 1))
    : Math.max(0, Math.min(C.CAPS.DIGEST - prefixLen - 1, C.CAPS.PREVIEW - rulesLen - 1 - prefixLen - 1));
  // The block keeps whole lines while the rendered result so far stays within blockCap (incremental sum: one \n
  // between lines, the first line carries none).
  const keptLines: string[] = [];
  let blockTotal = 0;
  for (const c of block) {
    const n = renderOf(c, lang).length + (keptLines.length > 0 ? 1 : 0);
    if (blockTotal + n > blockCap) break;
    keptLines.push(renderOf(c, lang));
    blockTotal += n;
  }
  let overflow = block.length - keptLines.length;
  // F2 #38 (found by the 06 test 31 fuzz): the block's MORE line counts inside blockCap — kept lines yield room for
  // it — so RULES, which follows whole, never pushes the text past CAPS.PREVIEW (INV-CCI-CAP). 06 test 31's numbers
  // are unchanged (965 + 1 + 26 ≤ 999 there).
  if (overflow > 0) {
    const moreLen = (k: number): number => renderOf(overflowItem(kind, k), lang).length;
    while (keptLines.length > 0 && blockTotal + 1 + moreLen(overflow) > blockCap) {
      const last = keptLines.pop()!;
      blockTotal -= last.length + (keptLines.length > 0 ? 1 : 0);
      overflow++;
    }
  }
  const keptItems = block.slice(0, keptLines.length);
  for (const [i, t] of keptLines.entries()) { lines.push(t); included.push(keptItems[i]!); }
  let blockMore: CarrierItem | null = null;
  if (overflow > 0) {
    const more = overflowItem(kind, overflow);
    lines.push(renderOf(more, lang));
    included.push(more);
    blockMore = more;
  }
  for (const r of rulesItems) { lines.push(renderOf(r, lang)); included.push(r); }   // RULES whole, never cut
  let total = lines.join('\n').length;
  const droppedOthers: CarrierItem[] = [];
  const pushedOthers: Array<{ item: CarrierItem; line: string }> = [];
  for (const o of others) {
    const n = renderOf(o, lang).length + (lines.length > 0 ? 1 : 0);
    if (total + n > C.CAPS.PREVIEW) { droppedOthers.push(o); continue; }
    lines.push(renderOf(o, lang));
    included.push(o);
    pushedOthers.push({ item: o, line: renderOf(o, lang) });
    total += n;
  }
  let othersMore: CarrierItem | null = null;
  if (overflow === 0 && droppedOthers.length > 0) {
    const t0 = renderOf(overflowItem(kind, droppedOthers.length), lang);
    while (pushedOthers.length > 0 && total + 1 + t0.length > C.CAPS.PREVIEW) {   // yield room for the MORE line
      const last = pushedOthers.pop()!;
      droppedOthers.unshift(last.item);
      total -= last.line.length + 1;
      lines.pop();
      included.pop();
    }
    const more = overflowItem(kind, droppedOthers.length);
    const t = renderOf(more, lang);
    if (total + t.length + 1 <= C.CAPS.PREVIEW) { lines.push(t); included.push(more); overflow = droppedOthers.length; othersMore = more; }
  }
  return { lines, included, overflow, more: blockMore ?? othersMore };
}

/** A7-3: packs one reply under the caps of 06 §3.14.1. */
export function composeReply(kind: CarrierKind, items: readonly CarrierItem[], lang: ClaudeLang, o: { pullMode: boolean; deny: ReplyDraft['deny']; block: ReplyDraft['block'] }): ReplyOutcome {
  if (kind === 'none') return { decision: 'none', text: '', system: null, eventIds: [], overflow: 0, chars: 0, suppressed: [], more: null, packed: [] };
  // 06 §3.4.5: a Stop prints only a block reason, so a Stop without a block carries nothing — no line, no id, and no
  // suppression bookkeeping (nothing is offered); its rows stay pending for the next carrier (INV-NOSILENT, F2 #1).
  if (kind === 'stop' && o.block === null) return { decision: 'none', text: '', system: null, eventIds: [], overflow: 0, chars: 0, suppressed: [], more: null, packed: [] };
  for (const it of items) checkCode(it);
  // PULL_MODE drops exactly the suppressed families/codes; a mandatory item never drops (CCI-46, MANDATORY_FAMILIES).
  const kept: CarrierItem[] = [];
  const suppressedIds: string[] = [];
  for (const it of items) {
    if (o.pullMode && !it.mandatory && !MANDATORY_FAMILIES.includes(it.family as (typeof MANDATORY_FAMILIES)[number]) && suppressedItem(it)) {
      if (it.eventId !== null) suppressedIds.push(it.eventId);
      continue;
    }
    kept.push(it);
  }
  let decision: CarrierDecision = 'context';
  let text = '';
  let system: string | null = null;
  const eventIds: string[] = [];
  let overflow = 0;
  let moreOut: CarrierItem | null = null;   // the one overflow line the reply carried ({template:'T-MORE'|'T-STOP.more'|'T-AHEAD.more', params:{k,…}})
  const packed: CarrierItem[] = [];          // the items whose lines the reply carries, in output order (A7-3 additive, F2 #6 #16)
  const contextItems = kept.filter((i) => i.slot !== 'system');   // the attribution slot items are positioned by finishReply: their own slot on a plain post (F2 #12), context elsewhere
  const systemItems = kept.filter((i) => i.slot === 'system');
  const deny = o.deny;
  if (deny !== null) {
    // The G1 reason: form caps T1 ≤ 1,050 / other ≤ 800 / T1R ≤ 300; PULL_MODE shortens a T1 to its T1R form
    // (CCI-46: shortened, never suppressed). The reason line, nothing else rides a deny.
    decision = 'deny';
    const form = deny.form === 'T1' && o.pullMode ? 'T1R' : deny.form;
    const cap = form === 'T1' ? C.CAPS.T1 : form === 'T1R' ? C.CAPS.T1R : C.CAPS.DENY;
    text = truncate(renderClaude(deny.code, deny.params, lang, 'deny'), cap);
  } else if (o.block !== null) {
    // The block reason: K2 ≤ 1,000 on post, the STOP_SUMMARY reason ≤ 1,200 on stop; the item lines ride under it —
    // mandatory items are offered first (an order guarantee, not a cap exception), then the rest in rank order;
    // teammate free text (family note) never rides (R2-E6). When anything is dropped the one MORE line is carried
    // inside the cap: the packer frees room from the pushed tail and, if need be, from the reason itself (R5-60).
    decision = 'block';
    const cap = kind === 'stop' ? C.CAPS.STOP : C.CAPS.K2;
    const block = o.block;
    const full = renderClaude(block.code, block.params, lang);
    let reason = truncate(full, cap);
    // F2 #38 (Ruling; plan:2904, plan:1649): a Stop's STOP_SUMMARY keeps whole entries of its params.items — when the
    // rendered reason passes the cap, trailing entries are dropped until the reason and its T-STOP.more line fit, and
    // the dropped count is the reply's overflow (the one MORE line names it with the riders' drops). The asks render
    // first (code-line keys are sorted) and stay whole; a code line's params are sanitized uncapped, so the rendered
    // length of each prefix is exact. If even no entry fits, today's truncation stays (a Carry to Plan 6, O-4).
    const entries = kind === 'stop' && block.code === 'STOP_SUMMARY' ? jsonArrayParam(block.params['items']) : null;
    const reasonWith = (n: number): string => renderClaude(block.code, { ...block.params, items: JSON.stringify(entries!.slice(0, n)) }, lang);
    let shown = entries?.length ?? 0;
    if (entries !== null && full.length > cap) {
      const moreLen = (k: number): number => renderOf(overflowItem(kind, k), lang).length;
      const n = largestFit(entries.length - 1, (m) => reasonWith(m).length + 1 + moreLen(entries.length - m) <= cap);
      if (n >= 0) { reason = reasonWith(n); shown = n; overflow = entries.length - n; }
      else shown = 0;
    }
    const riders = contextItems.filter((i) => i.family !== 'note');   // teammate free text never rides (R2-E6)
    const mand = riders.filter((i) => i.mandatory);
    const rest = riders.filter((i) => !i.mandatory).sort((a, b) => a.tier - b.tier);
    // F2 #15: the text is reason + Σ('\n' + rider line), so the riders' budget is cap − reason.length with each rider
    // costing its line + 1 (the first separator is counted once).
    const budget = cap - reason.length;
    const lines: string[] = [];
    const pushed: Array<{ it: CarrierItem; t: string; ev: string | null; mandatory: boolean }> = [];
    let used = 0;
    for (const it of [...mand, ...rest]) {   // mandatory items are offered first, so a non-mandatory one never displaces them
      const n = renderOf(it, lang).length + 1;
      if (used + n > budget) { overflow++; continue; }
      pushed.push({ it, t: renderOf(it, lang), ev: it.eventId, mandatory: it.mandatory });
      used += n;
    }
    if (overflow > 0) {   // the MORE line is carried inside the cap: pushed non-mandatory lines yield room for it
      const moreText = (k: number): string => renderOf(overflowItem(kind, k), lang);
      const ridersLen = (): number => pushed.reduce((s, p) => s + p.t.length + 1, 0);
      // F2 #15 (Ruling): the yield pops the last non-mandatory line first (MANDATORY_FAMILIES, 06:725 "never
      // suppressed, only shortened"); when the reason and the mandatory riders still leave no room for the MORE line,
      // the reason is shortened (its code line kept) — R5-60 and MANDATORY_FAMILIES win over plan:2861's "reason kept
      // whole" in that edge case; only when even the code line does not fit does a mandatory rider yield (below).
      while (reason.length + ridersLen() + 1 + moreText(overflow).length > cap) {
        let j = pushed.length - 1;
        while (j >= 0 && pushed[j]!.mandatory) j--;
        if (j < 0) break;
        pushed.splice(j, 1);
        overflow++;
      }
      // A STOP_SUMMARY reason still too long drops whole trailing entries before any truncation (F2 #38).
      if (entries !== null && shown > 0 && reason.length + ridersLen() + 1 + moreText(overflow).length > cap) {
        const s0 = shown, o0 = overflow, rl = ridersLen();
        const s = largestFit(s0 - 1, (m) => reasonWith(m).length + rl + 1 + moreText(o0 + s0 - m).length <= cap);
        shown = Math.max(0, s);
        overflow = o0 + s0 - shown;
        reason = reasonWith(shown);
      }
      // F2 #15 (Ruling; found by the 06 test 31 fuzz): the reason is never cut below its code line
      // ('[cowork-sync] <code>', or that many chars of a template reason). When the mandatory riders leave no room for
      // it beside the MORE line, the last mandatory rider yields too — counted in the MORE, its store row not listed, so
      // it stays pending for the next carrier (deferred, never suppressed) — and the K2/Stop cap holds (INV-CCI-CAP).
      const floor = Math.min(reason.length, `[cowork-sync] ${block.code}`.length);
      while (pushed.length > 0 && floor + ridersLen() + 1 + moreText(overflow).length > cap) {
        pushed.pop();
        overflow++;
      }
      const t = moreText(overflow);
      if (reason.length + ridersLen() + 1 + t.length > cap) reason = truncate(reason, Math.max(0, cap - ridersLen() - 1 - t.length));   // the reason yields room too (it is a truncation already)
      for (const p of pushed) { lines.push(p.t); packed.push(p.it); if (p.ev !== null) eventIds.push(p.ev); }
      lines.push(t);
      const m = overflowItem(kind, overflow);
      moreOut = { ...m, params: { k: overflow } };   // the final count (yielded lines included)
      packed.push(moreOut);
    } else {
      for (const p of pushed) { lines.push(p.t); packed.push(p.it); if (p.ev !== null) eventIds.push(p.ev); }
    }
    text = [reason, ...lines].join('\n');
  } else if (kind === 'session_start' || kind === 'subagent_start') {
    const ps = packSession(contextItems, lang, kind);
    text = ps.lines.join('\n');
    overflow = ps.overflow;
    moreOut = ps.more;
    packed.push(...ps.included);
    for (const i of ps.included) if (i.eventId !== null) eventIds.push(i.eventId);
  } else {
    // The generic packer: context/digest items in tier order under the carrier's text cap; 'pre_context' holds at
    // most one note item (06 §3.14.1); when anything is dropped the one T-MORE line is carried — the packer frees
    // room for it rather than replying with an overflow it does not name (R5-60, INV-CCI-CAP).
    // F2 #12 (06:618, plan:1566): on post the attribution slot is packed apart — the coordination block takes the
    // non-slot items under CAPS.POST_EVENT (1,000; tier order; its own T-MORE), the slot follows it below.
    const isPost = kind === 'post';
    const cap = isPost ? C.CAPS.POST_EVENT : CARRIER_CAPS[kind].text;
    const all = (isPost ? contextItems.filter((i) => i.slot !== 'attribution') : [...contextItems]).sort((a, b) => a.tier - b.tier);
    const eligible: CarrierItem[] = [];
    let noteSkipped = 0;
    if (kind === 'pre_context') {
      let noteSeen = false;
      for (const it of all) {
        if (it.family === 'note') {
          if (noteSeen) { noteSkipped++; continue; }
          noteSeen = true;
        }
        eligible.push(it);
      }
    } else eligible.push(...all);
    let fit = 0;
    let total = 0;
    for (const it of eligible) {
      const n = renderOf(it, lang).length + (fit > 0 ? 1 : 0);
      if (total + n > cap) break;
      total += n;
      fit++;
    }
    let dropped = noteSkipped + (eligible.length - fit);   // the reply's overflow below; the inner name avoids shadowing
    if (dropped > 0) {
      const t = renderOf(overflowItem(kind, dropped), lang).length;
      while (fit > 0 && total + 1 + t > cap) {   // free room for the MORE line
        const it = eligible[fit - 1]!;
        total -= renderOf(it, lang).length + (fit > 1 ? 1 : 0);
        fit--;
      }
      dropped = noteSkipped + (eligible.length - fit);
      overflow = dropped;
    }
    const lines: string[] = [];
    for (const it of eligible.slice(0, fit)) {
      lines.push(renderOf(it, lang));
      packed.push(it);
      if (it.eventId !== null) eventIds.push(it.eventId);
    }
    if (dropped > 0) { const m = overflowItem(kind, dropped); lines.push(renderOf(m, lang)); moreOut = m; packed.push(m); }
    if (isPost) {
      // The attribution slot (glossary §29.6): its own CAPS.POST_SLOT (600) after the coordination block, in the order
      // finishReply placed its items (ATTRIBUTION first, then a SlotExtraPort item or the T-AHEAD.more collapse); whole
      // lines while the slot part stays ≤ 600. A slot item that does not fit is dropped and names no MORE (the slot's
      // overflow is finishReply's T-AHEAD.more collapse); a dropped slot store row is not listed and stays pending.
      let slotLen = 0;
      let slotCount = 0;
      for (const it of contextItems.filter((i) => i.slot === 'attribution')) {
        const t = renderOf(it, lang);
        const n = t.length + (slotCount > 0 ? 1 : 0);
        if (slotLen + n > C.CAPS.POST_SLOT) continue;
        lines.push(t);
        packed.push(it);
        if (it.eventId !== null) eventIds.push(it.eventId);
        slotLen += n;
        slotCount++;
      }
    }
    text = lines.join('\n');
    decision = text === '' ? 'none' : 'context';
  }
  // The system slot: every system item, one per line, ≤ 1,050 (glossary §19). A carried system store row's id
  // rides the reply's eventIds too — it is delivered on its batch's printed like any other carried event.
  const sysLines: string[] = [];
  const sysIncluded: CarrierItem[] = [];
  let sysTotal = 0;
  for (const it of systemItems) {
    const n = renderOf(it, lang).length + 1;
    if (sysTotal + n > CARRIER_CAPS[kind].system) break;
    sysLines.push(renderOf(it, lang));
    sysIncluded.push(it);
    sysTotal += n;
  }
  if (sysLines.length > 0) system = sysLines.join('\n');
  packed.push(...sysIncluded);
  for (const it of sysIncluded) if (it.eventId !== null) eventIds.push(it.eventId);
  const chars = text.length + (system?.length ?? 0);
  return { decision, text, system, eventIds, overflow, chars, suppressed: suppressedIds, more: moreOut, packed };
}

/** The largest m in [0, max] with fits(m), or -1 (F2 #38 fix round 1). A galloping search from 0 (1, 2, 4, …) then a
 *  bisection between the last prefix that fit and the first that did not: O(log m) probes, each a prefix about the
 *  size of the answer, so a STOP_SUMMARY with thousands of entries costs a handful of cap-sized renders, never the
 *  ~N²/2 entry renders of a scan down from the top. A rendered prefix grows with m, so fits is monotone and this is
 *  the largest fitting prefix; if a sanitize edge ever broke that, the answer is still a prefix that was rendered and
 *  fit — the cap never depends on monotonicity. */
function largestFit(max: number, fits: (m: number) => boolean): number {
  if (max < 0 || !fits(0)) return -1;
  let lo = 0;          // fits(lo)
  let hi = max + 1;    // the first probe that did not fit, or past max
  for (let p = 1; p <= max; p = Math.min(max + 1, p * 2)) {
    if (!fits(p)) { hi = p; break; }
    lo = p;
    if (p === max) break;
  }
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (fits(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

/** A param holding a JSON array as a string (STOP_SUMMARY's items), parsed; null for anything else. */
function jsonArrayParam(v: unknown): unknown[] | null {
  if (typeof v !== 'string') return null;
  try {
    const a: unknown = JSON.parse(v);
    return Array.isArray(a) ? a : null;
  } catch {
    return null;
  }
}

/** Cap truncation of a rendered reason (sanitize truncates placeholders, never whole templates — the rendered
 *  line keeps its code prefix). */
function truncate(s: string, cap: number): string {
  return s.length > cap ? s.slice(0, cap) : s;
}

/** A7-4: the CarrierKind from the event and outcome (finishReply derives it; no step sets it). */
function carrierOf(r: HookRequest, d: ReplyDraft): CarrierKind {
  switch (r.frame.event) {
    case 'SessionStart': return 'session_start';
    case 'SubagentStart': return 'subagent_start';
    case 'UserPromptSubmit': return 'ups';
    case 'PreToolUse': return d.deny !== null ? 'pre_deny' : 'pre_context';
    case 'PostToolUse': return 'post';
    case 'PostToolUseFailure': return 'post_failure';
    case 'Stop': return 'stop';
    default: return 'none';
  }
}

/** A7-7: the one place a hook reply is assembled, called by ClaudeServer after the last step (A7-4): composeReply
 *  over d.items plus the seat's pending store events by tier (honouring each event's carriers filter; a G1 deny and
 *  a Stop without a block carry no store events — neither prints them, 06 §3.4.5, INV-NOSILENT, F2 #1),
 *  EventStore.batch (→ ReplyFrame.batch_id), suppressed ids retired without charge,
 *  BudgetMeter.charge of exactly the printed characters split per packed item family (recap → 'recap', CLAIM_AHEAD*
 *  → 'claim_ahead', other context/deny/block text → 'inject', other system → 'system'; F2 #6), one carrier trace
 *  event (codes = the reason code, then the packed items' codes or template ids; F2 #16). */
export function finishReply(r: HookRequest, d: ReplyDraft, ctx: DaemonCtx): ReplyFrame {
  const seat = r.seat;
  const seatId = seat.seatId ?? '';
  const lang = claudeLangOf(ctx);
  const kind = carrierOf(r, d);
  const pullMode = seatId !== '' && ctx.meter.inPullMode(seatId);
  const gating = d.deny !== null;
  const plainStop = kind === 'stop' && d.block === null;   // prints nothing: its rows ride the next carrier (F2 #1)
  const storeRows = seatId === '' || gating || kind === 'none' || plainStop
    ? []
    : ctx.events.pending(seatId).filter((e) => e.carriers === null || e.carriers.includes(kind));
  // F2 #3: a store row whose raw slot is 'both' (the Stop block's own STOP_SUMMARY row, params = the block's) is the
  // reason's content, never a rider line: it never enters the items, and only a Stop reply that renders a block lists
  // it (its printed delivers it and marks its asks).
  const bothIds = storeRows.filter((e) => e.slot === 'both').map((e) => e.id);
  const storeItems: CarrierItem[] = storeRows.filter((e) => e.slot !== 'both').map((e) => ({
    code: e.code, params: e.params, eventId: e.id, family: e.family, mandatory: e.mandatory,
    slot: e.slot === 'system' ? 'system' : 'context', tier: 10,
  }));
  const items = [...d.items, ...storeItems];
  // The attribution slot (glossary §29.6, post only): ATTRIBUTION first, then a SlotExtraPort item when both fit
  // in CAPS.POST_SLOT; slotExtra bound to null → no call (F05-04).
  if (kind === 'post' && d.deny === null && !pullMode) {
    const i = items.findIndex((it) => it.slot === 'attribution');
    const attr = i >= 0 ? items.splice(i, 1)[0]! : null;
    const extra = ctx.bindings.slotExtra;
    if (attr !== null) {
      const charsLeft = C.CAPS.POST_SLOT - renderOf(attr, lang).length;
      const held = attr.params['claims'];
      const heldIds = typeof held === 'string' && held !== '' ? held.split(',') : [];
      const extraItem = extra !== null && charsLeft >= 0 ? extra.postExtra(seatId, agentOf(r), Math.max(0, charsLeft), heldIds) : null;
      if (extraItem !== null && renderOf(extraItem, lang).length + 1 <= charsLeft) items.unshift(attr, extraItem);   // ATTRIBUTION first, then the extra
      else {
        // R2-E2/F05-04: a CLAIM_AHEAD item that does not fit collapses into the template-only T-AHEAD.more {k, file}
        // inside the slot; other extra items are simply dropped (Plan 5 queues nothing; F05's waiting rule is Plan 6's).
        const ahead = extraItem !== null && extraItem.code === 'CLAIM_AHEAD' ? extraItem : attr.code === 'CLAIM_AHEAD' ? attr : null;
        const slotItems: CarrierItem[] = [attr];
        if (ahead !== null) {
          const file = typeof ahead.params['file'] === 'string' ? ahead.params['file'] : '';
          const k = typeof ahead.params['n'] === 'number' ? ahead.params['n'] : 1;
          slotItems.push({ code: '', params: { k, file }, eventId: null, family: 'note', mandatory: false, slot: 'attribution', tier: 0, template: 'T-AHEAD.more' });
        }
        items.unshift(...slotItems);
      }
    } else if (extra !== null) {
      const extraItem = extra.postExtra(seatId, agentOf(r), C.CAPS.POST_SLOT, []);
      if (extraItem !== null) {
        if (extraItem.code === 'CLAIM_AHEAD' && renderOf(extraItem, lang).length + 1 > C.CAPS.POST_SLOT) {
          const file = typeof extraItem.params['file'] === 'string' ? extraItem.params['file'] : '';
          const k = typeof extraItem.params['n'] === 'number' ? extraItem.params['n'] : 1;
          items.unshift({ code: '', params: { k, file }, eventId: null, family: 'note', mandatory: false, slot: 'attribution', tier: 0, template: 'T-AHEAD.more' });
        } else if (renderOf(extraItem, lang).length <= C.CAPS.POST_SLOT) items.unshift(extraItem);
      }
    }
  }
  const o = composeReply(kind, items, lang, { pullMode, deny: d.deny, block: d.block });
  // The reply's event ids: the store rows the reply carries (a Task-owned d.items carry with an unknown store id
  // batches to nothing, harmlessly).
  const listed = [...new Set([...(kind === 'stop' && o.decision === 'block' ? bothIds : []), ...o.eventIds])];
  const batchId = seatId === '' || listed.length === 0 ? '' : ctx.events.batch(seatId, listed, kind);
  // A7-3: the suppressed rows retire as delivered, without charge and without a batch (additive retire, A7-3's note).
  if (o.suppressed.length > 0 && seatId !== '') ctx.events.retire(o.suppressed);
  // Metering (F2 #6; 06:723, R5-43, CCI-61): the meter is charged exactly the characters the reply prints — its text
  // and system, separators and MORE lines included — split by what o.packed carried: CLAIM_AHEAD* items and the
  // T-AHEAD.more collapse → 'claim_ahead' (its 5,000 share), family recap → 'recap', the rest of the system →
  // 'system', the rest of the text (deny/block reasons, context lines, ATTRIBUTION — cowork-injected
  // additionalContext) → 'inject'. An item that was offered but not printed (cap-dropped, PULL_MODE-suppressed,
  // under a deny) is not charged; slash is charged by the MCP-tool path, never here.
  let metered = 0;
  if (seatId !== '' && kind !== 'none') {
    ctx.meter.touch(seatId);
    let caT = 0, caS = 0, rcT = 0, rcS = 0;
    for (const it of o.packed) {
      const n = renderOf(it, lang).length;
      const sys = it.slot === 'system';
      if (it.code.startsWith('CLAIM_AHEAD') || it.template === 'T-AHEAD.more') { if (sys) caS += n; else caT += n; }
      else if (it.family === 'recap') { if (sys) rcS += n; else rcT += n; }
    }
    const charge = (k: 'claim_ahead' | 'recap' | 'system' | 'inject', n: number): void => {
      if (n <= 0) return;
      ctx.meter.charge(seatId, k, n);
      metered += n;
    };
    charge('claim_ahead', caT + caS);
    charge('recap', rcT + rcS);
    charge('system', (o.system?.length ?? 0) - caS - rcS);
    charge('inject', o.text.length - caT - rcT);
  }
  // One carrier trace event (plan:2921; F2 #16): codes in packing order — the deny/block reason code first, then each
  // packed item's code, or its template id for a template-only item.
  const reasonCode = d.deny !== null ? d.deny.code : d.block !== null && o.decision === 'block' ? d.block.code : null;
  ctx.trace.emit({
    kind: 'carrier', peer: ctx.engine.peer(), seat: seatId, event: r.frame.event, chars: o.chars, metered,
    codes: [...(reasonCode !== null ? [reasonCode] : []), ...o.packed.map((i) => (i.code !== '' ? i.code : (i.template ?? '')))], eventIds: listed,
  });
  return { t: 'reply', batch_id: batchId, decision: o.decision, text: o.text, system: o.system, events: listed, cursor: seatId === '' ? 0 : ctx.events.cursor(seatId) };
}

/** The agent_id of the hook (SubagentStart's header; null elsewhere). */
function agentOf(r: HookRequest): string | null {
  const h = (r.frame as { h: { agent_id: string | null } }).h;
  return h.agent_id ?? null;
}

/** L_c = claudeLang(resolveHumanLang({user, team, osLocale}).lang) (X-53). */
function claudeLangOf(ctx: DaemonCtx): ClaudeLang {
  // X-53, F2 #41 #56 (I9): the daemon's OS locale, read once at start by src/daemon/run.ts (plan:1326-1327) — never Intl per reply.
  return claudeLang(resolveHumanLang({ user: ctx.prefs().language, team: ctx.engine.teamLanguage(), osLocale: ctx.osLocale ?? null }).lang);
}

/** COO content (Plan 6 binds): RULES, full/delta/subagent digests, carrier priority, EV.* routing (R5-09, R5-11).
 *  Plan 5's binding is codeOnlyDigest, read through codeOnlyDigestOf(ctx) by carrier.context (plan:1593, A7-11). */
export interface DigestPort {
  rules(seatId: string): CarrierItem[];
  digest(seatId: string, kind: 'full' | 'delta' | 'subagent', o: { supersedes: boolean }): CarrierItem[];   // supersedes → DIGEST_SUPERSEDES first (CCI-40)
  rank(items: readonly CarrierItem[]): CarrierItem[];
}

/** R5-11's Plan 5 binding (plan:1593), the identity claudeDaemon.ts binds: rules → one STANDING_RULES code line
 *  (07 §3.16.4's registry code, R5-60), rank by tier; this ctx-less const answers the digest with DIGEST_SUPERSEDES
 *  when asked and nothing else. carrier.context never reads its digest directly: when the binding is this const it
 *  uses codeOnlyDigestOf(ctx), whose digest adds this seat's own held records and HOLD_IN_FILE (HLD-22, F2 #2). */
export const codeOnlyDigest: DigestPort = Object.freeze({
  rules: (seatId: string): CarrierItem[] =>
    seatId === '' ? [] : [{ code: 'STANDING_RULES', params: {}, eventId: null, family: 'rules', mandatory: false, slot: 'rules', tier: 20 }],
  digest: (_seatId: string, _kind: 'full' | 'delta' | 'subagent', o: { supersedes: boolean }): CarrierItem[] =>
    o.supersedes ? [{ code: 'DIGEST_SUPERSEDES', params: {}, eventId: null, family: 'note', mandatory: false, slot: 'digest', tier: 0 }] : [],
  rank: (items: readonly CarrierItem[]): CarrierItem[] => [...items].sort((a, b) => a.tier - b.tier),
});

const DIGEST_OF = new WeakMap<DaemonCtx, DigestPort>();
/** The per-seat seen sets of each ctx's codeOnlyDigestOf binding (dropDigestSeat prunes an ended seat). */
const DIGEST_SEEN = new WeakMap<DaemonCtx, Map<string, ReadonlySet<string>>>();

/** F2 fix round 1 (review, ROBUST r1): drops an ended seat's digest seen set, so the codeOnlyDigestOf state is bounded
 *  by the live seats, not by every seat of the daemon's uptime. The composition's seats.onEnd calls it beside
 *  ctx.items.endTurn (C-3: that one line is t5-compose's). A seat this ctx never digested is a no-op. */
export function dropDigestSeat(ctx: DaemonCtx, seatId: string): void {
  DIGEST_SEEN.get(ctx)?.delete(seatId);
}

/** The seat id a CS id or a record origin names: the segment before its first '/' (the whole string without one). */
const seatSegment = (s: string): string => { const i = s.indexOf('/'); return i < 0 ? s : s.slice(0, i); };

/** A7-11 (contract addition, F2 #2): the ctx-reading Plan 5 binding carrier.context uses when ctx.bindings.digest is
 *  codeOnlyDigest (memoized per ctx). rules and rank are codeOnlyDigest's. digest reads ctx.engine.registry() and
 *  ctx.readSets (plan:1593 "this seat's own conflict/held items (TurnItems, registry), nothing else; code lines"):
 *  - every non-terminal record (ULID order) whose origin, or one of whose cs_ids, names this seat (the segment before
 *    the first '/') → one OWN_CHANGE_HELD {rid, path, reason} (family held; 06:591 "told at once when a record was
 *    created from its own change"); a pathless record is skipped;
 *  - every other ACTIVE ON_DISK record → one HOLD_IN_FILE {path, rid, reason} (family held) per path in the seat's
 *    full-read set (HLD-22 SessionStart half; 06:591). R-F2-15: ctx.readSets is the Task 12 stub (an empty set) until
 *    Task 12 binds ReadSets, so this half is inactive before it (a Carry owned by Task 12);
 *  - full / subagent → DIGEST_SUPERSEDES first when asked (CCI-40), then those items; delta → those items whose key
 *    (code + params) the seat has not seen. full and delta replace the seat's seen set; subagent leaves it.
 *  Nothing says a hold ended (no Plan 5 code for it; Plan 6's DigestPort). */
export function codeOnlyDigestOf(ctx: DaemonCtx): DigestPort {
  const known = DIGEST_OF.get(ctx);
  if (known !== undefined) return known;
  const seen = new Map<string, ReadonlySet<string>>();
  DIGEST_SEEN.set(ctx, seen);
  const keyOf = (it: CarrierItem): string => `${it.code}|${JSON.stringify(it.params)}`;
  const held = (seatId: string): CarrierItem[] => {
    if (seatId === '') return [];
    const reg = ctx.engine.registry();
    const reads = ctx.readSets.fullReadSet(seatId);
    const out: CarrierItem[] = [];
    for (const r of reg.nonTerminal()) {
      const reason = reasonKey(r, (id) => reg.get(id)) ?? null;
      const own = seatSegment(r.origin) === seatId || r.cs_ids.some((c) => seatSegment(c) === seatId);
      if (own) {
        const path = r.paths[0];
        if (path === undefined) continue;
        out.push({ code: 'OWN_CHANGE_HELD', params: { rid: r.id, path, reason }, eventId: null, family: 'held', mandatory: false, slot: 'digest', tier: 1 });
        continue;
      }
      if (r.state !== 'ACTIVE' || r.residence !== 'ON_DISK') continue;
      for (const path of r.paths) {
        if (reads.has(path)) out.push({ code: 'HOLD_IN_FILE', params: { path, rid: r.id, reason }, eventId: null, family: 'held', mandatory: false, slot: 'digest', tier: 2 });
      }
    }
    return out;
  };
  const port: DigestPort = Object.freeze({
    rules: codeOnlyDigest.rules,
    rank: codeOnlyDigest.rank,
    digest: (seatId: string, kind: 'full' | 'delta' | 'subagent', o: { supersedes: boolean }): CarrierItem[] => {
      const items = held(seatId);
      if (kind === 'subagent') return [...codeOnlyDigest.digest(seatId, kind, o), ...items];
      const last = seen.get(seatId) ?? new Set<string>();
      seen.set(seatId, new Set(items.map(keyOf)));
      if (kind === 'full') return [...codeOnlyDigest.digest(seatId, kind, o), ...items];
      return items.filter((it) => !last.has(keyOf(it)));
    },
  });
  DIGEST_OF.set(ctx, port);
  return port;
}

/** F05 (Plan 6). V-10 (Plan 6's O-7). */
export interface SlotExtraPort { postExtra(seatId: string, agentId: string | null, charsLeft: number, heldAttribClaimIds: readonly string[]): CarrierItem | null; }

/** A7-10: thrown by composeReply in test builds when an item's code starts with UI_FLOW_LAST_. */
export class CarrierCodeRefused extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`carrier item code refused: ${code}`);
    this.code = code;
  }
}

// ---- The Task 7 steps (A7-7) --------------------------------------------------------------------------------------------

/** carrier.context: RULES + digest items at SessionStart (supersedes for compact|clear|resume|fork) and
 *  SubagentStart, the digest delta at a new-turn UserPromptSubmit (and calls TurnItems.endTurn first when
 *  r.turn.newTurn), nothing on other events. */
export async function carrierContextStep(r: HookRequest, d: ReplyDraft, ctx: DaemonCtx): Promise<void> {
  const seatId = r.seat.seatId ?? '';
  // The Plan 5 binding reads the registry and read sets through ctx (A7-11, F2 #2); claudeDaemon.ts keeps binding the
  // ctx-less const.
  const digest = ctx.bindings.digest === codeOnlyDigest ? codeOnlyDigestOf(ctx) : ctx.bindings.digest;
  const p = r.frame.payload;
  if (r.frame.event === 'SessionStart') {
    const source = p.event === 'SessionStart' ? p.source : 'startup';
    d.items.push(...digest.rules(seatId), ...digest.digest(seatId, 'full', { supersedes: source !== 'startup' }));
    return;
  }
  if (r.frame.event === 'SubagentStart') {
    d.items.push(...digest.rules(seatId), ...digest.digest(seatId, 'subagent', { supersedes: false }));
    return;
  }
  if (r.frame.event === 'UserPromptSubmit' && r.turn !== null) {
    if (r.turn.newTurn) ctx.items.endTurn(seatId);   // the new turn ends the previous turn's items (R5-39)
    if (!r.turn.doorbell) d.items.push(...digest.digest(seatId, 'delta', { supersedes: false }));
    // a doorbell (nonce) UserPromptSubmit carries no digest (CCI-39, 06 §3.14.1 row 2)
    return;
  }
}

/** event.deliver: meter.touch (the seat-hour anchor at the first hook) and events.nextHook (re-queues un-printed
 *  batches for a full re-send, V-10); the pending events are then offered to the carrier by finishReply's packing
 *  (the carriers filter and the G1 rule live there). */
export async function eventDeliverStep(r: HookRequest, _d: ReplyDraft, ctx: DaemonCtx): Promise<void> {
  const seatId = r.seat.seatId ?? '';
  if (seatId === '') return;
  ctx.meter.touch(seatId);
  ctx.events.nextHook(seatId, { ended: r.seat.ended });
}

/** Task 7 registers the two carrier steps (A7-7). */
registerStep('carrier.context', carrierContextStep);
registerStep('event.deliver', eventDeliverStep);
