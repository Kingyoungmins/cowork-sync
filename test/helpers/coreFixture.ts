// N peers with EngineCores on real clones of one file:// bare remote, with virtual clocks, one VirtualScheduler, a
// FaultFs over the real disk per peer and one TraceRecorder (Plan 2 Task 13). bootstrap() is the test-only stand-in
// for genesis and join until Task 15; pushTeamChange() lands a synthetic teammate's publish. Git is never mocked.
//
// Time: every peer clock (and the scheduler's) starts with its wall 60 s after the real now, so files checked out or
// written by a test are past the 300 ms quiet window; writeWork() sets a written file's mtime to the peer's virtual
// wall clock minus 1 s (distinct per call) for the same reason. advance(ms) moves every clock together.
import { realpathSync } from 'node:fs';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildBoardCommit, CODE_SUBJECT, liveCommitTrailers, readBoardCommit, type BoardDraft, type CsTrailer, type WriterId } from '../../src/board/boardCommit.js';
import { foldCommit, Folder, initialFoldState, serializeFold, CHECKPOINT_EVERY } from '../../src/board/fold.js';
import { newEpoch, newPeerId } from '../../src/board/ids.js';
import { serializeOps, type Op } from '../../src/board/ops.js';
import { Outbox } from '../../src/board/outbox.js';
import { genesisProtocol } from '../../src/board/protocol.js';
import { attachState, createEngineCore, type EngineCore } from '../../src/engine/core.js';
import { humanOnlyAttribution, PLAN2_REGION_SPEC, type EngineDeps, type MutantId } from '../../src/engine/deps.js';
import type { Meta } from '../../src/engine/meta.js';
import { RELEASE_NAMESPACE, refNames } from '../../src/engine/refs.js';
import { fetchRefs } from '../../src/git/fetch.js';
import { ABSENT, parseOid, type Oid, type OidOrAbsent } from '../../src/git/oid.js';
import { pushSpec, runPush } from '../../src/git/push.js';
import { GitRepo, type FileMode, type MktreeEntry, type RepoContext } from '../../src/git/repo.js';
import type { GitRunner } from '../../src/git/runner.js';
import { alwaysLeased } from '../../src/ports/lease.js';
import { nullLog } from '../../src/ports/log.js';
import { realFs } from '../../src/ports/fs.js';
import { seededRandom } from '../../src/ports/random.js';
import { validPathSyntax } from '../../src/sec/validators.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { FaultFs } from '../sim/faultfs.js';
import { clonePeer, seedRemote, type PeerClone } from '../sim/peers.js';
import { createBareRemote, type BareRemote } from '../sim/remote.js';
import { TraceRecorder } from '../sim/traceRecorder.js';
import { SIM_WALL_EPOCH_MS, VirtualClock } from '../sim/vclock.js';
import { VirtualScheduler } from '../sim/vscheduler.js';
import { spyRunner, type GitCall } from './snapFixture.js';
import { makeTempRoot, testRunner } from './tmp.js';

export interface PeerFixture { name: string; clone: PeerClone; clock: VirtualClock; fs: FaultFs; deps: EngineDeps; core: EngineCore; }
export interface CoreFixture {
  root: string; remote: BareRemote; peers: PeerFixture[]; scheduler: VirtualScheduler; trace: TraceRecorder;
  advance(ms: number): void;                                   // every peer clock and the scheduler clock
  /** Test-only stand-in for genesis/join until Task 15: L0/B0 built with the Task 5 builders, pushed with ABSENT leases, each peer's state created with A = tree(HEAD), LA_C = L0, LA_B = B0, a new epoch. */
  bootstrap(): Promise<void>;
  /** A synthetic teammate lands one live commit (bytes or null = delete, stored as given) with Cowork-CS/Cowork-CS-Paths trailers and its board commit, leased. */
  pushTeamChange(changes: Readonly<Record<string, Buffer | null>>, opts?: { csId?: string }): Promise<{ board: Oid; live: Oid }>;
  cleanup(): Promise<void>;
}

/** Fixture extension (beyond the contract's options): `platform` replaces EngineDeps.platform of every peer (01-engine test 14 form). */
export interface CoreOptions {
  n: number; files?: Record<string, Buffer>; autocrlf?: readonly boolean[]; seed?: string; mutants?: ReadonlySet<MutantId>;
  platform?: NodeJS.Platform;
}

const DEFAULT_FILES: Record<string, Buffer> = {
  'README.md': Buffer.from('# core fixture\n', 'utf8'),
  'src/a.txt': Buffer.from('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n', 'utf8'),
  'src/b.txt': Buffer.from('alpha\nbeta\ngamma\n', 'utf8'),
};

const BRANCH = 'main';
const PLUGIN_SHA = 'f'.repeat(64);
/** The git calls of each peer's core, in order (the same order as `git <sub>` entries in its FaultFs.calls). */
const callsOf = new WeakMap<PeerFixture, GitCall[]>();

let mtimeSeq = 0;

/** The absolute path of a repository path in the peer's work tree. */
export function workPath(p: PeerFixture, path: string): string {
  return join(p.deps.paths.workTree, ...path.split('/'));
}

