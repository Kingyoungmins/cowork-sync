// The incident check (01-engine §3.7 CHECK; ENG-20; INV-FIRSTPARENT) and live_base (R-08). Inputs are oids only — the
// state's LA_B and LA_C and the fetched board tip T — so the mirror and the displaced refs can never be inputs
// (PRO-13, INV-ENG-AUTH; lint L-MIRROR keeps RefNames' mirror names out of this file).
//
// FP_OK(old, new): new == old, or L = rev-list --first-parent old..new is non-empty and parent1(oldest(L)) == old: old
// is on new's first-parent chain. A bare ancestry test would pass a rewrite that keeps the old chain as a second parent.
//
// Cost: the check reads whole ranges in batches, so a peer returning after a day with a thousand new board commits
// does not stall its loop: at most 10 git calls when each of its two batched commit reads (the board range, and the
// range's new live code commits) totals at most 32 MiB of commit objects (any realistic range), plus one more
// `cat-file --batch` per further chunk of up to 32 MiB (BATCH_READ_MAX_BYTES) in each. The last verified
// (LA_B, LA_C, T) of each repo is remembered, so an unchanged range (an idle iteration) costs no git call.
import { boardShapeOk, checkBoardCommits, liveShape, readCommitsChecked, RemoteContentError, type CheckedBoardCommit } from '../board/boardCommit.js';
import { ABSENT, isOid, parseOid, type Oid, type OidOrAbsent } from '../git/oid.js';
import type { GitRepo } from '../git/repo.js';
import { parseMessage } from '../git/trailers.js';
import type { MutantId } from './deps.js';

const BASE_KEY = 'Cowork-Base';

export type IncidentWhy = 'board_missing' | 'board_not_ff' | 'code_not_ff' | 'board_shape' | 'live_shape';
export type IncidentVerdict = { ok: true } | { ok: false; why: IncidentWhy; observedBoard: Oid | null; observedCode: Oid | null };

/** The last range incidentCheck found ok, per repo (verdicts depend on immutable objects only). */
const lastVerified = new WeakMap<GitRepo, { laB: Oid; laC: Oid; T: Oid }>();

/**
 * The commits of old..next along first parents, newest first, when FP_OK(old, next) holds; null otherwise. One
 * `rev-list --first-parent --format=%H %P`: the oldest listed commit's first parent must be old (only the first
 * entry of %P is read, whichever parents git lists under --first-parent).
 */
async function firstParentRange(repo: GitRepo, old: Oid, next: Oid): Promise<Oid[] | null> {
  parseOid(old);
  parseOid(next);
  if (old === next) return [];
  const r = await repo.run(['rev-list', '--first-parent', '--no-commit-header', '--format=%H %P', next, `^${old}`]);
  const range: Oid[] = [];
  let oldestParent: string | undefined;
  for (const line of r.stdout.toString('utf8').split('\n')) {
    const words = line.split(' ').filter((w) => w.length > 0);
    if (words.length === 0) continue;
    range.push(parseOid(words[0]!));
    oldestParent = words[1];
  }
  if (range.length === 0 || range[0] !== next) return null;   // next is old's ancestor (a rewind), or old itself
  return oldestParent === old ? range : null;
}

export async function fpOk(repo: GitRepo, old: Oid, next: Oid): Promise<boolean> {
  return (await firstParentRange(repo, old, next)) !== null;
}

/**
 * FP_OK(LA_B, T), FP_OK(LA_C, TIP), shapes on LA_B..T and LA_C..TIP, board present; never reads the mirror or displaced refs.
 * Mutant M07: always ok.
 *
 * Order: T absent → board_missing; T == LA_B → ok (nothing new: the transition that set LA_B checked it, or this peer
 * built it); T not a readable board commit (readBoardCommit's refusals: not a commit, no parent, over a cap) →
 * board_shape; ¬FP_OK(LA_B, T) → board_not_ff; ¬FP_OK(LA_C, TIP) → code_not_ff (TIP = T's last parent); then every
 * board commit of LA_B..T, oldest first: readBoardCommit's refusals → board_shape, the board shape with its first
 * parent the previous board commit (board_shape), and its last parent either the previous board commit's live code
 * commit (board-only) or one live step from it, ordinary or base move (live_shape: a last parent that jumps, a commit
 * without the markers, a stray Cowork-Base, an oversized or non-commit live code). The walk starts from
 * live_code(LA_B), which is LA_C except after an own base-move publish (ENG-44 leaves LA_C unchanged there); with
 * FP_OK(LA_C, TIP) every live commit of LA_C..TIP is then on TIP's first-parent chain with one of the three shapes.
 * A missing local object throws (plain Error); it is never a verdict.
 *
 * Git calls: T and LA_B (checkBoardCommits, 3), the board range (1), the code range (0–1), the other board commits of
 * the range (checkBoardCommits, 0, or 2 + one `cat-file --batch` per chunk of up to 32 MiB of those commit objects),
 * their new live code commits (readCommitsChecked, 0, or 1 + one `cat-file --batch` per such chunk). A chunk closes
 * only when the next commit (≤ 1 MiB) would pass 32 MiB, so every closed chunk holds over 31 MiB: a read of at most
 * 32 MiB is one chunk, and the check then takes 10 calls at most.
 */
