// The change-set step (Plan 3 Task 9; 01-engine ENG-13 engine side, ENG-04; 05-holds HLD-34, HLD-36, HLD-40; rulings R3-05,
// R3-23, R3-40, R3-69): change-set signals into the CS table (queueSignal), the captures of a materializing iteration journaled
// with the table in one state update (captureStep), and the cache cs/<enc(b)>.json (writeCsCache, readCsCache).
//
// The table is truth in the state ref (journal/keep/cs/table.json, written only in state transitions); the cache carries the
// open CSs' membership between transitions and is read at a restart only when it names the current state commit (HLD-36).
// Task 10: captureStep settles the edit-checkpoint candidates (HLD-67) through EngineDeps.editCheck and bundles closing CSs into held PINs.
import { dirname } from 'node:path';
import { canonicalBytes, type Json } from '../board/canonicalJson.js';
import { enc } from '../git/enc.js';
import { ABSENT, type Oid } from '../git/oid.js';
import type { IndexEdit } from '../git/repo.js';
import { checkCsTable, heldPins, humanCsN, type CaptureBundle, type CsTable, type HeldPin, type ReadyPair } from '../holds/changesets.js';
import type { EditCheckVerdict } from '../holds/ports.js';
import { blobAt, isTerminal, setBlob, type BlobMap } from '../holds/record.js';
import type { CsSignal } from '../holds/signals.js';
import { KilledAt } from '../ports/crashpoint.js';
import { errnoCode } from '../ports/fs.js';
import { captureDue, currentA, ensureAttrs, foldPatch, materializedFor, materializedOver, partialMaterialization, type EngineCore, type IterationCtx } from './core.js';
import { keepsPathsOutOfPins } from './publish.js';
import type { Materialized } from './snapshot.js';
import { csTableKeep, OP_SNAP_KEEP, opSnapKeep, readOpSnap, StateCasLostError, type StateView } from './state.js';
import { editTreeIndexOnly } from './treeEdit.js';

/** The signals that ask for an out-of-cycle iteration whenever they come (ENG-13 (b)/(c)); idle_10min only when it closes. */
const BOUNDARY: ReadonlySet<CsSignal['kind']> = new Set(['stop', 'stop_failure', 'subagent_stop', 'session_end', 'seat_end', 'checkpoint']);

/** The open CSs of a seat in the table. */
function openOf(core: EngineCore, seat: string): number {
  return core.cs.table().cs.filter((e) => e.seat === seat && e.state === 'open').length;
}

/**
 * Queues a signal into the CS table; true when it asks for an out-of-cycle iteration: a boundary (stop, stop_failure,
 * subagent_stop, session_end, seat_end), a checkpoint (green, tool, or edit once its paths are 300 ms quiet), or an idle_10min
 * that closed a CS; never an effect, prompt, activity, checks_run or an idle_10min that keeps the CS open. Synchronous (it cannot
 * lstat): Engine.signal (async) waits for the 300 ms quiet period of the hook-named paths before the iteration (01-engine test 55).
 */
export function queueSignal(core: EngineCore, s: CsSignal): boolean {
  if (s.kind === 'idle_10min') {
    const before = openOf(core, s.seat);
    core.cs.signal(s);
    return openOf(core, s.seat) < before;
  }
  core.cs.signal(s);
  return BOUNDARY.has(s.kind);
}

