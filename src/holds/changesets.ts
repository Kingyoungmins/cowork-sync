// The human change-set and its ready pairs (HLD-33, HLD-35, HLD-37, HLD-38, HLD-40…HLD-42; ruling R-01). Task 8
// seeded the ready-pair type and its journal key, which the state ref stores as journal/ready/<readyKey(cs_id)>/{R,A}
// (glossary §4); Task 11 adds ChangeSets.
//
// Plan 2 has one CS kind, the peer's human CS (HLD-35): it opens at the first local delta, closes after 20 s Δmono
// without a change on any of its paths or at done(), and its close captures one ready pair (A_cap, R) as sparse trees
// of its paths (HLD-40). P is MASK(R) of the newest ready pair covering each path and A[p] elsewhere (HLD-42); every
// state update that changes A[p] on a ready path rebases the pair by HLD-41, with its conflict split. The open CS
// is not journaled: after a restart the engine re-forms it through observe() from diff(A, S_disk) minus ready paths.
import { Buffer } from 'node:buffer';
import type { PeerId } from '../board/ids.js';
import { mergeFile } from '../git/merge.js';
import type { Oid } from '../git/oid.js';
import type { GitRepo, IndexEdit, TreeEntry, TreeMap } from '../git/repo.js';
import { resetScratchIndex } from '../git/scratchIndex.js';
import type { Clock } from '../ports/clock.js';
import type { Fs } from '../ports/fs.js';
import { validId } from '../sec/validators.js';

/** HLD-35: a human CS closes this long (local Δmono) after the last change on any of its paths. */
export const HUMAN_CS_QUIET_MS = 20_000;

/** order: capture sequence (newest wins). */
export interface ReadyPair { csId: string; R: Oid; A: Oid; paths: string[]; order: number; }
// The journal holds only ready/<k>/{R,A} (glossary §4): StateStore.read derives csId from the key, paths from the union of R's and A's
// entries, and order from n of `<peer>/human/<n>` (R-01), so "newest capture wins" survives a restart.

export interface RebaseChange {
  path: string;
  aOld: TreeEntry | null; aNew: TreeEntry | null;            // A[p] before / after the state update
  written: 'clean' | 'concat' | 'take_tip' | 'none';         // what the update did to p ('none' = A changed without a write)
  sDiskBefore: TreeEntry | null;                              // S_disk[p] before the apply
  writtenEntry: TreeEntry | null;                             // the verified-written M_disk[p] (clean or concat)
}
/** ready: the pairs after the rebase (journal them in the same update); cancelled → CS_READY_CANCELLED; recapture: paths re-captured later. */
export interface RebaseResult { ready: ReadyPair[]; cancelled: string[]; recapture: ReadonlySet<string>; }

/** composeP found A_cap[p] ≠ A[p]: a state update changed A[p] without the HLD-41 rebase (ENG-39; mutant M20). */
export class ReadyBaseMismatchError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`ready pair base A_cap differs from A on ${JSON.stringify(path)}`);
    this.name = 'ReadyBaseMismatchError';
    this.path = path;
  }
}

/** base64url(utf8(cs_id)) without padding: a tree entry name for any cs_id. A string validId('cs') refuses throws. */
export function readyKey(csId: string): string {
  if (!validId('cs', csId)) throw new TypeError(`readyKey: not a change-set id ${JSON.stringify(csId)}`);
  return Buffer.from(csId, 'utf8').toString('base64url');
}

/** Regular files: the only modes merge-file rebases (a symlink or gitlink that changed on both sides conflicts). */
const FILE_MODES: ReadonlySet<string> = new Set(['100644', '100755']);

/** Equal entries (oid and mode); null = absent. */
function same(a: TreeEntry | null, b: TreeEntry | null): boolean {
  return a === null ? b === null : b !== null && a.oid === b.oid && a.mode === b.mode;
}

function byOrder(a: ReadyPair, b: ReadyPair): number {
  return a.order - b.order || (a.csId < b.csId ? -1 : a.csId > b.csId ? 1 : 0);
}

/**
 * HLD-41's plain rebase of one path, R[p] := merge-file(A_new, A_cap, R): the entry (null = absent) when it is clean,
 * undefined for a conflict. An absent side on a path both sides changed (add/add, modify/delete) is a conflict.
 */
