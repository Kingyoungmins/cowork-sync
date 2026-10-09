// ENG-41 pre-push asserts (01-engine §3.12 step 5; glossary §21 INV-MASK, INV-PUSHED-IS-MERGE; HLD-19). Letter (f) is
// SEC-07's secret scan, out per ruling R-06 (Plan 7). Pure over the given trees: the caller built OUT, C and Bnew and reads
// the parents back from git, so (a) checks the objects that would be pushed, not the caller's intentions.
//
// Check order (the first failure is reported): (a) parents, (d) OUT non-empty, (b) paths(diff(TIP, OUT)) ⊆ paths(diff(A, P))
// for a code publish, (c) OUT[p] == TIP[p] wherever P[p] == A[p], (e) new conflict-marker rows, (g) gitlinks and symlinks,
// (h) quarantined and save-only paths, (i) held paths in P, INV-MASK path classes in P, (j) held/ entries.
//
// (b) and (c) state one fact twice (p ∉ diff(A, P) ⇒ p ∉ diff(TIP, OUT)); (b) is the code-publish form and runs only when
// P differs from A somewhere, so (c) is the letter of a publish whose P is A everywhere (board-only: OUT must be TIP).
// (i) is the held side of ENG-41 (i) (`masked`: a record — PIN, CONFLICTED, local_only, whole-path guard — masks p); the
// path classes QUARANTINED, SAVE_ONLY and UNMANAGED differing from A in P are reported as HLD-19's INV-MASK assertion.
import type { ScopeClass } from '../data/scope.js';
import { conflictMarkerRows } from '../data/rows.js';
import { ABSENT, isOid, type Oid, type OidOrAbsent } from '../git/oid.js';
import type { TreeEntry, TreeMap } from '../git/repo.js';
import { diffPaths, isRegularEntry as isRegular } from './treeDiff.js';

export type AssertLetter = 'a' | 'b' | 'c' | 'd' | 'e' | 'g' | 'h' | 'i' | 'j' | 'INV-MASK';
export interface PrePushInput {
  T: OidOrAbsent; tip: Oid; tipMap: TreeMap; A: TreeMap; P: TreeMap; out: TreeMap; outTree: Oid; emptyTree: Oid;
  bnewParents: readonly Oid[]; liveCode: Oid; cParents: readonly Oid[] | null;   // null = board-only (liveCode == tip)
  scope: (p: string) => ScopeClass; masked: (p: string) => boolean;
  heldEntriesAdded: number;                                                       // 0 in Plan 2
  readBlob: (o: Oid) => Promise<Buffer>;
}
export type PrePushResult = { ok: true } | { ok: false; letter: AssertLetter; path: string | null };

const SPECIAL: ReadonlySet<string> = new Set(['120000', '160000']);
const PATH_CLASSES: ReadonlySet<ScopeClass> = new Set<ScopeClass>(['QUARANTINED', 'SAVE_ONLY', 'UNMANAGED']);
const OUTGOING_GUARDED: ReadonlySet<ScopeClass> = new Set<ScopeClass>(['QUARANTINED', 'SAVE_ONLY']);

const fail = (letter: AssertLetter, path: string | null): PrePushResult => ({ ok: false, letter, path });

/**
 * ENG-41 (i) and HLD-19's INV-MASK over P, the one place their letters are assigned: the first path differing from A in P
 * that a record masks (`masked`: letter 'i'), else the first whose path class withholds it (QUARANTINED, SAVE_ONLY,
 * UNMANAGED: 'INV-MASK'); null when no held path differs. publishStep's check before the merge and prePushAsserts share it.
 */
export function heldPathInP(A: TreeMap, P: TreeMap, masked: (p: string) => boolean, scope: (p: string) => ScopeClass): { letter: 'i' | 'INV-MASK'; path: string } | null {
  const pDiff = diffPaths(A, P);
  for (const p of pDiff) if (masked(p)) return { letter: 'i', path: p };
  for (const p of pDiff) if (PATH_CLASSES.has(scope(p))) return { letter: 'INV-MASK', path: p };
  return null;
}

/** Marker rows of a regular entry's blob (none for an absent or special entry). */
async function markerRows(inp: PrePushInput, e: TreeEntry | undefined): Promise<Set<string>> {
  return isRegular(e) ? conflictMarkerRows(await inp.readBlob(e.oid)) : new Set();
}

export async function prePushAsserts(inp: PrePushInput): Promise<PrePushResult> {
  const { A, P, tipMap: TIP, out: OUT } = inp;

  // (a) Bnew = [T, liveCode]; liveCode is TIP (board-only) or a C whose sole parent is TIP.
  const parents = inp.bnewParents;
  if (inp.T === ABSENT || parents.length !== 2 || parents[0] !== inp.T || parents[1] !== inp.liveCode) return fail('a', null);
  if (inp.cParents === null ? inp.liveCode !== inp.tip : inp.cParents.length !== 1 || inp.cParents[0] !== inp.tip || inp.liveCode === inp.tip) {
    return fail('a', null);
  }

  // (d) a validated tree oid, never the empty tree over a non-empty TIP (ENG-09: an empty OUT would delete the live tree).
  if (!isOid(inp.outTree) || (TIP.size > 0 && (inp.outTree === inp.emptyTree || OUT.size === 0))) return fail('d', null);

  const outDiff = diffPaths(TIP, OUT);
  const pDiff = diffPaths(A, P);
  const pChanged = new Set(pDiff);

  // (b) paths(diff(TIP, OUT)) ⊆ paths(diff(A, P)) — a code publish (P differs from A somewhere).
  if (pDiff.length > 0) {
    for (const p of outDiff) if (!pChanged.has(p)) return fail('b', p);
  }
  // (c) OUT[p] == TIP[p] for every p with P[p] == A[p].
  for (const p of outDiff) if (!pChanged.has(p)) return fail('c', p);

  // (e) no blob of diff(TIP, OUT) carries a conflict-marker row absent from both P[p] and TIP[p].
  for (const p of outDiff) {
    const rows = await markerRows(inp, OUT.get(p));   // none for a deletion, a symlink or a gitlink
    if (rows.size === 0) continue;                    // P[p] and TIP[p] are read only when OUT[p] has marker rows
    const known = new Set([...(await markerRows(inp, P.get(p))), ...(await markerRows(inp, TIP.get(p)))]);
    for (const r of rows) if (!known.has(r)) return fail('e', p);
  }

  // (g) no 160000 / 120000 entry differs from TIP.
  for (const p of outDiff) {
    const o = OUT.get(p);
    const t = TIP.get(p);
    if ((o !== undefined && SPECIAL.has(o.mode)) || (t !== undefined && SPECIAL.has(t.mode))) return fail('g', p);
  }

  // (h) no quarantined or save-only path differs from TIP.
  for (const p of outDiff) if (OUTGOING_GUARDED.has(inp.scope(p))) return fail('h', p);

  // (i) no held path differs from A in P; INV-MASK (HLD-19): no QUARANTINED, SAVE_ONLY or UNMANAGED path differs from A in P.
  const held = heldPathInP(A, P, inp.masked, inp.scope);
  if (held !== null) return fail(held.letter, held.path);

  // (j) every held/ entry Bnew adds belongs to a mirrored LIVE record: Plan 2 mirrors no record, so none may be added.
  if (inp.heldEntriesAdded !== 0) return fail('j', null);

  return { ok: true };
}