/**
 * Captures every due group from the materialized S_disk (HLD-40) and settles the pending edit-checkpoint candidates through
 * EngineDeps.editCheck (HLD-67, trace 'edit_check'), in one state update that journals the ready pairs, the human counter and the CS
 * table: Transition.keep is view.keep with only the 'cs' entry replaced (R3-40). Captures run only when it.mat is non-null; closing
 * captures only when captureDue(core) holds (a close, a pending green or tool checkpoint, a recapture) and the materialization covers
 * the change-sets' paths, whatever else made the iteration materialize; P2-STRANDED-SKIP carried (R3-23): while
 * core.writer.strandedPaths() is non-empty it returns {captured: [], candidates: []} and journals nothing. A ready pair a kept push
 * intent names is never replaced (its group waits for the intent's resolution), and no candidate is settled while a push intent is
 * kept. A state update that fails (but a lost CAS or a crash) rolls ChangeSets back to the rollbackPoint() taken first, so the CSs
 * close again with their kinds and clocks.
 *
 * Plan 3 Task 10: the captures take the held PINs (heldPins): a closing CS whose group holds one joins it as a bundle (HLD-49,
 * R3-44: paths ∪, cs_ids ∪, h1 refreshed from R, one registry transition, one op) before the state update. Each pending candidate
 * (oldest first) is a candidate capture of its CS's group (ChangeSets.candidate); a group path the materialization could not read
 * stably fails it silently (HLD-67 step 1: no port call, no pair, no record — last_check incomplete, no_snapshot); otherwise the
 * port sees (A, R over A, TIP, the CS's own paths) and ChangeSets.settleCandidate journals a pass or keeps a fail in memory only.
 *
 * EF2 fix round 2: the same state update drops the journal/keep/op_snap entries of every path this step's pairs name (dropCapturedOpSnap).
 */
export async function captureStep(core: EngineCore, it: IterationCtx): Promise<{ captured: string[]; candidates: Array<{ csId: string; verdict: EditCheckVerdict['verdict'] }> }> {
  const none = { captured: [], candidates: [] };
  if (core.writer.strandedPaths().length > 0) return none;
  const mat = it.mat;
  if (mat === null) return none;
  const prev = core.view;
  if (prev === null) throw new Error('captureStep: no state');
  const pins = heldPins(core.holds);
  const pushKept = prev.intent.kind === 'push';
  const kept = prev.intent.kind === 'push' ? new Set(prev.intent.cs_ids) : new Set<string>();
  // Fix round 1 (findings 1–2): a failed update rolls ChangeSets back exactly — every CS keeps its kind, cs_id, clocks, claims and
  // candidates (an open recovered CS its HLD-36 close rule), and the closes are due again.
  const rollback = core.cs.rollbackPoint();
  const captured: string[] = [];
  const candidates: Array<{ csId: string; verdict: EditCheckVerdict['verdict'] }> = [];
  // EF2 fix round 2: every path a pair captured in this step names (journaled pairs, settled candidates, and the bundles' pairs).
  const capturedPaths = new Set<string>();
  const took = (pairs: readonly ReadyPair[]): void => {
    for (const pair of pairs) for (const p of pair.paths) capturedPaths.add(p);
  };
  let changed = false;
  try {
    if (captureDue(core)) {
      // A materialization of a hold-record occasion's paths only (PrepareOptions.holdPaths) is no S_disk to capture from.
      const paths = [...new Set([...core.cs.openPaths(), ...core.cs.ready().flatMap((p) => p.paths)])].filter((p) => !mat.excluded.has(p));
      if (materializedOver(it, paths)) {
        const cap = await core.cs.capture(core.repo, mat.sDiskMap, it.A, core.scratch('r'), kept, pins);
        if (cap !== null) {
          changed = true;
          captured.push(...cap.pairs.map((p) => p.csId));
          took(cap.pairs);
          for (const b of cap.bundles ?? []) {
            took(b.pairs);
            await joinPin(core, it, b);
          }
        }
      }
    }
    // Task 12b (carry 4): a hold-record occasion's materialization of its paths only (an out-of-cycle or loop iteration's holdPaths:
    // the repairs, S6) is no S_disk to settle a candidate from either — the candidates wait for the next full materialization.
    if (!pushKept && !partialMaterialization(it)) {
      for (const pc of core.cs.pendingCandidates()) {
        const r = await settleOne(core, it, mat, pc, pins);
        if (r === null) continue;
        candidates.push({ csId: pc.csId, verdict: r.verdict });
        if (r.pairs !== null) {
          changed = true;
          captured.push(...r.pairs.map((p) => p.csId));
          took(r.pairs);
        }
      }
    }
    if (!changed) return { captured: [], candidates };
    const [name, tree] = await csTableKeep(core.repo, core.cs.table());
    const keep = new Map([...prev.keep, [name, tree]]);
    await dropCapturedOpSnap(core, prev, keep, capturedPaths);
    const fp = foldPatch(core);
    await core.commit({
      ready: core.cs.ready(), keep,
      meta: { ...prev.meta, ...(fp?.meta ?? {}), cs_human_next: humanNext(core, prev.meta.cs_human_next) }, ...(fp !== null ? { fold: fp.fold } : {}),
    });
  } catch (e) {
    if (!(e instanceof StateCasLostError) && !(e instanceof KilledAt)) rollback();
    throw e;
  }
  return { captured: [...new Set(captured)], candidates };
}