async function rebaseEntry(repo: GitRepo, path: string, aNew: TreeEntry | null, acap: TreeEntry | null, r: TreeEntry | null): Promise<TreeEntry | null | undefined> {
  if (same(r, acap)) return aNew;          // the pair left p as it was: take the new base
  if (same(r, aNew)) return r;             // the update made the pair's own change
  if (acap === null || aNew === null || r === null) return undefined;
  let mode: string;
  if (r.mode === acap.mode) mode = aNew.mode;
  else if (aNew.mode === acap.mode || aNew.mode === r.mode) mode = r.mode;
  else return undefined;
  if (r.oid === aNew.oid) return { path, mode: mode as TreeEntry['mode'], oid: r.oid };
  if (r.oid === acap.oid) return { path, mode: mode as TreeEntry['mode'], oid: aNew.oid };
  if (aNew.oid === acap.oid) return { path, mode: mode as TreeEntry['mode'], oid: r.oid };
  if (![acap.mode, aNew.mode, r.mode].every((m) => FILE_MODES.has(m))) return undefined;
  const m = await mergeFile(repo, aNew.oid, acap.oid, r.oid);
  if (m.rc !== 0) return undefined;
  // Route (c): merge output of stored-form blobs is stored form.
  return { path, mode: mode as TreeEntry['mode'], oid: await repo.hashBytes(m.out, true) };
}

/** What a rebase does to a whole capture: keep it ready, withdraw it silently, or cancel it (CS_READY_CANCELLED); both re-capture. */
type Verdict = 'keep' | 'withdraw' | 'cancel';
const STRENGTH: Readonly<Record<Verdict, number>> = { keep: 0, withdraw: 1, cancel: 2 };

/**
 * HLD-41's split for a rebase conflict on p, decided by what the update did to p: R's new entry (null = absent) or the
 * capture's verdict. take_tip, or A changed without a write → cancel; a clean or concat write after a later file effect on p
 * (S_disk[p] ≠ R[p] before the apply) → withdraw; else R[p] := the verified-written entry. A written entry of null is a
 * deletion in R only when A_new lacks p as well: a clean or concat write cannot delete p while A_new has it, so that input is
 * withdrawn and re-captured from the disk instead of publishing a deletion the disk may not have.
 */
function decideConflict(ch: RebaseChange, r: TreeEntry | null): { entry: TreeEntry | null } | Exclude<Verdict, 'keep'> {
  if (ch.written !== 'clean' && ch.written !== 'concat') return 'cancel';
  if (!same(ch.sDiskBefore, r)) return 'withdraw';
  if (ch.writtenEntry !== null) return { entry: ch.writtenEntry };
  return ch.aNew === null ? { entry: null } : 'withdraw';
}

/** One ready pair's own rebase: its verdict and, when kept, the edits of its R and A_cap trees and its paths after them. */
interface RebasePlan { pair: ReadyPair; verdict: Verdict; rEdits: IndexEdit[]; aEdits: IndexEdit[]; paths: string[]; }

/**
 * The verdict of each plan's publication group (HLD-38: ready pairs connected through shared paths, transitively): the
 * strongest verdict of any member, so a group is withdrawn or cancelled whole, never one pair alone (INV-HLD-ATOMIC-PUB).
 */
function groupVerdicts(plans: readonly RebasePlan[]): Verdict[] {
  const parent = plans.map((_, i) => i);
  const find = (i: number): number => {
    let x = i;
    while (parent[x] !== x) x = parent[x]!;
    for (let y = i; parent[y] !== x;) { const up = parent[y]!; parent[y] = x; y = up; }
    return x;
  };
  const owner = new Map<string, number>();
  plans.forEach((plan, i) => {
    for (const p of plan.pair.paths) {
      const j = owner.get(p);
      if (j === undefined) owner.set(p, i);
      else parent[find(i)] = find(j);
    }
  });
  const strongest = new Map<number, Verdict>();
  plans.forEach((plan, i) => {
    const root = find(i);
    const v = strongest.get(root) ?? 'keep';
    strongest.set(root, STRENGTH[plan.verdict] > STRENGTH[v] ? plan.verdict : v);
  });
  return plans.map((_, i) => strongest.get(find(i))!);
}

