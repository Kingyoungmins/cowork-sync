// The relative region tripwires (04-regions §3.15; REG-24, INV-REG-TRIPWIRE; glossary §10 K7 "new ERROR/MISSING parse nodes
// relative to TIP" and "label count above max(TIP, local)"). Run per path on every outgoing blob after a merge or re-merge and on
// every insertion-concat output (theirs = TIP[p], ours = the local side — LOCAL for a concat — out = the output):
//   (a) errorCount(out) ≤ errorCount(theirs), 0 for a new path;
//   (b) for every label key, count(out) ≤ max(count(theirs), count(ours));
//   (c) out decodes as UTF-8 if theirs did.
// Only these relative forms exist: the absolute forms ("no ERROR node", "no duplicate label") are forbidden because valid code
// violates them (VERIFIED rc_valid_errors, rc_dupes). The function reads the tables' errorCount and labelCounts and the decode
// flags, nothing else (REG-02 verdicts only; labels serve the count accounting only, REG-14).
import type { LabelKey, RegionTable, TableOrNone } from './types.js';

export type TripwireViolation =
  | { readonly form: 'a'; readonly theirs: number; readonly out: number }   // errorCount(out) > errorCount(theirs) (0 for a new path)
  | { readonly form: 'b'; readonly key: LabelKey; readonly theirs: number; readonly ours: number; readonly out: number }   // count(out) > max(count(theirs), count(ours))
  | { readonly form: 'c' };                                                   // theirs decodes as UTF-8, out does not

/** A symbol table (class 4): a grammar table, never NO_TABLE or a class-6 block table. */
function symbolTable(t: TableOrNone | null): RegionTable | null {
  return t !== null && !('kind' in t) && t.grammar !== null ? t : null;
}

/** A side's count of one label key; a side without a symbol table (absent, NO_TABLE, a block table) counts 0 (P2: more violations, never fewer). */
const countOf = (t: RegionTable | null, key: LabelKey): number => (t === null ? 0 : (t.labelCounts[key] ?? 0));

/**
 * The relative forms only (the absolute forms are forbidden); a null side = an absent path. Forms (a) and (b) apply when out has a
 * symbol table (an out without one — not decodable, no grammar, NO_TABLE — has no error or label count to compare; a NO_TABLE{budget}
 * out is the caller's `incomplete`); a theirs without a symbol table counts 0 errors and 0 labels. Form (c) compares the decode flags
 * of the two blobs and applies only when theirs exists. Violations are ordered (a), (b) by label key, (c).
 */
export function regionTripwire(theirs: TableOrNone | null, ours: TableOrNone | null, out: TableOrNone, decodes: { theirs: boolean; out: boolean }): TripwireViolation[] {
  const vs: TripwireViolation[] = [];
  const o = symbolTable(out);
  if (o !== null) {
    const t = symbolTable(theirs);
    const l = symbolTable(ours);
    const theirsErrors = t === null ? 0 : t.errorCount;
    if (o.errorCount > theirsErrors) vs.push({ form: 'a', theirs: theirsErrors, out: o.errorCount });
    const keys = Object.keys(o.labelCounts).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    for (const key of keys) {
      const n = o.labelCounts[key] ?? 0;
      const ct = countOf(t, key);
      const cl = countOf(l, key);
      if (n > Math.max(ct, cl)) vs.push({ form: 'b', key, theirs: ct, ours: cl, out: n });
    }
  }
  if (theirs !== null && decodes.theirs && !decodes.out) vs.push({ form: 'c' });
  return vs;
}
