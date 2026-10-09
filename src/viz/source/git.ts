// The git room source (12 §3.3.1–§3.3.4, §3.9.2, §6; VIZ-06, VIZ-07, VIZ-11, VIZ-15; rulings R-V05, R-V19, R-V31, R-V69,
// R-V74; Review Focus 4). Per tick: stat pairs of the board ref's storage (no git while they are unchanged, a rev-parse when
// one changed or 60 s passed), then one pinned tip — every later read of the tick names that oid, never the moving ref —
// one rev-list of its first-parent chain, and the batched readers (≤ 1,280 board commits and the live commits they name
// per --batch-check/--batch pair). Frames are folded by the build's own foldCommit (foldFrame); a malformed board commit is
// the no-op draft of the previous draft, a live commit that is not a live step has shape null, and a missing object stops
// the batch before any of its frames (the store shows UI_VIZ_NO_BOARD and retries next tick).
import { join } from 'node:path';
import { isBoardReadFailure, readBoardCommits, READ_BATCH_MAX, type BoardRead, type BoardReadFailure } from '../../board/batchRead.js';
import { liveShape } from '../../board/boardCommit.js';
import { CHECKPOINT_EVERY, initialFoldState, parseFold, type FoldState } from '../../board/fold.js';
import type { PeerId } from '../../board/ids.js';
import { readProtocol, type ProtocolJson } from '../../board/protocol.js';
import type { Oid } from '../../git/oid.js';
import type { Clock } from '../../ports/clock.js';
import type { Fs } from '../../ports/fs.js';
import { foldFrame, noopDraft, toDraft, ZERO_PEER, type Frame, type FrameCode, type FrameInput } from '../model/frame.js';
import type { Advance, RoomSource, RoomSpec, TipInfo } from './roomSource.js';
import type { VizGit } from './vizGit.js';

/** (size, mtime) of one file of the board ref's storage; null when the file does not exist. */
export interface StatPair { size: number; mtimeNs: bigint; }
/** The safety net for a ref update a stat cannot see (12 §3.9.2). */
export const REVPARSE_SAFETY_MS = 60_000;
/** R-V31: the new tip's newest READ_BATCH_MAX + 1 commits hold the last folded one after ≤ 1,280 new commits. */
const FF_PAGE = READ_BATCH_MAX + 1;
/**
 * The fold states startAt computed at checkpoint heights whose own checkpoint/state.json does not parse at its height
 * (version skew: parseFold needs serializeFold(s) to equal the stored bytes, so a newer build's checkpoints are refused at
 * every height) are kept per room, at most this many, the least recently used dropped first. 16 = twice the store's
 * retained window (2,048 heights = 8 checkpoint spans): the window's checkpoints and 8 "load earlier" pages below it are
 * served without a fold from the newest parseable checkpoint (or genesis) again. Each entry is one FoldState, as large as
 * a checkpoint the store itself keeps (round 1 fix; controller ruling: cache the last good fold seed per room, bounded).
 */
export const FOLD_CACHE_MAX = 16;
/** How far below a malformed board commit one read looks for the readable draft its no-op carries. */
const SEED_CHUNK = CHECKPOINT_EVERY;
const NO_LIVE = '0'.repeat(40) as Oid;

/**
 * A board or live object the store lacks (a partial clone; transports are disabled, VIZ-07): nothing of the batch is
 * folded; the store shows UI_VIZ_NO_BOARD and retries next tick (R-V19, 12 §6). Never served: oid is transient.
 */
export class BoardObjectMissingError extends Error {
  readonly height: number;
  readonly oid: string;
  constructor(height: number, oid: string) {
    super(`a board or live object of height ${height} is missing`);
    this.name = 'BoardObjectMissingError';
    this.height = height;
    this.oid = oid;
  }
}

/** The draft at a height as the next frame needs it: liveCode and protocol (a no-op carries both) and the live trailers' seats/base. */
interface Seed { liveCode: Oid; protocol: ProtocolJson; seats: string[]; base: string | null; }
/** One frame's input without its fold, and the seed it leaves for the next height. */
interface Step { input: FrameInput; seed: Seed; }