/** One pair's own HLD-41 rebase (merge outputs are written by route (c); no tree is built here). */
async function planRebase(repo: GitRepo, pair: ReadyPair, byPath: ReadonlyMap<string, RebaseChange>): Promise<RebasePlan> {
  const plan: RebasePlan = { pair, verdict: 'keep', rEdits: [], aEdits: [], paths: pair.paths };
  const touched = pair.paths.filter((p) => byPath.has(p));
  if (touched.length === 0) return plan;
  const R = await repo.readTreeMap(pair.R);
  const Acap = await repo.readTreeMap(pair.A);
  const rKeys = new Set(R.keys());
  const aKeys = new Set(Acap.keys());
  for (const p of touched) {
    const ch = byPath.get(p)!;
    const acap = Acap.get(p) ?? null;
    const r = R.get(p) ?? null;
    if (same(acap, ch.aNew) && ch.written !== 'take_tip') continue;   // already on the new base (a take_tip still decides)
    let next = await rebaseEntry(repo, p, ch.aNew, acap, r);
    if (next === undefined) {
      const d = decideConflict(ch, r);
      if (typeof d === 'string') {
        if (STRENGTH[d] > STRENGTH[plan.verdict]) plan.verdict = d;
        if (d === 'cancel') break;   // nothing is stronger; a withdrawal still looks for a cancellation on the other paths
        continue;
      }
      next = d.entry;
    }
    if (plan.verdict !== 'keep') continue;   // the capture leaves: its edits are never used
    if (next !== null) {
      plan.rEdits.push({ path: p, mode: next.mode, oid: next.oid });
      rKeys.add(p);
    } else if (rKeys.delete(p)) {
      plan.rEdits.push({ path: p, remove: true });
    }
    if (ch.aNew !== null) {
      plan.aEdits.push({ path: p, mode: ch.aNew.mode, oid: ch.aNew.oid });
      aKeys.add(p);
    } else if (aKeys.delete(p)) {
      plan.aEdits.push({ path: p, remove: true });
    }
  }
  if (plan.verdict !== 'keep' || (plan.rEdits.length === 0 && plan.aEdits.length === 0)) return plan;
  plan.paths = [...new Set([...rKeys, ...aKeys])].sort();
  // Nothing left in R or A_cap: the pair leaves through `recapture` (withdrawn, no message), never silently; the
  // recapture reads the disk, so it publishes nothing when the disk and A agree p is gone.
  if (plan.paths.length === 0) plan.verdict = 'withdraw';
  return plan;
}

interface OpenCs { paths: Set<string>; lastChangeMono: number; done: boolean; }

export class ChangeSets {
  private readonly peer: PeerId;
  private readonly clock: Clock;
  /** The Fs port for the capture's scratch-index reset (P2-SCRATCHLOCK); absent in unit uses without an engine. */
  private readonly fs: Fs | null;
  private nextN = 1;
  private open: OpenCs | null = null;
  /** Paths of withdrawn or cancelled captures with no open member to carry them: re-captured at the next snapshot (HLD-41). */
  private readonly pending = new Set<string>();
  private pairs: ReadyPair[] = [];

  constructor(peer: PeerId, clock: Clock, fs?: Fs) {
    if (!validId('hex128', peer)) throw new TypeError(`ChangeSets: not a peer id ${JSON.stringify(peer)}`);
    this.peer = peer;
    this.clock = clock;
    this.fs = fs ?? null;
  }

  /** The journal's ready pairs and meta.cs_human_next; the open CS re-forms through observe(). n never reuses a journaled order. */
  restore(ready: readonly ReadyPair[], nextN: number): void {
    if (!Number.isSafeInteger(nextN) || nextN < 1) throw new RangeError(`ChangeSets.restore: nextN must be a safe integer >= 1, got ${String(nextN)}`);
    this.pairs = ready.map((p) => ({ ...p, paths: [...p.paths] })).sort(byOrder);
    this.nextN = Math.max(nextN, ...this.pairs.map((p) => p.order + 1));
    this.open = null;
    this.pending.clear();
  }

  /** HLD-35: open or extend the human CS with the changed paths; restart its 20 s quiet timer. */
  observe(changed: Iterable<string>): void {
    let any = false;
    for (const p of changed) {
      this.open ??= { paths: new Set(), lastChangeMono: 0, done: false };
      this.open.paths.add(p);
      any = true;
    }
    if (any) this.open!.lastChangeMono = this.clock.monoMs();
    this.absorbPending();
  }

  /** /cowork done: the open CS closes at the next iteration. */
  done(): void {
    if (this.open !== null) this.open.done = true;
  }

