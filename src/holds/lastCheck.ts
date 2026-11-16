// The latest unpassed edit-check result per open seat CS, `last_check`, and its `last_pass` (Plan 3 Task 10, rev 2.5; glossary
// §29.8, owner decision D1; 05-holds §2 `last_check`, HLD-67 step 4; 10-product §3.5.1; reconciliation X-05, X-06).
//
// Daemon memory only: one slot per open seat CS, written by HLD-67 step 4 (ChangeSets.settleCandidate: fail, conflict,
// incomplete), by the T0 slot's drop of an open CS's edit-checkpoint capture at publish (stale) and by Plan 5's 06-claude
// §3.8.4 skip conditions 3–6 (skipped, through recordFor); cleared when the CS closes (clearCs, called inside ChangeSets) or
// when a passing capture with a higher edit_n lands in the journal (passedFor). It is never written to the state ref, the hold
// registry, the cs/<enc(b)>.json cache, status.json, the board, a carrier or any file, and it is lost at daemon restart:
// nothing here imports a port, and the slots live in a module-private WeakMap, so the store serializes to "{}".
//
// edit_n is the 1-based ordinal of the edit-checkpoint trigger within its CS (06-claude §3.8.4): Plan 5's EditCheckpoints notes
// it per cand_seq first (noteCandidate); Plan 3 has no edit-checkpoint counter, so ChangeSets.candidate notes edit_n = cand_seq
// when nothing was noted, and the first note of a (CS, cand_seq) wins.

export type LastCheckKind = 'fail' | 'conflict' | 'incomplete' | 'stale' | 'skipped';
/** 06-claude §3.8.4 skips 3–6 (written by Plan 5's editCheckpoints.ts through recordFor). */
export type SkipReason = 'shrink' | 'slow_read' | 'base_moved' | 'batch';
export interface LastCheck { edit_n: number; kind: LastCheckKind; check?: 1 | 2 | 3 | 4; path?: string; line?: number; skip?: SkipReason; more: number; }

/** One open seat CS's slot: its last_check, its last_pass and the edit_n noted per cand_seq. */
interface Slot { last: LastCheck | null; ready: number | null; shared: number | null; notes: Map<number, number>; }

/** The slots of each store, outside the instance (no own field, nothing to serialize). */
const SLOTS = new WeakMap<LastCheckStore, Map<string, Slot>>();

function slotsOf(store: LastCheckStore): Map<string, Slot> {
  let m = SLOTS.get(store);
  if (m === undefined) {
    m = new Map();
    SLOTS.set(store, m);
  }
  return m;
}

function slotOf(store: LastCheckStore, csId: string): Slot {
  const m = slotsOf(store);
  let s = m.get(csId);
  if (s === undefined) {
    s = { last: null, ready: null, shared: null, notes: new Map() };
    m.set(csId, s);
  }
  return s;
}

const isEditN = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;

export class LastCheckStore {
  /** Keeps the first failed check of the newest edit_n; an older edit_n is ignored (10-product §3.5.1). */
  record(csId: string, e: LastCheck): void {
    if (!isEditN(e.edit_n)) throw new RangeError(`LastCheckStore.record: edit_n must be a safe integer >= 1, got ${String(e.edit_n)}`);
    const s = slotOf(this, csId);
    if (s.last !== null && e.edit_n <= s.last.edit_n) return;
    s.last = { ...e };
  }

  /** The CS's last_check, a copy; null when none is kept. */
  get(csId: string): LastCheck | null {
    const last = slotsOf(this).get(csId)?.last ?? null;
    return last === null ? null : { ...last };
  }

  /** last_pass: the edit_n of the CS's passing ready pair (`ready`, following the journal) and of its newest shared capture. */
  pass(csId: string): { ready: number | null; shared: number | null } {
    const s = slotsOf(this).get(csId);
    return { ready: s?.ready ?? null, shared: s?.shared ?? null };
  }

  /** The CS closed: its slot goes, notes included (called inside ChangeSets). */
  clearCs(csId: string): void {
    slotsOf(this).delete(csId);
  }

  /** The edit_n of a cand_seq; the first note of a (CS, cand_seq) wins (Plan 5's note precedes ChangeSets.candidate's). */
  noteCandidate(csId: string, candSeq: number, editN: number): void {
    if (!isEditN(editN)) throw new RangeError(`LastCheckStore.noteCandidate: edit_n must be a safe integer >= 1, got ${String(editN)}`);
    const s = slotOf(this, csId);
    if (!s.notes.has(candSeq)) s.notes.set(candSeq, editN);
  }

  /** record() with the edit_n noted for candSeq; an unknown candSeq records nothing. */
  recordFor(csId: string, candSeq: number, e: Omit<LastCheck, 'edit_n'>): void {
    const n = slotsOf(this).get(csId)?.notes.get(candSeq);
    if (n === undefined) return;
    this.record(csId, { ...e, edit_n: n });
  }

  /** A passing capture of candSeq landed in the journal: last_pass.ready := its edit_n; last_check is cleared when its edit_n is lower. */
  passedFor(csId: string, candSeq: number): void {
    const s = slotsOf(this).get(csId);
    const n = s?.notes.get(candSeq);
    if (s === undefined || n === undefined) return;
    s.ready = n;
    if (s.last !== null && s.last.edit_n < n) s.last = null;
  }

  /** candSeq's capture was published: last_pass.shared := its edit_n. */
  sharedFor(csId: string, candSeq: number): void {
    const s = slotsOf(this).get(csId);
    const n = s?.notes.get(candSeq);
    if (s === undefined || n === undefined) return;
    s.shared = n;
  }
}

/**
 * `last_pass.ready` follows the journal (10-product §3.5.1): an HLD-41 withdrawal of the CS's passing capture, or the T0 slot's drop
 * of it, clears it. A non-member helper (X-05 keeps the store at its eight members), used inside src/holds and by the T0 slot.
 */
export function clearReady(store: LastCheckStore, csId: string): void {
  const s = slotsOf(store).get(csId);
  if (s !== undefined) s.ready = null;
}

/** Every slot goes: the daemon (re)attached its state, so the run that kept them is over (glossary §29.8 "lost at daemon restart"). */
export function forgetAll(store: LastCheckStore): void {
  slotsOf(store).clear();
}
