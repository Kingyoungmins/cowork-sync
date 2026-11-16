// N peers with EngineCores on real clones of one file:// bare remote, with virtual clocks, one VirtualScheduler, a
// FaultFs over the real disk per peer and one TraceRecorder (Plan 2 Task 13). bootstrap() is the test-only stand-in
// for genesis and join until Task 15; pushTeamChange() lands a synthetic teammate's publish. Git is never mocked.
//
// Time: every peer clock (and the scheduler's) starts with its wall WALL_MARGIN_MS (24 h) after the real now, so files with a
// real mtime — checked out by the clone, written by the engine's writer (applies, the revert write, --discard) or by a test
// through node:fs — are past the 300 ms quiet window for the fixture's whole life; writeWork() sets a written file's mtime to
// the peer's virtual wall clock minus 1 s (distinct per call, in whole milliseconds) for the same reason. advance(ms) moves
// every clock together.
//
// Plan 3 Task EF (item 6): the margin was 60 s. Real time then overtook it under a loaded run (Task 17: a ~6x slowdown on a
// single-fixture test whose virtual advance stayed small): a writer-made file became "in the future" for the virtual wall, its
// first tick quiet-excluded it and a capture took the pre-write entry. A fixture never outlives the test that made it, and the
// longest node:test timeout of any core/engine-fixture test is 60 min (apply.bomcrlf.test.ts), so 24 h keeps every real mtime
// behind the virtual wall with a 24x reserve. Only the quiet rule (snapshot.ts, loop.ts's hook-path wait) compares a wall time
// with a file mtime; the 14-day provenance and revert windows the tests cross advance 15 days, far past the extra 24 h.
import { realpathSync } from 'node:fs';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildBoardCommit, CODE_SUBJECT, liveCommitTrailers, type BoardDraft, type WriterId } from '../../src/board/boardCommit.js';
import { foldCommit, initialFoldState, serializeFold } from '../../src/board/fold.js';
import { newEpoch, newPeerId } from '../../src/board/ids.js';
import { serializeOps, type Op } from '../../src/board/ops.js';
import { Outbox } from '../../src/board/outbox.js';
import { genesisProtocol } from '../../src/board/protocol.js';
import { attachCsTable, attachState, createEngineCore, type EngineCore } from '../../src/engine/core.js';
import { humanOnlyAttribution, noClaude, PLAN2_REGION_SPEC, type EngineDeps, type MutantId } from '../../src/engine/deps.js';
import { testRegionDeps } from './regionDeps.js';
import type { Meta } from '../../src/engine/meta.js';
import { RELEASE_NAMESPACE, refNames } from '../../src/engine/refs.js';
import { fetchRefs } from '../../src/git/fetch.js';
import { plan3Ports } from '../../src/holds/ports.js';
import { ABSENT, parseOid, type Oid } from '../../src/git/oid.js';
import { pushSpec, runPush } from '../../src/git/push.js';
import type { GitRunner } from '../../src/git/runner.js';
import { alwaysLeased } from '../../src/ports/lease.js';
import { nullLog } from '../../src/ports/log.js';
import { realFs } from '../../src/ports/fs.js';
import { seededRandom } from '../../src/ports/random.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { FaultFs } from '../sim/faultfs.js';
import { clonePeer, seedRemote, type PeerClone } from '../sim/peers.js';
import { createBareRemote, type BareRemote } from '../sim/remote.js';
import { teamPush, type TeamWriter } from '../sim/teamWriter.js';
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
  /**
   * A synthetic teammate lands one live commit (bytes or null = delete) with Cowork-CS/Cowork-CS-Paths trailers and its board commit,
   * leased. A conforming writer (03-data §3.2): the bytes of a path TIP already holds are stored as canon(bytes, TIP[p]) (as given when
   * canon refuses, or for a new path); `raw` stores every path's bytes as given, no canon (I-DAT-13's non-conforming writer, Task 6).
   */
  pushTeamChange(changes: Readonly<Record<string, Buffer | null>>, opts?: { csId?: string; raw?: boolean }): Promise<{ board: Oid; live: Oid }>;
  cleanup(): Promise<void>;
}

/** Plan 3 Task 10 (contract addition 3; rev 2.5, X-15): the Plan 3 ports a test replaces (src/holds cannot name EngineDeps). */
export type PortsOverride = Partial<Pick<EngineDeps, 'editCheck' | 't0Regions' | 'gate' | 'symbols'>>;

/**
 * Fixture extension (beyond the contract's options): `platform` replaces EngineDeps.platform of every peer (01-engine test 14 form).
 * `ports` (Plan 3 Task 10, X-15): every peer binds plan3Ports() and then this override — a static PortsOverride for every peer, or a
 * function called once per peer with that peer's built deps and its index (so a later plan's override can read deps it builds).
 */
export interface CoreOptions {
  n: number; files?: Record<string, Buffer>; autocrlf?: readonly boolean[]; seed?: string; mutants?: ReadonlySet<MutantId>;
  platform?: NodeJS.Platform;
  ports?: PortsOverride | ((deps: EngineDeps, peerIndex: number) => PortsOverride);
  /** Plan 5 Task 5 (A5-13): the per-peer daemon port overrides — claude/attribution/lease — applied over the defaults
   *  AFTER Plan 3's `ports`; each peer has its own ClaudeDaemon, hence the function form. Absent → every peer keeps
   *  noClaude, humanOnlyAttribution and alwaysLeased (Plan 2/3 behaviour unchanged). */
  engineDeps?: (peer: number) => Partial<Pick<EngineDeps, 'claude' | 'attribution' | 'lease'>>;
}