const samePair = (a: StatPair | null, b: StatPair | null): boolean => (a === null || b === null ? a === b : a.size === b.size && a.mtimeNs === b.mtimeNs);
const samePairs = (a: ReadonlyArray<StatPair | null>, b: ReadonlyArray<StatPair | null>): boolean => a.length === b.length && a.every((x, i) => samePair(x, b[i]!));

/**
 * One batched read as a frame input (R-V19, R-V74): a failure 'missing' throws; another failure is noopDraft(previous draft)
 * with code {changed: false, shape: null, seats: [], base: null} and malformed; a read's live: 'same' → unchanged (the
 * previous live trailers carried), a live step → changed with liveShape(live commit, previous liveCode) ('genesis' rules at
 * height 0), a live failure 'missing' throws, any other live failure → shape null.
 */
function stepOf(r: BoardRead | BoardReadFailure, prev: Seed | null): Step {
  if (isBoardReadFailure(r)) {
    if (r.malformed === 'missing') throw new BoardObjectMissingError(r.height, r.oid);
    const p = prev ?? { liveCode: NO_LIVE, protocol: readProtocol(null), seats: [], base: null };
    return {
      input: { height: r.height, oid: r.oid, draft: noopDraft(p), csPaths: new Map(), code: { changed: false, shape: null, seats: [], base: null }, malformed: true },
      seed: p,
    };
  }
  const live = r.live;
  const changed = prev === null || r.liveCode !== prev.liveCode;
  let code: FrameCode;
  if (live === 'same' || live === null) {
    code = { changed: false, shape: null, seats: prev === null ? [] : [...prev.seats], base: prev?.base ?? null };
  } else if ('malformed' in live) {
    if (live.malformed === 'missing') throw new BoardObjectMissingError(r.height, live.oid ?? r.liveCode);
    code = { changed, shape: null, seats: [], base: null };
  } else {
    const shape = r.height === 0 ? liveShape(live.info, null) : changed && prev !== null ? liveShape(live.info, prev.liveCode) : null;
    code = { changed, shape, seats: [...live.seats], base: live.base };
  }
  const draft = toDraft({ liveCode: r.liveCode, writer: r.writer, cs: r.cs, protocol: r.protocol, opsLines: r.opsLines, checkpoint: r.checkpoint, heldIds: r.heldIds });
  return {
    input: { height: r.height, oid: r.oid, draft, csPaths: r.csPaths, code, malformed: false },
    seed: { liveCode: r.liveCode, protocol: r.protocol, seats: code.seats, base: code.base },
  };
}

/**
 * GitRoomSource: one room's board ref through VizGit. tip() and advance() pin the tip; startAt() and frames() read only the
 * pinned chain. The oids of the pinned chain are kept by height (from advance's page and frames' listings), so a tick lists
 * its range at most once; the draft of the last frame folded seeds the next call's first frame.
 */
export class GitRoomSource implements RoomSource {
  readonly kind = 'git' as const;
  private readonly git: VizGit;
  private readonly fs: Fs;
  private readonly clock: Clock;
  private readonly ref: string;
  private readonly refFile: string;
  private readonly packedRefs: string;
  private readonly reftable: string;
  private pinned: { oid: Oid; height: number } | null = null;
  private oids = new Map<number, Oid>();
  /** The stat pairs taken just before the rev-parse of the last tip() or advance() that succeeded; null before one, after a failed one or when the stat failed. */
  private baseline: Array<StatPair | null> | null = null;
  /** Δmono anchor of the safety net: the rev-parse of the last successful tip() or advance(), or the last time the net fired. */
  private resolvedAt: number | null = null;
  /** The seed after the last height folded or read on the pinned chain. */
  private seed: { height: number; oid: Oid; seed: Seed } | null = null;
  /**
   * startAt's folded states at checkpoint heights whose checkpoint does not parse, by height, each with the board oid at that
   * height (the state is a function of that commit's first-parent chain, so an entry is served only while the pinned chain
   * holds the same oid there — across ff, rewrites above it and re-pins alike); insertion order = recency, ≤ FOLD_CACHE_MAX.
   */
  private folds = new Map<number, { oid: Oid; state: FoldState }>();

