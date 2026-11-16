// The ports later plans bind (Plan 3 Task 10; rulings R3-03, R3-04, R3-07; rev 2.5 X-07, X-08): the edit check (04-regions
// editCheck, REG-36), T0's region items 1–2 (HLD-50, REG-24/REG-27), the B1 publish gate with the claim PREDICATE (REG-20) and
// the HLD-48/HLD-49 symbol branch, each with its Plan 3 binding — grammarlessEditCheck, passT0Regions, openGate, noSymbols —
// bound through the one plan3Ports() at every EngineDeps construction site; and HLD-50 item 3's shrink guard, t0Shrink, which
// Plan 3 owns. Nothing here reads claim state (HLD-06): the only claim-dependent input is PublishGatePort.
import type { EditCheckEntry, EditCheckReason } from '../regions/editCheck.js';   // type-only, erased at build: the one src/regions import L-CLAIMFREE-HOLDS allows here
export type { EditCheckEntry, EditCheckReason };                                // re-exported so src/holds consumers name them without a src/regions import
import type { Oid } from '../git/oid.js';
import { MergeFailedError, mergeTree } from '../git/merge.js';
import { GitCommandError, type GitRepo, type TreeEntry, type TreeMap } from '../git/repo.js';
import type { HoldRecord } from './record.js';

/**
 * rev 2.5 (X-08): fail and incomplete carry `entries?` — 04-regions §3.20's failed entries, ordered by check, path, line;
 * Plan 3 Task 10 declared the element with its own shape (`check?; path; line?; reason: string`); Plan 4 Task 5 narrows it
 * to EditCheckEntry (reason: the closed EditCheckReason, R4-42), which stays assignable (X-08). `failed` keeps Plan 3's
 * meaning: the distinct check numbers (Plan 5 reads entries, never a re-typed failed).
 */
export type EditCheckVerdict = { verdict: 'pass' }
  | { verdict: 'fail'; failed: ReadonlyArray<1 | 2 | 3 | 4>; entries?: readonly EditCheckEntry[] }
  | { verdict: 'incomplete'; entries?: readonly EditCheckEntry[] };
/** R4-39: the optional trailing opts — the per-CS queue key and the F10 predict mode (D2 drops check 4's size part). */
export interface EditCheckOpts { csId?: string; mode?: 'checkpoint' | 'predict'; }
/** 04-regions editCheck(A, R, TIP, cs) as a port (REG-36); trees as commits or trees, restricted to the CS's paths; incomplete = fail (HLD-67). */
export interface EditCheckPort { check(repo: GitRepo, a: Oid, r: Oid, tip: Oid, csPaths: readonly string[], opts?: EditCheckOpts): Promise<EditCheckVerdict>; }

/**
 * F14 §4 numbering of T0 findings (FEAT-F14-07; R4-38): rev 2.5 (X-07) declares the fail form's `findings?` element as
 * `{check: 1–4; path; line?}`; Plan 4 Task 5 narrows it to T0Finding (+ reason, symbol?), which stays assignable. Plan 3
 * imports nothing from src/regions for it. Plan 3 fills item 3 from t0Shrink; passT0Regions never fails.
 */
export interface T0Finding { check: 1 | 2 | 3 | 4; path: string; line?: number; reason: EditCheckReason; symbol?: { qualname: string; simple: string }; }
export type T0Verdict = { pass: true }
  | { pass: false; paths: string[]; item: 1 | 2 | 3; findings?: readonly T0Finding[] }
  | { incomplete: true };
/** R4-38: the optional trailing ctx — A, P and the group's CS ids (items 1–2 need them; without it the port is `incomplete`). */
export interface T0Ctx { a: Oid; p: Oid; csIds: readonly string[]; }
/** HLD-50 items 1–2 (REG-24 regionTripwire relative form, REG-27 interfaceCheck over the merged tree); Plan 4 binds. */
export interface T0RegionsPort { check(repo: GitRepo, tip: Oid, out: Oid, paths: readonly string[], ctx?: T0Ctx): Promise<T0Verdict>; }

