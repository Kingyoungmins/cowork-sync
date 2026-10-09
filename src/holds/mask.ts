// MASK (glossary §3; 05-holds §3.4 item 2; ruling R-04). Per path p, in this order:
//   1. p's scope class is QUARANTINED, SAVE_ONLY or UNMANAGED                        → A[p]   'path_class'
//   2. p is a path of a non-terminal ON_DISK local_only record, or of an ON_DISK
//      record carrying a whole-path guard (05-holds §2)                               → A[p]   'local_only' / 'whole_path_guard'
//   3. p is covered by an ON_DISK PIN with a non-empty guard set                      → A[p]   'pin'
//   4. p is covered by an ON_DISK CONFLICTED record, or an OFF_DISK record carrying
//      claim-breach                                                                    → A[p]   'conflicted'
//   5. (whole-path form, R-04) p is covered by an ON_DISK ACTIVE PATCH with a
//      non-empty guard set                                                             → A[p]   'patch'
//   6. otherwise X[p].
// "→ A[p]" is absent when A has no entry for p. Every other OFF_DISK record masks nothing (INV-HLD-OFFDISK).
// Whole-path masking only withholds more than the merge-file form of step 5 (Plan 3), never less (INV-MASK).
import type { ScopeClass } from '../data/scope.js';
import type { TreeEntry, TreeMap } from '../git/repo.js';
import { WHOLE_PATH_GUARDS, guardName, isTerminal, type HoldRecord } from './record.js';

export interface MaskInputs { A: TreeMap; scope: (path: string) => ScopeClass; records: readonly HoldRecord[]; }
export type MaskReason = 'path_class' | 'local_only' | 'whole_path_guard' | 'pin' | 'conflicted' | 'patch' | null;

type RecordReason = Exclude<MaskReason, 'path_class' | null>;

/** Step order of the record reasons (step 2's two forms first). */
const RANK: Readonly<Record<RecordReason, number>> = { local_only: 0, whole_path_guard: 1, pin: 2, conflicted: 3, patch: 4 };

const PATH_CLASSES: ReadonlySet<ScopeClass> = new Set<ScopeClass>(['QUARANTINED', 'SAVE_ONLY', 'UNMANAGED']);

/** The earliest step at which r masks its paths, or null when r masks nothing. */
function recordReason(r: HoldRecord): RecordReason | null {
  if (isTerminal(r)) return null;
  if (r.residence === 'ON_DISK') {
    if (r.local_only) return 'local_only';
    if (r.guards.some((g) => WHOLE_PATH_GUARDS.has(guardName(g)))) return 'whole_path_guard';
    if (r.kind === 'PIN' && r.guards.length > 0) return 'pin';
    if (r.state === 'CONFLICTED') return 'conflicted';
    if (r.kind === 'PATCH' && r.state === 'ACTIVE' && r.guards.length > 0) return 'patch';
    return null;
  }
  // OFF_DISK: only a claim-breach path pin (step 4).
  return r.guards.some((g) => guardName(g) === 'claim-breach') ? 'conflicted' : null;
}

/** path → the earliest record step that masks it. */
function recordIndex(records: readonly HoldRecord[]): Map<string, RecordReason> {
  const idx = new Map<string, RecordReason>();
  for (const r of records) {
    const reason = recordReason(r);
    if (reason === null) continue;
    for (const p of r.paths) {
      const had = idx.get(p);
      if (had === undefined || RANK[reason] < RANK[had]) idx.set(p, reason);
    }
  }
  return idx;
}

/** Why MASK resets p to A[p] (the first step that applies), or null when it keeps X[p]. */
export function maskReason(path: string, inp: MaskInputs): MaskReason {
  if (PATH_CLASSES.has(inp.scope(path))) return 'path_class';
  return recordIndex(inp.records).get(path) ?? null;
}

/**
 * MASK(X) over the paths of X and A: a masked path takes A's entry (absent when A has none, so a masked creation is
 * withheld) and a masked path that X lacks keeps A's entry (a masked deletion is withheld); an unmasked path keeps
 * X's entry or its absence. Pure: neither X nor the inputs are modified.
 */
export function maskEntries(X: TreeMap, inp: MaskInputs): Map<string, TreeEntry> {
  const idx = recordIndex(inp.records);
  const masked = (p: string): boolean => PATH_CLASSES.has(inp.scope(p)) || idx.has(p);
  const out = new Map<string, TreeEntry>();
  for (const [p, e] of X) {
    if (!masked(p)) {
      out.set(p, e);
      continue;
    }
    const a = inp.A.get(p);
    if (a !== undefined) out.set(p, a);
  }
  for (const [p, a] of inp.A) {
    if (!X.has(p) && masked(p)) out.set(p, a);
  }
  return out;
}