/**
 * EF2 fix round 2 (ruling: an op_snap entry is dropped when a human change of that path is captured). The capture's state update drops
 * from journal/keep/op_snap (OP_SNAP_KEEP, readOpSnap) the entries of every path a pair captured in this step names: its journaled
 * pairs, its settled candidates' pairs and its bundles' pairs (HLD-49: the pairs a CS joining a held PIN would have journaled). A
 * capture's state commit does not move snap, so core.commit's pruning (opSnapPruned) never sees it; without this an operator-written
 * path whose human edit was captured (R[p] = X) and then undone back to the operator's bytes in the open CS alone kept its exemption,
 * and a kill made the restart's re-form (reformOpenCs) read R[p] ≠ snap[p] as the operator's write: the stale X capture published while
 * the disk kept the operator's bytes. A pair captured before the operator's write (HLD-45 K6: the PIN keeps it) names no later capture,
 * so its exemption stays. Edits `keep` in place; nothing changes when no captured path has an entry.
 */
async function dropCapturedOpSnap(core: EngineCore, prev: StateView, keep: Map<string, Oid>, paths: ReadonlySet<string>): Promise<void> {
  if (paths.size === 0 || !prev.keep.has(OP_SNAP_KEEP)) return;
  const ops = await readOpSnap(core.repo, prev);
  const still = new Map([...ops].filter(([p]) => !paths.has(p)));
  if (still.size === ops.size) return;
  if (still.size === 0) keep.delete(OP_SNAP_KEEP);
  else keep.set(...(await opSnapKeep(core.repo, still)));
}

/** meta.cs_human_next after this step's captures: above every human-class cs_id the table names (a candidate may give one too). */
function humanNext(core: EngineCore, before: number): number {
  let n = before;
  for (const e of core.cs.table().cs) n = Math.max(n, (humanCsN(e.cs_id) ?? 0) + 1);
  return n;
}

/**
 * HLD-49 (R3-44): the closing CSs of a group that holds `b.pin` join it — one transition of that PIN: paths ∪ the LIVE paths the
 * bundle names (HLD-03), cs_ids ∪, h1 refreshed from the bundle's R on its paths (the rest kept), h0 = A[p] on a new path. No
 * `dependency` guard naming the record itself is added (R3-44). A PIN that ended meanwhile takes nothing. Final review F4 (05 §3.4
 * items 3–4, DAT-46): a path a non-terminal ON_DISK `markers` record withholds is never added and keeps the PIN's blob — the
 * bundle's R holds the restore-marker rows the disk has there, and the PIN's h1 is mirrored to held/. Final review r3 B3-2 (ruling
 * R3-FF3-B2; HLD-42, INV-SECRET): likewise for a path of a non-terminal ON_DISK `local_only` record (pinnablePaths' predicate,
 * keepsPathsOutOfPins, as R3-FF2-B2 at a PIN's creation) — the iteration's scope still classes it LIVE when the record was made by
 * a step of this iteration or is INCOMING, and the bundle's R holds the disk's bytes there, which stay only in that record.
 */