  constructor(spec: RoomSpec, git: VizGit, deps: { fs: Fs; clock: Clock }) {
    if (spec.kind !== 'git' || spec.gitDir === null || spec.boardRef === null) throw new Error('GitRoomSource: a git room needs a gitDir and a board ref');
    this.git = git;
    this.fs = deps.fs;
    this.clock = deps.clock;
    this.ref = spec.boardRef;
    this.refFile = join(spec.gitDir, ...spec.boardRef.split('/'));
    this.packedRefs = join(spec.gitDir, 'packed-refs');
    this.reftable = join(spec.gitDir, 'reftable');
  }

  /** (size, mtime) of <gitdir>/refs/cowork-remote/<e>/board, <gitdir>/packed-refs and, when <gitdir>/reftable/ exists, reftable/tables.list. */
  async statPairs(): Promise<Array<StatPair | null>> {
    const pair = async (p: string): Promise<StatPair | null> => {
      const l = await this.fs.lstat(p);
      return l === null ? null : { size: l.size, mtimeNs: l.mtimeNs };
    };
    const out = [await pair(this.refFile), await pair(this.packedRefs)];
    const rt = await this.fs.lstat(this.reftable);
    if (rt !== null && rt.isDirectory) out.push(await pair(join(this.reftable, 'tables.list')));
    return out;
  }

  /** A stat pair differs from the pairs taken before the last rev-parse (a stat error counts as a change), or 60 s passed since that rev-parse or since the net last fired. No git process. */
  async changed(): Promise<boolean> {
    let pairs: Array<StatPair | null>;
    try {
      pairs = await this.statPairs();
    } catch {
      return true;
    }
    if (this.baseline === null || !samePairs(pairs, this.baseline)) return true;
    const now = this.clock.monoMs();
    if (this.resolvedAt === null || now - this.resolvedAt >= REVPARSE_SAFETY_MS) {
      this.resolvedAt = now;
      return true;
    }
    return false;
  }

  /** rev-parse of the board ref (the stat pairs taken first, so an update between the two is seen next tick) and the pin; then its height by rev-list --count when it is new. */
  async tip(): Promise<TipInfo | null> {
    return this.resolving(async (oid) => {
      if (oid === null) return this.pin(null, false);
      if (this.pinned !== null && this.pinned.oid === oid) return { height: this.pinned.height, key: oid };
      return this.pin({ oid, height: (await this.git.chainCount(oid)) - 2 }, false);
    });
  }

  /**
   * R-V31: re-resolve; the ref gone → 'gone'; the same oid → 'none'; else the new tip's newest 1,281 commits: the last folded
   * oid at index n → 'ff' to last.height + n; not on a full page → rev-list --count and the one commit at last.height
   * (--skip) tell a catch-up beyond 1,280 ('ff') from a rewrite; not on a shorter page (the whole chain) → 'rewrite'.
   */
  async advance(last: TipInfo): Promise<Advance> {
    return this.resolving(async (oid): Promise<Advance> => {
      if (oid === null) {
        this.pin(null, false);
        return { kind: 'gone' };
      }
      if (oid === last.key) {
        this.pin({ oid, height: last.height }, this.pinned?.oid === oid);
        return { kind: 'none' };
      }
      const page = await this.git.chain(oid, 0, FF_PAGE);
      const n = page.indexOf(last.key as Oid);
      let height: number;
      let kind: 'ff' | 'rewrite' = 'rewrite';
      if (n > 0) {
        height = last.height + n;
        kind = 'ff';
      } else if (page.length < FF_PAGE) {
        height = page.length - 2;
      } else {
        height = (await this.git.chainCount(oid)) - 2;
        if (height > last.height && (await this.git.chain(oid, height - last.height, 1))[0] === last.key) kind = 'ff';
      }
      if (height < 0) {
        this.pin(null, false);
        return { kind: 'gone' };
      }
      const to = this.pin({ oid, height }, kind === 'ff' && this.pinned?.oid === last.key)!;
      page.forEach((o, i) => {
        if (height - i >= 0) this.oids.set(height - i, o);
      });
      return { kind, to };
    });
  }