  /** 20 s Δmono quiet, done(), or a pending recapture. */
  closeDue(): boolean {
    return this.openDue() || this.pending.size > 0;
  }

  /**
   * HLD-40 at the close (the iteration materialized): R[p] = S_disk[p], A_cap[p] = A[p] over the closing CS's paths plus
   * pending recaptures, sparse trees by writeTreeMap; cs_id `<peer>/human/<n>`, n then increments. A path absent from
   * both trees is not a path of the pair (a sparse tree cannot say "absent"), so the newest capture of such a path — a
   * file created and then deleted before it was published — is expressed by every older ready pair dropping it from R
   * and A_cap (a pair left with no path leaves the journal): the creation is never published (Task 19 ruling, HLD-42's
   * "the newest capture wins"; A lacks p, so A_cap[p] is absent as well and P[p] = A[p] = absent).
   * `kept`: the cs_ids a kept push intent names (Task 19 ruling, fix round 3). Such a pair is never shrunk: the push may
   * have landed, and its ok update reads A_cap from the pair (A[p] := C[p] only where the pair still lists p), so a
   * shrunk pair would leave A behind TIP and the next apply would write the deleted file back. Its vanished path waits
   * in `pending` instead and re-closes at the next capture after the intent resolved: landed, A has p and the disk
   * lacks it, so a deletion pair is captured; not landed, the pair is no longer kept and drops p.
   * Returns null when nothing changed in the journal (nothing due, or only paths absent everywhere that no unkept pair
   * covers); otherwise `pair` is the new ready pair, or null when the close only shrank older pairs, and the caller
   * journals ready() with `nextN` (unchanged when no pair was captured: no n is consumed).
   */
  async capture(
    repo: GitRepo, sDisk: TreeMap, A: TreeMap, scratchIndex: string, kept: ReadonlySet<string> = new Set(),
  ): Promise<{ pair: ReadyPair | null; nextN: number } | null> {
    const closing = this.openDue();
    if (!closing && this.pending.size === 0) return null;
    const paths = new Set(this.pending);
    if (closing) for (const p of this.open!.paths) paths.add(p);
    const R = new Map<string, TreeEntry>();
    const Acap = new Map<string, TreeEntry>();
    const vanished = new Set<string>();
    for (const p of [...paths].sort()) {
      const r = sDisk.get(p);
      const a = A.get(p);
      if (r !== undefined) R.set(p, { path: p, mode: r.mode, oid: r.oid });
      if (a !== undefined) Acap.set(p, { path: p, mode: a.mode, oid: a.oid });
      if (r === undefined && a === undefined) vanished.add(p);
    }
    const pairPaths = [...new Set([...R.keys(), ...Acap.keys()])].sort();
    let pair: ReadyPair | null = null;
    if (pairPaths.length > 0) {
      const n = this.nextN;
      const csId = `${this.peer}/human/${n}`;
      readyKey(csId);
      // P2-SCRATCHLOCK (the shared helper): the scratch index and a stale <index>.lock go before each read-tree; a
      // holder that keeps either throws ScratchResetError (the capture fails, the CS closes again next time).
      await this.resetScratch(scratchIndex);
      const rTree = await repo.writeTreeMap(R, scratchIndex);
      await this.resetScratch(scratchIndex);
      const aTree = await repo.writeTreeMap(Acap, scratchIndex);
      pair = { csId, R: rTree, A: aTree, paths: pairPaths, order: n };
    }
    const { pairs: shrunk, deferred } = await this.withoutVanished(repo, vanished, kept, scratchIndex);
    // State changes only after the trees exist, so a failed git call leaves the CS to close again.
    if (closing) this.open = null;
    this.pending.clear();
    for (const p of deferred) this.pending.add(p);
    if (shrunk !== null) this.pairs = shrunk;
    if (pair === null) return shrunk === null ? null : { pair: null, nextN: this.nextN };
    this.nextN = pair.order + 1;
    this.pairs.push(pair);
    this.pairs.sort(byOrder);
    return { pair: { ...pair, paths: [...pair.paths] }, nextN: this.nextN };
  }

