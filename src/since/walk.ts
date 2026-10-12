// The board walk of `/cowork since` (10-product §3.9a "Reads", "Limits"; FEAT-F04-02, -08; F04-a Task A2): the one file of
// src/since that reads git. It reads board commits only, through 8a's batched reader readBoardCommits (12 §9.7 item 8;
// per round one `cat-file --batch-check` and one `cat-file --batch` of ≤ 1,280 board commits: the commit object,
// ops.jsonl, protocol.json, the held/ tree for entry names and checkpoint/state.json at multiples of 256; no live commit,
// withLive off), folds every commit with Plan 2's foldCommit (its per-op verdicts, 12 §9.7 item 1) from the checkpoint at
// or below the walk's start, and feeds each folded commit to the pure core (report.ts). No live-code tree or blob, save
// commit, branch commit, hold record or blob is read, nothing is written, and every git call is local. The terminal verb
// (cli.ts) reaches git only through this file: openBoard builds its runner and repository and reads HEAD's branch (F04-a
// Task A3 fix r1 ruling), and sinceAnchors searches the anchors.
//
// Imports: src/board, src/git, node:path (the runner's hooks path), the Clock port's type and ./report.js only — src/since
// sits after src/board and before src/holds and src/engine (X-110), and cli.js may not load src/viz/model (12 §3.13), so the
// no-op draft of an unreadable board commit (8a's noopDraft, R-V19) is built here.
import { posix, win32 } from 'node:path';
import { isBoardReadFailure, readBoardCommits, READ_BATCH_MAX, type BoardRead, type BoardReadFailure } from '../board/batchRead.js';
import { CHECKPOINT_EVERY, foldCommit, initialFoldState, parseFold, type FoldState, type OpVerdict } from '../board/fold.js';
import { parseOpId, type PeerId } from '../board/ids.js';
import { parseOpLine } from '../board/ops.js';
import { readProtocol, type ProtocolJson } from '../board/protocol.js';
import { enc, EncTooLongError } from '../git/enc.js';
import { buildDaemonEnv } from '../git/env.js';
import { parseOid, type Oid } from '../git/oid.js';
import { GitRepo, type RepoContext, type RepoPaths } from '../git/repo.js';
import { createGitRunner, type GitRunner, type GitRunnerDeps } from '../git/runner.js';
import type { Clock } from '../ports/clock.js';
import { MY_PATHS_LOOKBACK, sinceFinish, sinceInit, sincePush, type MyRecord, type SinceAcc, type SinceOptions, type SinceReport } from './report.js';

/** The range cap (10-product §3.9a "Limits", glossary §29.7): a longer range is reported as (to − 5,000, to] (T-F04-cap). */
export const SINCE_CAP_HEIGHTS = 5_000;
// "My paths" are this peer's groups in (from − 1,024, to] (10-product §3.9a): the walk starts MY_PATHS_LOOKBACK (report.ts's
// one definition) below the range.

/** What a walk learned on the way: the newest epoch start of `you`, and the effective saves by save commit in lower case (newest height). */
interface Seen { joinHeight: number | null; saves: Map<string, number>; }

/** The board tip a caller already resolved (sinceAnchors' tipOid and tip): its oid and its first-parent height. */
export interface SinceTip { readonly oid: Oid; readonly height: number; }

/** walkSince's options; see walkSince. */
export interface WalkSinceOptions {
  from: number; to: number; you: PeerId; mine: readonly MyRecord[]; verifiedLabel?: SinceOptions['verifiedLabel'];
  /** The tip to walk (final review M3): given, the board ref is not read again, so the walk reads the chain the anchor was resolved on. */
  tip?: SinceTip;
}

