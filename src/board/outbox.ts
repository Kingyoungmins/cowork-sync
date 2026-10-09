// The outbox: this peer's pending board ops (02-protocol §2 "outbox", §3.2 step 2, §3.8; PRO-06, PRO-08,
// PRO-09, PRO-11, PRO-45), persisted as meta.outbox (ruling R-14).
//
// Order. Entries are kept as the allocated ones in increasing seq, then the unallocated ones in the order
// they were added. Seqs come from one monotonic counter (meta.seq_next), so a newly allocated seq is above
// every seq already held and appending keeps the order; take() therefore returns ops in strictly increasing
// seq, the ops.jsonl order (PRO-03).
//
// Ids. An op gets its seq when it is first placed into a publish intent (take) and keeps that id across
// rebuilds until it lands (landed) or is dropped; it is renumbered only by PRO-09's two rules (landed,
// renumberAtOrBelow). The cid of a non-conflict event kind is always H(own op id, kind) (PRO-11), set at
// allocation and recomputed at every renumbering; a conflict kind's cid is H(winner, loser), the caller's.
//
// Every op is the parseOpLine() normalization of its draft plus id, so what take() returns is exactly what
// a fold reads back, and serializeOps() accepts it. A draft that cannot form a valid op line is refused at
// add() (TypeError) instead of stalling the outbox later.
import { canonicalJson, type Json } from './canonicalJson.js';
import { formatOpId, parseOpId, type EpochId, type PeerId } from './ids.js';
import { eventCid, OPS_MAX_BYTES, OPS_MAX_LINES, parseOpLine, type EventKind, type Op, type OpDraft } from './ops.js';

/**
 * What may be pushed (02-protocol §3.8 table). The engine passes one value per active condition (several
 * may hold at once, ruling P2-PUSHSTATES; see allowedInAll):
 * 'ok' = ok / degraded; 'frozen' = FREEZE without INCIDENT or CONFIG(url|public); 'incident' = FREEZE with
 * INCIDENT; 'config_net' = FREEZE with CONFIG(url|public); 'offline' = OFFLINE/AUTH; 'nonretryable';
 * 'version_proto' = VERSION, proto form; 'version_board_only' = VERSION, regionSpec form or checkpoint_mismatch.
 */
export type PushState = 'ok' | 'frozen' | 'incident' | 'config_net' | 'offline' | 'nonretryable' | 'version_proto' | 'version_board_only';
/** Backed by meta.seq_next; the high-water mark is persisted before any push that uses it (PRO-08). */
export interface SeqAllocator { next(): number; }
/** op is set once a seq is allocated (ids kept across rebuilds). */
export interface PendingOp { draft: OpDraft; op: Op | null; }

type Self = { peer: PeerId; epoch: EpochId };
type Room = { maxOps: number; maxBytes: number };

/** Event kinds whose cid is H(own op id, kind) (02-protocol §3.2 item 4); the others are conflict kinds. */
const OWN_ID_CID_KINDS: ReadonlySet<string> = new Set<EventKind>(['freeze', 'unfreeze', 'incident', 'nonretryable', 'health']);
/** The FREEZE row: freeze-class and health events, answer-class, release-class, hold mirrors (glossary §8). */
const FROZEN_TYPES: ReadonlySet<string> = new Set(['answer', 'request_status', 'release', 'seat_end', 'leave', 'hold']);
const FROZEN_EVENT_KINDS: ReadonlySet<string> = new Set(['freeze', 'unfreeze', 'health']);
/** The VERSION regionSpec row (glossary §8): no events at all, answers only with these verbs. */
const VERSION_TYPES: ReadonlySet<string> = new Set(['join', 'leave', 'seat_end', 'release', 'request_status', 'hold']);
const VERSION_ANSWER_VERBS: ReadonlySet<string> = new Set(['decline', 'later', 'release']);

const field = (d: OpDraft, k: string): unknown => (d as Record<string, unknown>)[k];

/**
 * The 02-protocol §3.8 table for one state (PRO-45). Where rows overlap the most restrictive wins; the
 * PushState values already name the overlaps that the table resolves (FREEZE with INCIDENT is 'incident',
 * FREEZE with CONFIG(url|public) is 'config_net', both allowing nothing). The FREEZE and VERSION regionSpec
 * rows are incomparable (FREEZE admits freeze/unfreeze/health events and every answer verb, VERSION admits
 * join), so when both hold only what both rows allow may leave: allowedInAll, which take and
 * pendingAllowed use.
 */