  /**
   * initialFoldState(protocol of B0) at 0; for h % 256 === 0, parseFold(checkpoint/state.json at h) when it parses at its
   * own height (trusted as a joiner trusts it, glossary §24 default 9), else the state below (this rule, one checkpoint
   * down) folded up to h — that state is cached for h and its board oid (FOLD_CACHE_MAX), and a cached state is served
   * (a copy) before anything is read, so a run of unparseable checkpoints is folded up once, from the last good state. The
   * board commit at h is read with its live commit, which seeds frames from h + 1 (after a cached state, frames reads it).
   */
  async startAt(h: number): Promise<FoldState> {
    const pin = this.requirePin();
    if (!Number.isSafeInteger(h) || h < 0 || h > pin.height || h % CHECKPOINT_EVERY !== 0) throw new RangeError(`GitRoomSource.startAt: ${h} is not a checkpoint height of the pinned tip (0…${pin.height})`);
    if (h > 0) {
      await this.list(h, h);
      const hit = this.folds.get(h);
      if (hit !== undefined && hit.oid === this.oids.get(h)) {
        this.folds.delete(h);
        this.folds.set(h, hit);
        return structuredClone(hit.state);
      }
    }
    const [{ read }] = await this.readSteps([h], null) as [{ read: BoardRead | BoardReadFailure }];
    const oid = this.oids.get(h)!;
    if (isBoardReadFailure(read)) {
      if (read.malformed === 'missing') throw new BoardObjectMissingError(h, read.oid);
    } else {
      this.seed = { height: h, oid, seed: stepOf(read, null).seed };
    }
    if (h === 0) return initialFoldState(isBoardReadFailure(read) ? readProtocol(null) : read.protocol);
    const s = isBoardReadFailure(read) || read.checkpoint === null ? null : parseFold(read.checkpoint);
    if (s !== null && s.height === h) return s;
    const below = await this.startAt(h - CHECKPOINT_EVERY);
    let state = below;
    for await (const f of this.frames(below, h === CHECKPOINT_EVERY ? 0 : h - CHECKPOINT_EVERY + 1, h, ZERO_PEER)) state = f.after;
    this.folds.delete(h);
    this.folds.set(h, { oid, state: structuredClone(state) });
    for (const k of this.folds.keys()) {
      if (this.folds.size <= FOLD_CACHE_MAX) break;
      this.folds.delete(k);
    }
    return state;
  }

