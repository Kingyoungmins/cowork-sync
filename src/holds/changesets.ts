// Change-sets and their ready pairs (HLD-33…HLD-42; rulings R-01, R3-05, R3-40, R3-43, R3-68, R3-69). Plan 2 Task 8 seeded
// the ready-pair type and its journal key, which the state ref stores as journal/ready/<readyKey(cs_id)>/{R,A} (glossary
// §4); Plan 2 Task 11 added ChangeSets with the one human CS; Plan 3 Task 9 adds the change-set table.
//
// The table (Plan 3 Task 9) holds every CS of this peer: the human CS (HLD-35: unattributed deltas; it opens at the first
// such delta and closes 20 s Δmono after its last change or at done()), the `recovered` CS that re-forms the unpublished
// deltas when the open-CS table was lost (HLD-36), and seat CSs from scripted CsSignals (HLD-34; Plan 5 feeds the same
// signals from hooks). A seat CS has its cs_id `<seat_id>/<turn-seq>` from its first file effect; a human CS gets
// `<peer_id>/human/<n>` at its first capture, a recovered CS at its creation, so the table and the cache carry it with its kind
// (HLD-33, HLD-36; Task 9 fix round 1, findings 1–2). A capture is per publication group (HLD-38, here a private
// closure over the CSs and the given held PINs sharing a path): one ready pair per member CS over its own paths, with one
// shared order (HLD-40). The table is journaled as journal/keep/cs/table.json in the state transitions that write it
// (captureStep, the push-ok update) and cached in cs/<enc(b)>.json (R3-40); while no table is journaled, a capture called
// with Plan 2's shape keeps Plan 2's form exactly — the human CS alone, order = n (R3-68).
import { Buffer } from 'node:buffer';
import { canonicalBytes, type Json } from '../board/canonicalJson.js';
import type { PeerId } from '../board/ids.js';
import type { CsTrailer } from '../board/boardCommit.js';
import { mergeFile } from '../git/merge.js';
import { ABSENT, type Oid, type OidOrAbsent } from '../git/oid.js';
import type { GitRepo, IndexEdit, TreeEntry, TreeMap } from '../git/repo.js';
import { resetScratchIndex } from '../git/scratchIndex.js';
import type { Clock } from '../ports/clock.js';
import type { Fs } from '../ports/fs.js';
import { validId, validPathSyntax } from '../sec/validators.js';
import { clearReady, LastCheckStore, type LastCheck } from './lastCheck.js';
import type { MaskResult } from './mask.js';
import type { EditCheckVerdict } from './ports.js';
import { guardName, isTerminal, setBlob, type BlobMap, type Offer } from './record.js';
import type { HoldRegistry, NewRecord } from './registry.js';
import { RevertMarks } from './revertCs.js';
import type { CsSignal, SeatActivity } from './signals.js';

/** HLD-35: a human CS closes this long (local Δmono) after the last change on any of its paths; HLD-36's recovered CS too. */
export const HUMAN_CS_QUIET_MS = 20_000;

/** order: capture sequence (newest wins). */
export interface ReadyPair { csId: string; R: Oid; A: Oid; paths: string[]; order: number; }
// The journal holds only ready/<k>/{R,A} (glossary §4): StateStore.read derives csId from the key, paths from the union of R's and A's
// entries, and order from the CS table's `orders` (Plan 3 Task 9), or from n of `<peer>/human/<n>` while no table is journaled
// (R-01, R3-68), so "newest capture wins" survives a restart.

export type CsKind = 'human' | 'recovered' | 'seat';
export interface CsTableEntry {
  cs_id: string; kind: CsKind; seat: string | null; agent: string | null; origin: 'human' | 'prompt' | 'wake';
  paths: string[]; state: 'open' | 'closed'; cap_seq: number; publishes: number; checks: 'pass' | 'fail' | 'skipped'; covered: boolean;   // covered: the latest file effect is covered by a passing capture (HLD-39)
}
// checks: the result of the CS's latest checks_run signal before the capture — ok → 'pass', not ok → 'fail' — else 'skipped' (HLD-37, R3-43) (Task 9).
// covered (Task 9; the edit-check pass that sets it is Task 10's): true at a green or tool checkpoint and at a passing edit check on the CS's latest effect, false at any later
//   effect; a candidate's capture is passing iff every member CS is closed or covered after the verdict.
/** journal/keep/cs/table.json, canonical JSON (R3-40). Written only in state transitions (captures, closes, publishes; ENG-04). */
export interface CsTable {
  v: 1; next_order: number; seats: Record<string, { turn_seq: number }>; cs: CsTableEntry[]; orders: Record<string, number>;
  passing: Record<string, boolean>;   // per cs_id: its journaled ready pair came from a passing capture (05 §2); Plan 2 pairs read without a table count as passing (Task 9; Task 10's readiness reads it)
}
/**
 * A non-terminal ON_DISK PIN with guards ("held PIN", glossary §3); declared by Task 9 (capture's `pins`), produced by heldPins (Task 10).
 * `guards` are the full guard names (`t0`, `dependency:<id>`, `claim:<claim_id>`), so the T0 slot can tell a t0-only PIN.
 */
export interface HeldPin { id: string; paths: readonly string[]; guards: readonly string[]; }
/** HLD-38; key = the smallest cs_id (a group whose only CS is the open human CS before its first capture: the id that capture gives it). */
export interface PublicationGroup { key: string; csIds: string[]; paths: string[]; pins: string[]; ready: boolean; }
/** HLD-67 step 1: a candidate capture of a seat CS's publication group, not journaled (R3-41). */
export interface Candidate { csId: string; candSeq: number; groupKey: string; pairs: ReadyPair[]; }
export interface Composition {
  P: Map<string, TreeEntry>; csIds: string[]; csPaths: Map<string, string[]>; groups: PublicationGroup[];
  /**
   * group key → the group paths withheld whole on R (HLD-42 → dependency PIN): composeP gives every group path the MASK result
   * withheld whole; publishStep's compose replaces it with the paths a MASK steps 2–4 record withholds (maskReason over every group
   * path, so a path in neither R nor A counts too, R3-35; never a path class). Every group with a journaled pair (its R), ready or
   * not: the `compose` event shows it while the group's dependency PIN holds it (publishStep pins ready groups only).
   */
  withheldWhole: Map<string, string[]>;
}

// ---- the table format (R3-40): one parser for the journal (state.ts) and the cache (csStep.ts) -------------------------

const CS_KINDS: ReadonlySet<string> = new Set(['human', 'recovered', 'seat']);
const CS_ORIGINS: ReadonlySet<string> = new Set(['human', 'prompt', 'wake']);
const CS_CHECKS: ReadonlySet<string> = new Set(['pass', 'fail', 'skipped']);
const TABLE_KEYS = ['cs', 'next_order', 'orders', 'passing', 'seats', 'v'];
const ENTRY_KEYS = ['agent', 'cap_seq', 'checks', 'covered', 'cs_id', 'kind', 'origin', 'paths', 'publishes', 'seat', 'state'];
const HUMAN_CS = /^([0-9a-f]{32})\/human\/([1-9][0-9]*)$/;
const SEAT_CS = /^([0-9a-f]{32})\/([1-9][0-9]*)$/;

type Obj = Record<string, unknown>;

function tableError(what: string): TypeError {
  return new TypeError(`CS table: ${what}`);
}

function exactKeys(v: unknown, want: readonly string[], what: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw tableError(`${what} is not an object`);
  const have = Object.keys(v).sort();
  if (have.length !== want.length || have.some((k, i) => k !== want[i])) throw tableError(`${what} has keys [${have.join(', ')}]`);
  return v as Obj;
}

const count = (v: unknown, min: number): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;

function record<T>(v: unknown, what: string, key: (k: string) => boolean, value: (x: unknown) => T | undefined): Record<string, T> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw tableError(`${what} is not an object`);
  const out: Record<string, T> = {};
  for (const [k, x] of Object.entries(v)) {
    const val = value(x);
    if (!key(k) || val === undefined) throw tableError(`${what}[${JSON.stringify(k)}] is not valid`);
    out[k] = val;
  }
  return out;
}

/** A parsed CsTable (journal/keep/cs/table.json or the cache's `table`): every field checked, unknown keys refused; a TypeError otherwise. */
export function checkCsTable(v: unknown): CsTable {
  const o = exactKeys(v, TABLE_KEYS, 'table');
  if (o['v'] !== 1) throw tableError('v is not 1');
  if (!count(o['next_order'], 1)) throw tableError('next_order must be a safe integer >= 1');
  const seats = record(o['seats'], 'seats', (k) => validId('hex128', k), (x) => {
    const s = exactKeys(x, ['turn_seq'], 'seat');
    return count(s['turn_seq'], 0) ? { turn_seq: s['turn_seq'] as number } : undefined;
  });
  if (!Array.isArray(o['cs'])) throw tableError('cs is not an array');
  const seen = new Set<string>();
  const cs = o['cs'].map((x): CsTableEntry => {
    const e = exactKeys(x, ENTRY_KEYS, 'cs entry');
    const id = e['cs_id'];
    if (typeof id !== 'string' || !validId('cs', id) || seen.has(id)) throw tableError(`cs_id ${JSON.stringify(id)}`);
    seen.add(id);
    const kind = e['kind'];
    if (typeof kind !== 'string' || !CS_KINDS.has(kind)) throw tableError(`${id}: kind`);
    if ((kind === 'seat') !== SEAT_CS.test(id)) throw tableError(`${id}: a ${kind} CS with this cs_id`);
    const seat = e['seat'];
    if (kind === 'seat' ? seat !== SEAT_CS.exec(id)![1] : seat !== null) throw tableError(`${id}: seat`);
    if (!(e['agent'] === null || (kind === 'seat' && typeof e['agent'] === 'string'))) throw tableError(`${id}: agent`);
    if (typeof e['origin'] !== 'string' || !CS_ORIGINS.has(e['origin']) || (kind !== 'seat') !== (e['origin'] === 'human')) throw tableError(`${id}: origin`);
    const paths = e['paths'];
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && validPathSyntax(p)) || new Set(paths).size !== paths.length) throw tableError(`${id}: paths`);
    if (e['state'] !== 'open' && e['state'] !== 'closed') throw tableError(`${id}: state`);
    if (!count(e['cap_seq'], 0) || !count(e['publishes'], 0)) throw tableError(`${id}: counters`);
    if (typeof e['checks'] !== 'string' || !CS_CHECKS.has(e['checks'])) throw tableError(`${id}: checks`);
    if (typeof e['covered'] !== 'boolean') throw tableError(`${id}: covered`);
    return {
      cs_id: id, kind: kind as CsKind, seat: seat as string | null, agent: e['agent'] as string | null, origin: e['origin'] as CsTableEntry['origin'],
      paths: [...(paths as string[])], state: e['state'], cap_seq: e['cap_seq'] as number, publishes: e['publishes'] as number,
      checks: e['checks'] as CsTableEntry['checks'], covered: e['covered'],
    };
  });
  const orders = record(o['orders'], 'orders', (k) => validId('cs', k), (x) => (count(x, 1) ? (x as number) : undefined));
  const passing = record(o['passing'], 'passing', (k) => validId('cs', k), (x) => (typeof x === 'boolean' ? x : undefined));
  return { v: 1, next_order: o['next_order'] as number, seats, cs, orders, passing };
}

/** canonical JSON of a valid table (the bytes of journal/keep/cs/table.json). */
export function serializeCsTable(t: CsTable): Buffer {
  const buf = canonicalBytes(t as unknown as Json);
  parseCsTable(buf);
  return buf;
}

/** journal/keep/cs/table.json: canonical JSON of a valid table; anything else (non-canonical bytes included) throws a TypeError. */
export function parseCsTable(buf: Buffer): CsTable {
  let v: unknown;
  try {
    v = JSON.parse(buf.toString('utf8'));
  } catch {
    throw tableError('table.json is not JSON');
  }
  const t = checkCsTable(v);
  if (!canonicalBytes(v as Json).equals(buf)) throw tableError('table.json is not canonical JSON');
  return t;
}

/** n of a human-class cs_id `<peer>/human/<n>`, else null. */
export function humanCsN(csId: string): number | null {
  const m = HUMAN_CS.exec(csId);
  if (m === null) return null;
  const n = Number(m[2]);
  return Number.isSafeInteger(n) ? n : null;
}

/** The Cowork-Seat of a CS (glossary §5): its seat id, or `human` for a human-class cs_id. */
export function seatOfCs(csId: string): string {
  const m = SEAT_CS.exec(csId);
  return m === null ? 'human' : m[1]!;
}

export interface RebaseChange {
  path: string;
  aOld: TreeEntry | null; aNew: TreeEntry | null;            // A[p] before / after the state update
  written: 'clean' | 'concat' | 'take_tip' | 'none';         // what the update did to p ('none' = A changed without a write)
  sDiskBefore: TreeEntry | null;                              // S_disk[p] before the apply
  writtenEntry: TreeEntry | null;                             // the verified-written M_disk[p] (clean or concat)
}
/**
 * ready: the pairs after the rebase (journal them in the same update); cancelled → CS_READY_CANCELLED; recapture: paths re-captured later.
 * marksMoved (Task 17, contract addition 2; glossary §29.2, decision D2): per revert CS whose shrink mark a clean HLD-41 rebase moved, the
 * mark's whole current map — applyStep appends it to reverts.jsonl, fsynced, before its state update (ENG-36, §8 Q18 option (a)).
 */