/** B1's block detail (R4-37): every blocked CS with its claims, holders and touch reasons, and the admitted ones. */
export interface GateBlockDetail {
  blocked: ReadonlyArray<{ csId: string; claimId: string; holder: { peer: string; seat: string }; path: string; reason: string }>;
  admitted: ReadonlyArray<{ csId: string; claimId: string; path: string }>;
}

/** B1 (REG-20) over every hunk of diff(A[p], R[p]) of a ready group at the exact leased tip, and the `claim` PREDICATE (R4-37). */
export interface PublishGatePort {
  gate(repo: GitRepo, tip: Oid, A: TreeMap, R: TreeMap, paths: readonly string[], csIds: readonly string[]): Promise<{ block: null } | { block: { claimId: string; claimIds?: readonly string[]; detail?: GateBlockDetail } }>;
  claimStillBlocks(r: HoldRecord): Promise<boolean>;
}

/** HLD-48/HLD-49 symbol branch (REG symbol delta, 05 §8 Q2); Plan 4 binds. R4-50: shadowDependency is optional, Plan 5 wires it. */
export interface SymbolPort {
  referencesHeldOnly(repo: GitRepo, held: HoldRecord, csR: TreeMap, A: TreeMap): Promise<boolean>;
  shadowDependency?(repo: GitRepo, shadow: HoldRecord, csA: TreeMap, csR: TreeMap): Promise<boolean>;
}

/** Regular blobs and symlinks: the entries whose stored size compares (a gitlink names a commit of another repository). */
const SIZED: ReadonlySet<string> = new Set(['100644', '100755', '120000']);

/** The tree of a commit or a tree oid. */
async function treeOfObject(repo: GitRepo, o: Oid): Promise<Oid> {
  return (await repo.hasObject(o, 'commit')) ? (await repo.readCommit(o)).tree : o;
}

/** Stored sizes of the sized entries among `entries` (one cat-file --batch-check). */
async function sizesOf(repo: GitRepo, entries: ReadonlyArray<TreeEntry | undefined>): Promise<Map<string, number>> {
  const oids = [...new Set(entries.filter((e): e is TreeEntry => e !== undefined && SIZED.has(e.mode)).map((e) => e.oid))];
  const sizes = await repo.blobSizes(oids);
  return new Map(oids.map((o, i) => [o, sizes[i] ?? 0] as const));
}

/** check 4's size clause and T0's shrink rule: TIP[p] non-empty and the result absent, empty or under half of TIP's stored size. */
function shrunk(tip: TreeEntry | undefined, res: TreeEntry | undefined, sizes: ReadonlyMap<string, number>): boolean {
  if (tip === undefined || !SIZED.has(tip.mode)) return false;
  const before = sizes.get(tip.oid) ?? 0;
  if (before === 0) return false;
  const after = res === undefined || !SIZED.has(res.mode) ? 0 : (sizes.get(res.oid) ?? 0);
  return after === 0 || after * 2 < before;
}

function sameEntry(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && a.oid === b.oid && a.mode === b.mode;
}

/**
 * The Plan 3 binding of the edit check (R3-03; glossary §27.1 with no grammar): checks 1–3 pass trivially for every path, and
 * check 4's size clause applies (04-regions §3.20 check 4): over the checked paths — the CS's paths with R[p] ≠ A[p] — of
 * M = merge-tree --merge-base=A R TIP, a path whose TIP[p] is non-empty fails when M[p] is absent, empty or smaller than 50 % of
 * TIP[p]'s stored size. A checked path that merge-tree left conflicted fails with an entry `merge_conflict` (no check number),
 * and a merge that cannot run with `no_merge` (REG-36: a conflicted or missing merge result fails the check). Writes no ref.
 */