/**
 * The catch-up report of the range (from, to] of branch b's board (refs/cowork-remote/<enc(b)>/board), for this peer `you`
 * with its hold-record metadata `mine` (and, from Plan 4, the verified-label lookup). `from` is the anchor's height (−1: the
 * whole board) and `to` a height of the board's first-parent chain (normally its tip; the chain is read at that height).
 * `o.tip`, when given, is that chain's tip (sinceAnchors' tipOid and tip, as the CLI passes them): the board ref is then not
 * read, so the anchor search and the walk read one chain even when the ref moves between the two (an incident rewrite
 * fetched in between); absent, the walk reads the ref itself.
 * A range of more than SINCE_CAP_HEIGHTS heights is capped: the report keeps `from`, covers (to − 5,000, to] and sets
 * truncatedFrom. The walk starts 1,024 heights below the range start (my paths) at the newest checkpoint below that (a
 * checkpoint that does not parse at its height: the one below it; at 256 or less: the fold from genesis), so a capped range
 * reads at most 5,000 + 1,024 + 257 board commits: ≤ 5 rounds of 1,280.
 *
 * Also returned (the contract's interface): joinHeight, the height of the newest effective join of `you` that started an
 * epoch (no record before it, or a record of another epoch) among the commits the walk folded, else null; and saves(prefix),
 * the heights of the effective save ops whose save commit starts with `prefix` (compared case-insensitively) among those
 * commits, one per distinct save commit (its newest), ascending. Both are window-limited: they see only the commits this
 * walk folds, from 1,024 heights (and a checkpoint) below the range start. The CLI does not feed resolveSinceAnchor from
 * them: its anchor context is sinceAnchors' (the tip; this peer's newest join, by a search of its own that no fold window
 * bounds; for a save: anchor, the saves of the whole first-parent chain), so `since` neither refuses a join older than the
 * window nor misses a save below it (final review M8).
 *
 * A board commit readBoardCommits cannot read (BoardReadFailure: malformed, missing or unreadable, R-V19/R-V74) folds as the
 * no-op draft — writer null, no ops, no trailers, the previous protocol and live code — and makes no row; the walk goes on.
 * Refuses (RangeError) a `from` or `to` that is not an integer with −1 ≤ from ≤ to, or `to` above the tip; throws when the
 * branch has no board.
 */
export async function walkSince(repo: GitRepo, b: string, o: WalkSinceOptions):
  Promise<{ report: SinceReport; joinHeight: number | null; saves: (prefix: string) => readonly number[] }> {
  const { from, to } = o;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < -1 || to < 0 || from > to) {
    throw new RangeError(`walkSince: the range (${String(from)}, ${String(to)}] is not a range of board heights`);
  }
  const ref = `refs/cowork-remote/${enc(b)}/board`;
  let tip: Oid;
  let top: number;
  if (o.tip !== undefined) {
    if (!Number.isSafeInteger(o.tip.height) || o.tip.height < 0) throw new RangeError(`walkSince: the tip height ${String(o.tip.height)} is not a board height`);
    tip = o.tip.oid;
    top = o.tip.height;
  } else {
    const read = await repo.readRef(ref);
    if (read === null) throw new Error(`walkSince: no board at ${ref}`);
    tip = read;
    // B0's only parent is the parentless L0, so the first-parent chain of a tip at height H has H + 2 commits.
    top = (await repo.firstParentCount(tip)) - 2;
    if (top < 0) throw new Error(`walkSince: ${ref} does not name a board commit`);
  }
  if (to > top) throw new RangeError(`walkSince: height ${to} is above the board tip (${top})`);
  const capFrom = to - from > SINCE_CAP_HEIGHTS ? to - SINCE_CAP_HEIGHTS : null;
  // The first folded step only sets the live-code baseline (report.ts), so it must lie at or below base, or be B0.
  const base = (capFrom ?? from) - MY_PATHS_LOOKBACK;
  let c = base <= 0 ? -1 : Math.floor((base - 1) / CHECKPOINT_EVERY) * CHECKPOINT_EVERY;
  for (;;) {
    const done = await walkFrom(repo, tip, top, c, o, capFrom);
    if (done !== null) {
      const { report, seen } = done;
      const saves = [...seen.saves];
      return {
        report,
        joinHeight: seen.joinHeight,
        saves: (prefix: string): readonly number[] => {
          const p = prefix.toLowerCase();
          return saves.filter(([commit]) => commit.startsWith(p)).map(([, h]) => h).sort((x, y) => x - y);
        },
      };
    }
    c -= CHECKPOINT_EVERY;   // c > 0 here: a checkpoint that does not parse at its height
  }
}

