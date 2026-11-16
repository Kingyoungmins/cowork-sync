// Test helper (Plan 2 Task 6): a seeded generator of long board op streams, their fold from genesis, and
// a git fast-import writer that turns one stream into a real board chain in a single git process (a
// 600-commit board built through buildBoardCommit would cost ~2,400 git calls).
//
// Plan 3 Task 3: with `holds: true` the generator also emits `hold` ops (valid chains, stale prev_rev, races, non-owner
// writes, terminal → terminal ops, revival attempts, local_only stub and held/ subtree violations, malformed lines) and
// tracks which held/<id>/ subtrees each commit's tree carries (GenCommit.heldIds), which importBoard writes. Hold
// decisions draw from their own seeded stream, so a board generated without them is the Plan 2 board, byte for byte.
import type { BoardDraft, WriterId } from '../../src/board/boardCommit.js';
import { BOARD_SUBJECT, boardTrailers, CODE_SUBJECT } from '../../src/board/boardCommit.js';
import { canonicalJson, type Json } from '../../src/board/canonicalJson.js';
import { foldCommit, initialFoldState, serializeFold, CHECKPOINT_EVERY, type FoldState } from '../../src/board/fold.js';
import { H, newEpoch, newPeerId } from '../../src/board/ids.js';
import { eventCid, type EventKind } from '../../src/board/ops.js';
import { genesisProtocol, serializeProtocol, type ProtocolJson } from '../../src/board/protocol.js';
import { parseOid, type Oid } from '../../src/git/oid.js';
import type { GitRepo } from '../../src/git/repo.js';
import { formatMessage, type Trailer } from '../../src/git/trailers.js';
import { randomHex, randomInt, seededRandom, type Random } from '../../src/ports/random.js';

/** heldIds: the held/<id>/ subtrees this commit's tree carries (absent: none, the Plan 2 boards). */
export interface GenCommit { writer: WriterId | null; lines: string[]; heldIds?: string[]; }
/**
 * b0SeatKey: the seat key B0 starts and ends at height 0 (compaction drops it at 512). b0HoldId (holds only): the hold B0
 * creates and ends at height 0, so compaction at 512 drops it too (its held/ subtree is removed by the commit at 512).
 */
export interface GenBoard { protocol: ProtocolJson; peers: string[]; commits: GenCommit[]; b0SeatKey: string; b0HoldId?: string; }
/** holds: also emit `hold` ops (Plan 3); peers: how many peers (default 4; peer index 3 is silent for heights 100–449). */
export interface GenOptions { holds?: boolean; peers?: number; }