  /**
   * The ready pairs after dropping `vanished` (closing paths absent from S_disk and A) from every pair covering one: its
   * R and A_cap lose the path (only the trees that hold it are rewritten), a pair left with no path leaves. A pair in
   * `kept` (named by a kept push intent) is left whole and its vanished paths are returned as `deferred`. `pairs` is null
   * when no unkept pair covers a vanished path. Builds trees only; the caller replaces `pairs` and fills `pending`.
   */
  private async withoutVanished(
    repo: GitRepo, vanished: ReadonlySet<string>, kept: ReadonlySet<string>, scratchIndex: string,
  ): Promise<{ pairs: ReadyPair[] | null; deferred: ReadonlySet<string> }> {
    const deferred = new Set<string>();
    if (vanished.size === 0) return { pairs: null, deferred };
    let changed = false;
    const out: ReadyPair[] = [];
    for (const pair of this.pairs) {
      const gone = pair.paths.filter((p) => vanished.has(p));
      if (gone.length === 0) {
        out.push(pair);
        continue;
      }
      if (kept.has(pair.csId)) {
        for (const p of gone) deferred.add(p);
        out.push(pair);
        continue;
      }
      changed = true;
      const rest = pair.paths.filter((p) => !vanished.has(p));
      if (rest.length === 0) continue;
      const drop = async (tree: Oid): Promise<Oid> => {
        const held = await repo.readTreeMap(tree);
        const edits: IndexEdit[] = gone.filter((p) => held.has(p)).map((p) => ({ path: p, remove: true }));
        if (edits.length === 0) return tree;
        await this.resetScratch(scratchIndex);
        return repo.editTree(tree, edits, scratchIndex);
      };
      out.push({ csId: pair.csId, R: await drop(pair.R), A: await drop(pair.A), paths: rest, order: pair.order });
    }
    return { pairs: changed ? out : null, deferred };
  }

  /**
   * R-01 at a restart (final review FD, Task 19 round-3 residual). `pending` and the open CS are not journaled, so the
   * close that would have dropped a created-then-deleted path from its ready pair (a path `vanished`: absent from A and
   * from the disk) is lost with the process; the restart makes it here, as capture() would: every pair `kept` (named by
   * a kept push intent) does not name drops the path (R and A_cap lose it, a pair left with no path leaves), and a kept
   * pair's path waits in `pending` again, to re-close after the intent resolved. True when the pairs changed: the caller
   * journals ready() (cs_human_next is unchanged: no pair is captured).
   */
  async dropVanished(repo: GitRepo, vanished: ReadonlySet<string>, kept: ReadonlySet<string>, scratchIndex: string): Promise<boolean> {
    const { pairs, deferred } = await this.withoutVanished(repo, vanished, kept, scratchIndex);
    for (const p of deferred) this.pending.add(p);
    this.absorbPending();
    if (pairs === null) return false;
    this.pairs = pairs;
    return true;
  }

  /** P2-SCRATCHLOCK before a read-tree into the capture's scratch index (no Fs port in unit uses without an engine). */
  private async resetScratch(scratchIndex: string): Promise<void> {
    if (this.fs !== null) await resetScratchIndex(this.fs, scratchIndex);
  }

  /**
   * HLD-41 at a state update that changed A: for every ready pair with a changed path, R[p] := merge-file(A_new, A_cap, R)
   * and A_cap[p] := A_new. A conflict on p is decided by what the update did to p (decideConflict): a clean or concat write
   * with S_disk[p] == R[p] before the apply sets R[p] := the written entry and the pair stays ready; a clean or concat write
   * after a later file effect on p withdraws the capture (no message); take_tip, or A changed without a write, cancels it
   * (CS_READY_CANCELLED). A pair left with no path (R and A_cap both lost every entry) is withdrawn, never dropped
   * silently. Withdrawal and cancellation apply to the whole publication group (HLD-38: the ready pairs connected through
   * shared paths), cancellation winning when both occur; only kept groups get rebased trees. Withdrawn and cancelled paths
   * are re-captured at the close of an open CS that shares a path with them, else at the next snapshot (every member is closed).
   */
  async rebase(repo: GitRepo, changes: readonly RebaseChange[], scratchIndex: string): Promise<RebaseResult> {
    const byPath = new Map<string, RebaseChange>();
    // A take_tip with A unchanged (apply.ts: a local path displaced from beneath a TIP file and removed) counts too.
    for (const ch of changes) if (!same(ch.aOld, ch.aNew) || ch.written === 'take_tip') byPath.set(ch.path, ch);
    const plans: RebasePlan[] = [];
    for (const pair of this.pairs) plans.push(await planRebase(repo, pair, byPath));
    const verdicts = groupVerdicts(plans);
    const kept: ReadyPair[] = [];
    const cancelled: string[] = [];
    const recapture = new Set<string>();
    for (const [i, plan] of plans.entries()) {
      const { pair } = plan;
      const verdict = verdicts[i]!;
      if (verdict !== 'keep') {
        for (const p of pair.paths) recapture.add(p);
        if (verdict === 'cancel') cancelled.push(pair.csId);
        continue;
      }
      if (plan.rEdits.length === 0 && plan.aEdits.length === 0) {
        kept.push(pair);
        continue;
      }
      const rTree = plan.rEdits.length > 0 ? await repo.editTree(pair.R, plan.rEdits, scratchIndex) : pair.R;
      const aTree = plan.aEdits.length > 0 ? await repo.editTree(pair.A, plan.aEdits, scratchIndex) : pair.A;
      kept.push({ csId: pair.csId, R: rTree, A: aTree, paths: plan.paths, order: pair.order });
    }
    this.pairs = kept;
    for (const p of recapture) this.pending.add(p);
    this.absorbPending();
    return { ready: kept.map((p) => ({ ...p, paths: [...p.paths] })), cancelled, recapture };
  }