async function joinPin(core: EngineCore, it: IterationCtx, b: CaptureBundle): Promise<void> {
  const r = core.holds.get(b.pin.id);
  if (r === undefined || isTerminal(r) || !('h1' in r.blobs)) return;
  const g = await core.cs.bundle(core.repo, b.pin, b.pairs);
  await ensureAttrs(core, it.epochBase, g.paths);
  const live = (p: string): boolean => {
    try {
      return it.scope(p).cls === 'LIVE';
    } catch {
      return false;
    }
  };
  // pinnablePaths' predicate as it is (the PIN itself included: a local_only PIN's own paths are LOCAL_ONLY in every later scope,
  // D5 row 9, so no CS lands on them; a `markers` record's paths stay out as in F4).
  const own = new Set(core.holds.nonTerminal().filter(keepsPathsOutOfPins).flatMap((x) => x.paths));
  const paths = g.paths.filter((p) => r.paths.includes(p) || (live(p) && !own.has(p))).sort();
  const h0: BlobMap = {};
  const h1: BlobMap = {};
  for (const p of paths) {
    setBlob(h0, p, blobAt(r.blobs.h0, p) ?? it.A.get(p)?.oid ?? ABSENT);
    setBlob(h1, p, Object.hasOwn(g.h1, p) && !own.has(p) ? g.h1[p]! : (blobAt(r.blobs.h1, p) ?? ABSENT));
  }
  const csIds = [...new Set([...r.cs_ids, ...g.csIds])].sort();
  const sameMap = (x: BlobMap, y: BlobMap): boolean => Object.keys(x).length === Object.keys(y).length && Object.keys(x).every((k) => blobAt(y, k) === x[k]);
  if (paths.join('\n') === r.paths.join('\n') && csIds.join('\n') === r.cs_ids.join('\n') && sameMap(h0, r.blobs.h0) && sameMap(h1, r.blobs.h1)) return;
  await core.holds.transition(r.id, { paths, cs_ids: csIds, blobs: { h0, h1 } });
}

/**
 * One pending edit-checkpoint candidate (HLD-67 steps 1–4): the candidate capture, the edit check and the settlement; null when
 * ChangeSets built none (the CS closed, or its group holds a held PIN).
 */
async function settleOne(
  core: EngineCore, it: IterationCtx, mat: Materialized, pc: { csId: string; candSeq: number; paths: readonly string[] }, pins: readonly HeldPin[],
): Promise<{ verdict: EditCheckVerdict['verdict']; pairs: readonly ReadyPair[] | null } | null> {
  const { repo, deps } = core;
  const cand = await core.cs.candidate(repo, pc.csId, pc.candSeq, mat.sDiskMap, it.A, core.scratch('r'), pins);
  if (cand === null) return null;
  const groupPaths = [...new Set([...cand.pairs.flatMap((p) => p.paths), ...pc.paths])].sort();
  // HLD-67 step 1: a group path this iteration's S_disk does not hold current (a materialize-time or tick exclusion) fails the candidate.
  const unread = groupPaths.find((p) => !materializedFor(it, [p]));
  let verdict: EditCheckVerdict;
  if (unread !== undefined) {
    verdict = { verdict: 'incomplete', entries: [{ path: unread, reason: 'no_snapshot' }] };
  } else {
    const { aTree } = await currentA(core);
    const edits: IndexEdit[] = [];
    for (const pair of cand.pairs) {
      const R = await repo.readTreeMap(pair.R);
      for (const p of pair.paths) {
        const e = R.get(p);
        edits.push(e === undefined ? { path: p, remove: true } : { path: p, mode: e.mode, oid: e.oid });
      }
    }
    const rTree = await editTreeIndexOnly(repo, deps.ports.fs, aTree, edits, core.scratch('cmp'));
    const own = core.cs.table().cs.find((e) => e.cs_id === pc.csId)?.paths ?? [...pc.paths];
    verdict = await deps.editCheck.check(repo, aTree, rTree, it.tip, own);
  }
  const pairs = core.cs.settleCandidate(cand, verdict);
  deps.trace.emit({ kind: 'edit_check', peer: core.peerId, cs: pc.csId, verdict: verdict.verdict });
  return { verdict: verdict.verdict, pairs };
}