export async function incidentCheck(repo: GitRepo, laB: Oid, laC: Oid, T: OidOrAbsent, mutants: ReadonlySet<MutantId>): Promise<IncidentVerdict> {
  if (mutants.has('M07')) return { ok: true };
  parseOid(laB);
  parseOid(laC);
  if (T === ABSENT) return { ok: false, why: 'board_missing', observedBoard: null, observedCode: null };
  if (parseOid(T) === laB) return { ok: true };
  const last = lastVerified.get(repo);
  if (last !== undefined && last.laB === laB && last.laC === laC && last.T === T) return { ok: true };
  const verdict = await check(repo, laB, laC, T);
  if (verdict.ok) lastVerified.set(repo, { laB, laC, T });
  return verdict;
}

async function check(repo: GitRepo, laB: Oid, laC: Oid, T: Oid): Promise<IncidentVerdict> {
  const fail = (why: IncidentWhy, observedCode: Oid | null): IncidentVerdict => ({ ok: false, why, observedBoard: T, observedCode });
  // T first (its refusal is the first verdict), with LA_B, whose last parent is live_code(LA_B).
  const [t, b] = await checkBoardCommits(repo, [T, laB]) as [CheckedBoardCommit, CheckedBoardCommit];
  if (t.commit === null || t.refused !== null) return fail('board_shape', null);
  if (b.commit === null || b.refused !== null) throw new Error(`incidentCheck: LA_B ${laB} is not a readable board commit (${b.refused ?? 'unknown'})`);
  const tip = lastParent(t.commit.parents);
  const range = await firstParentRange(repo, laB, T);
  if (range === null) return fail('board_not_ff', tip);
  if (!(await fpOk(repo, laC, tip))) return fail('code_not_ff', tip);

  // Oldest first, T last.
  const chain = [...range].reverse();
  const below = chain.slice(0, -1);
  const boards = [...(below.length > 0 ? await checkBoardCommits(repo, below) : []), t];
  // The board level: the first commit that is refused or misshapen.
  let bad = chain.length;
  let prevBoard = laB;
  for (let i = 0; i < chain.length; i++) {
    const c = boards[i]!;
    if (c.commit === null || c.refused !== null || !boardShapeOk(c.commit, prevBoard)) {
      bad = i;
      break;
    }
    prevBoard = chain[i]!;
  }
  // The live steps of the board commits before it; each new live code commit is read once, in one batch.
  const steps: Array<{ prev: Oid; live: Oid }> = [];
  let prevLive = lastParent(b.commit.parents);
  for (let i = 0; i < bad; i++) {
    const live = lastParent(boards[i]!.commit!.parents);
    steps.push({ prev: prevLive, live });
    prevLive = live;
  }
  const toRead = [...new Set(steps.filter((s) => s.live !== s.prev).map((s) => s.live))];
  const lives = new Map(toRead.map((o, k) => [o, k] as const));
  const read = await readCommitsChecked(repo, toRead);
  for (const s of steps) {
    if (s.live === s.prev) continue;                               // board-only: repeats the last parent
    const c = read[lives.get(s.live)!]!;
    if (c.commit === null || liveShape(c.commit, s.prev) === null) return fail('live_shape', tip);
  }
  return bad < chain.length ? fail('board_shape', tip) : { ok: true };
}

/** A board commit's live code commit: its last parent (checkBoardCommits refused every commit without one). */
function lastParent(parents: readonly Oid[]): Oid {
  const p = parents[parents.length - 1];
  if (p === undefined) throw new Error('incidentCheck: a board commit without parents passed the check');
  return p;
}

export interface LiveBase { base: Oid; introducedBy: Oid; }

/** The last liveBase answer per repo: live_base depends on immutable commits only, so (tip → answer) never goes stale. */
const lastBase = new WeakMap<GitRepo, { tip: Oid } & LiveBase>();

/** The line `rev-list --grep=^Cowork-Base: ` matches (per line, case-sensitive): both walks see the same candidates. */
const BASE_LINE = new RegExp(`^${BASE_KEY}: `, 'm');

/** `%x00%H%n%P%n%B` records of rev-list, in its order (newest first): NUL-led, so a message cannot forge one. */
interface BaseRecord { oid: Oid; parents: Oid[]; body: string; }
function baseRecords(stdout: Buffer): BaseRecord[] {
  return stdout.toString('utf8').split('\0').slice(1).map((record) => {
    const nl1 = record.indexOf('\n');
    const nl2 = nl1 < 0 ? -1 : record.indexOf('\n', nl1 + 1);
    if (nl2 < 0) throw new Error(`liveBase: unexpected rev-list output ${JSON.stringify(record.slice(0, 120))}`);
    const parents = record.slice(nl1 + 1, nl2).split(' ').filter((p) => p.length > 0).map((p) => parseOid(p));
    return { oid: parseOid(record.slice(0, nl1)), parents, body: record.slice(nl2 + 1) };
  });
}

