// The test-only teammate writer (Plan 3 Task 13; ruling R3-47's non-conforming writer, I-DAT-13's shape). A synthetic teammate with its
// own peer id and epoch lands one live commit per call — the given bytes stored verbatim (route (c), no canon) or, on request, as a
// conforming writer stores them (03-data §3.2 D1: canon against TIP's blob) — with Cowork-CS / Cowork-CS-Paths trailers and its board
// commit, both leased on what it fetched, commit dates on a virtual wall clock. CoreFixture.pushTeamChange delegates here (its body
// moved here unchanged); in the SIM the writer is a bare clone <root>/team.git (createTeamWriter) and its markers are authored `team`.
import { existsSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildBoardCommit, CODE_SUBJECT, liveCommitTrailers, readBoardCommit, type CsTrailer, type WriterId } from '../../src/board/boardCommit.js';
import { CHECKPOINT_EVERY, foldCommit, Folder, serializeFold } from '../../src/board/fold.js';
import { newEpoch, newPeerId, type PeerId } from '../../src/board/ids.js';
import { canon } from '../../src/data/canon.js';
import { PLAN2_REGION_SPEC } from '../../src/engine/deps.js';
import type { RefNames } from '../../src/engine/refs.js';
import { fetchRefs } from '../../src/git/fetch.js';
import { ABSENT, type Oid, type OidOrAbsent } from '../../src/git/oid.js';
import { pushSpec, runPush } from '../../src/git/push.js';
import { GitRepo, type FileMode, type MktreeEntry, type RepoContext } from '../../src/git/repo.js';
import type { GitRunner } from '../../src/git/runner.js';
import type { Random } from '../../src/ports/random.js';
import { validPathSyntax } from '../../src/sec/validators.js';
import type { SimContext } from './harness.js';

/** The teammate: its peer id and epoch, the seq of its last writer id (0 before its first push), and its clone (bare or not). */
export interface TeamWriter { readonly peer: PeerId; readonly epoch: string; seq: number; readonly dir: string; }

/** A bare clone <root>/team.git of the SIM remote with a fresh teammate id and epoch drawn from `random` (seededRandom(`${seed}/team`)). */
export async function createTeamWriter(ctx: SimContext, random: Random): Promise<TeamWriter> {
  const dir = join(ctx.root, 'team.git');
  const r = await ctx.git.run(['clone', '--bare', '-q', ctx.remote.url, dir], { class: 'network', cwd: ctx.root });
  if (r.code !== 0) throw new Error(`createTeamWriter: git clone --bare failed (${r.code}): ${r.stderr.toString('utf8').trim()}`);
  return { peer: newPeerId(random), epoch: newEpoch(random), seq: 0, dir: realpathSync.native(dir) };
}

/** The writer's repository: a bare clone (git dir = dir) or a work-tree clone (git dir = dir/.git). */
async function repoOf(git: GitRunner, w: TeamWriter, wallMs: number): Promise<GitRepo> {
  const bare = !existsSync(join(w.dir, '.git'));
  const gitDir = bare ? w.dir : join(w.dir, '.git');
  const paths = { workTree: w.dir, gitDir, coworkDir: join(gitDir, 'cowork') };
  await mkdir(paths.coworkDir, { recursive: true });
  const ctx = (): RepoContext => ({ attrTree: null, filterDrivers: [], identity: { name: 'Teammate', email: `${w.peer}@cowork.invalid` }, wallMs: () => wallMs });
  return new GitRepo(git, paths, ctx);
}

/**
 * A tree = `base` with whole-path edits, built bottom-up with mktree (test code only: a teammate on another OS can commit
 * names that git for Windows refuses in any index even with core.protectNTFS=false, such as `a:b.txt`).
 */
async function editTreeRaw(repo: GitRepo, base: Oid, edits: ReadonlyArray<{ path: string; mode: FileMode; oid: Oid } | { path: string; remove: true }>): Promise<Oid> {
  const leaves = new Map<string, { mode: FileMode; oid: Oid }>();
  for (const [p, e] of await repo.readTreeMap(base)) leaves.set(p, { mode: e.mode, oid: e.oid });
  for (const e of edits) {
    if ('remove' in e) leaves.delete(e.path);
    else leaves.set(e.path, { mode: e.mode, oid: e.oid });
  }
  const build = async (prefix: string): Promise<Oid> => {
    const entries: MktreeEntry[] = [];
    const dirs = new Set<string>();
    for (const [p, e] of leaves) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push({ name: rest, mode: e.mode, type: e.mode === '160000' ? 'commit' : 'blob', oid: e.oid });
      else dirs.add(rest.slice(0, slash));
    }
    for (const d of dirs) entries.push({ name: d, mode: '040000', type: 'tree', oid: await build(`${prefix}${d}/`) });
    return repo.mktree(entries);
  };
  return build('');
}