  /** Frames of heights from…to of the pinned tip, folded from `start` (the state at from − 1): one listing, reads in batches of ≤ 1,280. */
  async *frames(start: FoldState, from: number, to: number, self: PeerId): AsyncIterable<Frame> {
    const pin = this.requirePin();
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to > pin.height || from > to + 1) {
      throw new RangeError(`GitRoomSource.frames: ${from}…${to} outside the pinned tip's heights 0…${pin.height}`);
    }
    if (from > to) return;
    if (start.height !== from - 1) throw new RangeError(`GitRoomSource.frames: a start state at height ${start.height} does not precede height ${from}`);
    await this.list(Math.max(0, from - 1), to);
    let seed = from === 0 ? null : await this.seedAt(from - 1);
    let prev = start;
    for (let b = from; b <= to; b += READ_BATCH_MAX) {
      const e = Math.min(to, b + READ_BATCH_MAX - 1);
      const steps: Step[] = [];
      for (const { read } of await this.readSteps(range(b, e), seed?.liveCode ?? null)) {
        const s = stepOf(read, seed);
        steps.push(s);
        seed = s.seed;
      }
      this.seed = { height: e, oid: this.oids.get(e)!, seed: seed! };
      for (const s of steps) {
        const f = foldFrame(prev, s.input, self);
        prev = f.after;
        yield f;
      }
    }
  }

  // ---- internals --------------------------------------------------------------------------------------------

  private requirePin(): { oid: Oid; height: number } {
    if (this.pinned === null) throw new Error('GitRoomSource: no pinned tip (call tip() or advance() first)');
    return this.pinned;
  }

  /**
   * The stat pairs (taken first, so an update between them and the rev-parse is seen next tick), rev-parse --verify -q of
   * the board ref, then `op` with its oid. The pairs become changed()'s baseline, and the rev-parse resets the safety net,
   * only when the whole operation succeeds; a failure at or after the rev-parse (a transient git error, the watchdog kill,
   * a ref naming a non-commit) leaves no baseline, so the next changed() is true and the store retries next tick instead of
   * waiting for the 60 s net (the pin is unchanged: every pin() call follows the last git call that can fail).
   */
  private async resolving<T>(op: (oid: Oid | null) => Promise<T>): Promise<T> {
    let pairs: Array<StatPair | null> | null;
    try {
      pairs = await this.statPairs();
    } catch {
      pairs = null;
    }
    try {
      const oid = await this.git.revParse(this.ref);
      const at = this.clock.monoMs();
      const out = await op(oid);
      this.baseline = pairs;
      this.resolvedAt = at;
      return out;
    } catch (e) {
      this.baseline = null;
      throw e;
    }
  }

  /** Pins p (null: none). keep: p extends the old pin's chain, so its oids by height stay valid; otherwise they are dropped. */
  private pin(p: { oid: Oid; height: number } | null, keep: boolean): TipInfo | null {
    if (p !== null && p.height < 0) p = null;
    if (!keep) {
      this.oids = new Map();
      this.seed = null;
    }
    this.pinned = p;
    if (p === null) return null;
    this.oids.set(p.height, p.oid);
    return { height: p.height, key: p.oid };
  }

  /** The oids of heights lo…hi of the pinned chain: those not yet known in one rev-list. */
  private async list(lo: number, hi: number): Promise<void> {
    const pin = this.requirePin();
    let top = hi;
    while (top >= lo && this.oids.has(top)) top--;
    let bottom = lo;
    while (bottom <= top && this.oids.has(bottom)) bottom++;
    if (top < bottom) return;
    const got = await this.git.chain(pin.oid, pin.height - top, top - bottom + 1);
    if (got.length !== top - bottom + 1) throw new Error(`GitRoomSource: the first-parent chain of the pinned tip is shorter than its count`);
    got.forEach((o, i) => this.oids.set(top - i, o));
  }

  /**
   * Reads the board commits at `heights` (≤ READ_BATCH_MAX, ascending, oids known) with their live commits, call after call
   * from `next` (R-V69), prevLive carried across calls as the last draft's liveCode (a no-op draft keeps the previous one).
   */
  private async readSteps(heights: readonly number[], prevLive: Oid | null): Promise<Array<{ read: BoardRead | BoardReadFailure }>> {
    await this.list(heights[0]!, heights[heights.length - 1]!);
    const items = heights.map((h) => ({ oid: this.oids.get(h)!, height: h }));
    const out: Array<{ read: BoardRead | BoardReadFailure }> = [];
    let live = prevLive;
    while (out.length < items.length) {
      const { reads, next } = await readBoardCommits(this.git, items.slice(out.length), { withLive: true, prevLive: live });
      if (next === 0) throw new Error('GitRoomSource: a batched read made no progress');
      for (const read of reads) {
        out.push({ read });
        if (!isBoardReadFailure(read)) live = read.liveCode;
      }
    }
    return out;
  }

  /**
   * The seed of height h: the last frame's when it is h of this chain; else h read with its live commit — and when h is a
   * malformed board commit (a no-op draft carries the previous draft), the readable draft below it, read downward in chunks
   * of 256 (genesis-less chains end at a fixed placeholder). A missing object on the way throws.
   */
  private async seedAt(h: number): Promise<Seed> {
    const known = this.seed;
    if (known !== null && known.height === h && known.oid === this.oids.get(h)) return known.seed;
    let window = [h];
    let found: Seed | null = null;
    for (;;) {
      const reads = await this.readSteps(window, null);
      const firstOk = reads.findIndex((x) => !isBoardReadFailure(x.read));
      if (firstOk >= 0) {
        // The readable draft and everything above it in this window (no-op drafts carry it; a missing object throws).
        for (const { read } of reads.slice(firstOk)) found = stepOf(read, found).seed;
        break;
      }
      for (const { read } of reads) stepOf(read, null);   // a missing object throws; a malformed one is a no-op draft
      if (window[0] === 0) break;
      const hi = window[0]! - 1;
      window = range(Math.max(0, hi - SEED_CHUNK + 1), hi);
    }
    const seed = found ?? { liveCode: NO_LIVE, protocol: readProtocol(null), seats: [], base: null };
    this.seed = { height: h, oid: this.oids.get(h)!, seed };
    return seed;
  }
}

function range(lo: number, hi: number): number[] {
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}