/**
 * The walk from checkpoint height c (> 0: its checkpoint/state.json is the start state, null when it does not parse at c;
 * 0: B0 folded from the empty state, not pushed; −1: every commit from B0 pushed onto the empty state) up to `to`.
 */
async function walkFrom(repo: GitRepo, tip: Oid, top: number, c: number, o: WalkSinceOptions, capFrom: number | null): Promise<{ report: SinceReport; seen: Seen } | null> {
  const lo = Math.max(c, 0);
  const chain = await repo.firstParents(tip, null, top - lo + 1);   // newest first: chain[k] is at height top − k
  if (chain.length !== top - lo + 1) throw new Error(`walkSince: the first-parent chain of ${tip} is shorter than its count`);
  const items = Array.from({ length: o.to - lo + 1 }, (_, i) => ({ oid: chain[top - lo - i]!, height: lo + i }));
  const seen: Seen = { joinHeight: null, saves: new Map() };
  const opts = o.verifiedLabel === undefined ? undefined : { verifiedLabel: o.verifiedLabel };
  let state: FoldState | null = null;
  let acc: SinceAcc | null = null;
  let protocol: ProtocolJson = readProtocol(null);
  let liveCode: Oid | null = null;
  let done = 0;
  while (done < items.length) {
    const { reads, next } = await readBoardCommits(repo, items.slice(done, done + READ_BATCH_MAX));
    if (next === 0) throw new Error('walkSince: a batched read made no progress');
    for (const r of reads) {
      if (state === null) {
        // The first item, at height lo.
        if (c > 0) {
          if (isBoardReadFailure(r) || r.checkpoint === null) return null;
          const s = parseFold(r.checkpoint);
          if (s === null || s.height !== c) return null;
          state = s;
          protocol = r.protocol;
          liveCode = r.liveCode;
          acc = sinceInit(s, o.from, o.you, o.mine, opts);
          continue;
        }
        const start = initialFoldState(isBoardReadFailure(r) ? protocol : r.protocol);
        if (c === 0) {
          const data = readOrNoop(r, protocol, liveCode);
          const f = foldCommit(start, data, o.you);
          note(seen, data, start, f.opVerdicts, o.you);
          state = f.state;
          protocol = data.protocol;
          liveCode = data.liveCode;
          acc = sinceInit(f.state, o.from, o.you, o.mine, opts);
          continue;
        }
        state = start;
        acc = sinceInit(start, o.from, o.you, o.mine, opts);
      }
      const data = readOrNoop(r, protocol, liveCode);
      const f = foldCommit(state, data, o.you);
      note(seen, data, state, f.opVerdicts, o.you);
      acc = sincePush(acc!, { data, verdicts: f.opVerdicts, after: f.state });
      state = f.state;
      protocol = data.protocol;
      liveCode = data.liveCode;
    }
    done += next;
  }
  return { report: sinceFinish(acc!, capFrom), seen };
}

/**
 * The read itself, or for a BoardReadFailure the no-op draft of 8a's R-V19 as a BoardRead: writer null, no ops, no trailers,
 * no held ids, checkpoint null, the previous protocol and live code (the zero id before any readable commit). Its other
 * fields are placeholders nothing reads.
 */
function readOrNoop(r: BoardRead | BoardReadFailure, protocol: ProtocolJson, liveCode: Oid | null): BoardRead {
  if (!isBoardReadFailure(r)) return r;
  const zero = parseOid('0'.repeat(r.oid.length));
  return {
    oid: r.oid, parents: [], firstParent: null, liveCode: liveCode ?? zero, writer: null, cs: [], protocol, opsLines: [], checkpoint: null, heldIds: [],
    height: r.height, info: { oid: r.oid, tree: zero, parents: [], subject: '', trailers: [] }, csPaths: new Map(), live: null,
  };
}

