// ENG-41 pre-push asserts (01-engine §3.12 step 5; glossary §21 INV-MASK, INV-PUSHED-IS-MERGE; HLD-19). Letter (f) is
// SEC-07's secret scan, out per ruling R-06 (Plan 7). Pure over the given trees: the caller built OUT, C and Bnew and reads
// the parents back from git, so (a) checks the objects that would be pushed, not the caller's intentions.
//
// Check order (the first failure is reported): (a) parents, (d) OUT non-empty, (b) paths(diff(TIP, OUT)) ⊆ paths(diff(A, P))
// for a code publish, (c) OUT[p] == TIP[p] wherever P[p] == A[p], (e) new conflict-marker rows, (g) gitlinks and symlinks,
// (h) quarantined and save-only paths, (i) held paths in P, INV-MASK path classes in P, (j) held/ entries, (k) restore-marker
// rows in new live blobs.
//
// (b) and (c) state one fact twice (p ∉ diff(A, P) ⇒ p ∉ diff(TIP, OUT)); (b) is the code-publish form and runs only when
// P differs from A somewhere, so (c) is the letter of a publish whose P is A everywhere (board-only: OUT must be TIP).
// (i) is the held side of ENG-41 (i) (`masked`: a record — PIN, CONFLICTED, local_only, whole-path guard — masks p); the
// path classes QUARANTINED, SAVE_ONLY and UNMANAGED differing from A in P are reported as HLD-19's INV-MASK assertion.
// Plan 3 (Task 2, R3-20): `masked(p)` keeps meaning "withheld whole by a record" — MASK steps 2–4, a binary or filtered step-5
// path, or a step-5 conflict: MaskResult.withheld.has(p) && maskReason(p) !== 'path_class' (publishStep computes it itself).
// A step-5 path MASK changed only partly is not `masked`: its held ranges are HLD-19's assertP (clause p_range), not letter (i).
// Plan 3 (Task 4; ENG-41 (j), DAT-46, D-18): (j) checks the held/ entries Bnew really adds (`heldAdded`, exactly its puts):
// each belongs to a non-local_only record and a LIVE path, and no new held/ blob carries a restore-marker row (LF or CRLF)
// unless that blob is already a blob of tree(TIP).
// Final review R3-FF2-B1 (DAT-46's live-blob half, INV-DAT-NOMARKER): (k) is the fail-closed backstop for a masking site that
// missed a restore-marker path (a journaled pair whose R holds the rows of a conflicted RESTORE, its `markers` record parked):
// no blob of diff(TIP, OUT) carries a restore-marker row unless that blob is already a blob of tree(TIP). It is independent of P
// ((e) passes whenever P[p] carries the rows, which is exactly that shape) and reuses (e)'s single read of each OUT blob. Last
// letter, so every earlier letter keeps its report. Final review r3 B3-1 (ruling R3-FF3-B1; DAT-46 has no text-only qualifier): it
// scans every such blob whatever the DAT-04 binary sniff, as (j) does — R3-18 sniffs only a RESTORE's input sides, and a conflicted
// merge of three text sides can put its NUL in the first 8,000 bytes (both sides delete rows before it), a result restore() still
// marks `markers` (hasRestoreMarkerRow, no binary gate).
import type { HeldBlob } from '../board/boardCommit.js';
import type { ScopeClass } from '../data/scope.js';
import { conflictMarkerRows, hasRestoreMarkerRow } from '../data/rows.js';
import { ABSENT, isOid, type Oid, type OidOrAbsent } from '../git/oid.js';
import type { TreeEntry, TreeMap } from '../git/repo.js';
import { diffPaths, isRegularEntry as isRegular } from './treeDiff.js';

export type AssertLetter = 'a' | 'b' | 'c' | 'd' | 'e' | 'g' | 'h' | 'i' | 'j' | 'k' | 'INV-MASK';
export interface PrePushInput {
  T: OidOrAbsent; tip: Oid; tipMap: TreeMap; A: TreeMap; P: TreeMap; out: TreeMap; outTree: Oid; emptyTree: Oid;
  bnewParents: readonly Oid[]; liveCode: Oid; cParents: readonly Oid[] | null;   // null = board-only (liveCode == tip)
  scope: (p: string) => ScopeClass;
  /** Withheld whole by a record (MASK steps 2–4, a binary/filtered step-5 path, a step-5 conflict); never a path class (R3-20). */
  masked: (p: string) => boolean;
  /** The held/ entries Bnew adds (its puts; Plan 3 Task 4): (j) non-local_only, LIVE, no restore-marker row unless the blob is in tree(TIP). */
  heldAdded: ReadonlyArray<{ holdId: string; path: string; stage: HeldBlob['stage']; oid: Oid; localOnly: boolean; live: boolean }>;
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

/** The blob ids of tree(TIP), built once per call when (j) or (k) needs them. */
function tipBlobs(TIP: TreeMap): () => ReadonlySet<string> {
  let s: Set<string> | null = null;
  return () => (s ??= new Set<string>([...TIP.values()].map((e) => e.oid)));
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

  // (e) no blob of diff(TIP, OUT) carries a conflict-marker row absent from both P[p] and TIP[p]. The same read gives (k) its
  // input: every restore-marker row is a conflict-marker row, so a blob without marker rows has none.
  const inTip = tipBlobs(TIP);
  let liveMarked: string | null = null;   // (k): the first path of diff(TIP, OUT) whose new blob carries a restore-marker row
  for (const p of outDiff) {
    const o = OUT.get(p);
    if (!isRegular(o)) continue;                      // nothing to scan for a deletion, a symlink or a gitlink
    const blob = await inp.readBlob(o.oid);
    const rows = conflictMarkerRows(blob);
    if (rows.size === 0) continue;                    // P[p] and TIP[p] are read only when OUT[p] has marker rows
    if (liveMarked === null && hasRestoreMarkerRow(blob) && !inTip().has(o.oid)) liveMarked = p;   // text or binary (R3-FF3-B1)
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

  // (j) every held/ entry Bnew adds belongs to a non-local_only record and a LIVE path (ENG-41 (j), D-18), and no new held/ blob
  // holds a restore-marker row — LF or CRLF, row 1's BOM ignored (Review Focus 5) — unless that blob is already one of
  // tree(TIP) (DAT-46). Each blob is read once.
  if (inp.heldAdded.length > 0) {
    const marked = new Map<string, boolean>();
    for (const e of inp.heldAdded) {
      if (e.localOnly || !e.live) return fail('j', e.path);
      if (inTip().has(e.oid)) continue;
      let m = marked.get(e.oid);
      if (m === undefined) {
        m = hasRestoreMarkerRow(await inp.readBlob(e.oid));
        marked.set(e.oid, m);
      }
      if (m) return fail('j', e.path);
    }
  }

  // (k) no new live blob — a blob of diff(TIP, OUT) that is not already a blob of tree(TIP), text or binary by DAT-04 — carries a
  // restore-marker row, LF or CRLF, row 1's BOM ignored (DAT-46's live-blob half; rulings R3-FF2-B1, R3-FF3-B1), whatever P holds:
  // found by (e)'s loop above.
  if (liveMarked !== null) return fail('k', liveMarked);

  return { ok: true };
}