/**
 * A conforming writer's stored form (03-data §3.2 D1): canon(bytes, ref) against the regular blob TIP holds for the path; a new path,
 * a special entry or a canon refusal keeps the bytes as given.
 */
async function conforming(repo: GitRepo, tipEntry: { mode: FileMode; oid: Oid } | undefined, bytes: Buffer): Promise<Buffer> {
  if (tipEntry === undefined || (tipEntry.mode !== '100644' && tipEntry.mode !== '100755')) return bytes;
  const c = canon(bytes, await repo.readBlob(tipEntry.oid), false);
  return c.ok ? c.out : bytes;
}

/**
 * One live commit storing the given bytes verbatim (route (c), no canon; null = delete) with Cowork-CS/Cowork-CS-Paths trailers and its
 * board commit, leased; commit dates = wallMs. Extension: `conform` stores each path a conforming writer would (canon against TIP's
 * blob; CoreFixture.pushTeamChange's default). The CS id defaults to `<peer>/human/<seq>`; a change naming a path that fails
 * validPathSyntax carries no CS trailer (the receiver reads the commit as one change-set, HLD-37). Each call takes the next seq.
 */
export async function teamPush(
  git: GitRunner, remoteUrl: string, refs: RefNames, w: TeamWriter, changes: Readonly<Record<string, Buffer | null>>,
  o: { csId?: string; wallMs: number; conform?: boolean },
): Promise<{ board: Oid; live: Oid }> {
  const repo = await repoOf(git, w, o.wallMs);
  const f = await fetchRefs(repo, remoteUrl, refs.fetchSpecs);
  const T = f.values.get(refs.remoteBoard);
  if (!f.ok || T === undefined || T === ABSENT) throw new Error('teamPush: no board on the remote (bootstrap first)');
  const mirror: OidOrAbsent = f.values.get(refs.remoteCode) ?? ABSENT;
  const b = await repo.readCommit(T);
  const tip = b.parents[b.parents.length - 1] as Oid;
  const tipTree = (await repo.readCommit(tip)).tree;
  const tipMap = await repo.readTreeMap(tipTree);
  const paths = Object.keys(changes).sort();
  const edits: Array<{ path: string; mode: FileMode; oid: Oid } | { path: string; remove: true }> = [];
  for (const path of paths) {
    const bytes = changes[path] ?? null;
    if (bytes === null) edits.push({ path, remove: true });
    else edits.push({ path, mode: tipMap.get(path)?.mode === '100755' ? '100755' : '100644', oid: await repo.hashBytes(o.conform === true ? await conforming(repo, tipMap.get(path), bytes) : bytes, true) });
  }
  const tree = await editTreeRaw(repo, tipTree, edits);
  const seq = ++w.seq;
  const writer: WriterId = { peer: w.peer, epoch: w.epoch, seq };
  const csId = o.csId ?? `${w.peer}/human/${seq}`;
  // Cowork-CS-Paths can name only paths that pass validPathSyntax: a change with any other path carries no CS
  // trailer at all, and the receiver reads it as one change-set of the whole commit (HLD-37).
  const listable = paths.every((p) => validPathSyntax(p));
  const cs: CsTrailer[] = listable ? [{ csId, state: 'closed', seq, origin: 'human', checks: 'skipped', paths: paths.length }] : [];
  const csPaths = new Map<string, string[]>(listable && paths.length <= 256 ? [[csId, paths]] : []);
  const live = await repo.commitTree({ tree, parents: [tip], subject: CODE_SUBJECT, trailers: liveCommitTrailers(writer, ['human'], cs, csPaths, null) });
  // A board commit at a checkpoint height carries the fold's checkpoint (PRO-26).
  const height = (await repo.firstParentCount(T)) - 2 + 1;
  let checkpoint: Buffer | null = null;
  if (height % CHECKPOINT_EVERY === 0) {
    const folded = await new Folder(repo, w.peer).foldTo(T, null, PLAN2_REGION_SPEC);
    const protocol = (await readBoardCommit(repo, T)).protocol;
    const next = foldCommit(folded.state, { liveCode: live, writer, cs, protocol, opsLines: [], checkpoint: null, heldIds: [] }, w.peer);
    checkpoint = serializeFold(next.state);
  }
  const board = await buildBoardCommit(repo, { prevBoard: T, liveCode: live, writer, ops: [], cs, csPaths, protocol: null, checkpoint });
  const out = await runPush(repo, remoteUrl, [pushSpec(board, refs.remoteBoard, T), pushSpec(live, refs.remoteCode, mirror)], []);
  if (out.statuses.get(refs.remoteBoard) !== 'ok') throw new Error(`teamPush: the board push did not land (exit ${out.code})`);
  return { board, live };
}