/** What a folded commit tells resolveSinceAnchor: an epoch start of `you` and its effective saves. */
function note(seen: Seen, d: BoardRead, before: FoldState, verdicts: readonly OpVerdict[], you: PeerId): void {
  const w = d.writer;
  if (w === null) return;
  for (const v of verdicts) {
    if (v.verdict !== 'effective') continue;
    if (v.type === 'join' && w.peer === you) {
      const rec = Object.prototype.hasOwnProperty.call(before.peers, you) ? before.peers[you] : undefined;
      if (rec === undefined || rec.epoch !== w.epoch) seen.joinHeight = d.height;
    } else if (v.type === 'save') {
      const op = parseOpLine(d.opsLines[v.line] ?? '');
      if (op !== null && op.type === 'save') {
        const commit = op.save_commit.toLowerCase();
        seen.saves.delete(commit);
        seen.saves.set(commit, d.height);
      }
    }
  }
}

const HEIGHT_ANCHOR = /^#(0|[1-9][0-9]{0,9})$/;
/** A well-formed `save:<oid>` anchor (7–64 hex, 10-product §3.9a); the CLI sends any other `save:` value down the tip-only path. */
export const SAVE_ANCHOR = /^save:([0-9a-fA-F]{7,64})$/;

/**
 * The `from` of a `--since` value (10-product §3.9a anchor table; FEAT-F04-02): '#<n>' (decimal, no leading zero, ≤ 10 digits)
 * when n is below the tip; 'save:<7–64 hex>' the height of the one effective save whose save commit starts with that prefix
 * (case-insensitive; several save commits → AMBIGUOUS_ID); null (no flag) this peer's join height (`last-run` and the local
 * marks are Plan 5's, so before Plan 5 the default is the own-join fallback). Every other value, `last-run` and `away`
 * included, and an anchor that does not resolve → RF_SINCE_ANCHOR (FEAT-F04-17: F04 defines no `away`).
 *
 * `ctx` is the board as the anchor table reads it, and the CLI takes it from sinceAnchors (final review M8): `tip` the board
 * tip's height; `joinHeight` this peer's newest join (the start of its current epoch), found by a search that no fold window
 * bounds; `saves` for a `save:` anchor the saves of the whole first-parent chain (sinceAnchors' wholeChain), so a save below
 * that join resolves and a prefix matching saves on both sides of it is AMBIGUOUS_ID. walkSince's joinHeight and saves are
 * the same lookups limited to the commits its walk folds (the range less 1,024 heights and a checkpoint), and its joinHeight
 * is the newest join that started an epoch by the fold's records: a ctx built from them would refuse a join or a save below
 * that window.
 */
export function resolveSinceAnchor(v: string | null, ctx: { tip: number; joinHeight: number | null; saves: (prefix: string) => readonly number[] }): { from: number } | { refuse: 'RF_SINCE_ANCHOR' | 'AMBIGUOUS_ID' } {
  const refuse = { refuse: 'RF_SINCE_ANCHOR' } as const;
  if (v === null) return ctx.joinHeight === null ? refuse : { from: ctx.joinHeight };
  const height = HEIGHT_ANCHOR.exec(v);
  if (height !== null) {
    const n = Number(height[1]);
    return n < ctx.tip ? { from: n } : refuse;
  }
  const save = SAVE_ANCHOR.exec(v);
  if (save !== null) {
    const hs = ctx.saves(save[1]!.toLowerCase());
    if (hs.length > 1) return { refuse: 'AMBIGUOUS_ID' };
    return hs.length === 1 ? { from: hs[0]! } : refuse;
  }
  return refuse;
}