  /**
   * P (HLD-42): MASK(R) of the newest ready pair covering p, A[p] elsewhere; A_cap[p] ≠ A[p] → ReadyBaseMismatchError
   * (ENG-39). 01-engine §3.12 step 1 (ruling P2-PIN): a ready pair sharing any path with `pinnedPaths` (non-terminal
   * ON_DISK PINs: join, phantom, host-reject) is skipped whole and stays journaled. csIds lists every included pair in
   * capture order, also one whose paths a newer pair covers (its edits are in the newer R), so published() clears it;
   * csPaths maps each to its paths (Cowork-CS-Paths).
   */
  async composeP(
    repo: GitRepo, A: TreeMap, mask: (X: TreeMap) => Map<string, TreeEntry>, pinnedPaths: ReadonlySet<string>,
  ): Promise<{ P: Map<string, TreeEntry>; csIds: string[]; csPaths: Map<string, string[]> }> {
    const X = new Map<string, TreeEntry>(A);
    const csIds: string[] = [];
    const csPaths = new Map<string, string[]>();
    for (const pair of this.pairs) {
      if (pair.paths.some((p) => pinnedPaths.has(p))) continue;
      const R = await repo.readTreeMap(pair.R);
      const Acap = await repo.readTreeMap(pair.A);
      for (const p of pair.paths) if (!same(Acap.get(p) ?? null, A.get(p) ?? null)) throw new ReadyBaseMismatchError(p);
      for (const p of pair.paths) {
        const r = R.get(p);
        if (r !== undefined) X.set(p, r);
        else X.delete(p);
      }
      csIds.push(pair.csId);
      csPaths.set(pair.csId, [...pair.paths]);
    }
    return { P: mask(X), csIds, csPaths };
  }

  /** The pairs of a landed publish (or of OUT == tree(TIP) with no ops, R-02) leave the journal. */
  published(csIds: readonly string[]): void {
    const gone = new Set(csIds);
    this.pairs = this.pairs.filter((p) => !gone.has(p.csId));
  }

  /** Capture order, oldest first. */
  ready(): readonly ReadyPair[] {
    return this.pairs.map((p) => ({ ...p, paths: [...p.paths] }));
  }

  /** open: the open human CS, plus one for paths waiting for a recapture; ready: the journaled pairs. */
  counts(): { open: number; ready: number } {
    return { open: (this.open !== null ? 1 : 0) + (this.pending.size > 0 ? 1 : 0), ready: this.pairs.length };
  }

  /** Local deltas in no ready pair: the open CS's paths and the paths waiting for a recapture. */
  openPaths(): ReadonlySet<string> {
    return new Set([...(this.open?.paths ?? []), ...this.pending]);
  }

  private openDue(): boolean {
    return this.open !== null && (this.open.done || this.clock.monoMs() - this.open.lastChangeMono >= HUMAN_CS_QUIET_MS);
  }

  /** Paths waiting for a recapture that the open CS shares go with the open CS: they are re-captured at its close. */
  private absorbPending(): void {
    if (this.open === null || this.pending.size === 0) return;
    if (![...this.pending].some((p) => this.open!.paths.has(p))) return;
    for (const p of this.pending) this.open.paths.add(p);
    this.pending.clear();
  }
}