export function allowedInState(d: OpDraft, state: PushState): boolean {
  const type = field(d, 'type');
  switch (state) {
    case 'ok':
      return true;
    case 'frozen':
      if (type === 'event') return FROZEN_EVENT_KINDS.has(String(field(d, 'kind')));
      return FROZEN_TYPES.has(String(type));
    case 'version_board_only':
      if (type === 'answer') return VERSION_ANSWER_VERBS.has(String(field(d, 'verb')));
      return VERSION_TYPES.has(String(type));
    case 'incident':
    case 'config_net':
    case 'offline':
    case 'nonretryable':
    case 'version_proto':
      return false;
    default:
      throw new RangeError(`allowedInState: unknown push state ${JSON.stringify(state)}`);
  }
}

const PUSH_STATES: ReadonlySet<string> = new Set<PushState>(['ok', 'frozen', 'incident', 'config_net', 'offline', 'nonretryable', 'version_proto', 'version_board_only']);

/**
 * Every active state at once (ruling P2-PUSHSTATES): an op may leave only if each active row allows it, so
 * FREEZE together with the VERSION regionSpec pause (an EPOCH freeze plus checkpoint_mismatch) admits only
 * the intersection of the two rows. `[]` (no restricting condition) is the ok row. Every state is checked
 * before any is evaluated, so an unknown one is refused wherever it stands (RangeError).
 */
export function allowedInAll(d: OpDraft, states: readonly PushState[]): boolean {
  checkStates(states);
  return states.every((s) => allowedInState(d, s));
}

/** TypeError for a non-array, RangeError for an unknown state (before any state is evaluated). */
function checkStates(states: readonly PushState[]): void {
  if (!Array.isArray(states)) throw new TypeError('outbox: states must be an array of push states');
  for (const s of states) {
    if (!PUSH_STATES.has(s)) throw new RangeError(`outbox: unknown push state ${JSON.stringify(s)}`);
  }
}

/** The op for `draft` under `id`: own-id cid filled, normalized by parseOpLine; TypeError when it is not a valid op. */
function materialize(draft: OpDraft, id: string): Op {
  if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) throw new TypeError('outbox: a draft must be an object');
  const o: Record<string, unknown> = { ...(draft as Record<string, unknown>), id };
  if (o['type'] === 'event' && OWN_ID_CID_KINDS.has(String(o['kind']))) o['cid'] = eventCid(id, o['kind'] as EventKind);
  let op: Op | null = null;
  try {
    op = parseOpLine(canonicalJson(o as Json));
  } catch {
    op = null;
  }
  if (op === null) throw new TypeError(`outbox: a ${String(o['type'])} draft does not form a valid op line`);
  return op;
}

/** ops.jsonl bytes of one op: its canonical line plus LF (as serializeOps counts them). */
const lineBytes = (op: Op): number => Buffer.byteLength(canonicalJson(op as unknown as Json), 'utf8') + 1;

/** The widest id a (peer, epoch) can have: its seq has 16 digits. Sizing a draft under it bounds its real line. */
const widestId = (self: Self): string => formatOpId({ peer: self.peer, epoch: self.epoch, seq: Number.MAX_SAFE_INTEGER });
const PROBE_SELF: Self = { peer: '0'.repeat(32), epoch: '0'.repeat(32) };

function seqOf(op: Op): number {
  const id = parseOpId(op.id);
  if (id === null) throw new TypeError(`outbox: op id ${JSON.stringify(op.id)} is not an op id`);
  return id.seq;
}

/** An entry is under `self` when its op id carries self's (peer, epoch). */
function isOwn(op: Op, self: Self): boolean {
  const id = parseOpId(op.id);
  return id !== null && id.peer === self.peer && id.epoch === self.epoch;
}

function capOf(v: number, cap: number): number {
  if (typeof v !== 'number' || Number.isNaN(v)) throw new RangeError(`outbox: room must be a number, got ${String(v)}`);
  return Math.max(0, Math.min(v, cap));
}

export class Outbox {
  /** Allocated entries (op !== null) by increasing seq, then unallocated ones in insertion order. */
  private entries: PendingOp[];

  /** Takes the entries as persisted (or built by a caller); each is validated like fromJson validates. */
  constructor(entries?: readonly PendingOp[]) {
    this.entries = normalize((entries ?? []).map(checkEntry));
  }