/**
 * What resolveSinceAnchor needs from the board (its tip height, this peer's join height, the save lookup), and saveCommits(prefix),
 * the matching save commits in the order of saves(prefix), for the anchor's name (UI_SINCE_ANCHOR_SAVE: the matched commit as 8 hex).
 * tipOid is the tip the search read, for walkSince's `tip` option (one chain for the anchor and the walk, final review M3).
 */
export interface SinceAnchors { tip: number; tipOid: Oid; joinHeight: number | null; saves: (prefix: string) => readonly number[]; saveCommits: (prefix: string) => readonly string[]; }

/**
 * The search behind the anchors of `since` (controller ruling A3, F04-a): a walk of its own, independent of walkSince's fold
 * window, so that a plain `since` (default anchor: this peer's join, as nothing writes meta.since before Plan 5) never fails
 * because the join is older than the heights walkSince folds. It reads branch b's board ref once and that tip's chain from
 * the tip down, newest first, READ_BATCH_MAX board commits per round through readBoardCommits (board objects only), and
 * parses each commit's ops.jsonl lines: no fold. An op counts when its line parses and its op id names the commit's
 * Cowork-Writer (peer and epoch), the fold's attribution rule; the fold's other checks (a retired epoch, a stale seq) are
 * not applied, so an op the fold rejects can still count here. An unreadable board commit has no ops.
 *
 * By default the search stops at this peer's newest join (inclusive), else at B0: every join the engine writes starts a new
 * epoch (start, restart and recover's re-anchor), so that commit is the start of the peer's current epoch (10-product §3.9a
 * "(omitted)"), and the default anchor needs nothing older. With wholeChain (a `save:` anchor; final review I1) it reads the
 * whole chain down to B0: the anchor table puts no join bound on `save:<oid>`, so a save below this peer's newest join
 * resolves, and a prefix matching saves on both sides of it is ambiguous. Returned: `tip`, the board tip's height, and
 * `tipOid`, its oid; `joinHeight`, the newest join's height (the first join of `you` the search meets, in either mode) or
 * null; `saves(prefix)`, the heights of the counted save ops in the searched commits (without wholeChain a save below that
 * join is not found) whose save commit starts with `prefix`, one per distinct save commit (its newest), ascending, compared
 * case-insensitively; saveCommits(prefix), those commits in lower case. With tipOnly (an anchor that needs neither: '#<n>'),
 * nothing below the tip is read: joinHeight null, no saves. null when the branch has no board; throws when its ref names no
 * board commit.
 */
export async function sinceAnchors(repo: GitRepo, b: string, you: PeerId, o: { tipOnly?: boolean; wholeChain?: boolean } = {}): Promise<SinceAnchors | null> {
  const ref = `refs/cowork-remote/${enc(b)}/board`;
  const tipOid = await repo.readRef(ref);
  if (tipOid === null) return null;
  const tip = (await repo.firstParentCount(tipOid)) - 2;   // see walkSince: the chain below B0 ends at L0
  if (tip < 0) throw new Error(`sinceAnchors: ${ref} does not name a board commit`);
  const whole = o.wholeChain === true;
  const found = new Map<string, number>();   // save commit (lower case) → the height of its newest counted save op
  let joinHeight: number | null = null;
  /** The search goes on below the commit just read: always with wholeChain, else until the newest join is found. */
  const more = (): boolean => whole || joinHeight === null;
  let cursor: Oid | null = o.tipOnly === true ? null : tipOid;
  let h = tip;   // the height of cursor
  while (cursor !== null) {
    const n = Math.min(READ_BATCH_MAX, h + 1);
    // Newest first: page[k] is at height h − k; page[n], when h − n ≥ 0, starts the next page.
    const page = await repo.firstParents(cursor, null, n + 1);
    if (page.length < n) throw new Error(`sinceAnchors: the first-parent chain of ${cursor} is shorter than its count`);
    const items = page.slice(0, n).map((oid, k) => ({ oid, height: h - k }));
    let done = 0;
    while (done < items.length && more()) {
      const { reads, next } = await readBoardCommits(repo, items.slice(done, done + READ_BATCH_MAX));
      if (next === 0) throw new Error('sinceAnchors: a batched read made no progress');
      for (const r of reads) {
        if (isBoardReadFailure(r) || r.writer === null) continue;
        if (countOps(r, you, found) && joinHeight === null) {
          joinHeight = r.height;
          if (!whole) break;
        }
      }
      done += next;
    }
    h -= n;
    cursor = more() && h >= 0 ? (page[n] ?? null) : null;
  }
  const matching = (prefix: string): Array<[string, number]> => {
    const p = prefix.toLowerCase();
    return [...found].filter(([commit]) => commit.startsWith(p)).sort(([, x], [, y]) => x - y);
  };
  return {
    tip,
    tipOid,
    joinHeight,
    saves: (prefix: string): readonly number[] => matching(prefix).map(([, at]) => at),
    saveCommits: (prefix: string): readonly string[] => matching(prefix).map(([commit]) => commit),
  };
}