const KINDS: readonly EventKind[] = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'breach', 'freeze', 'unfreeze', 'incident', 'nonretryable', 'health'];
const CONFLICT: ReadonlySet<EventKind> = new Set(['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'breach']);
const CID_POOL: readonly string[] = Array.from({ length: 6 }, (_, i) => H(`pool-${i}`, 'cid'));
/** The seat B0 starts and ends: in no peer's seat pool, so nothing restarts it and compaction at 512 must drop it. */
const B0_SEAT = 'b0'.repeat(16);
const L = (o: Record<string, Json>): string => canonicalJson(o);

interface SimPeer { id: string; epoch: string; seq: number; status: 'none' | 'active' | 'left'; seats: string[]; regionSpec: string; }

function join(p: SimPeer, seq: number, display: string): string {
  return L({
    id: `${p.id}/${p.epoch}/${seq}`, type: 'join', display, plugin_version: '0.2.0', plugin_sha: 'f'.repeat(64), proto: 1, regionSpec: p.regionSpec,
    config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '2.47.1' }, coauthor_optin: false,
  });
}

/** One random op of an active peer (some of them invalid against the fold, which decides). */
function randomOp(r: Random, p: SimPeer, seq: number): string {
  const id = `${p.id}/${p.epoch}/${seq}`;
  const pick = randomInt(r, 100);
  if (pick < 34) {
    const kind = KINDS[randomInt(r, KINDS.length)]!;
    const cid = CONFLICT.has(kind) ? CID_POOL[randomInt(r, CID_POOL.length)]! : eventCid(id, kind);
    const reason = kind === 'health' && randomInt(r, 3) === 0 ? 'HOST_THROTTLED' : 'TEST_REASON';
    return L({ id, type: 'event', cid, kind, refs: randomInt(r, 2) === 0 ? [] : ['src/a.ts'], reason_code: reason });
  }
  if (pick < 52) return L({ id, type: 'seat_start', seat_id: p.seats[randomInt(r, p.seats.length)]!, permission_mode: randomInt(r, 2) === 0 ? 'default' : 'acceptEdits' });
  if (pick < 68) return L({ id, type: 'seat_end', seat_id: p.seats[randomInt(r, p.seats.length)]!, permission_mode: 'default' });
  if (pick < 72) return L({ id, type: 'caps', custom_refs: true, lease: randomInt(r, 2) === 0, delete: true, push_options: false, two_parent_ok: true });
  if (pick < 75) return L({ id, type: 'save', save_commit: randomHex(r, 20), saved_live: randomHex(r, 20), chain_base: randomHex(r, 20), released_claim_ids: [] });
  if (pick < 80) {
    p.regionSpec = randomInt(r, 2) === 0 ? 'rs-1' : 'rs-2';
    return join(p, seq, 'Again');
  }
  if (pick < 86) return L({ id, type: 'note', target: null, text: 'hi' });
  if (pick < 90) return L({ id, type: 'claim', path: 'src/a.ts', claim_id: 'abcdefghijklmnop' });
  if (pick < 95) return '{"truncated":';
  return L({ id: `${p.id}/${p.epoch}/${Math.max(1, seq - 3)}`, type: 'leave' });   // a stale seq: a generic no-op
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TERMINAL_STATES = ['SUBSUMED', 'GONE', 'RESOLVED_PUBLISH', 'RESOLVED_DISCARD'] as const;
const LIVE_STATES = ['ACTIVE', 'CONFLICTED', 'PARKED'] as const;
const OFFERS = ['none', 'pending_leftover', 'offered', 'accepted', 'returned'] as const;
const PATH_POOL = ['README.md', 'docs/guide.md', 'src/a.ts', 'src/b.ts', 'src/deep/c.ts', 'test/a.test.ts'] as const;
const REVERT = { name: 'revert', class: 'DECISION', owner: 'HLD' };
const HOST_REJECT = { name: 'host-reject', class: 'DECISION', owner: 'ENG' };

/** A record as the generator intends the fold to hold it (only ops meant to be valid change it). */
interface GenHold { id: string; owner: string; rev: number; terminal: boolean; localOnly: boolean; pathless: boolean; paths: string[]; }

/**
 * The hold half of a generated board: one op line per call, each either meant to fold valid (and then applied to the
 * model) or a deliberate no-op of one PRO-21/PRO-24 kind. `held` is the set of held/<id>/ subtrees the next commit's
 * tree carries (puts are carried until removed, as buildBoardCommit carries them).
 */
class HoldGen {
  readonly holds: GenHold[] = [];
  readonly held = new Set<string>();
  constructor(private readonly r: Random) {}

  newId(): string {
    let s = String(randomInt(this.r, 8));
    for (let i = 0; i < 25; i++) s += CROCKFORD[randomInt(this.r, 32)];
    return s;
  }

  private line(opId: string, h: GenHold, rev: number, prevRev: number | null, state: string, o: { paths?: string[]; localOnly?: boolean } = {}): string {
    const terminal = (TERMINAL_STATES as readonly string[]).includes(state);
    const owner = h.owner;
    return L({
      id: opId, type: 'hold', hold_id: h.id, rev, prev_rev: prevRev, kind: h.pathless ? 'PIN' : (['PATCH', 'PIN', 'INCOMING'] as const)[randomInt(this.r, 3)]!,
      residence: terminal ? null : state === 'PARKED' ? 'OFF_DISK' : 'ON_DISK', state, offer: OFFERS[randomInt(this.r, OFFERS.length)]!,
      guards: h.pathless ? [HOST_REJECT] : [REVERT], paths: o.paths ?? h.paths, origin: h.pathless ? 'daemon' : 'human',
      cs_ids: h.pathless ? [] : [`${owner}/human/${1 + randomInt(this.r, 9)}`], peer_authors: [], local_only: o.localOnly ?? h.localOnly,
    });
  }

  private pick<T>(xs: readonly T[]): T | undefined {
    return xs.length === 0 ? undefined : xs[randomInt(this.r, xs.length)];
  }

  private someState(terminalPct: number): string {
    return randomInt(this.r, 100) < terminalPct ? TERMINAL_STATES[randomInt(this.r, TERMINAL_STATES.length)]! : LIVE_STATES[randomInt(this.r, LIVE_STATES.length)]!;
  }

  private somePaths(): string[] {
    const out = PATH_POOL.filter(() => randomInt(this.r, 3) === 0);
    return out.length > 0 ? [...out] : [PATH_POOL[randomInt(this.r, PATH_POOL.length)]!];
  }

  /** Subtrees to remove once the current commit is generated (its own ops may still need them). */
  private readonly dropAfter = new Set<string>();

  /**
   * A record created valid by `owner`: 20 % local_only stubs, 5 % pathless host-reject PINs, else mirrored with its held/
   * subtree put in this commit (o.mirrored forces the last kind).
   */
  create(owner: string, opId: string, o: { state?: string; mirrored?: boolean } = {}): string {
    const roll = o.mirrored === true ? 99 : randomInt(this.r, 100);
    const pathless = roll < 5;
    const h: GenHold = { id: this.newId(), owner, rev: 1, terminal: false, localOnly: !pathless && roll < 25, pathless, paths: pathless ? [] : this.somePaths() };
    const state = o.state ?? this.someState(10);
    h.terminal = (TERMINAL_STATES as readonly string[]).includes(state);
    if (!h.localOnly && !h.pathless) this.held.add(h.id);
    this.holds.push(h);
    return this.line(opId, h, 1, null, state);
  }

  /**
   * A valid next rev of a record (rev gaps allowed): a terminal record (or o.terminal) moves to a terminal state, never back.
   * Half of the records that end here have their subtree removed from the next commit on (o.keepHeld: never).
   */
  update(h: GenHold, opId: string, o: { terminal?: boolean; keepHeld?: boolean } = {}): string {
    const rev = h.rev + 1 + randomInt(this.r, 2);
    const state = h.terminal || o.terminal === true ? TERMINAL_STATES[randomInt(this.r, TERMINAL_STATES.length)]! : this.someState(25);
    const out = this.line(opId, h, rev, h.rev, state);
    h.rev = rev;
    if ((TERMINAL_STATES as readonly string[]).includes(state)) {
      h.terminal = true;
      if (o.keepHeld !== true && randomInt(this.r, 2) === 0) this.dropAfter.add(h.id);
    }
    return out;
  }

  /** The held/ subtrees of the commit just generated, sorted; removals queued during it apply from the next commit on. */
  commitHeld(): string[] {
    const out = [...this.held].sort();
    for (const id of this.dropAfter) this.held.delete(id);
    this.dropAfter.clear();
    return out;
  }

  /** 0–2 hold op lines of peer `owner`, each from `nextId()`. */
  ops(owner: string, nextId: () => string): string[] {
    const lines: string[] = [];
    const n = randomInt(this.r, 3);
    for (let i = 0; i < n; i++) {
      const mine = this.holds.filter((h) => h.owner === owner);
      const live = mine.filter((h) => !h.terminal);
      const dead = mine.filter((h) => h.terminal);
      const roll = randomInt(this.r, 100);
      const target = roll < 30 ? undefined : roll < 55 ? this.pick(live) : roll < 72 ? this.pick(dead.length > 0 ? dead : live) : this.pick(mine);
      if (target === undefined || roll < 30) {
        lines.push(this.create(owner, nextId()));
      } else if (roll < 60) {
        lines.push(this.update(target, nextId()));                                                       // valid (terminal → terminal on a dead one)
      } else if (roll < 66 && target.terminal) {
        lines.push(this.line(nextId(), target, target.rev + 1, target.rev, LIVE_STATES[randomInt(this.r, 3)]!));   // revival: 'type'
      } else if (roll < 72) {
        lines.push(this.line(nextId(), target, target.rev + 1, target.rev > 1 ? target.rev - 1 : null, 'ACTIVE'));  // stale: 'prev_rev'
      } else if (roll < 79 && !target.terminal) {
        const prev = target.rev;
        lines.push(this.update(target, nextId()));                                                       // a race: the first applies,
        lines.push(this.line(nextId(), target, prev + 5, prev, 'CONFLICTED'));                            // the second is 'prev_rev'
      } else if (roll < 86) {
        const theirs = this.pick(this.holds.filter((h) => h.owner !== owner));
        if (theirs !== undefined) lines.push(this.line(nextId(), theirs, theirs.rev + 1, theirs.rev, 'ACTIVE'));   // non-owner: 'type'
      } else if (roll < 91) {
        const id = this.newId();
        this.held.add(id);                                                                                // local_only with held/: stub rule
        lines.push(this.line(nextId(), { id, owner, rev: 1, terminal: false, localOnly: true, pathless: false, paths: this.somePaths() }, 1, null, 'ACTIVE'));
      } else if (roll < 96) {
        const ghost: GenHold = { id: this.newId(), owner, rev: 1, terminal: false, localOnly: false, pathless: false, paths: this.somePaths() };
        lines.push(this.line(nextId(), ghost, 1, null, 'ACTIVE'));                                        // mirrored without held/: held_subtree
      } else {
        const bad: GenHold = { id: this.newId(), owner, rev: 1, terminal: false, localOnly: false, pathless: false, paths: ['docs/12:30-notes.md'] };
        lines.push(this.line(nextId(), bad, 1, null, 'ACTIVE'));                                          // a path SEC-35 refuses: 'validator'
      }
    }
    return lines;
  }
}

/**
 * A board of n commits from a seed: 4 peers (opts.peers); peer 3 is silent for heights 100–449 (a ghost from 300 on);
 * peers leave, rejoin, start new epochs and re-announce regionSpecs; ~1 % of commits carry no writer.
 * B0 also creates a height-0 event and an ended seat with a dedicated id (b0SeatKey), so compaction at 512
 * has both kinds of terminal record to drop; with opts.holds it also creates and ends a hold (b0HoldId).
 */
export function generateBoard(seed: string, n: number, opts: GenOptions = {}): GenBoard {
  const r = seededRandom(seed);
  const hg = opts.holds === true ? new HoldGen(seededRandom(`${seed}/holds`)) : null;
  const heldNow = (): string[] | undefined => (hg === null ? undefined : hg.commitHeld());
  const protocol = genesisProtocol(12, 'rs-1');
  const peers: SimPeer[] = Array.from({ length: opts.peers ?? 4 }, () => ({
    id: newPeerId(r), epoch: newEpoch(r), seq: 0, status: 'none' as const, seats: [randomHex(r, 16), randomHex(r, 16), randomHex(r, 16)], regionSpec: 'rs-1',
  }));
  const commits: GenCommit[] = [];
  const g = peers[0]!;
  const gid = (s: number): string => `${g.id}/${g.epoch}/${s}`;
  const b0Lines = [
    join(g, 1, 'Genesis'),
    L({ id: gid(2), type: 'caps', custom_refs: true, lease: true, delete: true, push_options: false, two_parent_ok: true }),
    L({ id: gid(3), type: 'seat_start', seat_id: B0_SEAT, permission_mode: 'default' }),
    L({ id: gid(4), type: 'event', cid: eventCid(gid(4), 'freeze'), kind: 'freeze', refs: [], reason_code: 'EPOCH_CHANGED' }),
    L({ id: gid(5), type: 'seat_end', seat_id: B0_SEAT, permission_mode: 'default' }),
  ];
  g.seq = 5;
  let b0HoldId: string | undefined;
  if (hg !== null) {
    // A mirrored hold created and ended at height 0: terminal_height 0, so compaction at 512 drops it.
    b0Lines.push(hg.create(g.id, gid(++g.seq), { state: 'ACTIVE', mirrored: true }));
    const b0Hold = hg.holds[0]!;
    b0HoldId = b0Hold.id;
    b0Lines.push(hg.update(b0Hold, gid(++g.seq), { terminal: true, keepHeld: true }));
  }
  commits.push({ writer: { peer: g.id, epoch: g.epoch, seq: ++g.seq }, lines: b0Lines, heldIds: heldNow() });
  g.status = 'active';
  for (let h = 1; h < n; h++) {
    // PRO-27 writer side: the commit at 512 removes the subtree of the B0 hold, which compaction drops there.
    if (hg !== null && h === 2 * CHECKPOINT_EVERY && b0HoldId !== undefined) hg.held.delete(b0HoldId);
    if (randomInt(r, 100) === 0) {
      commits.push({ writer: null, lines: [L({ id: gid(1), type: 'leave' })], heldIds: heldNow() });
      continue;
    }
    const eligible = peers.filter((_, i) => !(i === 3 && h >= 100 && h < 450));
    const p = eligible[randomInt(r, eligible.length)]!;
    const lines: string[] = [];
    if (p.status === 'none') {
      lines.push(join(p, ++p.seq, 'Peer'));
      p.status = 'active';
    } else if (p.status === 'left') {
      if (randomInt(r, 2) === 0) {
        lines.push(join(p, ++p.seq, 'Back'));
        p.status = 'active';
      } else {
        lines.push(L({ id: `${p.id}/${p.epoch}/${++p.seq}`, type: 'note', target: null, text: 'while left' }));
      }
    } else {
      const roll = randomInt(r, 100);
      if (roll < 2) {
        p.epoch = newEpoch(r);
        p.seq = 0;
        lines.push(join(p, ++p.seq, 'New epoch'));
      } else if (roll < 4 && p !== g) {
        lines.push(L({ id: `${p.id}/${p.epoch}/${++p.seq}`, type: 'leave' }));
        p.status = 'left';
      } else {
        const k = randomInt(r, 5);
        for (let i = 0; i < k; i++) lines.push(randomOp(r, p, ++p.seq));
        if (hg !== null) lines.push(...hg.ops(p.id, () => `${p.id}/${p.epoch}/${++p.seq}`));
      }
    }
    commits.push({ writer: { peer: p.id, epoch: p.epoch, seq: ++p.seq }, lines, heldIds: heldNow() });
  }
  const b0SeatKey = `${g.id}/${commits[0]!.writer!.epoch}/${B0_SEAT}`;
  return b0HoldId === undefined ? { protocol, peers: peers.map((p) => p.id), commits, b0SeatKey } : { protocol, peers: peers.map((p) => p.id), commits, b0SeatKey, b0HoldId };
}

export function genDraft(gen: GenBoard, c: GenCommit, liveCode: Oid, checkpoint: Buffer | null = null): BoardDraft {
  return { liveCode, writer: c.writer, cs: [], protocol: gen.protocol, opsLines: [...c.lines], checkpoint, heldIds: [...(c.heldIds ?? [])] };
}

/** The fold from genesis: states[h] after folding commit h. */
export function foldAll(gen: GenBoard, self: string, liveCode: Oid): FoldState[] {
  const states: FoldState[] = [];
  let s = initialFoldState(gen.protocol);
  for (const c of gen.commits) {
    s = foldCommit(s, genDraft(gen, c, liveCode), self).state;
    states.push(s);
  }
  return states;
}

/** The honest checkpoint/state.json bytes of every checkpoint height. */
export function honestCheckpoints(states: readonly FoldState[]): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  states.forEach((s, h) => {
    if (h % CHECKPOINT_EVERY === 0) out.set(h, serializeFold(s));
  });
  return out;
}

const DATE = '1700000000 +0000';

function dataBlock(bytes: Buffer): Buffer[] {
  return [Buffer.from(`data ${bytes.length}\n`, 'utf8'), bytes, Buffer.from('\n', 'utf8')];
}

/**
 * Writes the board into `<prefix>/live` (L0) and `<prefix>/board` with one `git fast-import`: B0 = [L0]
 * with ops.jsonl, protocol.json and checkpoint/state.json; every later commit [previous, L0] replaces
 * ops.jsonl and, at checkpoint heights, checkpoint/state.json (protocol.json and the checkpoint carried).
 * A commit's heldIds become held/<id>/h1/held.txt entries: a new id is put, an id the previous commit carried and this
 * one does not is removed, the rest are carried. Returns L0 and the board oids by height.
 */
export async function importBoard(repo: GitRepo, prefix: string, gen: GenBoard, checkpoints: ReadonlyMap<number, Buffer>): Promise<{ L0: Oid; oids: Oid[] }> {
  const parts: Buffer[] = [];
  const text = (s: string): void => { parts.push(Buffer.from(s, 'utf8')); };
  let carried = new Set<string>();
  text(`commit ${prefix}/live\nmark :1\nauthor Fixture <fixture@cowork.invalid> ${DATE}\ncommitter Fixture <fixture@cowork.invalid> ${DATE}\n`);
  parts.push(...dataBlock(formatMessage(CODE_SUBJECT, [{ key: 'skip-checks', value: 'true' }, { key: 'Cowork-Proto', value: '1' }])));
  text('M 100644 inline README.md\n');
  parts.push(...dataBlock(Buffer.from('# board fixture\n', 'utf8')));
  gen.commits.forEach((c, h) => {
    const who = c.writer === null ? 'nobody' : c.writer.peer;
    text(`commit ${prefix}/board\nmark :${h + 2}\nauthor Peer <${who}@cowork.invalid> ${DATE}\ncommitter Peer <${who}@cowork.invalid> ${DATE}\n`);
    const trailers: Trailer[] = c.writer === null
      ? [{ key: 'skip-checks', value: 'true' }, { key: 'Cowork-Proto', value: '1' }]
      : boardTrailers(c.writer, [], new Map());
    parts.push(...dataBlock(formatMessage(BOARD_SUBJECT, trailers)));
    if (h === 0) {
      text('from :1\ndeleteall\nM 100644 inline protocol.json\n');
      parts.push(...dataBlock(serializeProtocol(gen.protocol)));
    } else {
      text(`from :${h + 1}\nmerge :1\n`);
    }
    text('M 100644 inline ops.jsonl\n');
    parts.push(...dataBlock(Buffer.from(c.lines.map((l) => `${l}\n`).join(''), 'utf8')));
    const ck = checkpoints.get(h);
    if (ck !== undefined) {
      text('M 100644 inline checkpoint/state.json\n');
      parts.push(...dataBlock(ck));
    } else if (h === 0) {
      throw new Error('importBoard: B0 needs its checkpoint');
    }
    const now = new Set(c.heldIds ?? []);
    for (const id of carried) if (!now.has(id)) text(`D held/${id}\n`);
    for (const id of now) {
      if (carried.has(id)) continue;
      text(`M 100644 inline held/${id}/h1/held.txt\n`);
      parts.push(...dataBlock(Buffer.from(`${id}\n`, 'utf8')));
    }
    carried = now;
  });
  text('done\n');
  await repo.run(['fast-import', '--quiet', '--done'], { stdin: Buffer.concat(parts) });
  const list = await repo.run(['rev-list', '--first-parent', '--reverse', `${prefix}/board`]);
  const oids = list.stdout.toString('utf8').split('\n').filter((l) => l.length > 0).map((l) => parseOid(l));
  if (oids.length !== gen.commits.length + 1) throw new Error(`importBoard: expected ${gen.commits.length + 1} commits, got ${oids.length}`);
  return { L0: oids[0]!, oids: oids.slice(1) };
}