  /** Queues a draft; it gets its seq on first placement. TypeError when it cannot form a valid op line. */
  add(draft: OpDraft): void {
    materialize(draft, widestId(PROBE_SELF));
    this.entries.push({ draft: copyOf(draft), op: null });
  }

  /**
   * Allowed ops (PRO-45) in seq order within the caps; allocates seqs on first placement (event drafts get
   * cid = eventCid(id, kind)). The room is clamped to the ops.jsonl caps (1,000 ops, 64 KiB, PRO-03); the
   * first allowed op that does not fit ends the take, so later ops never jump ahead (oldest seq first,
   * PRO-06), and an op left out is not allocated a seq. `states` are every active push state; an op leaves
   * only if each allows it (allowedInAll; `[]` is ok). Ops not allowed stay, unallocated ones without a
   * seq. An op allocated under another (peer, epoch) can never fold valid for this writer (PRO-16); it is
   * placed again as a fresh draft.
   */
  take(states: readonly PushState[], self: Self, alloc: SeqAllocator, room: Room): Op[] {
    checkStates(states); // a malformed state list is refused before anything changes
    const maxOps = capOf(room.maxOps, OPS_MAX_LINES);
    const maxBytes = capOf(room.maxBytes, OPS_MAX_BYTES);
    if (this.entries.some((e) => e.op !== null && !isOwn(e.op, self))) {
      this.entries = normalize(this.entries.map((e) => (e.op !== null && !isOwn(e.op, self) ? { draft: e.draft, op: null } : e)));
    }
    const widest = widestId(self);
    let floor = this.maxOwnSeq(self);
    const out: Op[] = [];
    let bytes = 0;
    try {
      for (const e of this.entries) {
        if (!allowedInAll(e.draft, states)) continue;
        if (out.length >= maxOps) break;
        const size = e.op !== null ? lineBytes(e.op) : lineBytes(materialize(e.draft, widest));
        if (bytes + size > maxBytes) break;
        if (e.op === null) {
          e.op = mint(e.draft, alloc, self, floor);
          floor = seqOf(e.op);
        }
        bytes += lineBytes(e.op);
        out.push(e.op);
      }
    } finally {
      this.entries = normalize(this.entries); // newly allocated entries join the allocated segment
    }
    return out;
  }

  /**
   * After an own intent with writer seq w landed: drop its ops; renumber every op with seq < w that was not
   * in it (order kept; cids recomputed) — the fold's last_seq of this epoch is now ≥ w, so those ids would
   * fold as no-ops (PRO-09).
   */
  landed(intentOpIds: ReadonlySet<string>, writerSeq: number, alloc: SeqAllocator, self: Self): void {
    const floor = Math.max(this.maxOwnSeq(self), writerSeq);
    this.entries = this.entries.filter((e) => e.op === null || !intentOpIds.has(e.op.id));
    this.renumber((op) => seqOf(op) < writerSeq, alloc, self, floor);
  }

  /** PRO-09's second rule: at intent build, every op whose seq is ≤ the folded last_seq of its own epoch gets a new seq (order kept). */
  renumberAtOrBelow(lastSeq: number, alloc: SeqAllocator, self: Self): void {
    this.renumber((op) => seqOf(op) <= lastSeq, alloc, self, Math.max(this.maxOwnSeq(self), lastSeq));
  }