/**
 * The base a record introduces, or null when it introduces none: a Cowork-Base line that is not in its trailer
 * paragraph (liveShape's rule: an ordinary commit here as there). More than one Cowork-Base trailer, a value that is no
 * oid, or a shape that is neither a genesis (no parents) nor a base move (Cowork-Base == its second parent) is remote
 * content no board chain holds: RemoteContentError (typed at its source, Task 15 ruling).
 */
function baseOf(r: BaseRecord): LiveBase | null {
  if (!BASE_LINE.test(r.body)) return null;
  const bases = parseMessage(r.body).trailers.filter((t) => t.key === BASE_KEY);
  if (bases.length === 0) return null;                             // the line is in the body, not a trailer
  if (bases.length !== 1) throw new RemoteContentError(`liveBase: ${r.oid} carries ${bases.length} ${BASE_KEY} trailers`);
  const value = bases[0]!.value;
  if (!isOid(value)) throw new RemoteContentError(`liveBase: ${r.oid} carries a ${BASE_KEY} trailer that is no oid`);
  const base = parseOid(value);
  if (!(r.parents.length === 0 || (r.parents.length === 2 && r.parents[1] === base))) {
    throw new RemoteContentError(`liveBase: ${r.oid} is neither a genesis nor a base move`);
  }
  return { base, introducedBy: r.oid };
}

/**
 * The whole first-parent chain of L, in one call: rev-list --first-parent --grep=^Cowork-Base: lists, newest first,
 * every commit with such a line (a message never holds a NUL: git prints a message only up to its first NUL, and the
 * forced fetch.fsckObjects refuses one); the first that introduces a base is the answer.
 */
async function fullWalk(repo: GitRepo, L: Oid): Promise<LiveBase> {
  const r = await repo.run(['rev-list', '--first-parent', '--no-commit-header', `--grep=^${BASE_KEY}: `, '--format=%x00%H%n%P%n%B', L]);
  for (const record of baseRecords(r.stdout)) {
    const found = baseOf(record);
    if (found !== null) return found;
  }
  throw new RemoteContentError(`liveBase: no ${BASE_KEY} trailer on the first-parent chain of ${L}`);
}

/**
 * Only the commits of last.tip..L along first parents, in one call, when last.tip is on L's first-parent chain (the
 * oldest listed commit's first parent is last.tip — FP_OK's test; a rev-list stopped by a commit that is merely
 * reachable from last.tip fails it): the newest of them that introduces a base, else last's answer. null when
 * last.tip is not on the chain (a rewind, a rewrite, another chain), and when git exits 128 because last.tip's object
 * is gone (an abandoned TIP pruned after a rewrite: `bad object`): the caller walks the whole chain, and its answer
 * replaces the stale memo. Any other exit code throws.
 */
async function sinceLast(repo: GitRepo, L: Oid, last: { tip: Oid } & LiveBase): Promise<LiveBase | null> {
  const r = await repo.run(['rev-list', '--first-parent', '--no-commit-header', '--format=%x00%H%n%P%n%B', L, `^${last.tip}`], { okCodes: [0, 128] });
  if (r.code === 128) return null;                                 // stdout is not read: git stopped on a bad revision
  const records = baseRecords(r.stdout);
  const oldest = records[records.length - 1];
  if (oldest === undefined || records[0]!.oid !== L || oldest.parents[0] !== last.tip) return null;
  for (const record of records) {
    const found = baseOf(record);
    if (found !== null) return found;
  }
  return { base: last.base, introducedBy: last.introducedBy };
}

/**
 * live_base(L): X of the newest base-move commit on L's first-parent chain, else the genesis Cowork-Base; with the
 * commit that introduced it.
 *
 * Cost (R-08 computes Hb = live_base(TIP) every iteration): the last answer of each repo is kept, so the same L again
 * costs no git call, and an L whose first-parent chain continues the last one costs one rev-list over the new commits
 * only (one commit per publish in the normal case). Any other L (the first call, a rewind, a rewrite, a last tip
 * whose object was pruned) is walked in full: one rev-list --grep, after the failed incremental call when there was a
 * last answer. A missing L throws (GitCommandError from the whole-chain walk: a local failure); a chain without a base,
 * or with a misshapen base commit, throws RemoteContentError (remote content).
 */
export async function liveBase(repo: GitRepo, L: Oid): Promise<LiveBase> {
  parseOid(L);
  const last = lastBase.get(repo);
  if (last !== undefined && last.tip === L) return { base: last.base, introducedBy: last.introducedBy };
  const found = (last !== undefined ? await sinceLast(repo, L, last) : null) ?? (await fullWalk(repo, L));
  lastBase.set(repo, { tip: L, base: found.base, introducedBy: found.introducedBy });
  return { base: found.base, introducedBy: found.introducedBy };
}