/** One board commit's counted ops (see sinceAnchors): its saves into `found` (an earlier, newer one kept); true when it holds a join of `you`. */
function countOps(r: BoardRead, you: PeerId, found: Map<string, number>): boolean {
  const w = r.writer!;
  let joined = false;
  for (const line of r.opsLines) {
    const op = parseOpLine(line);
    const id = op === null ? null : parseOpId(op.id);
    if (op === null || id === null || id.peer !== w.peer || id.epoch !== w.epoch) continue;
    if (op.type === 'save') {
      const commit = op.save_commit.toLowerCase();
      if (!found.has(commit)) found.set(commit, r.height);
    } else if (op.type === 'join' && w.peer === you) {
      joined = true;
    }
  }
  return joined;
}

/** The git runner openBoard builds, from these deps; tests wrap it to see every call (T-F04-readonly's argv spy). */
export interface SinceDeps { gitRunner(d: GitRunnerDeps): GitRunner; }
const REAL_DEPS: SinceDeps = { gitRunner: createGitRunner };

/** What openBoard reads of the CLI's environment (8a's CliEnv is assignable): its clock, process environment and platform. */
export interface BoardEnv { readonly clock: Clock; readonly env: Readonly<Record<string, string | undefined>>; readonly platform: NodeJS.Platform; }

/**
 * The repository of the main worktree `paths` as `since` reads it, and the branch its HEAD names (F04-a Task A3 fix r1 ruling:
 * this file is the one of src/since that reads git, so the CLI's runner is built here). The runner is the daemon probe's —
 * hooks at `<coworkDir>/empty-hooks`, the daemon environment (buildDaemonEnv, no passthrough) — and every call runs as class
 * 'local'. The branch comes from `symbolic-ref --quiet HEAD` (a ref read). null when HEAD is detached, names no refs/heads/
 * branch, or names one enc() refuses (such a branch has no board); whether the branch has a board is sinceAnchors' answer.
 */
export async function openBoard(paths: RepoPaths, env: BoardEnv, deps: SinceDeps = REAL_DEPS): Promise<{ repo: GitRepo; branch: string } | null> {
  const runner = deps.gitRunner({
    clock: env.clock,
    hooksPath: (env.platform === 'win32' ? win32 : posix).join(paths.coworkDir, 'empty-hooks'),
    daemonEnv: buildDaemonEnv({ ...env.env }, []),
    platform: env.platform,
  });
  const ctx = (): RepoContext => ({ attrTree: null, filterDrivers: [], identity: { name: 'cowork', email: 'cli@cowork.invalid' }, wallMs: () => env.clock.wallMs() });
  const repo = new GitRepo(runner, paths, ctx);
  const r = await repo.run(['symbolic-ref', '--quiet', 'HEAD'], { okCodes: [0, 1] });
  const ref = r.code === 0 ? r.stdout.toString('utf8').trim() : '';
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : '';
  if (branch.length === 0) return null;
  try {
    enc(branch);
  } catch (e) {
    if (e instanceof EncTooLongError) return null;
    throw e;
  }
  return { repo, branch };
}