  /** Removes every entry whose draft matches (e.g. an unpublished HOST_THROTTLED event once the mode is normal, PRO-55); returns the count. */
  drop(pred: (d: OpDraft) => boolean): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !pred(e.draft));
    return before - this.entries.length;
  }

  /** Some queued op may leave while every state in `states` holds (PRO-42's "allowed outbox ops"; `[]` is ok). */
  pendingAllowed(states: readonly PushState[]): boolean {
    checkStates(states); // a malformed state list throws even on an empty outbox
    return this.entries.some((e) => allowedInAll(e.draft, states));
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * Copies of every entry's draft, in outbox order (allocated ones first, by seq). A new Outbox of these drafts with no
   * op is the same queue with every seq released: a re-anchor rebuilds the outbox under its new epoch this way (PRO-25).
   */
  drafts(): OpDraft[] {
    return this.entries.map((e) => copyOf(e.draft));
  }

  /** meta.outbox: `{ entries: [{ draft, op }] }` in outbox order (ruling R-14). */
  toJson(): Json {
    return { entries: this.entries.map((e) => ({ draft: e.draft as unknown as Json, op: e.op as unknown as Json })) };
  }

  /** The inverse of toJson. Anything malformed throws TypeError: a dropped entry would be a lost op. */
  static fromJson(j: Json): Outbox {
    if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new TypeError('outbox: meta.outbox must be an object');
    const list = j['entries'];
    if (!Array.isArray(list)) throw new TypeError('outbox: meta.outbox.entries must be an array');
    return new Outbox(
      list.map((x) => {
        if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new TypeError('outbox: an entry must be an object');
        return { draft: x['draft'] as unknown as OpDraft, op: (x['op'] ?? null) as unknown as Op | null };
      }),
    );
  }

  /**
   * The highest seq this outbox holds under self's (peer, epoch); 0 when none. The publish's seq allocator starts above
   * it as well as above meta.seq_next, so an allocation the state never persisted can never make a writer seq ≤ an op
   * seq (PRO-09; Task 14 round 1).
   */
  maxOwnSeq(self: Self): number {
    return this.entries.reduce((m, e) => (e.op !== null && isOwn(e.op, self) ? Math.max(m, seqOf(e.op)) : m), 0);
  }

  /**
   * New seqs, in their current order, for the allocated ops matching `pred`; they move after the other
   * allocated ones. Every new seq must rise above `floor` (the landed writer seq or the folded last_seq, and
   * every seq held): a lower one would fold as a no-op again or reuse an id.
   */
  private renumber(pred: (op: Op) => boolean, alloc: SeqAllocator, self: Self, floor: number): void {
    const moving = this.entries.filter((e) => e.op !== null && pred(e.op));
    if (moving.length === 0) return;
    const movingSet = new Set(moving);
    const allocated = this.entries.filter((e) => e.op !== null && !movingSet.has(e));
    const rest = this.entries.filter((e) => e.op === null);
    let f = floor;
    const renumbered = moving.map((e) => {
      const op = mint(e.draft, alloc, self, f);
      f = seqOf(op);
      return { draft: e.draft, op };
    });
    this.entries = [...allocated, ...renumbered, ...rest];
  }
}

/** A fresh seq for `draft` from the counter; one that does not rise above `floor` would reuse or reorder ids (PRO-08). */
function mint(draft: OpDraft, alloc: SeqAllocator, self: Self, floor: number): Op {
  const seq = alloc.next();
  if (!Number.isSafeInteger(seq) || seq <= floor) throw new RangeError(`outbox: allocated seq ${String(seq)} does not rise above ${floor}`);
  return materialize(draft, formatOpId({ peer: self.peer, epoch: self.epoch, seq }));
}

/** A detached copy, so a caller mutating its draft later cannot change a queued op. */
const copyOf = (d: OpDraft): OpDraft => JSON.parse(canonicalJson(d as unknown as Json)) as OpDraft;

/** Validates one entry: the draft forms a valid op, and an allocated op is exactly that draft under its id. */
function checkEntry(e: PendingOp): PendingOp {
  if (typeof e !== 'object' || e === null) throw new TypeError('outbox: an entry must be an object');
  const { op } = e;
  materialize(e.draft, widestId(PROBE_SELF));
  const draft = copyOf(e.draft);
  if (op === null) return { draft, op: null };
  if (typeof op !== 'object' || Array.isArray(op) || typeof op.id !== 'string' || parseOpId(op.id) === null) {
    throw new TypeError('outbox: an allocated entry needs an op with an op id');
  }
  const expected = materialize(draft, op.id);
  if (canonicalJson(expected as unknown as Json) !== canonicalJson(op as unknown as Json)) {
    throw new TypeError(`outbox: op ${op.id} does not match its draft`);
  }
  return { draft, op: expected };
}

/** Allocated entries by increasing seq (an id held twice is corrupt), then the unallocated ones in order. */
function normalize(entries: PendingOp[]): PendingOp[] {
  const allocated = entries.filter((e) => e.op !== null);
  const ids = new Set(allocated.map((e) => (e.op as Op).id));
  if (ids.size !== allocated.length) throw new TypeError('outbox: one op id is held by two entries');
  allocated.sort((a, b) => seqOf(a.op as Op) - seqOf(b.op as Op));
  return [...allocated, ...entries.filter((e) => e.op === null)];
}