/** Writes a working file (test code, node:fs) and sets its mtime to the peer's virtual wall clock minus 1 s (distinct per call). */
export async function writeWork(p: PeerFixture, path: string, bytes: Buffer | string): Promise<void> {
  const abs = workPath(p, path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes);
  const t = (p.clock.wallMs() - 1_000 + (mtimeSeq++ % 100_000) / 1_000) / 1_000;
  await utimes(abs, t, t);
}

/** A working file's bytes, or null when it is absent. */
export async function readWork(p: PeerFixture, path: string): Promise<Buffer | null> {
  try {
    return await readFile(workPath(p, path));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Every git call the peer's core made so far (args and options). */
export function gitCallsOf(p: PeerFixture): readonly GitCall[] {
  return callsOf.get(p) ?? [];
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

export async function makeCores(label: string, opts: CoreOptions): Promise<CoreFixture> {
  const { root, cleanup } = await makeTempRoot(label);
  try {
    const seed = opts.seed ?? label;
    const runner = testRunner();
    const remote = await createBareRemote(root, runner);
    await seedRemote(remote, root, runner, opts.files ?? DEFAULT_FILES);
    const trace = new TraceRecorder();
    // Every virtual wall clock starts 60 s after the real now (see the file comment).
    const wallOffsetMs = Date.now() + 60_000 - SIM_WALL_EPOCH_MS;
    const schedClock = new VirtualClock({ wallOffsetMs, startMono: 1_000 });
    const scheduler = new VirtualScheduler(schedClock, seededRandom(`${seed}/scheduler`));
    const refs = refNames(BRANCH, RELEASE_NAMESPACE);
    const peers: PeerFixture[] = [];
    for (let i = 0; i < opts.n; i++) {
      const name = `p${i + 1}`;
      const clone = await clonePeer(remote, root, { name, autocrlf: opts.autocrlf?.[i] ?? false, withFilter: false }, runner);
      const clock = new VirtualClock({ wallOffsetMs, startMono: 1_000 });
      const fs = new FaultFs(realFs);
      const calls: GitCall[] = [];
      const git: GitRunner = spyRunner(runner, calls, fs.calls);
      const workTree = realpathSync.native(clone.dir);
      const deps: EngineDeps = {
        ports: { clock, random: seededRandom(`${seed}/${name}`), scheduler, fs, git },
        trace, log: nullLog, lease: alwaysLeased, attribution: humanOnlyAttribution,
        heartbeatMs: () => clock.monoMs(),
        paths: { workTree, gitDir: join(workTree, '.git'), coworkDir: join(workTree, '.git', 'cowork') },
        branch: BRANCH, namespace: RELEASE_NAMESPACE, url: remote.url, display: `Peer ${name}`,
        pluginVersion: PLUGIN_VERSION, pluginSha: PLUGIN_SHA, regionSpec: PLAN2_REGION_SPEC,
        platform: opts.platform ?? process.platform, testBuild: true, testMutants: opts.mutants ?? new Set(),
      };
      const core = await createEngineCore(deps);
      trace.names.set(core.peerId, name);
      const p: PeerFixture = { name, clone, clock, fs, deps, core };
      callsOf.set(p, calls);
      peers.push(p);
    }

    // The synthetic teammate: its own clone, peer id and epoch, writing with a seq counter.
    const teamRandom = seededRandom(`${seed}/team`);
    const teamPeer = newPeerId(teamRandom);
    const teamEpoch = newEpoch(teamRandom);
    let teamSeq = 0;
    let team: GitRepo | null = null;
    const teamRepo = async (): Promise<GitRepo> => {
      if (team !== null) return team;
      const clone = await clonePeer(remote, root, { name: 'team', autocrlf: false, withFilter: false }, runner);
      const workTree = realpathSync.native(clone.dir);
      const paths = { workTree, gitDir: join(workTree, '.git'), coworkDir: join(workTree, '.git', 'cowork') };
      await mkdir(paths.coworkDir, { recursive: true });
      const ctx = (): RepoContext => ({ attrTree: null, filterDrivers: [], identity: { name: 'Teammate', email: `${teamPeer}@cowork.invalid` }, wallMs: () => schedClock.wallMs() });
      team = new GitRepo(runner, paths, ctx);
      return team;
    };

    const fx: CoreFixture = {
      root, remote, peers, scheduler, trace,
      advance(ms: number): void {
        for (const p of peers) p.clock.advance(ms);
        schedClock.advance(ms);
      },

      async bootstrap(): Promise<void> {
        const p0 = peers[0];
        if (p0 === undefined) throw new Error('bootstrap: no peers');
        const r0 = p0.core.repo;
        const hr = await r0.resolve('HEAD');
        if (hr === null) throw new Error('bootstrap: the first peer has no HEAD');
        const epoch0 = newEpoch(p0.deps.ports.random);
        const writer: WriterId = { peer: p0.core.peerId, epoch: epoch0, seq: 3 };
        const L0 = await r0.commitTree({ tree: (await r0.readCommit(hr)).tree, parents: [], subject: CODE_SUBJECT, trailers: liveCommitTrailers(writer, [], [], new Map(), hr) });
        const protocol = genesisProtocol(12, PLAN2_REGION_SPEC);
        const ops: Op[] = [
          {
            id: `${p0.core.peerId}/${epoch0}/1`, type: 'join', display: p0.deps.display, plugin_version: PLUGIN_VERSION, plugin_sha: PLUGIN_SHA, proto: 1,
            regionSpec: PLAN2_REGION_SPEC, config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '' }, coauthor_optin: false,
          },
          { id: `${p0.core.peerId}/${epoch0}/2`, type: 'caps', custom_refs: true, lease: true, delete: true, push_options: false, two_parent_ok: true },
        ];
        const draft: BoardDraft = {
          liveCode: L0, writer, cs: [], protocol, checkpoint: null, heldIds: [],
          opsLines: serializeOps(ops).toString('utf8').split('\n').filter((l) => l.length > 0),
        };
        const s0 = foldCommit(initialFoldState(protocol), draft, p0.core.peerId).state;
        const B0 = await buildBoardCommit(r0, { prevBoard: null, liveCode: L0, writer, ops, cs: [], csPaths: new Map(), protocol, checkpoint: serializeFold(s0) });
        const pushed = await runPush(r0, remote.url, [pushSpec(B0, refs.remoteBoard, ABSENT), pushSpec(L0, refs.remoteCode, ABSENT)], []);
        if (pushed.statuses.get(refs.remoteBoard) !== 'ok') throw new Error(`bootstrap: the genesis push failed (exit ${pushed.code})`);
        for (const [i, p] of peers.entries()) {
          const repo = p.core.repo;
          const f = await fetchRefs(repo, remote.url, p.core.refs.fetchSpecs);
          if (!f.ok) throw new Error(`bootstrap: ${p.name} could not fetch the board`);
          const head = await repo.resolve('HEAD');
          if (head === null) throw new Error(`bootstrap: ${p.name} has no HEAD`);
          const tree = (await repo.readCommit(head)).tree;
          const roots = (await repo.run(['rev-list', '--max-parents=0', head])).stdout.toString('utf8').split('\n').filter((l) => l.length > 0).map((l) => parseOid(l)).sort();
          const meta: Meta = {
            v: 1, proto: 1, peer_id: p.core.peerId, epoch: i === 0 ? epoch0 : newEpoch(p.deps.ports.random), seq_next: i === 0 ? writer.seq + 1 : 1,
            branch: BRANCH, enc: p.core.refs.e, pinned: { url: remote.url, identity: roots }, H_adopt: head, EPOCH_BASE: head,
            expected_epoch: { symref: `refs/heads/${BRANCH}`, head, stash: null }, freeze_reasons: [], config_detail: [],
            incident: null, nonretryable: null, rejections: null, throttle: null, pending: {}, displaced: [],
            fold_board: B0, fold_verified: null, checkpoint_mismatch: false, outbox: new Outbox().toJson(), cs_human_next: 1, incident_next: 1,
          };
          const view = await p.core.state.create({ laC: L0, laB: B0, base: tree, snap: tree, meta, fold: s0 });
          attachState(p.core, view);
          await p.core.snapshot.reseed(tree);
        }
      },

      async pushTeamChange(changes, o): Promise<{ board: Oid; live: Oid }> {
        const repo = await teamRepo();
        const f = await fetchRefs(repo, remote.url, refs.fetchSpecs);
        const T = f.values.get(refs.remoteBoard);
        if (!f.ok || T === undefined || T === ABSENT) throw new Error('pushTeamChange: no board on the remote (bootstrap first)');
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
          else edits.push({ path, mode: tipMap.get(path)?.mode === '100755' ? '100755' : '100644', oid: await repo.hashBytes(bytes, true) });
        }
        const tree = await editTreeRaw(repo, tipTree, edits);
        const seq = ++teamSeq;
        const writer: WriterId = { peer: teamPeer, epoch: teamEpoch, seq };
        const csId = o?.csId ?? `${teamPeer}/human/${seq}`;
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
          const folded = await new Folder(repo, teamPeer).foldTo(T, null, PLAN2_REGION_SPEC);
          const protocol = (await readBoardCommit(repo, T)).protocol;
          const next = foldCommit(folded.state, { liveCode: live, writer, cs, protocol, opsLines: [], checkpoint: null, heldIds: [] }, teamPeer);
          checkpoint = serializeFold(next.state);
        }
        const board = await buildBoardCommit(repo, { prevBoard: T, liveCode: live, writer, ops: [], cs, csPaths, protocol: null, checkpoint });
        const out = await runPush(repo, remote.url, [pushSpec(board, refs.remoteBoard, T), pushSpec(live, refs.remoteCode, mirror)], []);
        if (out.statuses.get(refs.remoteBoard) !== 'ok') throw new Error(`pushTeamChange: the board push did not land (exit ${out.code})`);
        return { board, live };
      },

      cleanup,
    };
    return fx;
  } catch (e) {
    await cleanup();
    throw e;
  }
}