export const grammarlessEditCheck: EditCheckPort = Object.freeze({
  async check(repo: GitRepo, a: Oid, r: Oid, tip: Oid, csPaths: readonly string[]): Promise<EditCheckVerdict> {
    const [aTree, rTree, tipTree] = [await treeOfObject(repo, a), await treeOfObject(repo, r), await treeOfObject(repo, tip)];
    const A = await repo.readTreeMap(aTree);
    const R = await repo.readTreeMap(rTree);
    const checked = [...new Set(csPaths)].filter((p) => !sameEntry(R.get(p), A.get(p))).sort();
    if (checked.length === 0) return { verdict: 'pass' };
    let merged;
    try {
      merged = await mergeTree(repo, aTree, rTree, tipTree);
    } catch (e) {
      if (!(e instanceof MergeFailedError) && !(e instanceof GitCommandError)) throw e;
      return { verdict: 'fail', failed: [], entries: [{ path: checked[0]!, reason: 'no_merge' }] };
    }
    const conflicted = checked.filter((p) => merged.conflicted.includes(p));
    if (conflicted.length > 0) return { verdict: 'fail', failed: [], entries: conflicted.map((p) => ({ path: p, reason: 'merge_conflict' })) };
    const TIP = await repo.readTreeMap(tipTree);
    const M = await repo.readTreeMap(merged.tree);
    const sizes = await sizesOf(repo, checked.flatMap((p) => [TIP.get(p), M.get(p)]));
    // Check 4's size clause carries no row (REG-36); with no grammar there is no other entry to report.
    return checked.some((p) => shrunk(TIP.get(p), M.get(p), sizes)) ? { verdict: 'fail', failed: [4] } : { verdict: 'pass' };
  },
});

/** HLD-50 items 1–2 before Plan 4: always passes (R3-04). */
export const passT0Regions: T0RegionsPort = Object.freeze({
  async check(): Promise<T0Verdict> {
    return { pass: true };
  },
});

/**
 * HLD-50 item 3: the paths of `paths` going from non-empty to empty or absent, or losing more than 50 % of their stored size, from
 * TIP to OUT, unless attributed (R-25's human rule through `attributed`); in path order. Exactly half passes; a path empty or absent
 * in TIP passes.
 */
export async function t0Shrink(repo: GitRepo, tip: TreeMap, out: TreeMap, paths: readonly string[], attributed: (path: string) => boolean): Promise<string[]> {
  const sorted = [...new Set(paths)].sort();
  const sizes = await sizesOf(repo, sorted.flatMap((p) => [tip.get(p), out.get(p)]));
  return sorted.filter((p) => shrunk(tip.get(p), out.get(p), sizes) && !attributed(p));
}

/** B1 before Plan 4: never blocks; the claim PREDICATE answers true (fail closed: no Plan 3 code creates a claim record, R3-07). */
export const openGate: PublishGatePort = Object.freeze({
  async gate(): Promise<{ block: null }> {
    return { block: null };
  },
  async claimStillBlocks(): Promise<boolean> {
    return true;
  },
});

/** The symbol branch before Plan 4: no CS references a held name only (HLD-48/HLD-49 path branch only, R3-07). */
export const noSymbols: SymbolPort = Object.freeze({
  async referencesHeldOnly(): Promise<boolean> {
    return false;
  },
});

/**
 * The one Plan 3 binding of the four ports; src/daemon/run.ts, tools/real/two-clone.ts, test/sim/engineAdapter.ts and both test
 * fixtures spread it into EngineDeps (X-111: a later plan's binder replaces it there).
 */
export function plan3Ports(): { editCheck: EditCheckPort; t0Regions: T0RegionsPort; gate: PublishGatePort; symbols: SymbolPort } {
  return { editCheck: grammarlessEditCheck, t0Regions: passT0Regions, gate: openGate, symbols: noSymbols };
}