export interface RebaseResult {
  ready: ReadyPair[]; cancelled: string[]; recapture: ReadonlySet<string>;
  marksMoved?: ReadonlyArray<{ cs: string; written: Record<string, Oid | 'ABSENT'> }>;
}

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

/**
 * One ready pair's own rebase: its verdict and, when kept, the edits of its R and A_cap trees and its paths after them. moves (Task 17):
 * the paths whose update was a clean HLD-41 rebase of R[p] (glossary §29.2: an apply that wrote p as a clean merge or a concat blob with
 * S_disk[p] == R[p] before it, whether the plain rebase was clean or decideConflict took the written entry) and R[p]'s oid before and
 * after it — the revert shrink mark moves only along one of these, and only when its oid is `before` (RevertMarks.moveOnCleanRebase).
 */
interface RebasePlan { pair: ReadyPair; verdict: Verdict; rEdits: IndexEdit[]; aEdits: IndexEdit[]; paths: string[]; moves: Array<{ path: string; before: Oid; after: Oid }>; }

/**
 * The verdict of each plan's publication group (HLD-38: ready pairs connected through shared paths, transitively, and — Task 10 —
 * through the CSs of `groupOf`, cs_id → the index of its group among the CSs sharing a path): the strongest verdict of any member,
 * so a group is withdrawn or cancelled whole, never one pair alone (INV-HLD-ATOMIC-PUB).
 */