/** cs/<enc(b)>.json under the cowork directory (glossary §6). */
function cacheFile(core: EngineCore): string {
  return core.path(`cs/${enc(core.deps.branch)}.json`);
}

/** 01-engine §3.16's retries of one write on a held file, as StatusWriter's: a reader without share-delete or an AV/indexer scan. */
const CACHE_RETRIES = 3;
const CACHE_RETRY_MS = 50;
const CACHE_RETRYABLE: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Per core, the tail of its queued cache writes (fix round 1, finding 5): one write at a time, in call order. */
const cacheTail = new WeakMap<EngineCore, Promise<unknown>>();

/**
 * The cache cs/<enc(b)>.json: {state: <the current state commit>, table: ChangeSets.table()} as canonical JSON, temp file + rename
 * through Fs. Written at every membership change: the caller awaits it after every queueSignal that changed seat membership
 * (Engine.signal) and, from Task 12a on, after every iteration that committed state (HLD-36, R3-40). Nothing to write before a state exists.
 * Writes are serialized per core (the callers are independent: two signals, a signal and the loop) and each takes the state and the
 * table when it runs, so the last write holds the newest membership; the temp file lives in tmp/ (created when missing, the
 * status.json pattern). EPERM/EACCES/EBUSY are retried 3 × 50 ms, deleting nothing meanwhile. A write that still fails removes the
 * cache as well: a cache naming the current state commit with older membership must not survive it (a missing cache reads as lost,
 * the safe direction, HLD-36); a transient error then ends quietly (never into the signal path), any other error is rethrown.
 */
export function writeCsCache(core: EngineCore): Promise<void> {
  const run = (cacheTail.get(core) ?? Promise.resolve()).then(() => writeCsCacheNow(core));
  cacheTail.set(core, run.catch(() => undefined));
  return run;
}

async function writeCsCacheNow(core: EngineCore): Promise<void> {
  const view = core.view;
  if (view === null) return;
  const fs = core.deps.ports.fs;
  const file = cacheFile(core);
  const tmp = core.path(`tmp/cs-${enc(core.deps.branch)}.json.tmp`);
  const bytes = canonicalBytes({ state: view.commit, table: core.cs.table() } as unknown as Json);
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.mkdirp(dirname(file), 0o700);
      await fs.mkdirp(dirname(tmp), 0o700);
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, file);
      return;
    } catch (e) {
      const retryable = CACHE_RETRYABLE.has(errnoCode(e) ?? '');
      if (retryable && attempt < CACHE_RETRIES) {
        await core.deps.ports.clock.sleep(CACHE_RETRY_MS);
        continue;
      }
      await fs.unlink(tmp).catch(() => undefined);
      await fs.unlink(file).catch(() => undefined);
      if (retryable) return;
      throw e;
    }
  }
}

/**
 * The cached table, only when the cache names the current state commit (R3-69); null when it is missing, unreadable, malformed or
 * stale — the open-CS table is then lost and the unpublished deltas form one recovered CS (HLD-36).
 */
export async function readCsCache(core: EngineCore): Promise<CsTable | null> {
  const view = core.view;
  if (view === null) return null;
  let doc: unknown;
  try {
    const bytes = await core.deps.ports.fs.readFile(cacheFile(core));
    doc = JSON.parse(bytes.toString('utf8'));
    if (!canonicalBytes(doc as Json).equals(bytes)) return null;
  } catch {
    return null;
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return null;
  const o = doc as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== 'state,table' || o['state'] !== view.commit) return null;
  try {
    return checkCsTable(o['table']);
  } catch {
    return null;
  }
}