/** The override of peer `i` (X-15): the static object, or the function's answer for that peer's deps. */
export function portsFor(ports: CoreOptions['ports'], deps: EngineDeps, i: number): PortsOverride {
  if (ports === undefined) return {};
  return typeof ports === 'function' ? ports(deps, i) : ports;
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

/** How far every virtual wall clock starts after the real now (see the file comment; Plan 3 Task EF: was 60 s). */
export const WALL_MARGIN_MS = 24 * 60 * 60_000;

/** The absolute path of a repository path in the peer's work tree. */
export function workPath(p: PeerFixture, path: string): string {
  return join(p.deps.paths.workTree, ...path.split('/'));
}

/**
 * Writes a working file (test code, node:fs) and sets its mtime to the peer's virtual wall clock minus 1 s, plus a per-call step of
 * whole milliseconds (0–499), so two calls at one virtual instant give mtimes that differ on every file system: steps of 1 µs were
 * rounded away on Windows (a same-size rewrite then passed snapshot unchanged()), and 499 ms keeps the mtime clear of QUIET_MS (300).
 */
export async function writeWork(p: PeerFixture, path: string, bytes: Buffer | string): Promise<void> {
  const abs = workPath(p, path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes);
  const t = (p.clock.wallMs() - 1_000 + (mtimeSeq++ % 500)) / 1_000;
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

export async function makeCores(label: string, opts: CoreOptions): Promise<CoreFixture> {
  const { root, cleanup } = await makeTempRoot(label);
  try {
    const seed = opts.seed ?? label;
    const runner = testRunner();
    const remote = await createBareRemote(root, runner);
    await seedRemote(remote, root, runner, opts.files ?? DEFAULT_FILES);
    const trace = new TraceRecorder();
    // Every virtual wall clock starts WALL_MARGIN_MS after the real now (see the file comment).
    const wallOffsetMs = Date.now() + WALL_MARGIN_MS - SIM_WALL_EPOCH_MS;
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
        trace, log: nullLog, lease: alwaysLeased, attribution: humanOnlyAttribution, claude: noClaude,
        heartbeatMs: () => clock.monoMs(),
        paths: { workTree, gitDir: join(workTree, '.git'), coworkDir: join(workTree, '.git', 'cowork') },
        branch: BRANCH, namespace: RELEASE_NAMESPACE, url: remote.url, display: `Peer ${name}`,
        pluginVersion: PLUGIN_VERSION, pluginSha: PLUGIN_SHA, regionSpec: PLAN2_REGION_SPEC,
        platform: opts.platform ?? process.platform, testBuild: true, testMutants: opts.mutants ?? new Set(),
        ...plan3Ports(),   // Plan 3 Task 10 (R3-03, R3-04, R3-07), then the test's override (X-15)
        regions: await testRegionDeps({ clock }),   // Plan 4 Task 5 (R4-36): the test region module (inline workers)
      };
      Object.assign(deps, portsFor(opts.ports, deps, i));
      // A5-13: the daemon's claude/attribution/lease overrides, over the defaults (after Plan 3's `ports`; they never name a
      // plan3Ports field, so the identity contract of X-15 is untouched). Each peer is its own daemon, hence the function form.
      if (opts.engineDeps !== undefined) Object.assign(deps, opts.engineDeps(i));
      const core = await createEngineCore(deps);
      trace.names.set(core.peerId, name);
      const p: PeerFixture = { name, clone, clock, fs, deps, core };
      callsOf.set(p, calls);
      peers.push(p);
    }

    // The synthetic teammate: its own clone, peer id and epoch, writing with a seq counter (test/sim/teamWriter.ts, Plan 3 Task 13).
    const teamRandom = seededRandom(`${seed}/team`);
    const teamPeer = newPeerId(teamRandom);
    const teamEpoch = newEpoch(teamRandom);
    let team: TeamWriter | null = null;
    const teamWriter = async (): Promise<TeamWriter> => {
      if (team !== null) return team;
      const clone = await clonePeer(remote, root, { name: 'team', autocrlf: false, withFilter: false }, runner);
      team = { peer: teamPeer, epoch: teamEpoch, seq: 0, dir: realpathSync.native(clone.dir) };
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
          await attachCsTable(p.core, view);   // R3-69 (Plan 3 Task 12a): awaited right after every attachState
          // Plan 3 Task 8 (R3-59): the provenance journal is loaded as genesis and join load it — empty, at the live code of B0.
          await p.core.prov.load(L0, L0);
          await p.core.snapshot.reseed(tree);
        }
      },

      async pushTeamChange(changes, o): Promise<{ board: Oid; live: Oid }> {
        // Plan 3 Task 13: the body moved to teamPush unchanged — a conforming writer unless `raw` (I-DAT-13's non-conforming writer).
        return teamPush(runner, remote.url, refs, await teamWriter(), changes, { ...(o?.csId === undefined ? {} : { csId: o.csId }), wallMs: schedClock.wallMs(), conform: o?.raw !== true });
      },

      cleanup,
    };
    return fx;
  } catch (e) {
    await cleanup();
    throw e;
  }
}