function groupVerdicts(plans: readonly RebasePlan[], groupOf: ReadonlyMap<string, number> = new Map()): Verdict[] {
  const parent = plans.map((_, i) => i);
  const find = (i: number): number => {
    let x = i;
    while (parent[x] !== x) x = parent[x]!;
    for (let y = i; parent[y] !== x;) { const up = parent[y]!; parent[y] = x; y = up; }
    return x;
  };
  const owner = new Map<string, number>();
  const join = (key: string, i: number): void => {
    const j = owner.get(key);
    if (j === undefined) owner.set(key, i);
    else parent[find(i)] = find(j);
  };
  plans.forEach((plan, i) => {
    for (const p of plan.pair.paths) join(`p:${p}`, i);
    const g = groupOf.get(plan.pair.csId);
    if (g !== undefined) join(`g:${g}`, i);
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
  const plan: RebasePlan = { pair, verdict: 'keep', rEdits: [], aEdits: [], paths: pair.paths, moves: [] };
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
    // Task 17 (glossary §29.2): a clean HLD-41 rebase of R[p] — the update wrote p (clean or concat) and no member effect came after the
    // capture (S_disk[p] == R[p] before the apply) — is where a revert shrink mark on R[p]'s oid may follow it.
    if ((ch.written === 'clean' || ch.written === 'concat') && r !== null && next !== null && same(ch.sDiskBefore, r) && next.oid !== r.oid) {
      plan.moves.push({ path: p, before: r.oid, after: next.oid });
    }
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


type Checks = CsTableEntry['checks'];

/** HLD-36's recovered-CS close clock: 20 s quiet counted only while no seat is busy, or the stop of every seat that was busy. */
interface RecoveredClock {
  acc: number;                 // quiet Δmono counted before `since`
  since: number | null;        // when the counting (re)started; null while a seat is MID_TURN or AWAITING_PERMISSION
  waiting: Set<string>;        // seats MID_TURN or AWAITING_PERMISSION at the recovery or later that have not had their stop yet
  released: boolean;           // every such seat has had its Stop, StopFailure, SessionEnd or seat end
}

/** One change-set of this peer: the CsTableEntry fields plus what lives in memory only. */
interface Cs {
  csId: string | null;         // a human CS gets its id at its first capture; a seat CS at its first effect, a recovered CS at its creation
  kind: CsKind; seat: string | null; agent: string | null; origin: CsTableEntry['origin'];
  paths: Set<string>; state: 'open' | 'closed'; capSeq: number; publishes: number; checks: Checks; covered: boolean;
  /** A capture is due: a boundary closed the CS, or a green or tool checkpoint waits for its capture. */
  due: boolean;
  /** The latest checks_run of the CS; `checks` takes it at each capture (R3-43). */
  lastChecks: Checks;
  /** human: the Δmono of the last change on any of its paths; done(): /cowork done. */
  lastChangeMono: number; done: boolean;
  /** HLD-36 (recovered only). */
  rq: RecoveredClock | null;
  /**
   * Pending edit-checkpoint candidates (seat CSs only; settled by Task 10), each with the CS's effect count at its checkpoint: a pass
   * covers the CS's latest effect only when no effect came after it (HLD-39).
   */
  candidates: Array<{ candSeq: number; paths: string[]; effects: number }>;
  /** File effects so far (memory only): whether a passing edit check covers the latest one (Task 10). */
  effects: number;
  /**
   * HLD-49 path bundle (Task 10, R3-44): the held PIN this closed CS joined at its close instead of journaling a ready pair; the CS is
   * due again (a recapture of its group) once that PIN is no longer among the held PINs (closeDue). null otherwise.
   */
  bundledInto: string | null;
  /**
   * The paths an open seat CS held when a restart rebuilt it from a fresh cache (fix round 1, finding 4): the effect claims of the
   * lost process are gone, so a changed path among them stays with this CS — never copied into the human CS by the restart's R-01
   * re-form or by the first tick after the reseed — until its close, the only point that empties the set (fix round 2: the seat's
   * effects never shrink it; an effect's claims hold only its own paths for one observe(), while the reseeded snapshot reports the
   * restored paths again at the first tick). Paths later effects add keep the ordinary claim rule. Empty for every other CS.
   */
  restored: Set<string>;
}

/** What one capture does to one member CS of a group. */
type MemberPlan =
  | { c: Cs; kind: 'replace'; paths: string[]; R: Oid; A: Oid }
  | { c: Cs; kind: 'keep' }
  | { c: Cs; kind: 'drop' };

/**
 * An unsettled candidate (Task 10): its seat CS, each member's built trees over the member's own paths (or a drop when none is left),
 * the members (a closed human CS standing for a Plan 2 pair is resolved again by cs_id at settlement) and the CS's effect count at its
 * checkpoint.
 */
interface CandidatePlan { cs: Cs; entries: Array<Exclude<MemberPlan, { kind: 'keep' }>>; members: Cs[]; effects: number; }

/** One group of HLD-38's closure: its member CSs, the held PINs among it and their paths. */
interface Group { members: Cs[]; pins: HeldPin[]; pinPaths: Set<string>; }

/** A capture's bundle (HLD-49, Task 10): the closing CSs of a group that holds `pin`, as the pairs they would have journaled. */
export interface CaptureBundle { pin: HeldPin; pairs: ReadyPair[]; }

const BUSY: ReadonlySet<SeatActivity> = new Set(['MID_TURN', 'AWAITING_PERMISSION']);
/** ENG-25's snapshot exclusions (Snapshotter's Exclusion names): a > 50 % or to-0 shrink, a removal awaiting its second reading. */
const ENG25_EXCLUSIONS: ReadonlySet<string> = new Set(['shrink', 'deletion_pending']);
const sortedPaths = (s: Iterable<string>): string[] => [...s].sort();

export class ChangeSets {
  private readonly peer: PeerId;
  private readonly clock: Clock;
  /** The Fs port for the capture's scratch-index reset (P2-SCRATCHLOCK); absent in unit uses without an engine. */
  private readonly fs: Fs | null;
  /** The per-peer human counter n (meta.cs_human_next). */
  private nextN = 1;
  /** The peer-wide capture order of the next group capture; null while no table is journaled or built (R3-68). */
  private nextOrder: number | null = null;
  private css: Cs[] = [];
  /** Paths of withdrawn or cancelled captures with no CS to carry them: re-captured at the next snapshot (HLD-41). */
  private readonly pending = new Set<string>();
  private pairs: ReadyPair[] = [];
  /** Per ready pair: it came from a passing capture (absent = a Plan 2 pair, which counts as passing). */
  private readonly passingOf = new Map<string, boolean>();
  /** Per seat: the turn-seq of its newest CS (HLD-33). */
  private readonly seats = new Map<string, number>();
  /** Paths an effect claimed since the previous observe(): their deltas stay with that seat CS (Plan 3 attribution). */
  private readonly claims = new Map<string, Cs>();
  /** The seats' activity as the signals report it (HLD-36's close input). */
  private readonly activity = new Map<string, SeatActivity>();
  /** The CSs a group capture added (a first table's Plan 2 pairs, a recapture's orphan CS): a rollback removes them again. */
  private readonly captureMade = new WeakSet<Cs>();
  /** rev 2.5 (Task 10, X-05): the memory-only last_check/last_pass per open seat CS; never in the table, the cache or a state commit. */
  readonly lastCheck: LastCheckStore = new LastCheckStore();
  /** R3-53 (Task 10): the not-stageable non-portable paths of the latest tick (portabilityStep), in memory, replaced each call. */
  private blockSet: ReadonlySet<string> = new Set();
  /** R3-53 (Task 12a): the human and recovered CSs open when the blocked set emptied; the gate stays shut until each closed (blockPaths). */
  private gateLatch: Cs[] = [];
  /** R3-42 (Task 10): the CSs a non-terminal SHADOW names (shadowCsIds), as the caller last reported them. */
  private shadowSet: ReadonlySet<string> = new Set();
  /** The held PINs of the newest groups/capture/candidate/composeP call: closeDue's view of which bundles may be re-captured (Task 10). */
  private pinView: readonly HeldPin[] = [];
  /** Per journaled pair that came from an edit-checkpoint candidate: the candidate's CS and cand_seq (the T0 slot's drop, sharedFor). */
  private readonly pairCand = new Map<string, { cs: string; candSeq: number }>();
  /** Per seat CS: the cand_seq of its newest passing candidate capture (an older cand_seq never replaces it, HLD-67 step 3). */
  private readonly candDone = new Map<string, number>();
  /** The built trees and members of each unsettled candidate (settleCandidate). */
  private readonly candPlans = new WeakMap<Candidate, CandidatePlan>();
  /** Task 17 (X-09, decision D2): the revert shrink marks of pending revert CSs (memory; re-derived at every attachCsTable, §8 Q18). */
  readonly revertMarks: RevertMarks = new RevertMarks();
  /**
   * Task 17 (ENG-25, §8 Q18 snapshot side): per path, the closed CS that must take that path's next change — a revert CS's written paths
   * until a tick shows the write (`gate`: its group is not ready meanwhile, so it never publishes a pre-write entry), and a path a closing
   * capture took while this tick excluded it for a shrink or a pending deletion (its last stable entry, not the disk). tickSettled routes
   * such a change to that CS (due again: re-captured at the next completed snapshot, as HLD-41's all-closed case) instead of the human
   * CS, and drops the entry once a tick neither changes nor excludes the path. Memory only.
   */
  private readonly stale = new Map<string, { c: Cs; gate: boolean }>();
  /**
   * Plan 3 Task EF (Task 17's concern 2): the closed CSs a tick routed a gated stale path to (a revert CS whose write a tick showed).
   * Such a CS is due again and still holds its pre-write pair; while it is due (until the re-capture consumes `due`) its group is not
   * ready, so an iteration that routes the write without materializing (a capture not due, P2-STRANDED-SKIP) never publishes that
   * pair: the gate holds until the re-capture lands, not only until a tick shows the write. Memory only, as `stale`.
   */
  private readonly regated = new WeakSet<Cs>();
  /** The exclusions of the newest tick (tickSettled), read by the capture of the same iteration. */
  private excludedNow: ReadonlyMap<string, string> = new Map();
  /**
   * Task 17 fix round 1 (finding 1): the revert marks the newest rebase() moved or dropped, each with its CS's pair and mark as they were
   * at the rebase's entry. restore() — the error path of a state update that failed to store the rebased pairs — gives a CS that mark
   * back when the pairs it restores carry that very pair (a mark follows its pair); set by every rebase(), consumed by every restore().
   */
  private marksAtRebase: Array<{ pair: ReadyPair; mark: ReadonlyMap<string, Oid | 'ABSENT'> }> = [];

  constructor(peer: PeerId, clock: Clock, fs?: Fs) {
    if (!validId('hex128', peer)) throw new TypeError(`ChangeSets: not a peer id ${JSON.stringify(peer)}`);
    this.peer = peer;
    this.clock = clock;
    this.fs = fs ?? null;
  }

  /**
   * The journal's ready pairs, meta.cs_human_next, the journaled table and the cache (R3-69). `journaled` undefined (Plan 2's
   * error-path restores, attachState) keeps the in-memory table — every CS with a cs_id, an open recovered CS, the orders,
   * next_order, passing and the seats — and resets the pairs, the pending recaptures and the effect claims; the open human CS
   * before its first capture (no cs_id, so not in the table) is dropped, Plan 2's behaviour for its one open human CS;
   * null = no table journaled yet (order = n, R3-68); a journaled table supplies orders, next_order, passing, the publish
   * counts, the closed CSs and the seats' turn_seq; `cache` (readCsCache: only when it names the current state commit) supplies the
   * open CSs' membership (a CS it shows closed with no journaled pair closed after that commit: its capture is due; an open
   * recovered CS keeps its kind and its HLD-36 close rule; an open seat CS keeps the deltas of its paths, `restored`). With a
   * journaled table and no cache the open membership is lost (HLD-36): an open CS without a ready pair
   * is dropped, one with a pair is kept closed (the seat's next effect opens a new CS), and the unpublished deltas observe() re-forms
   * go to one `recovered` CS, which gets its `<peer>/human/<n>` here (fix round 1, findings 1–2: so the table and the cache carry
   * it). n never reuses a cs_id the journal or the cache names.
   */
  restore(ready: readonly ReadyPair[], nextN: number, journaled?: CsTable | null, cache?: CsTable | null): void {
    if (!Number.isSafeInteger(nextN) || nextN < 1) throw new RangeError(`ChangeSets.restore: nextN must be a safe integer >= 1, got ${String(nextN)}`);
    this.pairs = ready.map((p) => ({ ...p, paths: [...p.paths] })).sort(byOrder);
    this.pending.clear();
    this.claims.clear();
    if (journaled !== undefined) this.stale.clear();
    // Task 17 fix round 1 (finding 1): a revert CS whose pair comes back as it was before the newest rebase gets back the mark it had
    // with it (the rebase moved or dropped it, and the update that would have stored the rebased pair failed). With a journaled table
    // (attachCsTable) rederiveRevertMarks replaces every mark next.
    const atRebase = this.marksAtRebase;
    this.marksAtRebase = [];
    if (journaled === undefined) {
      for (const { pair, mark } of atRebase) {
        if (this.pairs.some((p) => p.csId === pair.csId && p.R === pair.R && p.A === pair.A)) this.revertMarks.set(pair.csId, mark);
      }
    }
    const ids: string[] = this.pairs.map((p) => p.csId);
    const maxOrder = Math.max(0, ...this.pairs.map((p) => p.order));
    if (journaled === undefined) {
      // The table stays, and so does an open recovered CS (the in-memory form of a lost table's open membership, HLD-36: it ends
      // only by its own close rule). The open human CS before its first capture (no cs_id, so not in the table) is dropped, as
      // Plan 2's restore dropped it: attachState makes this call too (a restart, a lost-state rebuild), where its deltas belong to
      // the rebuilt state (restart records, R-01's re-form), never to the CS of the state left behind.
      this.css = this.css.filter((c) => c.csId !== null || c.kind === 'recovered');
      for (const id of [...this.passingOf.keys()]) if (!ids.includes(id)) this.passingOf.delete(id);
      if (this.nextOrder !== null) this.nextOrder = Math.max(this.nextOrder, maxOrder + 1);
      this.nextN = this.floorN(nextN, [...ids, ...this.css.flatMap((c) => (c.csId === null ? [] : [c.csId]))]);
      return;
    }
    this.css = [];
    this.passingOf.clear();
    this.seats.clear();
    const now = this.clock.monoMs();
    const has = new Set(ids);
    // The cache's open CSs, and a CS it shows closed with no journaled pair: closed after the journaled commit, its closing capture
    // not journaled yet (still due).
    const fromCache = new Map((cache ?? { cs: [] }).cs.filter((e) => e.state === 'open' || !has.has(e.cs_id)).map((e) => [e.cs_id, e] as const));
    if (journaled === null) {
      this.nextOrder = null;
    } else {
      this.nextOrder = Math.max(journaled.next_order, maxOrder + 1);
      for (const [seat, s] of Object.entries(journaled.seats)) this.seats.set(seat, s.turn_seq);
      for (const [id, passing] of Object.entries(journaled.passing)) if (has.has(id)) this.passingOf.set(id, passing);
      for (const e of journaled.cs) {
        if (fromCache.has(e.cs_id)) continue;   // its open membership comes from the cache below
        if (!has.has(e.cs_id)) continue;        // no ready pair: published, or an open CS whose membership is lost (HLD-36)
        // Open at the journaled commit and closed in a fresh cache: its closing capture is still due. Without a cache it is kept
        // closed with the pair it has (a later capture now could sweep a running turn's edits, S1).
        const closedSince = e.state === 'open' && cache?.cs.some((x) => x.cs_id === e.cs_id && x.state === 'closed') === true;
        this.css.push({ ...this.fromEntry(e, now), state: 'closed', due: closedSince });
      }
    }
    for (const e of fromCache.values()) {
      const j = journaled?.cs.find((x) => x.cs_id === e.cs_id);
      const c = this.fromEntry(j === undefined ? e : { ...e, publishes: j.publishes, cap_seq: j.cap_seq, checks: j.checks }, now);
      this.css.push({ ...c, due: c.state === 'closed', restored: new Set(c.kind === 'seat' && c.state === 'open' ? c.paths : []) });
    }
    for (const c of this.css) {
      ids.push(c.csId!);
      const m = c.seat === null ? null : SEAT_CS.exec(c.csId!);
      if (m !== null) this.seats.set(c.seat!, Math.max(this.seats.get(c.seat!) ?? 0, Number(m[2])));
    }
    this.nextN = this.floorN(nextN, [...ids, ...(journaled?.cs ?? []).map((e) => e.cs_id), ...(cache?.cs ?? []).map((e) => e.cs_id)]);
    if (journaled !== null && (cache === null || cache === undefined)) {
      this.css.push({ ...this.blank('recovered', null, null, 'human', now), csId: `${this.peer}/human/${this.nextN++}`, rq: this.recoveredClock(now) });
    }
  }

  /**
   * HLD-35 / HLD-36: the tick's changed paths. A path an effect claimed since the previous observe() stays with that seat CS, and so
   * does a path an open seat CS held when a restart restored it from the cache (`restored`, fix round 1, finding 4; until its close,
   * fix round 2); every other changed path is unattributed and goes to the open recovered CS, else the human CS (opened here). A
   * change on any path of an open human or recovered CS restarts its quiet period.
   */
  observe(changed: Iterable<string>): void {
    const now = this.clock.monoMs();
    this.pruneRecovered(now);
    const all = [...changed];
    const restored = this.css.filter((c) => c.restored.size > 0 && c.state === 'open');
    const unclaimed = all.filter((p) => !this.claims.has(p) && !restored.some((c) => c.restored.has(p)));
    this.claims.clear();
    let r = this.recipient();
    if (unclaimed.length > 0 && r === null) {
      r = this.blank('human', null, null, 'human', now);
      this.css.push(r);
    }
    if (r !== null) for (const p of unclaimed) r.paths.add(p);
    for (const c of this.css) {
      if (c.kind === 'seat' || c.state !== 'open') continue;
      if ((c === r && unclaimed.length > 0) || all.some((p) => c.paths.has(p))) this.touch(c, now);
    }
    this.absorbPending();
  }

  /** HLD-34: effects open or extend seat CSs (agent rules), boundaries close them; a nonce prompt is no boundary and changes no CS (05 U9). */
  signal(s: CsSignal): void {
    const now = this.clock.monoMs();
    switch (s.kind) {
      case 'effect': {
        if (!validId('hex128', s.seat)) throw new TypeError(`ChangeSets.signal: not a seat id ${JSON.stringify(s.seat)}`);
        // Calls carrying an agent join the parent's open CS; with the parent's CS closed they form their own (HLD-34).
        let c = this.seatOpen(s.seat, null) ?? (s.agent !== null ? this.seatOpen(s.seat, s.agent) : null);
        if (c === null) {
          const turn = (this.seats.get(s.seat) ?? 0) + 1;
          this.seats.set(s.seat, turn);
          c = { ...this.blank('seat', s.seat, s.agent, s.turnOrigin, now), csId: `${s.seat}/${turn}` };
          this.css.push(c);
        }
        // Never split below one tool_use: every path of the effect enters this CS.
        for (const p of s.paths) {
          if (!validPathSyntax(p)) continue;
          c.paths.add(p);
          this.claims.set(p, c);
        }
        c.covered = false;
        c.effects += 1;
        // `restored` stays (fix round 2): these claims cover only this effect's paths, for one observe().
        break;
      }
      case 'prompt':
        break;
      case 'stop':
      case 'stop_failure':
      case 'session_end':
        this.close(this.seatOpen(s.seat, null));
        this.setActivity(s.seat, s.kind === 'session_end' ? 'ENDED' : 'IDLE', now, true);
        break;
      case 'seat_end':
        for (const c of this.css) if (c.kind === 'seat' && c.seat === s.seat && c.state === 'open') this.close(c);
        this.setActivity(s.seat, 'ENDED', now, true);
        break;
      case 'subagent_stop':
        this.close(this.seatOpen(s.seat, s.agent));
        break;
      case 'checkpoint': {
        const c = this.checkpointCs(s.seat);
        if (c === null) break;
        if (s.source === 'edit') c.candidates.push({ candSeq: s.candSeq, paths: [...s.paths], effects: c.effects });
        else {
          c.covered = true;
          c.due = true;
        }
        break;
      }
      case 'checks_run': {
        const c = this.checkpointCs(s.seat);
        if (c !== null) c.lastChecks = s.ok ? 'pass' : 'fail';
        break;
      }
      case 'idle_10min':
        this.setActivity(s.seat, s.activity, now, false);
        // The fallback close only for a seat with no open turn (HLD-34): IDLE or ENDED and no TXN window open.
        if ((s.activity === 'IDLE' || s.activity === 'ENDED') && !s.txnOpen) this.close(this.seatOpen(s.seat, null));
        break;
      case 'activity':
        this.setActivity(s.seat, s.activity, now, false);
        break;
    }
    this.pruneRecovered(now);
  }

  /** /cowork done: the open human and recovered CSs close at the next iteration. */
  done(): void {
    for (const c of this.css) if (c.kind !== 'seat' && c.state === 'open') c.done = true;
  }

  /**
   * Task 17 (X-09, HLD-68; Algorithm REV step 8): a second human-class CS beside the open human CS (no new CsKind): `<peer>/human/<n>`
   * with the next n of the per-peer counter, member paths exactly `paths`, closed at once (closeDue() true until it is captured, HLD-40
   * human close); returns its cs_id. Until a tick shows each written path, the path's change is this CS's (tickSettled), never the open
   * human CS's, and its group is not ready — so its capture takes the written blobs and it publishes as one human CS.
   */
  addRevertCs(paths: readonly string[]): string {
    const now = this.clock.monoMs();
    const csId = `${this.peer}/human/${this.nextN}`;
    readyKey(csId);
    const members = [...new Set(paths)].filter((p) => validPathSyntax(p));
    if (members.length === 0) throw new TypeError('ChangeSets.addRevertCs: no valid path');
    this.nextN += 1;
    const c: Cs = { ...this.blank('human', null, null, 'human', now), csId, paths: new Set(members), state: 'closed', due: true };
    this.css.push(c);
    for (const p of members) this.stale.set(p, { c, gate: true });
    return csId;
  }

  /**
   * Task 17 (ENG-25 snapshot side, §8 Q18): the tick's LIVE changes (as observe() gets them) and its exclusions, before observe(). A path a
   * closed CS must take next (the stale set: a revert CS's write, a capture that took an excluded path's old entry) goes to that CS when
   * it changed — claimed for this tick's observe(), the CS due again (re-captured at this completed snapshot) — and leaves the set when the
   * tick neither changed nor excluded it (the captured entry is the disk's). The capture of this iteration reads the exclusions.
   */
  tickSettled(changed: ReadonlySet<string>, excluded: ReadonlyMap<string, string>): void {
    this.excludedNow = excluded;
    for (const [p, { c, gate }] of [...this.stale]) {
      if (!this.css.includes(c) || c.state !== 'closed') {
        this.stale.delete(p);
      } else if (changed.has(p)) {
        this.claims.set(p, c);
        c.paths.add(p);
        c.due = true;
        if (gate) this.regated.add(c);   // Task EF: the gate holds until this CS's re-capture (readyOf)
        this.stale.delete(p);
      } else if (!excluded.has(p)) {
        this.stale.delete(p);
      }
    }
  }

  /**
   * A human or recovered close, a seat close, a pending green or tool checkpoint capture, a closed CS without a pair, or a pending
   * recapture is due — including (Task 10, HLD-49) a bundled CS whose PIN is no longer among the held PINs of the newest
   * groups/capture/composeP call (captureDue calls groups(heldPins) first, so a release is seen at the next tick).
   */
  closeDue(): boolean {
    const now = this.clock.monoMs();
    return this.pending.size > 0 || this.css.some((c) => this.isDue(c, now));
  }

  /**
   * HLD-40 at a trigger (the iteration materialized). Plan 2's form while no table is journaled and the caller passes no `pins`
   * (R3-68): the due human CS and the pending recaptures as one `<peer>/human/<n>` pair with order n (capturePlan2). Otherwise the
   * group form: for every publication group (CSs and `pins` sharing a path) holding a due CS, one ready pair per member CS over its
   * own paths (pin paths excluded), R[p] = S_disk[p], A_cap[p] = A[p], all with one order (next_order, then incremented). A member
   * without a pair always gets one; an unpublished passing pair is replaced only by a passing capture (every member closed or
   * covered, HLD-39); a member whose paths are absent from both trees gets none (a closed one leaves the table). A group holding a
   * pair named by `kept` (a kept push intent, Task 19 ruling) waits until the intent resolved. Every read-tree into scratchIndex is
   * preceded by resetScratchIndex (P2-SCRATCHLOCK). Returns null when nothing was captured or closed; `pair` is the first closing
   * CS's pair (pairs lists the closing CSs' pairs first), `nextN` the human counter after it.
   *
   * Task 10 (HLD-38, HLD-49, R3-44): a group holding a held PIN journals nothing. Each of its CSs closing now (a human or recovered
   * close, a seat CS closed without a pair) joins that PIN as a bundle instead: it is closed, gets its cs_id, keeps no pair and is
   * marked bundled into the PIN, and `bundles` carries the pairs it would have journaled — over all its own paths, the pinned ones
   * included, and the PIN's paths among its vanished ones (absent from both trees: h1 → ABSENT; final review F7, also when every path
   * of the CS vanished) — for the caller's registry growth (bundle()). Its other due work (a green or tool checkpoint of an open
   * member) is consumed: a held group publishes nothing until the PIN releases, and then its members are captured again (a bundled
   * CS at once, closeDue; an open one at its next trigger).
   */
  async capture(
    repo: GitRepo, sDisk: TreeMap, A: TreeMap, scratchIndex: string, kept: ReadonlySet<string> = new Set(), pins?: readonly HeldPin[],
  ): Promise<{ pair: ReadyPair | null; pairs: ReadyPair[]; nextN: number; bundles?: CaptureBundle[] } | null> {
    if (pins === undefined && this.nextOrder === null) return this.capturePlan2(repo, sDisk, A, scratchIndex, kept);
    if (pins !== undefined) this.pinView = pins;
    return this.captureGroups(repo, sDisk, A, scratchIndex, kept, pins ?? []);
  }

  /** Plan 2's capture (R3-68): the due human CS plus the pending recaptures, `<peer>/human/<n>` with order n; vanished paths leave older pairs. */
  private async capturePlan2(repo: GitRepo, sDisk: TreeMap, A: TreeMap, scratchIndex: string, kept: ReadonlySet<string>): Promise<{ pair: ReadyPair | null; pairs: ReadyPair[]; nextN: number } | null> {
    const now = this.clock.monoMs();
    const open = this.css.find((c) => c.kind === 'human' && c.state === 'open' && c.csId === null) ?? null;
    const closing = open !== null && this.isDue(open, now) ? open : null;
    if (closing === null && this.pending.size === 0) return null;
    const paths = new Set(this.pending);
    if (closing !== null) for (const p of closing.paths) paths.add(p);
    const { R, Acap, vanished } = sparse(paths, sDisk, A);
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
    if (closing !== null) this.css = this.css.filter((c) => c !== closing);
    this.pending.clear();
    for (const p of deferred) this.pending.add(p);
    if (shrunk !== null) this.replacePairs(shrunk);
    if (pair === null) return shrunk === null ? null : { pair: null, pairs: [], nextN: this.nextN };
    this.nextN = pair.order + 1;
    this.pairs.push(pair);
    this.pairs.sort(byOrder);
    const out = { ...pair, paths: [...pair.paths] };
    return { pair: out, pairs: [out], nextN: this.nextN };
  }

  /** The group form of capture() (R3-40, contract addition 3; Task 10's bundles for groups holding a held PIN). */
  private async captureGroups(
    repo: GitRepo, sDisk: TreeMap, A: TreeMap, scratchIndex: string, kept: ReadonlySet<string>, pins: readonly HeldPin[],
  ): Promise<{ pair: ReadyPair | null; pairs: ReadyPair[]; nextN: number; bundles?: CaptureBundle[] } | null> {
    const now = this.clock.monoMs();
    this.pruneRecovered(now);
    // Staged until every tree exists, so a capture that ends with nothing to journal changes nothing: the first table's CSs (a
    // Plan 2 pair as a closed human CS, R3-40) and, for the recaptures (HLD-41), a closed human CS of the paths no CS holds; a
    // pending path a CS holds re-captures that CS.
    const firstTable = this.nextOrder === null;
    const staged: Cs[] = firstTable ? this.pairs.filter((p) => !this.css.some((c) => c.csId === p.csId)).map((p) => this.plan2Cs(p, now)) : [];
    const css = [...this.css, ...staged];
    const recapture = new Set<Cs>();
    const orphans: string[] = [];
    for (const p of this.pending) {
      const owners = css.filter((c) => c.paths.has(p));
      if (owners.length === 0) orphans.push(p);
      for (const c of owners) recapture.add(c);
    }
    const orphanCs: Cs | null = orphans.length === 0 ? null : { ...this.blank('human', null, null, 'human', now), paths: new Set(orphans), state: 'closed', due: true };
    if (orphanCs !== null) css.push(orphanCs);
    const due = css.filter((c) => recapture.has(c) || this.isDue(c, now));
    if (due.length === 0) return null;
    const closing = new Set(due.filter((c) => c.kind !== 'seat' && c.state === 'open'));
    const groups = this.groupsWith(css, pins);
    const plans: Array<{ members: Cs[]; passing: boolean; plan: MemberPlan[] }> = [];
    // HLD-49 (Task 10): per group holding a held PIN, its closing CSs as the pairs they would journal, and the other due members.
    const joins: Array<{ pin: HeldPin; c: Cs; paths: string[]; R: Oid; A: Oid }> = [];
    const consumed: Cs[] = [];
    for (const g of groups) {
      if (!g.members.some((c) => due.includes(c))) continue;
      if (g.members.some((c) => c.csId !== null && kept.has(c.csId))) continue;   // the kept push intent resolves first
      if (g.pins.length > 0) {
        for (const c of g.members) {
          if (!due.includes(c) || c === orphanCs) continue;
          const closes = closing.has(c) || (c.state === 'closed' && !this.hasPair(c));
          if (!closes) {
            consumed.push(c);
            continue;
          }
          // Final review F7: a closing member joins even when its paths all vanished (created and deleted) — never `consumed`, which
          // left an open CS due at every iteration (a capture and a state commit each loop) and the recipient of every later
          // unattributed delta. Its vanished paths that the PIN holds join the bundle's pair with R and A_cap lacking them, so bundle()
          // refreshes the PIN's h1 to ABSENT there (the rest leave no entry); once the PIN is no longer held, the bundled CS is due
          // (isDue) and its group's recapture drops the vanished paths from the older pairs, so none of them is published again.
          // The empty-pair join is intentional (ruling R3-FF2-A4): a member that belongs to the held group only through another CS
          // (the `?? g.pins[0]` fallback) and whose paths all vanished, none of them the PIN's, joins with `paths` = [] — bundle()
          // adds nothing and joinPin's rev and op only add its cs_id. Dropping it instead would let an older ready pair over those
          // paths publish (resurrect) the deleted file; joined, it is due once the PIN is no longer held, and the group's recapture
          // drops it ('drop': it leaves the table). Its cost is one registry rev and one board op.
          const { R, Acap, vanished } = sparse(c.paths, sDisk, A);
          const pin = g.pins.find((x) => x.paths.some((q) => c.paths.has(q))) ?? g.pins[0]!;
          const paths = [...new Set([...R.keys(), ...Acap.keys(), ...[...vanished].filter((q) => pin.paths.includes(q))])].sort();
          await this.resetScratch(scratchIndex);
          const rTree = await repo.writeTreeMap(R, scratchIndex);
          await this.resetScratch(scratchIndex);
          const aTree = await repo.writeTreeMap(Acap, scratchIndex);
          joins.push({ pin, c, paths, R: rTree, A: aTree });
        }
        continue;
      }
      const passing = g.members.every((c) => c.state === 'closed' || closing.has(c) || c.covered);
      const plan: MemberPlan[] = [];
      for (const c of g.members) {
        const own = [...c.paths].filter((p) => !g.pinPaths.has(p));
        const { R, Acap } = sparse(own, sDisk, A);
        const paths = [...new Set([...R.keys(), ...Acap.keys()])].sort();
        const existing = c.csId === null ? undefined : this.pairs.find((p) => p.csId === c.csId);
        if (paths.length === 0) plan.push({ c, kind: 'drop' });
        else if (existing !== undefined && (this.passingOf.get(existing.csId) ?? true) && !passing) plan.push({ c, kind: 'keep' });
        else {
          await this.resetScratch(scratchIndex);
          const rTree = await repo.writeTreeMap(R, scratchIndex);
          await this.resetScratch(scratchIndex);
          const aTree = await repo.writeTreeMap(Acap, scratchIndex);
          plan.push({ c, kind: 'replace', paths, R: rTree, A: aTree });
        }
      }
      plans.push({ members: g.members, passing, plan });
    }
    if (plans.length === 0 && joins.length === 0 && consumed.length === 0) return null;
    // Every tree exists: memory changes from here on (the caller restores it when its state update fails).
    const planned = new Set(plans.flatMap((g) => g.members));
    if (firstTable) {
      this.nextOrder = this.firstNextOrder();
      this.css.push(...staged);
      for (const c of staged) this.captureMade.add(c);
    }
    if (orphanCs !== null && planned.has(orphanCs)) {
      this.css.push(orphanCs);
      this.captureMade.add(orphanCs);
    }
    // A pending path leaves once every CS holding it was captured (a group a kept push intent holds waits).
    for (const p of [...this.pending]) {
      const owners = css.filter((c) => c.paths.has(p));
      if (owners.every((c) => planned.has(c))) this.pending.delete(p);
    }
    const made: ReadyPair[] = [];
    for (const { members, passing, plan } of plans) {
      let order: number | null = null;
      if (plan.some((m) => m.kind === 'replace')) {
        order = this.nextOrder!;
        this.nextOrder = order + 1;
      }
      for (const m of plan) {
        const c = m.c;
        if (m.kind === 'replace') {
          c.csId ??= `${this.peer}/human/${this.nextN++}`;
          readyKey(c.csId);
          const pair: ReadyPair = { csId: c.csId, R: m.R, A: m.A, paths: m.paths, order: order! };
          this.pairs = [...this.pairs.filter((p) => p.csId !== pair.csId), pair].sort(byOrder);
          this.passingOf.set(c.csId, passing);
          this.pairCand.delete(c.csId);   // a closing, checkpoint or recapture pair, not an edit-checkpoint candidate's
          c.capSeq += 1;
          c.checks = c.lastChecks;
          c.bundledInto = null;
          made.push(pair);
        } else if (m.kind === 'drop' && c.csId !== null) {
          if (this.pairs.some((p) => p.csId === c.csId)) this.revertMarks.drop(c.csId);   // Task 17: it left journal/ready/ unpublished
          this.pairs = this.pairs.filter((p) => p.csId !== c.csId);
          this.passingOf.delete(c.csId);
          this.pairCand.delete(c.csId);
        }
      }
      for (const c of members) {
        if (closing.has(c)) c.state = 'closed';
        if (due.includes(c)) c.due = false;
        if (c.state === 'closed') c.candidates = [];   // its closing capture supersedes every pending candidate
        // Task 17 (ENG-25, §8 Q18): a closed member captured while this tick excluded one of its paths for a shrink or a pending deletion
        // took that path's last stable entry: the path's next change is re-captured into it (tickSettled) while it is unpublished.
        if (c.state === 'closed' && this.hasPair(c)) {
          for (const p of c.paths) if (ENG25_EXCLUSIONS.has(this.excludedNow.get(p) ?? '') && !this.stale.has(p)) this.stale.set(p, { c, gate: false });
        }
      }
      // A closed member left with no pair has nothing to publish: it leaves the table.
      this.css = this.css.filter((c) => !(members.includes(c) && c.state === 'closed' && !this.hasPair(c)));
    }
    // HLD-49: the bundled CSs close with no pair, marked bundled into their PIN; the rest of a held group's due work is consumed.
    const bundles: CaptureBundle[] = [];
    for (const j of joins) {
      const c = j.c;
      if (closing.has(c)) c.state = 'closed';
      c.csId ??= `${this.peer}/human/${this.nextN++}`;
      readyKey(c.csId);
      c.due = false;
      c.candidates = [];
      c.bundledInto = j.pin.id;
      const pair: ReadyPair = { csId: c.csId, R: j.R, A: j.A, paths: j.paths, order: 0 };
      const b = bundles.find((x) => x.pin.id === j.pin.id);
      if (b === undefined) bundles.push({ pin: j.pin, pairs: [pair] });
      else b.pairs.push(pair);
    }
    for (const c of consumed) c.due = false;
    this.prunePassing();
    const first = due.flatMap((c) => made.filter((p) => p.csId === c.csId));
    const pairs = [...new Set([...first, ...made])].map((p) => ({ ...p, paths: [...p.paths] }));
    return { pair: pairs[0] ?? null, pairs, nextN: this.nextN, ...(bundles.length > 0 ? { bundles } : {}) };
  }

  /**
   * The ready pairs after dropping `vanished` (closing paths absent from S_disk and A) from every pair covering one: its
   * R and A_cap lose the path (only the trees that hold it are rewritten), a pair left with no path leaves. A pair in
   * `kept` (named by a kept push intent) is left whole and its vanished paths are returned as `deferred`. `pairs` is null
   * when no unkept pair covers a vanished path. Builds trees only; the caller replaces `pairs` and fills `pending`.
   */
  private async withoutVanished(
    repo: GitRepo, vanished: ReadonlySet<string>, kept: ReadonlySet<string>, scratchIndex: string, only?: ReadonlySet<string>,
  ): Promise<{ pairs: ReadyPair[] | null; deferred: ReadonlySet<string> }> {
    const deferred = new Set<string>();
    if (vanished.size === 0) return { pairs: null, deferred };
    let changed = false;
    const out: ReadyPair[] = [];
    for (const pair of this.pairs) {
      const gone = only !== undefined && !only.has(pair.csId) ? [] : pair.paths.filter((p) => vanished.has(p));
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
    this.replacePairs(pairs);
    return true;
  }

  /**
   * EF2 fix round 1, F3 (05-holds Table 4 `--discard`): a discarded record's content leaves the change-sets it held — `paths` leave
   * every ready pair whose cs_id is in `csIds` (R and A_cap lose them, as withoutVanished does; a pair left with no path leaves
   * journal/ready/ unpublished, its revert mark with it, and its CS, closed with no capture due, leaves the table as a published one
   * would). Without it the pair a K6 PIN held published the discarded bytes once the record ended. The ids of the pairs that left, or
   * null when no pair changed; the caller journals ready() (with the table when one is journaled) and logs CS_READY_CANCELLED.
   */
  async discardPaths(repo: GitRepo, csIds: ReadonlySet<string>, paths: ReadonlySet<string>, scratchIndex: string): Promise<string[] | null> {
    const { pairs } = await this.withoutVanished(repo, paths, new Set(), scratchIndex, csIds);
    if (pairs === null) return null;
    const left = this.pairs.filter((p) => !pairs.some((x) => x.csId === p.csId)).map((p) => p.csId);
    this.replacePairs(pairs);
    for (const id of left) {
      this.pairCand.delete(id);
      const c = this.css.find((x) => x.csId === id);
      if (c !== undefined && c.state === 'closed' && !c.due) this.css = this.css.filter((x) => x !== c);
    }
    return left;
  }

  /**
   * Plan 3 final review F6 (05-holds §3.4 item 3, HLD-16; HLD-41's withdrawal): an operator write took a hold record's bytes off the
   * disk over `paths` (PARK, the markers park, their restart completions, an ON_DISK --discard), so an unpublished ready pair naming one
   * of them still carries those bytes in its R while nothing masks them any more (INV-HLD-OFFDISK). Every publication group (HLD-38, as
   * rebase() groups the pairs: the ready pairs and the CSs sharing a path, transitively; held PINs left out) holding such a pair is
   * withdrawn whole (never one pair alone, INV-HLD-ATOMIC-PUB), with no message, exactly as rebase() withdraws: its pairs leave
   * journal/ready/ unpublished (a withdrawn revert CS loses its mark), last_pass.ready follows the journal, and its paths are re-captured
   * from the disk — a tabled member keeps them (closed: due at once, a closed CS without a pair; open: at its next trigger), any other
   * path waits in `pending` for the next snapshot. Memory only: the caller takes a rollbackPoint() first and journals ready() (with the
   * table when one is journaled). The withdrawn cs_ids in capture order; [] when no pair names a path.
   */
  withdrawPaths(paths: ReadonlySet<string>): string[] {
    return this.withdrawWhere((pair) => pair.paths.some((p) => paths.has(p)));
  }

  /**
   * EF4 round 2 I2-3 (ruling R3-EF4-20): withdrawPaths' withdrawal for the ready pairs named by cs_id — each one's publication group
   * whole, silently, its paths re-captured from the disk. The caller (holdOps.withdrawMarkerPairs) names the pairs whose R holds a
   * restore-marker row at the paths of a record whose `markers` releases: such a pair can never pass ENG-41 (k). Memory only, as
   * withdrawPaths. The withdrawn cs_ids in capture order; [] when no pair has one of `csIds`.
   */
  withdrawPairs(csIds: ReadonlySet<string>): string[] {
    return this.withdrawWhere((pair) => csIds.has(pair.csId));
  }

  /** withdrawPaths' and withdrawPairs' body: every publication group holding a pair `names` picks is withdrawn whole. */
  private withdrawWhere(names: (pair: ReadyPair) => boolean): string[] {
    if (!this.pairs.some(names)) return [];
    const groupOf = this.groupIndex();
    const hit = new Set(this.pairs.filter(names).map((pair) => groupOf.get(pair.csId)));
    const out = this.pairs.filter((pair) => names(pair) || hit.has(groupOf.get(pair.csId)));
    const recapture = new Set<string>();
    for (const pair of out) {
      for (const p of pair.paths) recapture.add(p);
      clearReady(this.lastCheck, pair.csId);
      const from = this.pairCand.get(pair.csId);
      if (from !== undefined) clearReady(this.lastCheck, from.cs);
      this.revertMarks.drop(pair.csId);
    }
    this.pairs = this.pairs.filter((pair) => !out.includes(pair));
    const tabled = this.nextOrder !== null;
    for (const p of recapture) if (!(tabled && this.css.some((c) => c.paths.has(p)))) this.pending.add(p);
    this.absorbPending();
    return out.map((pair) => pair.csId);
  }

  /** The ready pairs after withoutVanished: a revert CS whose pair left (no path left) loses its mark (Task 17: it left journal/ready/ unpublished). */
  private replacePairs(next: ReadyPair[]): void {
    for (const p of this.pairs) if (!next.some((x) => x.csId === p.csId)) this.revertMarks.drop(p.csId);
    this.pairs = next;
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
   * With a table (Task 9) a withdrawn pair's CS keeps its paths and re-captures them itself: closed, it is due at once (a
   * closed CS without a pair); open, at its next trigger. Task 10: the group is HLD-38's (the ready pairs and the CSs sharing a
   * path, transitively), and a withdrawn or cancelled pair's CS loses last_pass.ready (rev 2.5, 10 §3.5.1 "follows the journal").
   * Task 17 (rev 2.5, decision D2, §8 Q18 option (a)): a clean HLD-41 rebase (glossary §29.2) of a kept pair whose R[p] before it is a
   * revert shrink mark's oid moves the mark to the new R[p] (RevertMarks.moveOnCleanRebase), reported in RebaseResult.marksMoved (the
   * whole current map per CS) once every tree exists; a withdrawn revert CS loses its mark (it left journal/ready/ unpublished). Fix round
   * 1 (finding 1): when the state update that stores the result fails, Plan 2's error-path restore() puts those marks back with the pairs.
   */
  async rebase(repo: GitRepo, changes: readonly RebaseChange[], scratchIndex: string): Promise<RebaseResult> {
    this.marksAtRebase = [];
    const byPath = new Map<string, RebaseChange>();
    // A take_tip with A unchanged (apply.ts: a local path displaced from beneath a TIP file and removed) counts too.
    for (const ch of changes) if (!same(ch.aOld, ch.aNew) || ch.written === 'take_tip') byPath.set(ch.path, ch);
    const plans: RebasePlan[] = [];
    for (const pair of this.pairs) plans.push(await planRebase(repo, pair, byPath));
    const verdicts = groupVerdicts(plans, this.groupIndex());
    const kept: ReadyPair[] = [];
    const cancelled: string[] = [];
    const recapture = new Set<string>();
    const movesOf: RebasePlan[] = [];
    const withdrawn: string[] = [];
    for (const [i, plan] of plans.entries()) {
      const { pair } = plan;
      const verdict = verdicts[i]!;
      if (verdict !== 'keep') {
        for (const p of pair.paths) recapture.add(p);
        if (verdict === 'cancel') cancelled.push(pair.csId);
        clearReady(this.lastCheck, pair.csId);
        const from = this.pairCand.get(pair.csId);
        if (from !== undefined) clearReady(this.lastCheck, from.cs);
        // Task 17 (decision D2): a withdrawn revert CS leaves journal/ready/ unpublished — its mark goes (its recapture reads the disk,
        // which the mark no longer vouches for). A cancelled one (TAKE_TIP, A changed without a write) is left to recordStep's sweep: the
        // K4 record apply.ts makes names the CS and keeps it pending (the revert version restorable with --restore, HLD-68).
        if (verdict === 'withdraw') withdrawn.push(pair.csId);
        // Its passing flag stays (table() lists passing for current pairs only): when the update fails, Plan 2's error-path restore
        // brings the pair back with the flag it had (fix round 1, finding 3); the next capture prunes it.
        continue;
      }
      if (plan.moves.length > 0) movesOf.push(plan);
      if (plan.rEdits.length === 0 && plan.aEdits.length === 0) {
        kept.push(pair);
        continue;
      }
      const rTree = plan.rEdits.length > 0 ? await repo.editTree(pair.R, plan.rEdits, scratchIndex) : pair.R;
      const aTree = plan.aEdits.length > 0 ? await repo.editTree(pair.A, plan.aEdits, scratchIndex) : pair.A;
      kept.push({ csId: pair.csId, R: rTree, A: aTree, paths: plan.paths, order: pair.order });
    }
    this.pairs = kept;
    // Task 17 (glossary §29.2, §8 Q18 option (a)), once every tree exists: the mark of a revert CS follows a clean HLD-41 rebase of
    // exactly its oid; each CS whose mark moved is reported with its whole current map (the reverts.jsonl line applyStep appends).
    // Fix round 1 (finding 1): each mark moved or dropped here is kept with its pre-rebase pair for restore() (marksAtRebase).
    const atRebase: Array<{ pair: ReadyPair; mark: ReadonlyMap<string, Oid | 'ABSENT'> }> = [];
    for (const plan of plans) {
      const mark = this.revertMarks.current(plan.pair.csId);
      if (mark !== null && (withdrawn.includes(plan.pair.csId) || movesOf.includes(plan))) atRebase.push({ pair: plan.pair, mark });
    }
    for (const id of withdrawn) this.revertMarks.drop(id);
    const marksMoved: Array<{ cs: string; written: Record<string, Oid | 'ABSENT'> }> = [];
    for (const plan of movesOf) {
      let moved = false;
      for (const m of plan.moves) if (this.revertMarks.moveOnCleanRebase(plan.pair.csId, m.path, m.before, m.after)) moved = true;
      const now = moved ? this.revertMarks.current(plan.pair.csId) : null;
      if (now !== null) marksMoved.push({ cs: plan.pair.csId, written: Object.fromEntries([...now].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) });
    }
    this.marksAtRebase = atRebase;
    const tabled = this.nextOrder !== null;
    for (const p of recapture) if (!(tabled && this.css.some((c) => c.paths.has(p)))) this.pending.add(p);
    this.absorbPending();
    return { ready: kept.map((p) => ({ ...p, paths: [...p.paths] })), cancelled, recapture, ...(marksMoved.length > 0 ? { marksMoved } : {}) };
  }

  /**
   * P (HLD-42): MASK(R) of the newest ready pair per path of every READY group (groups(pins): no held PIN, a passing capture, not
   * kept back by R3-53's blocked paths or R3-42's SHADOW), A[p] elsewhere; A_cap[p] ≠ A[p] → ReadyBaseMismatchError (ENG-39). A
   * group that is not ready (01-engine §3.12 step 1, HLD-38) publishes none of its paths and its pairs stay journaled. csIds lists
   * every included pair in capture order, also one whose paths a newer pair covers (its edits are in the newer R), so published()
   * clears it; csPaths maps each to its paths (Cowork-CS-Paths). `mask` is the asynchronous MASK (merge-file form, maskEntries; Task 2).
   * withheldWhole: every group path the MASK result withheld whole (publishStep narrows it to MASK steps 2–4, Composition). groups
   * lists every group with the engine's readiness (the compose event's, R3-63), ordered by key.
   */
  async composeP(repo: GitRepo, A: TreeMap, mask: (X: TreeMap) => Promise<MaskResult>, pins: readonly HeldPin[]): Promise<Composition> {
    const groups = this.groups(pins);
    const groupOf = new Map<string, PublicationGroup>();
    for (const g of groups) for (const id of g.csIds) groupOf.set(id, g);
    const X = new Map<string, TreeEntry>(A);
    const csIds: string[] = [];
    const csPaths = new Map<string, string[]>();
    for (const pair of this.pairs) {
      if (groupOf.get(pair.csId)?.ready !== true) continue;
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
    const m = await mask(X);
    const withheldWhole = new Map<string, string[]>();
    for (const g of groups) {
      if (!this.pairs.some((p) => g.csIds.includes(p.csId))) continue;   // no R: nothing to withhold
      const whole = g.paths.filter((p) => m.withheld.has(p));
      if (whole.length > 0) withheldWhole.set(g.key, whole);
    }
    return { P: m.entries, csIds, csPaths, groups, withheldWhole };
  }

  /**
   * HLD-38: the publication groups — the transitive closure of this peer's open and ready CSs (a journaled pair without a table
   * entry, a Plan 2 pair, stands as a closed human CS) and the held PINs `pins`, sharing a path — ordered by key. A group is ready
   * (HLD-39) when it holds no held PIN, has at least one unpublished ready pair and every one of its pairs came from a passing
   * capture (CsTable.passing; a Plan 2 pair counts as passing), and is not kept back by R3-53 (while blocked() is non-empty, a group
   * holding a human or recovered CS that is open or has an unpublished pair) or R3-42 (an open seat CS a non-terminal SHADOW names,
   * shadowed()). A group of PINs only is no group. `pins` also becomes closeDue's view of the held PINs (bundles).
   */
  groups(pins: readonly HeldPin[]): PublicationGroup[] {
    this.pinView = pins;
    return this.groupsView(pins);
  }

  /**
   * Plan 3 Task 18 (rev 2.5, F14; UX-33): groups(pins) as a pure read — the same publication groups, without making `pins` closeDue's
   * view of the held PINs (the flow's query changes no ChangeSets state).
   */
  groupsView(pins: readonly HeldPin[]): PublicationGroup[] {
    return this.groupsWith(this.members(), pins).map((g) => this.describe(g)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /**
   * Plan 3 Task 18 (X-11, FEAT-F14-04; HLD-35, HLD-36; O8's estimate input): the Δmono until the open human CS — or, while one is open,
   * the open recovered CS (the CS unattributed deltas go to) — reaches its 20 s quiet close: 20,000 minus the Δmono since its last
   * observed change (a recovered CS: minus the quiet counted so far, which does not grow while a seat is MID_TURN or
   * AWAITING_PERMISSION), 0 once due (also after done(), or once every busy seat of a recovered CS has stopped), null when no human or
   * recovered CS with a member path is open. A pure read.
   */
  quietLeftMs(): number | null {
    const now = this.clock.monoMs();
    const open = (kind: CsKind): Cs | undefined => this.css.find((c) => c.kind === kind && c.state === 'open' && c.paths.size > 0);
    const c = open('recovered') ?? open('human');
    if (c === undefined) return null;
    if (c.done) return 0;
    if (c.rq === null) return Math.max(0, HUMAN_CS_QUIET_MS - (now - c.lastChangeMono));
    if (c.rq.released) return 0;
    return Math.max(0, HUMAN_CS_QUIET_MS - (c.rq.acc + (c.rq.since === null ? 0 : now - c.rq.since)));
  }

  /**
   * R3-53: the not-stageable non-portable paths of this tick (portabilityStep, every tick); replaces the previous set. Plan 3 Task 12a:
   * the tick that empties a non-empty set latches the gate on the human and recovered CSs open with paths at that tick (`gateLatch`) —
   * the CS a rename to a portable name opened with the new name — until each of them has closed, so the human side captured behind
   * the gate (the deletion of the old name) publishes with the new name's capture in one commit (DAT-32), not alone in the loop's next
   * window; a fix that opened no CS (the bad name deleted) releases at once, and a CS opened later never extends the latch.
   */
  blockPaths(paths: ReadonlySet<string>): void {
    if (this.blockSet.size > 0 && paths.size === 0) this.latchGate();
    this.blockSet = new Set(paths);
  }

  /**
   * R3-53's latch, also for a name a record carries (Plan 3 Task EF, DAT-32): the gate latches on the human and recovered CSs open with
   * paths now, until each of them has closed (readyOf). blockPaths calls it when the blocked set empties; portabilityStep calls it at
   * the tick that ends a `portability` record (its name renamed, deleted or admitted) — the CS that tick opened with the fixed name is
   * open by then (prepareIteration's observe runs before the detection steps), so the CS the record's dependency PIN held back, whose
   * pair is journaled and whose PIN releaseDependencyGuards releases in the same loop, publishes with the fixed name's capture in one
   * commit, not alone in the next window. A fix that opened no CS releases at once; a CS opened later never extends the latch.
   */
  latchGate(): void {
    const open = this.css.filter((c) => c.kind !== 'seat' && c.state === 'open' && c.paths.size > 0);
    this.gateLatch = [...new Set([...this.gateLatch.filter((c) => c.state === 'open' && this.css.includes(c)), ...open])];
  }

  /** R3-53's latch still holds: a CS open with paths when the blocked set emptied has not closed yet. */
  private latched(): boolean {
    return this.gateLatch.some((c) => c.state === 'open' && this.css.includes(c));
  }

  blocked(): ReadonlySet<string> {
    return this.blockSet;
  }

  /**
   * R3-53's gate holds back the human side now: blocked() is non-empty or its latch holds (readyOf's condition). EF3: holdStatusInputs
   * lists the groups it keeps back in not_converged for as long as either holds, not only while blocked() is non-empty.
   */
  gated(): boolean {
    return this.blockSet.size > 0 || this.latched();
  }

  /**
   * R3-42 (Task 10): the cs_ids a non-terminal SHADOW names (shadowCsIds(registry)); while a CS among them is an open seat CS, none of
   * its group's captures is ready (HLD-48 "would hold" assumed without the symbol delta). Replaces the previous set; in memory.
   */
  shadowed(csIds: ReadonlySet<string>): void {
    this.shadowSet = new Set(csIds);
  }

  /**
   * HLD-67 step 1 (R3-41): a candidate capture of `csId`'s publication group from the materialized S_disk — per member CS one pair
   * over its own paths (held PIN paths excluded), R = S_disk, A_cap = A — built as trees and never journaled; settleCandidate
   * decides it. rev 2.5 (X-05): notes edit_n = candSeq unless an edit_n was noted for (csId, candSeq) before (Plan 5's wins). Null —
   * and the pending candidate is dropped — when csId is no open seat CS (its close supersedes the candidate) or its group holds a
   * held PIN (HLD-38: nothing of it publishes; the CS joins the PIN at its close). Every read-tree is preceded by resetScratchIndex.
   */
  async candidate(repo: GitRepo, csId: string, candSeq: number, sDisk: TreeMap, A: TreeMap, scratchIndex: string, pins: readonly HeldPin[]): Promise<Candidate | null> {
    this.lastCheck.noteCandidate(csId, candSeq, candSeq);
    this.pinView = pins;
    const c = this.css.find((x) => x.csId === csId && x.kind === 'seat' && x.state === 'open');
    const drop = (): null => {
      if (c !== undefined) c.candidates = c.candidates.filter((x) => x.candSeq !== candSeq);
      return null;
    };
    if (c === undefined) return drop();
    const g = this.groupsWith(this.members(), pins).find((x) => x.members.includes(c));
    if (g === undefined || g.pins.length > 0) return drop();
    const entries: CandidatePlan['entries'] = [];
    const pairs: ReadyPair[] = [];
    let k = 0;
    for (const m of g.members) {
      const own = [...m.paths].filter((p) => !g.pinPaths.has(p));
      const { R, Acap } = sparse(own, sDisk, A);
      const paths = [...new Set([...R.keys(), ...Acap.keys()])].sort();
      if (paths.length === 0) {
        entries.push({ c: m, kind: 'drop' });
        continue;
      }
      await this.resetScratch(scratchIndex);
      const rTree = await repo.writeTreeMap(R, scratchIndex);
      await this.resetScratch(scratchIndex);
      const aTree = await repo.writeTreeMap(Acap, scratchIndex);
      entries.push({ c: m, kind: 'replace', paths, R: rTree, A: aTree });
      pairs.push({ csId: m.csId ?? `${this.peer}/human/${this.nextN + k++}`, R: rTree, A: aTree, paths, order: 0 });
    }
    const effects = c.candidates.find((x) => x.candSeq === candSeq)?.effects ?? c.effects;
    const cand: Candidate = { csId, candSeq, groupKey: this.describe(g).key, pairs };
    this.candPlans.set(cand, { cs: c, entries, members: g.members, effects });
    return cand;
  }

  /**
   * HLD-67 steps 3–4 / HLD-39. pass → the CS's latest effect is covered (unless an effect came after its checkpoint) and the candidate's
   * pairs replace the group's ready pairs (one new order; a member's unpublished passing pair is replaced only when the candidate's
   * capture is passing — every member closed or covered — and a newer passing candidate of the CS is never replaced by an older
   * cand_seq), then lastCheck.passedFor(csId, candSeq) when the CS's own passing pair landed; returns the pairs to journal (null when
   * none changed). fail or incomplete → dropped: the only effect is the memory-only lastCheck.recordFor(csId, candSeq, …) (rev 2.5,
   * D1, X-06) — kind 'conflict' when the first entry's reason is merge_conflict, 'incomplete' for an incomplete verdict or a first entry
   * with reason no_snapshot or no_merge, else 'fail'; check (fail only), path and line from entries[0] (else check = failed[0]); more =
   * entries.length − 1 (else failed.length − 1). No record, op, event, state change or pushed message.
   */
  settleCandidate(c: Candidate, verdict: EditCheckVerdict): readonly ReadyPair[] | null {
    const plan = this.candPlans.get(c);
    if (plan === undefined) throw new TypeError(`settleCandidate: ${c.csId} #${c.candSeq} is not an unsettled candidate of this ChangeSets`);
    this.candPlans.delete(c);
    const cs = plan.cs;
    cs.candidates = cs.candidates.filter((x) => x.candSeq !== c.candSeq);
    if (verdict.verdict !== 'pass') {
      this.lastCheck.recordFor(c.csId, c.candSeq, lastCheckOf(verdict));
      return null;
    }
    if (!this.css.includes(cs) || cs.state !== 'open') return null;
    const done = this.candDone.get(c.csId);
    if (done !== undefined && done >= c.candSeq) return null;   // newest passing capture wins (glossary §27.1)
    if (cs.effects === plan.effects) cs.covered = true;
    const now = this.clock.monoMs();
    if (this.nextOrder === null) this.startTable(now);
    // Members by identity, or (a closed human CS standing for a Plan 2 pair, now in the table) by cs_id.
    const resolve = (m: Cs): Cs | null => (this.css.includes(m) ? m : (m.csId === null ? null : this.css.find((x) => x.csId === m.csId) ?? null));
    const members = plan.members.map(resolve).filter((m): m is Cs => m !== null);
    const passing = members.every((m) => m.state === 'closed' || m.covered);
    const order = this.nextOrder!;
    const made: ReadyPair[] = [];
    for (const e of plan.entries) {
      const m = resolve(e.c);
      if (m === null) continue;
      if (e.kind === 'drop') {
        if (m.csId !== null) {
          if (this.pairs.some((p) => p.csId === m.csId)) this.revertMarks.drop(m.csId);   // Task 17: it leaves journal/ready/ unpublished
          this.pairs = this.pairs.filter((p) => p.csId !== m.csId);
          this.passingOf.delete(m.csId);
          this.pairCand.delete(m.csId);
        }
        continue;
      }
      const existing = m.csId === null ? undefined : this.pairs.find((p) => p.csId === m.csId);
      if (existing !== undefined && (this.passingOf.get(existing.csId) ?? true) && !passing) continue;   // keep the older passing capture
      m.csId ??= `${this.peer}/human/${this.nextN++}`;
      readyKey(m.csId);
      const pair: ReadyPair = { csId: m.csId, R: e.R, A: e.A, paths: e.paths, order };
      this.pairs = [...this.pairs.filter((p) => p.csId !== pair.csId), pair].sort(byOrder);
      this.passingOf.set(m.csId, passing);
      this.pairCand.set(m.csId, { cs: c.csId, candSeq: c.candSeq });
      m.capSeq += 1;
      m.checks = m.lastChecks;
      made.push(pair);
    }
    if (made.length === 0) return null;
    this.nextOrder = order + 1;
    if (passing && made.some((p) => p.csId === c.csId)) {
      this.lastCheck.passedFor(c.csId, c.candSeq);
      this.candDone.set(c.csId, c.candSeq);
    }
    this.prunePassing();
    return made.map((p) => ({ ...p, paths: [...p.paths] }));
  }

  /**
   * HLD-49 path bundle: the registry growth of the held PIN `pin` when the closing CSs of its group join it instead of journaling the
   * ready `pairs` capture() returned in `bundles` (R3-44): paths = pin.paths ∪ the pairs' paths, csIds = the pairs' cs_ids (the
   * caller adds the record's), h1 = R over the pairs' paths (the newest pair wins; ABSENT for a path R lacks). Reads the pairs' R
   * trees only; the caller filters LIVE paths and commits one transition (one rev, one op). When the group no longer holds a held
   * PIN, closeDue() reports the recapture and the next materializing iteration captures the whole group, so the bundle publishes in
   * one commit (HLD-52).
   */
  async bundle(repo: GitRepo, pin: HeldPin, pairs: readonly ReadyPair[]): Promise<{ paths: string[]; csIds: string[]; h1: BlobMap }> {
    const paths = new Set<string>(pin.paths);
    const h1: BlobMap = {};
    for (const pair of [...pairs].sort(byOrder)) {
      const R = await repo.readTreeMap(pair.R);
      for (const p of pair.paths) {
        paths.add(p);
        setBlob(h1, p, R.get(p)?.oid ?? ABSENT);
      }
    }
    return { paths: [...paths].sort(), csIds: [...new Set(pairs.map((p) => p.csId))].sort(), h1 };
  }

  /**
   * HLD-67 / R3-04's T0-at-publish drop (Task 10): when a pair of the CSs `csIds` (one publication group) came from an
   * edit-checkpoint candidate of a seat CS that is still open, that capture leaves the journal — every pair of the group, each CS
   * keeping its paths (a closed one is captured again at the next snapshot, the open one at its next trigger) — the open CS's latest
   * effect is no longer covered, last_pass.ready is cleared, and the candidate is returned for the caller's last_check{kind:
   * 'stale'}; null (nothing changes) otherwise: the capture was taken at a close, a green checkpoint or cowork_checkpoint (K7).
   */
  dropCandidateCapture(csIds: readonly string[]): { csId: string; candSeq: number } | null {
    const ids = new Set(csIds);
    let from: { cs: string; candSeq: number } | null = null;
    for (const p of this.pairs) {
      const f = ids.has(p.csId) ? this.pairCand.get(p.csId) : undefined;
      if (f !== undefined && this.css.some((x) => x.csId === f.cs && x.kind === 'seat' && x.state === 'open')) {
        from = f;
        break;
      }
    }
    if (from === null) return null;
    for (const id of ids) {
      if (this.pairs.some((p) => p.csId === id)) this.revertMarks.drop(id);   // Task 17: it leaves journal/ready/ unpublished
      this.pairs = this.pairs.filter((p) => p.csId !== id);
      this.passingOf.delete(id);
      this.pairCand.delete(id);
      clearReady(this.lastCheck, id);
    }
    const open = this.css.find((x) => x.csId === from!.cs);
    if (open !== undefined) open.covered = false;
    clearReady(this.lastCheck, from.cs);
    return { csId: from.cs, candSeq: from.candSeq };
  }

  /**
   * The pairs of a landed publish (or of OUT == tree(TIP) with no ops, R-02) leave the journal; each CS's publish count rises
   * (the 1-based `seq` of its next trailer, R3-43), and a closed CS with no capture due leaves the table (fully published). The
   * passing flags stay until the next capture prunes them (table() lists passing for current pairs only), so an error-path restore
   * of the pairs never flips one; the caller that may fail takes a rollbackPoint() first (fix round 1, finding 3).
   */
  published(csIds: readonly string[]): void {
    const gone = new Set(csIds);
    this.pairs = this.pairs.filter((p) => !gone.has(p.csId));
    for (const id of gone) {
      // rev 2.5 (X-05): a published capture of an edit-checkpoint candidate sets its CS's last_pass.shared.
      const from = this.pairCand.get(id);
      if (from !== undefined) this.lastCheck.sharedFor(from.cs, from.candSeq);
      this.pairCand.delete(id);
      // Task 17 (X-09, decision D2): a published revert CS's shrink mark ends.
      this.revertMarks.drop(id);
      const c = this.css.find((x) => x.csId === id);
      if (c === undefined) continue;
      c.publishes += 1;
      if (c.state === 'closed' && !c.due) this.css = this.css.filter((x) => x !== c);
    }
  }

  /** HLD-37 trailer of a CS in this publish: seq 1-based, state closed|checkpoint, origin, checks (R3-43). A Plan 2 pair without a CS is a closed human CS. */
  trailer(csId: string, paths: number): CsTrailer {
    const c = this.css.find((x) => x.csId === csId);
    if (c === undefined) return { csId, state: 'closed', seq: 1, origin: 'human', checks: 'skipped', paths };
    return { csId, state: c.state === 'open' ? 'checkpoint' : 'closed', seq: c.publishes + 1, origin: c.origin, checks: c.checks, paths };
  }

  /** Capture order, oldest first. */
  ready(): readonly ReadyPair[] {
    return this.pairs.map((p) => ({ ...p, paths: [...p.paths] }));
  }

  /** open: the open CSs (an empty recovered CS not counted) and the closed ones still waiting for a pair, plus one for paths waiting for a recapture; ready: the journaled pairs. */
  counts(): { open: number; ready: number } {
    const open = this.css.filter((c) => this.awaitsPair(c)).length;
    return { open: open + (this.pending.size > 0 ? 1 : 0), ready: this.pairs.length };
  }

  /** Local deltas in no ready pair: the paths of the open CSs and of the closed ones waiting for a pair, and the paths waiting for a recapture. */
  openPaths(): ReadonlySet<string> {
    const out = new Set(this.pending);
    for (const c of this.css) if (this.awaitsPair(c)) for (const p of c.paths) out.add(p);
    return out;
  }

  /**
   * The CS table (R3-40): every CS with a cs_id (a human CS before its first capture has none and is not listed), the
   * seats' turn_seq, the order and passing flag of every ready pair, next_order — before the first table, the one it would start
   * with: max(max order of the journaled pairs, cs_human_next − 1) + 1, with a Plan 2 pair listed as a closed human CS.
   */
  table(): CsTable {
    const entries: CsTableEntry[] = this.css.filter((c) => c.csId !== null).map((c) => this.toEntry(c));
    for (const p of this.pairs) if (!entries.some((e) => e.cs_id === p.csId)) entries.push(this.toEntry(this.plan2Cs(p, 0)));
    entries.sort((a, b) => (a.cs_id < b.cs_id ? -1 : a.cs_id > b.cs_id ? 1 : 0));
    const seats: CsTable['seats'] = {};
    for (const seat of [...this.seats.keys()].sort()) seats[seat] = { turn_seq: this.seats.get(seat)! };
    const orders: CsTable['orders'] = {};
    const passing: CsTable['passing'] = {};
    for (const p of this.pairs) {
      orders[p.csId] = p.order;
      passing[p.csId] = this.passingOf.get(p.csId) ?? true;
    }
    return { v: 1, next_order: this.nextOrder ?? this.firstNextOrder(), seats, cs: entries, orders, passing };
  }

  /**
   * Fix round 1 (findings 1–3, R3-69): for a caller that changes memory before its state update (captureStep's capture, the push-ok
   * update's published() and rebase(), R-02's drop). The returned function, called when that update fails, puts back everything
   * capture(), published() and rebase() changed since this call — the ready pairs, passing, the pending recaptures, n and
   * next_order, each CS's cs_id, state, capture and publish counters, checks and pending candidates, the CSs a capture added and the
   * CSs a capture or a publish removed — so the failure is a full rollback: an open recovered CS keeps its kind and its HLD-36
   * clock, a non-passing pair stays non-passing, a publish is never counted twice. What signals changed meanwhile stays (an effect's
   * paths and claims, a boundary's close, a new seat CS, the seats' activity). Valid until the next state update of this ChangeSets.
   */
  rollbackPoint(): () => void {
    const copy = (p: ReadyPair): ReadyPair => ({ ...p, paths: [...p.paths] });
    const pairs = this.pairs.map(copy);
    const pending = [...this.pending];
    const passing = [...this.passingOf];
    const { nextN, nextOrder } = this;
    const css = [...this.css];
    const fields = new Map(css.map((c) => [c, {
      csId: c.csId, state: c.state, due: c.due, capSeq: c.capSeq, publishes: c.publishes, checks: c.checks, candidates: c.candidates,
      covered: c.covered, effects: c.effects, bundledInto: c.bundledInto,
    }] as const));
    // Task 10: which pairs came from candidates, and each CS's newest passing candidate (settleCandidate, dropCandidateCapture).
    const pairCand = [...this.pairCand];
    const candDone = [...this.candDone];
    // Task 17: the revert shrink marks (published() and a capture's drop end them, rebase() moves them) and the stale routing.
    const marks = this.revertMarks.pending().map((cs) => [cs, this.revertMarks.current(cs)!] as const);
    const stale = [...this.stale];
    return () => {
      for (const cs of this.revertMarks.pending()) this.revertMarks.drop(cs);
      for (const [cs, m] of marks) this.revertMarks.set(cs, m);
      this.stale.clear();
      for (const [p, e] of stale) this.stale.set(p, e);
      this.pairs = pairs.map(copy);
      this.pending.clear();
      for (const p of pending) this.pending.add(p);
      this.passingOf.clear();
      for (const [id, v] of passing) this.passingOf.set(id, v);
      this.pairCand.clear();
      for (const [id, v] of pairCand) this.pairCand.set(id, v);
      this.candDone.clear();
      for (const [id, v] of candDone) this.candDone.set(id, v);
      this.nextN = nextN;
      this.nextOrder = nextOrder;
      // A seat CS a signal opened meanwhile stays; a CS the capture added leaves; a CS it or a publish removed comes back.
      this.css = [...css, ...this.css.filter((c) => !fields.has(c) && !this.captureMade.has(c))];
      for (const [c, f] of fields) {
        c.csId = f.csId;
        c.capSeq = f.capSeq;
        c.publishes = f.publishes;
        c.checks = f.checks;
        c.bundledInto = f.bundledInto;
        if (c.kind !== 'seat') c.state = f.state;   // a capture closes only human and recovered CSs; a seat CS's state is its signals'
        c.due = c.due || f.due;                      // a boundary meanwhile keeps its close due
        if (c.candidates !== f.candidates) c.candidates = [...f.candidates, ...c.candidates];   // a capture's [] and later candidates
        if (c.effects === f.effects) c.covered = f.covered;   // a settled candidate's cover goes back; an effect meanwhile decides itself
      }
    };
  }

  /** The stored edit-checkpoint candidates of the open seat CSs, oldest first (contract addition 4; Task 10 settles them). */
  pendingCandidates(): ReadonlyArray<{ csId: string; candSeq: number; paths: readonly string[] }> {
    return this.css.flatMap((c) => (c.kind === 'seat' && c.state === 'open' ? c.candidates.map((x) => ({ csId: c.csId!, candSeq: x.candSeq, paths: [...x.paths] })) : []));
  }

  // ---- private ----------------------------------------------------------------------------------------------------------

  /** n never reuses a human-class cs_id among `ids`. */
  private floorN(nextN: number, ids: readonly string[]): number {
    return Math.max(nextN, ...ids.map((id) => (humanCsN(id) ?? 0) + 1));
  }

  private firstNextOrder(): number {
    return Math.max(0, this.nextN - 1, ...this.pairs.map((p) => p.order)) + 1;
  }

  /** A closed CS standing for a journaled pair that has no table entry (a Plan 2 pair). */
  private plan2Cs(p: ReadyPair, now: number): Cs {
    const seat = SEAT_CS.exec(p.csId)?.[1] ?? null;
    return {
      ...this.blank(seat === null ? 'human' : 'seat', seat, null, seat === null ? 'human' : 'prompt', now),
      csId: p.csId, paths: new Set(p.paths), state: 'closed', capSeq: 1,
    };
  }

  private blank(kind: CsKind, seat: string | null, agent: string | null, origin: CsTableEntry['origin'], now: number): Cs {
    return {
      csId: null, kind, seat, agent, origin, paths: new Set(), state: 'open', capSeq: 0, publishes: 0, checks: 'skipped', covered: false,
      due: false, lastChecks: 'skipped', lastChangeMono: now, done: false, rq: null, candidates: [], restored: new Set(), effects: 0, bundledInto: null,
    };
  }

  /** An open recovered CS rebuilt from the table or the cache keeps its HLD-36 close rule, its clock started now (findings 1–2). */
  private fromEntry(e: CsTableEntry, now: number): Cs {
    return {
      ...this.blank(e.kind, e.seat, e.agent, e.origin, now),
      csId: e.cs_id, paths: new Set(e.paths), state: e.state, capSeq: e.cap_seq, publishes: e.publishes, checks: e.checks, covered: e.covered,
      lastChecks: e.checks,
      ...(e.kind === 'recovered' && e.state === 'open' ? { rq: this.recoveredClock(now) } : {}),
    };
  }

  /**
   * HLD-36's close clock of a recovered CS created or rebuilt now: the seats MID_TURN or AWAITING_PERMISSION as the signals reported
   * them wait for their stop, and the 20 s quiet counts only while none is busy.
   */
  private recoveredClock(now: number): RecoveredClock {
    const waiting = new Set([...this.activity].filter(([, a]) => BUSY.has(a)).map(([s]) => s));
    return { acc: 0, since: waiting.size > 0 ? null : now, waiting, released: false };
  }

  /** Passing flags of pairs no longer journaled leave (published, withdrawn or cancelled pairs keep theirs until a capture). */
  private prunePassing(): void {
    for (const id of [...this.passingOf.keys()]) if (!this.pairs.some((p) => p.csId === id)) this.passingOf.delete(id);
  }

  private toEntry(c: Cs): CsTableEntry {
    return {
      cs_id: c.csId!, kind: c.kind, seat: c.seat, agent: c.agent, origin: c.origin, paths: sortedPaths(c.paths), state: c.state,
      cap_seq: c.capSeq, publishes: c.publishes, checks: c.checks, covered: c.covered,
    };
  }

  private hasPair(c: Cs): boolean {
    return c.csId !== null && this.pairs.some((p) => p.csId === c.csId);
  }

  /** Open (an empty recovered CS aside), or closed and still waiting for its pair. */
  private awaitsPair(c: Cs): boolean {
    if (c.state === 'open') return c.kind !== 'recovered' || c.paths.size > 0;
    return !this.hasPair(c);
  }

  private isDue(c: Cs, now: number): boolean {
    // HLD-49 (Task 10): a bundled CS waits for its PIN; once the PIN is no longer held its group is captured again.
    if (c.state === 'closed' && c.bundledInto !== null && !this.hasPair(c)) return !this.pinView.some((p) => p.id === c.bundledInto);
    if (c.state === 'closed') return c.due || !this.hasPair(c);
    if (c.kind === 'seat') return c.due;
    return c.paths.size > 0 && this.closeHolds(c, now);
  }

  /** HLD-35 / HLD-36: the close condition of an open human or recovered CS. */
  private closeHolds(c: Cs, now: number): boolean {
    if (c.done) return true;
    if (c.rq === null) return now - c.lastChangeMono >= HUMAN_CS_QUIET_MS;
    return c.rq.released || c.rq.acc + (c.rq.since === null ? 0 : now - c.rq.since) >= HUMAN_CS_QUIET_MS;
  }

  /** A change on a path of an open human or recovered CS restarts its quiet period. */
  private touch(c: Cs, now: number): void {
    c.lastChangeMono = now;
    if (c.rq !== null) {
      c.rq.acc = 0;
      c.rq.since = this.anyBusy() ? null : now;
    }
  }

  /** The CS unattributed deltas go to: the open recovered CS, else the open human CS without a pending close. */
  private recipient(): Cs | null {
    return this.css.find((c) => c.kind === 'recovered' && c.state === 'open')
      ?? this.css.find((c) => c.kind === 'human' && c.state === 'open')
      ?? null;
  }

  /** An empty recovered CS whose close condition holds has nothing to capture: it ends, and later deltas form the human CS. */
  private pruneRecovered(now: number): void {
    this.css = this.css.filter((c) => !(c.kind === 'recovered' && c.state === 'open' && c.paths.size === 0 && this.closeHolds(c, now)));
  }

  private seatOpen(seat: string, agent: string | null): Cs | null {
    return this.css.find((c) => c.kind === 'seat' && c.seat === seat && c.agent === agent && c.state === 'open') ?? null;
  }

  /** The CS a checkpoint or checks_run of the seat belongs to: its parent's open CS, else its newest open agent CS. */
  private checkpointCs(seat: string): Cs | null {
    const open = this.css.filter((c) => c.kind === 'seat' && c.seat === seat && c.state === 'open');
    return open.find((c) => c.agent === null) ?? open[open.length - 1] ?? null;
  }

  private close(c: Cs | null): void {
    if (c === null) return;
    c.state = 'closed';
    c.due = true;
    c.restored.clear();
    // rev 2.5 (X-05, glossary §29.8): a seat CS's last_check slot goes at its close; its candidates are superseded by the close.
    if (c.kind === 'seat' && c.csId !== null) {
      this.lastCheck.clearCs(c.csId);
      this.candDone.delete(c.csId);
    }
  }

  private anyBusy(): boolean {
    for (const a of this.activity.values()) if (BUSY.has(a)) return true;
    return false;
  }

  /** A seat's activity changed (stopped: a Stop, StopFailure, SessionEnd or seat end): HLD-36's recovered-CS clocks follow. */
  private setActivity(seat: string, a: SeatActivity, now: number, stopped: boolean): void {
    const wasBusy = this.anyBusy();
    this.activity.set(seat, a);
    const busy = this.anyBusy();
    for (const c of this.css) {
      const rq = c.rq;
      if (rq === null || c.state !== 'open') continue;
      if (BUSY.has(a)) rq.waiting.add(seat);
      if (stopped && rq.waiting.delete(seat) && rq.waiting.size === 0) rq.released = true;
      if (busy && !wasBusy && rq.since !== null) {
        rq.acc += now - rq.since;
        rq.since = null;
      } else if (!busy && rq.since === null) {
        rq.since = now;
      }
    }
  }

  /** Paths waiting for a recapture that the open human or recovered CS shares go with it: they are re-captured at its close. */
  private absorbPending(): void {
    const r = this.recipient();
    if (r === null || this.pending.size === 0) return;
    if (![...this.pending].some((p) => r.paths.has(p))) return;
    for (const p of this.pending) r.paths.add(p);
    this.pending.clear();
  }

  /** HLD-38's closure over `css` (open and ready CSs) and the held PINs sharing a path; groups of PINs only are dropped. */
  private groupsWith(css: readonly Cs[], pins: readonly HeldPin[]): Group[] {
    const n = css.length;
    const parent = Array.from({ length: n + pins.length }, (_, i) => i);
    const find = (i: number): number => {
      let x = i;
      while (parent[x] !== x) x = parent[x]!;
      for (let y = i; parent[y] !== x;) { const up = parent[y]!; parent[y] = x; y = up; }
      return x;
    };
    const owner = new Map<string, number>();
    const join = (i: number, paths: Iterable<string>): void => {
      for (const p of paths) {
        const j = owner.get(p);
        if (j === undefined) owner.set(p, i);
        else parent[find(i)] = find(j);
      }
    };
    css.forEach((c, i) => {
      const pair = c.csId === null ? undefined : this.pairs.find((p) => p.csId === c.csId);
      join(i, [...c.paths, ...(pair?.paths ?? [])]);
    });
    pins.forEach((pin, k) => join(n + k, pin.paths));
    const out = new Map<number, Group>();
    const at = (i: number): Group => {
      const root = find(i);
      let g = out.get(root);
      if (g === undefined) out.set(root, (g = { members: [], pins: [], pinPaths: new Set() }));
      return g;
    };
    css.forEach((c, i) => at(i).members.push(c));
    pins.forEach((pin, k) => {
      const g = at(n + k);
      g.pins.push(pin);
      for (const p of pin.paths) g.pinPaths.add(p);
    });
    for (const g of out.values()) g.pins.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return [...out.values()].filter((g) => g.members.length > 0);
  }

  /** The members of HLD-38's closure: the table's CSs plus a closed human CS standing for each journaled pair without one (a Plan 2 pair). */
  private members(): Cs[] {
    const now = this.clock.monoMs();
    return [...this.css, ...this.pairs.filter((p) => !this.css.some((c) => c.csId === p.csId)).map((p) => this.plan2Cs(p, now))];
  }

  /** cs_id → the index of its group among the CSs and pairs sharing a path (held PINs left out): HLD-41's per-group verdicts. */
  private groupIndex(): Map<string, number> {
    const out = new Map<string, number>();
    this.groupsWith(this.members(), []).forEach((g, i) => {
      for (const c of g.members) if (c.csId !== null) out.set(c.csId, i);
    });
    return out;
  }

  /** The PublicationGroup of a closure group: HLD-38's paths, the smallest cs_id as its key, the held PIN ids and the readiness. */
  private describe(g: Group): PublicationGroup {
    const csIds = [...new Set(g.members.flatMap((c) => (c.csId === null ? [] : [c.csId])))].sort();
    const paths = new Set<string>(g.pinPaths);
    for (const c of g.members) {
      for (const p of c.paths) paths.add(p);
      const pair = c.csId === null ? undefined : this.pairs.find((x) => x.csId === c.csId);
      for (const p of pair?.paths ?? []) paths.add(p);
    }
    // The open human CS before its first capture has no cs_id yet: a group of it alone is keyed by the id that capture gives it.
    const key = csIds[0] ?? `${this.peer}/human/${this.nextN}`;
    return { key, csIds, paths: [...paths].sort(), pins: g.pins.map((p) => p.id), ready: this.readyOf(g) };
  }

  /**
   * HLD-39 / R3-44 / R3-53 / R3-42: no held PIN, at least one unpublished ready pair, every pair of the group from a passing capture
   * (a Plan 2 pair counts as passing), no human or recovered CS (open, or with an unpublished pair) while blocked() is non-empty, and
   * no open seat CS that a non-terminal SHADOW names. Plan 3 Task 12a: and no closed member still waiting for its pair (a close whose
   * capture has not run yet, or an HLD-49 bundle whose PIN released in the same loop and whose recapture is due) — the group publishes
   * in one commit with every closed member's capture (HLD-52), never its older pairs alone.
   */
  private readyOf(g: Group): boolean {
    if (g.pins.length > 0) return false;
    if (g.members.some((c) => c.state === 'closed' && !this.hasPair(c))) return false;
    // Task 17 (§8 Q18): a revert CS whose written path no tick has shown yet (its capture would publish the pre-write entry) — and
    // (Task EF) one a tick routed that write to, until its re-capture consumes the due (its pair is still the pre-write one).
    if (this.stale.size > 0 && [...this.stale.values()].some((e) => e.gate && g.members.includes(e.c))) return false;
    if (g.members.some((c) => c.state === 'closed' && c.due && this.regated.has(c))) return false;
    const pairs = this.pairs.filter((p) => g.members.some((c) => c.csId === p.csId));
    if (pairs.length === 0) return false;
    if (!pairs.every((p) => this.passingOf.get(p.csId) ?? true)) return false;
    const gated = this.blockSet.size > 0 || this.latched();
    if (gated && g.members.some((c) => c.kind !== 'seat' && (c.state === 'open' ? c.paths.size > 0 : this.hasPair(c)))) return false;
    if (this.shadowSet.size > 0 && g.members.some((c) => c.kind === 'seat' && c.state === 'open' && c.csId !== null && this.shadowSet.has(c.csId))) return false;
    return true;
  }

  /** R3-40 at a candidate's settlement before any table exists: every journaled pair becomes a closed human CS and next_order starts. */
  private startTable(now: number): void {
    const staged = this.pairs.filter((p) => !this.css.some((c) => c.csId === p.csId)).map((p) => this.plan2Cs(p, now));
    this.nextOrder = this.firstNextOrder();
    this.css.push(...staged);
    for (const c of staged) this.captureMade.add(c);
  }
}

/** HLD-67 step 4's last_check of a failing or incomplete verdict (rev 2.5, X-06; 10-product §3.5.1). */
function lastCheckOf(v: Exclude<EditCheckVerdict, { verdict: 'pass' }>): Omit<LastCheck, 'edit_n'> {
  const entries = v.entries ?? [];
  const first = entries[0];
  const more = entries.length > 0 ? entries.length - 1 : v.verdict === 'fail' ? Math.max(0, v.failed.length - 1) : 0;
  const where = first === undefined ? {} : { path: first.path, ...(first.line !== undefined ? { line: first.line } : {}) };
  if (first?.reason === 'merge_conflict') return { kind: 'conflict', ...where, more };
  if (v.verdict === 'incomplete' || first?.reason === 'no_snapshot' || first?.reason === 'no_merge') return { kind: 'incomplete', ...where, more };
  const check = first?.check ?? v.failed[0];
  return { kind: 'fail', ...(check !== undefined ? { check } : {}), ...where, more };
}

/**
 * Non-terminal ON_DISK PIN records with a non-empty guard set (glossary §3 "held PIN", wake-scope included), guards by full name; in
 * ULID order. Replaces Plan 2's pinnedPaths and PIN_GUARDS in publish.ts (compose, allowedPending, pendingCheap) and is what
 * captureStep passes as `pins` (Task 10).
 */
export function heldPins(reg: Pick<HoldRegistry, 'nonTerminal'>): HeldPin[] {
  return reg.nonTerminal()
    .filter((r) => r.kind === 'PIN' && r.residence === 'ON_DISK' && !isTerminal(r) && r.guards.length > 0)
    .map((r) => ({ id: r.id, paths: [...r.paths], guards: r.guards.map((g) => g.name) }));
}

/**
 * R3-42: the cs_ids named by a non-terminal SHADOW (a K1 PATCH held OFF_DISK under a `claim` guard, HLD-47): their open seat CSs'
 * captures are not ready (ChangeSets.shadowed).
 */
export function shadowCsIds(reg: Pick<HoldRegistry, 'nonTerminal'>): Set<string> {
  const out = new Set<string>();
  for (const r of reg.nonTerminal()) {
    if (r.kind !== 'PATCH' || r.residence !== 'OFF_DISK' || isTerminal(r) || !r.guards.some((g) => guardName(g) === 'claim')) continue;
    for (const id of r.cs_ids) out.add(id);
  }
  return out;
}

/**
 * Record constructors for later plans' creators (unit-tested in Plan 3; R3-07). pinCs: the whole-CS PIN of K2/K3/K6/K7, HLD-42's
 * dependency PIN and the wake-scope PIN (HLD-45…HLD-47, HLD-50, HLD-66) over the LIVE paths it is given (HLD-03; the caller filters
 * them): H0 = A (ABSENT where A lacks the path), H1 = the given map on those paths (ABSENT where it names none), ON_DISK ACTIVE.
 */
export function pinCs(guard: string, csIds: readonly string[], livePaths: readonly string[], A: TreeMap, h1: BlobMap, origin: string, offer: Offer): NewRecord {
  const paths = [...new Set(livePaths)].sort();
  const h0: BlobMap = {};
  const held: BlobMap = {};
  for (const p of paths) {
    setBlob(h0, p, A.get(p)?.oid ?? ABSENT);
    setBlob(held, p, Object.hasOwn(h1, p) ? h1[p]! : ABSENT);
  }
  return {
    kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths, blobs: { h0, h1: held }, guard, origin,
    cs_ids: [...new Set(csIds)].sort(), displaced_by: null, offer,
  };
}

/** The K1 SHADOW (HLD-47): a PATCH born OFF_DISK PARKED under `claimGuard` (`claim:<claim_id>`), offer pending_leftover, keyed by its path. */
export function shadowRecord(claimGuard: string, path: string, h0: OidOrAbsent, h1: OidOrAbsent, origin: string): NewRecord {
  const b0: BlobMap = {};
  const b1: BlobMap = {};
  setBlob(b0, path, h0);
  setBlob(b1, path, h1);
  return {
    kind: 'PATCH', residence: 'OFF_DISK', state: 'PARKED', paths: [path], blobs: { h0: b0, h1: b1 }, guard: claimGuard, origin,
    cs_ids: [], displaced_by: null, offer: 'pending_leftover',
  };
}

/** The sparse R and A_cap entries of `paths` (HLD-40); a path absent from both is `vanished` (a sparse tree cannot say absent). */
function sparse(paths: Iterable<string>, sDisk: TreeMap, A: TreeMap): { R: Map<string, TreeEntry>; Acap: Map<string, TreeEntry>; vanished: Set<string> } {
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
  return { R, Acap, vanished };
}
