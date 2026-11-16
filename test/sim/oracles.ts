// The SIM oracles (11-testing §3.4; Plan 1 Task 13, Plan 2 Task 19; ruling R-32 and the Task 14/18 carries).
//
//   INV-FF            remote-log clause: every update of `<prefix><branch>/{board,code}` is a first-parent
//                     fast-forward; trace clause: no daemon push argv carries `--force`, `-f` or a `+…refs/…` refspec.
//                     The human-typed recover (purpose 'recover') is the one exemption (11-testing §3.4: "unless … a
//                     human /cowork recover"), and only in its leased form: no `--force`/`-f`/`+` either, and every
//                     ref it names carries `--force-with-lease=<ref>:<expected oid>` (empty = expected absent); the
//                     remote-log entry it produced is exempt only when its old value is that expected oid
//   INV-OID           the remote's reference-transaction log shows no deletion outside the allowed prefixes; trace
//                     clauses: a deleting push argv (`:<ref>`) is only a 'probe' push of the pushing peer's own probe
//                     ref; and the fault "write-tree / commit-tree exit 128 with empty stdout" spawns no push: after
//                     such a call, the same peer runs no push in the same op (the run's git calls, gitCalls.ts)
//   INV-FIRSTPARENT   every 'merge' event: LA_C on TIP's first-parent chain and LA_B on T's (in the peer's repo)
//   INV-BASE          every 'merge' event's base is the A of the peer's latest 'state' event; every 'A_set' is backed:
//                     write_verified / disk_equal / unmanaged_follow by the 'apply' event just before it (and TIP[p]),
//                     push_confirmed by a landed publish of the peer whose OUT[p] it is, genesis by tree(L0)[p], join by
//                     tree(HEAD)[p] (what makes M05 — A seeded from TIP — fail), restart_decision by TIP[p] of the
//                     peer's crashed apply, lost_state / recover_reanchor by a version of p on the new LA_C's chain
//   INV-PUSHED-IS-MERGE  every landed publish with a code commit C: P is recomputed from the journal (the push intent's
//                     state: its ready pairs over A, the pairs C's Cowork-CS trailers name; a journaled pair C leaves
//                     out must touch a held PIN, P2-PIN) and may differ from the composition only where MASK resets a
//                     path to A[p] (a record the trace shows ON_DISK with a guard, or a non-LIVE path class) or, at MASK
//                     step 5 (EF2 D1), where P[p] is the test-side step-5 chain over the compose event's registry; then
//                     OUT is recomputed in the peer's repo — merge-tree --merge-base=A P TIP, the rename carry and the
//                     conflict function's whole-path replacements and concat blobs — and must equal tree(C) in modes and
//                     oids; C's one parent is TIP; paths(diff(TIP, C)) ⊆ paths(diff(A, P))
//   INV-CONVERGE      (atQuiescence, ruling R-32): T* reached; zero push attempts and an unchanged tip in the extra
//                     loops; per peer LA_B == T* (or, Task 18 carry, an LA_B on T*'s first-parent chain whose live code
//                     tree is live_code(T*)'s: board-only last changes leave LA_B behind, ENG-36), A ==
//                     tree(live_code(T*)) and the working tree's stored form == tree(live_code(T*)) on LIVE paths
//                     outside not_converged — compared through canon (eol_rewrite leaves flipped endings on disk) —
//                     and untracked files only when admitNew classifies them NOT_ADMITTED; tracked paths are classed
//                     with their real size (the larger of their blobs and the file on disk)
//
// Oracles read the remote's hook logs (files under the run root) after every op and the bare remote itself only at
// quiescence, through its current path (a partition renames remote.dir). Trace events name peer ids; the recorder's
// `names` maps them to harness peers. Every oracle keeps a per-run cursor, so each event is judged once. The oracles
// run their own git (an oracle runner, never ctx.git, whose calls INV-OID judges). The recomputed merges write their
// R-30 wrapper commits (fixed identity and date) and concat blobs into the peer's object store: unreferenced objects
// that never reach a ref, the trace or the remote.
import { realpathSync } from 'node:fs';
import { lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AttrSnapshot, PathAttrs } from '../../src/data/attrs.js';
import { canon } from '../../src/data/canon.js';
import { DEFAULT_TEAM_CONFIG, readTeamConfig } from '../../src/data/config.js';
import { conflict, type ConflictCtx, type ConflictVerdict, type UnitKind } from '../../src/data/conflict.js';
import { admitNew, scopeOfTracked, wildmatch, type ScopeClass, type ScopeInputs } from '../../src/data/scope.js';
import { editable } from '../../src/engine/core.js';
import { PLAN2_REGION_SPEC } from '../../src/engine/deps.js';
import { parseMeta } from '../../src/engine/meta.js';
import { RELEASE_NAMESPACE, type RefNamespace } from '../../src/engine/refs.js';
import { parseCsTable, type CsTable } from '../../src/holds/changesets.js';
import { TERMINAL_STATES } from '../../src/holds/record.js';
import { mergeTree } from '../../src/git/merge.js';
import { ABSENT, parseOid, type Oid } from '../../src/git/oid.js';
import { GitRepo, type TreeEntry, type TreeMap } from '../../src/git/repo.js';
import type { GitRunner } from '../../src/git/runner.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { testRunner } from '../helpers/tmp.js';
import { recordGitCalls } from './gitCalls.js';
import { PARTITION_SUFFIX, type Oracle, type SimContext } from './harness.js';
import { readRegistry } from './holdsView.js';
import type { MarkerModel } from './markers.js';
import { oracleHeldSecret, oracleNoloss } from './oracleNoloss.js';
import { holdsOracles, oracleReleasedEnds, publishMaskOf } from './oraclesHolds.js';
import type { PeerClone } from './peers.js';

const ZERO_OID = /^0+$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

type PublishEvent = Extract<TraceEvent, { kind: 'publish' }>;
type HoldEvent = Extract<TraceEvent, { kind: 'hold' }>;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- shared per-run helpers ---------------------------------------------------------------------------------------

/** The R-30 wrapper commits of a recomputed merge get this identity and date (never a ref, never pushed). */
const ORACLE_IDENTITY = { name: 'cowork-oracle', email: 'oracle@cowork.invalid' } as const;
const ORACLE_WALL_MS = 1_700_000_000_000;

/** The oracles' own git: never the run's ctx.git (INV-OID judges the engines' calls on it). */
let oracleGit: GitRunner | null = null;
function oracleRunner(): GitRunner {
  oracleGit ??= testRunner();
  return oracleGit;
}

interface RunCache {
  repos: Map<string, GitRepo>;
  /** `${peer name} ${commit}` → the commit's first-parent chain (rev-list --first-parent). */
  chains: Map<string, ReadonlySet<string>>;
  /** realpath(peer dir) → peer name: the peer of an engine git call (its cwd is the main-worktree root). */
  dirs: Map<string, string> | null;
}
const caches = new WeakMap<SimContext, RunCache>();

function cacheOf(ctx: SimContext): RunCache {
  let c = caches.get(ctx);
  if (c === undefined) {
    c = { repos: new Map(), chains: new Map(), dirs: null };
    caches.set(ctx, c);
  }
  return c;
}

/** The harness peer of a trace event's peer id. */
function peerOf(ctx: SimContext, peerId: string): PeerClone {
  const name = ctx.trace.names.get(peerId) ?? peerId;
  const p = ctx.peers.find((x) => x.name === name);
  if (p === undefined) throw new Error(`oracle: no harness peer for peer id ${peerId}`);
  return p;
}

const nameOf = (ctx: SimContext, peerId: string): string => ctx.trace.names.get(peerId) ?? peerId;

/** The harness peer whose main worktree a git call ran in, or null (the remote, a temp dir, the harness). */
function peerOfDir(ctx: SimContext, cwd: string): string | null {
  const c = cacheOf(ctx);
  c.dirs ??= new Map(ctx.peers.map((p) => [realpathSync.native(p.dir), p.name] as const));
  return c.dirs.get(cwd) ?? null;
}

/** A GitRepo over the peer's clone (the engine's own layout: realpath work tree, absolute git dir), on the oracle runner. */
function repoOf(ctx: SimContext, peer: PeerClone): GitRepo {
  const c = cacheOf(ctx);
  let r = c.repos.get(peer.name);
  if (r === undefined) {
    const workTree = realpathSync.native(peer.dir);
    const paths = { workTree, gitDir: join(workTree, '.git'), coworkDir: join(workTree, '.git', 'cowork') };
    r = new GitRepo(oracleRunner(), paths, () => ({ attrTree: null, filterDrivers: [], identity: { ...ORACLE_IDENTITY }, wallMs: () => ORACLE_WALL_MS }));
    c.repos.set(peer.name, r);
  }
  return r;
}

async function firstParentChain(ctx: SimContext, peer: PeerClone, commit: string): Promise<ReadonlySet<string>> {
  const c = cacheOf(ctx);
  const key = `${peer.name} ${commit}`;
  let chain = c.chains.get(key);
  if (chain === undefined) {
    const r = await repoOf(ctx, peer).run(['rev-list', '--first-parent', commit]);
    chain = new Set(r.stdout.toString('utf8').split('\n').filter((l) => l.length > 0));
    c.chains.set(key, chain);
  }
  return chain;
}

/** The last parent of a board commit: its live code commit (glossary §5). */
async function liveCodeOf(repo: GitRepo, board: string): Promise<string> {
  const b = await repo.readCommit(parseOid(board));
  const tip = b.parents[b.parents.length - 1];
  if (tip === undefined) throw new Error(`oracle: board commit ${board} has no parent`);
  return tip;
}

async function treeOf(repo: GitRepo, commit: string): Promise<string> {
  return (await repo.readCommit(parseOid(commit))).tree;
}

function readTree(repo: GitRepo, tree: string): Promise<TreeMap> {
  return repo.readTreeMap(parseOid(tree));
}

const entryOid = (m: TreeMap, p: string): string | null => m.get(p)?.oid ?? null;

/** Equal entries (mode and oid); undefined = absent. */
function same(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && a.oid === b.oid && a.mode === b.mode;
}

const show = (e: TreeEntry | undefined): string => (e === undefined ? 'absent' : `${e.mode} ${e.oid}`);

/** The paths whose entries (mode and oid) differ between two tree maps, sorted. */
function diffPaths(a: TreeMap, b: TreeMap): string[] {
  const out: string[] = [];
  for (const p of new Set([...a.keys(), ...b.keys()])) if (!same(a.get(p), b.get(p))) out.push(p);
  return out.sort();
}

const isRegular = (e: TreeEntry | undefined): e is TreeEntry => e !== undefined && (e.mode === '100644' || e.mode === '100755');

/** oid → size of every non-gitlink entry of the maps (one cat-file --batch-check). */
async function blobSizes(repo: GitRepo, maps: readonly TreeMap[]): Promise<Map<string, number>> {
  const oids = [...new Set(maps.flatMap((m) => [...m.values()].filter((e) => e.mode !== '160000').map((e) => e.oid)))];
  const sizes = await repo.blobSizes(oids.map((o) => parseOid(o)));
  return new Map(oids.map((o, i) => [o, sizes[i] ?? 0] as const));
}

/** `<oid>:<ref>` refspecs of a push argv. */
function refspecs(argv: readonly string[]): Array<{ src: string; dst: string }> {
  const out: Array<{ src: string; dst: string }> = [];
  for (const a of argv) {
    const colon = a.indexOf(':');
    if (colon < 0 || a.startsWith('--')) continue;
    const src = a.slice(0, colon);
    const dst = a.slice(colon + 1);
    if (dst.startsWith('refs/') && (src === '' || OID.test(src.replace(/^\+/, '')))) out.push({ src, dst });
  }
  return out;
}

/** The remote-log entries landed so far, by new oid (a publish landed when its Bnew is one). */
async function landedOids(ctx: SimContext): Promise<ReadonlySet<string>> {
  return new Set((await ctx.remote.readRemoteLog()).map((e) => e.new));
}

/** Where the bare remote is now (a partition renames remote.dir away). */
export async function currentRemoteDir(ctx: SimContext): Promise<string> {
  if ((await lstat(ctx.remote.dir).catch(() => null)) !== null) return ctx.remote.dir;
  return `${ctx.remote.dir}${PARTITION_SUFFIX}`;
}

// ---- INV-FF ---------------------------------------------------------------------------------------------------------

/** A forcing push argument: --force, -f or a '+' refspec. */
function forcing(a: string): boolean {
  return a === '--force' || a === '-f' || (a.startsWith('+') && a.includes('refs/'));
}

/** `--force-with-lease=<ref>:<expect>` per ref: the expected oid ('' = expected absent), null when not explicit. */
function leases(argv: readonly string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const a of argv) {
    if (!a.startsWith('--force-with-lease')) continue;
    const v = a.slice('--force-with-lease'.length);
    if (!v.startsWith('=')) {
      out.set('*', null);   // a bare --force-with-lease: every ref against its remote-tracking value
      continue;
    }
    const colon = v.indexOf(':');
    if (colon < 0) out.set(v.slice(1), null);
    else out.set(v.slice(1, colon), v.slice(colon + 1));
  }
  return out;
}

/** Why a 'recover' push argv is not the leased form (null when it is), and its `<ref> <new>` → expected old values. */
function recoverForm(argv: readonly string[]): { why: string | null; expected: Map<string, string> } {
  const expected = new Map<string, string>();
  const bad = argv.find(forcing);
  if (bad !== undefined) return { why: `carries ${JSON.stringify(bad)}`, expected };
  const l = leases(argv);
  for (const s of refspecs(argv)) {
    const want = l.get(s.dst);
    if (want === undefined || want === null || l.has('*')) return { why: `names ${s.dst} without --force-with-lease=${s.dst}:<expected oid>`, expected };
    if (want !== '' && !OID.test(want)) return { why: `leases ${s.dst} on ${JSON.stringify(want)}, not an oid`, expected };
    expected.set(`${s.dst} ${s.src}`, want);
  }
  return { why: null, expected };
}

/**
 * INV-FF: every remote-log entry on a namespace ref `${refPrefix}<branch>/board` or `${refPrefix}<branch>/code`
 * (<branch> = enc(b), which never contains '/') is a fast-forward: `old` is on `git rev-list --first-parent new`.
 * Creations (old = 0…0) pass; a deletion (new = 0…0) fails; an update a leased 'recover' push named passes when its
 * old value is that lease's expected oid. Every other ref (probe refs, refs/heads/*, displaced copies, other names) is
 * ignored. Trace clause: no push event's argv carries `--force`, `-f` or a `+…refs/…` refspec, and a 'recover' push is
 * exempt only in its leased form (recoverForm). Entries and events already checked in this run are not re-checked.
 */
export function oracleFF(refPrefix: string): Oracle {
  const namespaceRef = new RegExp(`^${escapeRegExp(refPrefix)}[^/]+/(?:board|code)$`);
  const checked = new WeakMap<SimContext, number>();
  /** Per run: the trace events looked at so far and, per `<ref> <new oid>` a recover push named, its expected old oid. */
  const traced = new WeakMap<SimContext, { next: number; recovered: Map<string, string> }>();
  return {
    name: 'INV-FF',
    async afterEveryOp(ctx: SimContext): Promise<string | null> {
      const events = ctx.trace.events;
      let t = traced.get(ctx);
      if (t === undefined) {
        t = { next: 0, recovered: new Map() };
        traced.set(ctx, t);
      }
      for (; t.next < events.length; t.next++) {
        const e = events[t.next];
        if (e === undefined || e.kind !== 'push') continue;
        if (e.purpose === 'recover') {
          const f = recoverForm(e.argv);
          if (f.why !== null) {
            t.next++;
            return `${nameOf(ctx, e.peer)}: a 'recover' push argv ${f.why} (a recover may only --force-with-lease=<ref>:<expected oid>)`;
          }
          for (const [k, v] of f.expected) t.recovered.set(k, v);
          continue;
        }
        const bad = e.argv.find(forcing);
        if (bad !== undefined) {
          t.next++;
          return `${nameOf(ctx, e.peer)}: a '${e.purpose}' push argv carries ${JSON.stringify(bad)} (no daemon push may force)`;
        }
      }
      const recovered = t.recovered;

      const log = await ctx.remote.readRemoteLog();
      for (let i = checked.get(ctx) ?? 0; i < log.length; i++) {
        const e = log[i];
        if (e === undefined || !namespaceRef.test(e.ref)) continue;
        if (ZERO_OID.test(e.old)) continue;
        if (ZERO_OID.test(e.new)) return `${e.ref} deleted (was ${e.old}); not a fast-forward`;
        const lease = recovered.get(`${e.ref} ${e.new}`);
        if (lease !== undefined && lease === e.old) continue;
        const r = await oracleRunner().run(['rev-list', '--first-parent', e.new], { class: 'local', cwd: await currentRemoteDir(ctx) });
        if (r.code !== 0) return `rev-list --first-parent ${e.new} failed in the remote (exit ${r.code})`;
        const chain = r.stdout.toString('utf8').split('\n');
        if (!chain.includes(e.old)) {
          return `${e.ref} moved ${e.old} -> ${e.new}, not a first-parent fast-forward${lease !== undefined ? ` (the recover push leased ${lease || 'absent'})` : ''}`;
        }
      }
      checked.set(ctx, log.length);
      return null;
    },
  };
}

// ---- INV-OID --------------------------------------------------------------------------------------------------------

/** The fault of 11-testing §3.4 INV-OID: one of these exits 128 with empty stdout. */
const FAULT_SUBS: ReadonlySet<string> = new Set(['write-tree', 'commit-tree']);

/**
 * INV-OID: the remote's reference-transaction log shows no committed deletion except of refs starting with one of
 * allowedDeletePrefixes (the probe refs, glossary §4: `refs/cowork/probe-`, and the fallback namespace's
 * `refs/heads/cowork/probe-`). Trace clauses: a push argv deleting a ref (`:<ref>`) is a 'probe' push and names the
 * pushing peer's own probe ref (`<allowed prefix><peer id>`); and after a write-tree or commit-tree of a peer exits 128
 * with empty stdout, that peer spawns no push in the same op (the run's git calls, recorded from the factory of
 * realEngine on, or from this oracle's first run). Plan 3 Task EF (01-engine §6, "Missing object after user gc --prune=now |
 * write-tree / merge rc 128 | reseed private index from state:snap, retry"): a write-tree of a peer whose run already holds a
 * `gc_prune` op of that peer (the harness's op-log, test-side) and that a later write-tree of the same peer in the same op answers
 * with an oid (exit 0, stdout) is that retry, not the fault: the push that follows carries the retried tree. A write-tree with no
 * earlier gc_prune of its peer, one never retried before the push, and every commit-tree failure stay faults.
 */
export function oracleOID(allowedDeletePrefixes: string[]): Oracle {
  const allowed = [...allowedDeletePrefixes];
  const traced = new WeakMap<SimContext, number>();
  const calls = new WeakMap<SimContext, number>();
  return {
    name: 'INV-OID',
    async afterEveryOp(ctx: SimContext): Promise<string | null> {
      const events = ctx.trace.events;
      for (let i = traced.get(ctx) ?? 0; i < events.length; i++) {
        const e = events[i];
        if (e === undefined || e.kind !== 'push') continue;
        for (const s of refspecs(e.argv)) {
          if (s.src !== '') continue;
          if (e.purpose !== 'probe' || !allowed.some((p) => s.dst === `${p}${e.peer}`)) {
            traced.set(ctx, i + 1);
            return `${nameOf(ctx, e.peer)}: a '${e.purpose}' push deletes ${s.dst} (only the peer's own probe ref may be deleted)`;
          }
        }
      }
      traced.set(ctx, events.length);

      // The git calls of this op (since the previous run of this oracle), per peer.
      const log = recordGitCalls(ctx.git);
      const faulted = new Map<string, string>();
      for (let i = calls.get(ctx) ?? 0; i < log.length; i++) {
        const c = log[i];
        if (c === undefined) continue;
        const peer = peerOfDir(ctx, c.cwd);
        if (peer === null) continue;
        if (FAULT_SUBS.has(c.sub) && c.code === 128 && c.stdoutEmpty) {
          faulted.set(peer, c.sub);
        } else if (c.sub === 'write-tree' && c.code === 0 && !c.stdoutEmpty && faulted.get(peer) === 'write-tree' && ctx.opLog.some((o) => o.kind === 'gc_prune' && o.peer === peer)) {
          faulted.delete(peer);   // the gc row's reseed-and-retry (Plan 3 Task EF): the retried write-tree answered
        } else if (c.sub === 'push' && faulted.has(peer)) {
          calls.set(ctx, i + 1);
          return `${peer}: a push after its ${faulted.get(peer)} exited 128 with empty stdout in the same op (the fault spawns no push)`;
        }
      }
      calls.set(ctx, log.length);

      for (const e of await ctx.remote.readRefTxLog()) {
        if (e.state !== 'committed' || !ZERO_OID.test(e.new)) continue;
        if (!allowed.some((p) => e.ref.startsWith(p))) return `${e.ref} deleted on the remote (was ${e.old})`;
      }
      return null;
    },
  };
}

// ---- INV-FIRSTPARENT ------------------------------------------------------------------------------------------------

/** INV-FIRSTPARENT: for every 'merge' event, LA_C is on TIP's first-parent chain and LA_B on the board tip T's. */
export function oracleFirstParent(): Oracle {
  const cursor = new WeakMap<SimContext, number>();
  return {
    name: 'INV-FIRSTPARENT',
    async afterEveryOp(ctx: SimContext): Promise<string | null> {
      const events = ctx.trace.events;
      for (let i = cursor.get(ctx) ?? 0; i < events.length; i++) {
        const e = events[i];
        if (e === undefined || e.kind !== 'merge') continue;
        const peer = peerOf(ctx, e.peer);
        if (!(await firstParentChain(ctx, peer, e.tip)).has(e.laC)) {
          cursor.set(ctx, i + 1);
          return `${peer.name}: ${e.use} merge with LA_C ${e.laC} not on TIP ${e.tip}'s first-parent chain`;
        }
        if (!(await firstParentChain(ctx, peer, e.t)).has(e.laB)) {
          cursor.set(ctx, i + 1);
          return `${peer.name}: ${e.use} merge with LA_B ${e.laB} not on T ${e.t}'s first-parent chain`;
        }
      }
      cursor.set(ctx, events.length);
      return null;
    },
  };
}

// ---- INV-BASE -------------------------------------------------------------------------------------------------------

interface BaseState {
  next: number;
  /** Per peer id: the latest 'state' event. */
  state: Map<string, Extract<TraceEvent, { kind: 'state' }>>;
  /** Per peer id: the latest 'publish' event and every earlier one (push_confirmed looks for a landed one). */
  publishes: Map<string, PublishEvent[]>;
  /** Per peer id: the latest apply 'merge' event (restart_decision: TIP of the crashed apply). */
  applyMerge: Map<string, Extract<TraceEvent, { kind: 'merge' }>>;
}

/**
 * INV-BASE: every 'merge' event's base is the A of the peer's latest 'state' event (the journaled A); every 'A_set' is
 * backed by what the cause names (see the file header). An unknown cause fails.
 */
export function oracleBase(): Oracle {
  const states = new WeakMap<SimContext, BaseState>();
  return {
    name: 'INV-BASE',
    async afterEveryOp(ctx: SimContext): Promise<string | null> {
      let st = states.get(ctx);
      if (st === undefined) {
        st = { next: 0, state: new Map(), publishes: new Map(), applyMerge: new Map() };
        states.set(ctx, st);
      }
      const events = ctx.trace.events;
      let landed: ReadonlySet<string> | null = null;
      for (; st.next < events.length; st.next++) {
        const i = st.next;
        const e = events[i];
        if (e === undefined) continue;
        if (e.kind === 'state') {
          st.state.set(e.peer, e);
          continue;
        }
        if (e.kind === 'publish') {
          const l = st.publishes.get(e.peer) ?? [];
          l.push(e);
          st.publishes.set(e.peer, l);
          continue;
        }
        if (e.kind === 'merge') {
          const s = st.state.get(e.peer);
          if (e.use === 'apply') st.applyMerge.set(e.peer, e);
          if (s === undefined || s.base !== e.base) {
            st.next = i + 1;
            return `${nameOf(ctx, e.peer)}: ${e.use} merge with --merge-base ${e.base}, but the journaled A is ${s?.base ?? '(no state)'}`;
          }
          continue;
        }
        if (e.kind !== 'A_set') continue;
        const peer = peerOf(ctx, e.peer);
        const repo = repoOf(ctx, peer);
        const why = await (async (): Promise<string | null> => {
          switch (e.cause) {
            case 'write_verified':
            case 'disk_equal':
            case 'unmanaged_follow': {
              // ENG-36: the apply event comes right before its A_set events (one synchronous emission).
              let j = i - 1;
              while (j >= 0 && events[j]?.kind === 'A_set' && events[j]?.peer === e.peer) j--;
              const a = events[j];
              if (a === undefined || a.kind !== 'apply' || a.peer !== e.peer) return 'no apply event before it';
              if (e.cause === 'write_verified' && !a.written.includes(e.path)) return `the apply wrote ${JSON.stringify(a.written)}, not the path`;
              if (e.cause !== 'write_verified' && a.deferred.includes(e.path)) return 'the apply deferred the path';
              const tip = await readTree(repo, await treeOf(repo, a.tip));
              return entryOid(tip, e.path) === e.blob ? null : `A[p] := ${e.blob}, but TIP[p] is ${entryOid(tip, e.path)}`;
            }
            case 'push_confirmed': {
              landed ??= await landedOids(ctx);
              const l = st.publishes.get(e.peer) ?? [];
              for (let k = l.length - 1; k >= 0; k--) {
                const p = l[k] as PublishEvent;
                if (!landed.has(p.bnew)) continue;
                const out = await readTree(repo, p.outTree);
                return entryOid(out, e.path) === e.blob ? null : `A[p] := ${e.blob}, but the landed publish ${p.bnew} has OUT[p] ${entryOid(out, e.path)}`;
              }
              return 'no landed publish of the peer';
            }
            case 'genesis': {
              const s = st.state.get(e.peer);
              if (s === undefined) return 'no state before the genesis A';
              const l0 = await readTree(repo, await treeOf(repo, s.laC));
              return entryOid(l0, e.path) === e.blob ? null : `A[p] := ${e.blob}, but tree(L0)[p] is ${entryOid(l0, e.path)}`;
            }
            case 'join': {
              const head = await readTree(repo, await treeOf(repo, (await repo.run(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.toString('utf8').trim()));
              return entryOid(head, e.path) === e.blob ? null : `A[p] := ${e.blob}, but tree(HEAD)[p] is ${entryOid(head, e.path)} (A seeded from TIP?)`;
            }
            case 'restart_decision': {
              if (!ctx.opLog.some((o) => o.kind === 'killed' && o.peer === peer.name)) return 'no crash of the peer before it';
              const m = st.applyMerge.get(e.peer);
              if (m === undefined) return 'no apply merge of the peer before it';
              const tip = await readTree(repo, m.theirs);
              return entryOid(tip, e.path) === e.blob ? null : `A[p] := ${e.blob}, but TIP[p] of the crashed apply is ${entryOid(tip, e.path)}`;
            }
            case 'lost_state':
            case 'recover_reanchor': {
              const s = st.state.get(e.peer);
              if (s === undefined) return 'no state before it';
              const versions = await chainVersions(repo, s.laC, e.path);
              return versions.has(e.blob) ? null : `A[p] := ${e.blob}, a version of p on no commit of LA_C ${s.laC}'s chain`;
            }
            default:
              return `unknown cause ${String((e as { cause: unknown }).cause)}`;
          }
        })();
        if (why !== null) {
          st.next = i + 1;
          return `${peer.name}: A_set(${e.path}) cause ${e.cause}: ${why}`;
        }
      }
      return null;
    },
  };
}

/** Lost-state rebuilds read ≤ 500 first-parent commits (glossary §20). */
const LOST_STATE_DEPTH = 500;

/** Every version of `path` (null = absent) on the ≤ 500 newest commits of `tip`'s first-parent chain. */
async function chainVersions(repo: GitRepo, tip: string, path: string): Promise<ReadonlySet<string | null>> {
  const commits = await repo.firstParents(parseOid(tip), null, LOST_STATE_DEPTH);
  const out = new Set<string | null>();
  for (const c of commits) out.add(entryOid(await readTree(repo, await treeOf(repo, c)), path));
  return out;
}

// ---- INV-PUSHED-IS-MERGE ---------------------------------------------------------------------------------------------

/**
 * A publish waiting for its Bnew to land: the publisher's state and hold records as the trace stood at the event, and (Plan 3 Task 10)
 * the publisher's last `compose` event before it: its groups' readiness is the engine's (R3-63).
 */
interface Waiting { e: PublishEvent; state: string | null; holds: ReadonlyMap<string, HoldEvent>; compose: ComposeEvent | null; }
type ComposeEvent = Extract<TraceEvent, { kind: 'compose' }>;

/**
 * INV-PUSHED-IS-MERGE (see the file header): every 'publish' event whose Bnew landed (the remote log holds it) and that
 * carries a code commit C. A publish that has not landed is looked at again after later ops.
 */
export function oraclePushedIsMerge(): Oracle {
  interface Run { next: number; waiting: Waiting[]; lastState: Map<string, string>; holds: Map<string, Map<string, HoldEvent>>; compose: Map<string, ComposeEvent>; }
  const runs = new WeakMap<SimContext, Run>();
  return {
    name: 'INV-PUSHED-IS-MERGE',
    async afterEveryOp(ctx: SimContext): Promise<string | null> {
      let st = runs.get(ctx);
      if (st === undefined) {
        st = { next: 0, waiting: [], lastState: new Map(), holds: new Map(), compose: new Map() };
        runs.set(ctx, st);
      }
      const events = ctx.trace.events;
      for (; st.next < events.length; st.next++) {
        const e = events[st.next];
        if (e === undefined) continue;
        if (e.kind === 'state') st.lastState.set(e.peer, e.next);
        else if (e.kind === 'hold') {
          const h = st.holds.get(e.peer) ?? new Map<string, HoldEvent>();
          h.set(e.id, e);
          st.holds.set(e.peer, h);
        } else if (e.kind === 'compose') {
          st.compose.set(e.peer, e);
        } else if (e.kind === 'publish' && e.c !== null) {
          st.waiting.push({ e, state: st.lastState.get(e.peer) ?? null, holds: new Map(st.holds.get(e.peer) ?? []), compose: st.compose.get(e.peer) ?? null });
        }
      }
      if (st.waiting.length === 0) return null;
      const landed = await landedOids(ctx);
      const still: Waiting[] = [];
      let failure: string | null = null;
      for (const w of st.waiting) {
        if (failure !== null || !landed.has(w.e.bnew)) {
          still.push(w);
          continue;
        }
        failure = await checkPublish(ctx, w);
      }
      st.waiting = still;
      return failure;
    },
  };
}

interface JournalPair { csId: string; order: number; R: TreeMap; A: TreeMap; paths: string[]; }
interface Journal { base: string; tP: string | null; epochBase: string; ready: JournalPair[]; fold: unknown; }

const HUMAN_CS = /^[0-9a-f]{32}\/human\/([1-9][0-9]*)$/;

/** One level of a tree: name → {type, oid}. */
async function lsTree(repo: GitRepo, treeish: string): Promise<Map<string, { type: string; oid: string }>> {
  const r = await repo.run(['ls-tree', '-z', treeish]);
  const out = new Map<string, { type: string; oid: string }>();
  for (const rec of r.stdout.toString('utf8').split('\0')) {
    if (rec.length === 0) continue;
    const tab = rec.indexOf('\t');
    const [, type = '', oid = ''] = rec.slice(0, tab).split(' ');
    out.set(rec.slice(tab + 1), { type, oid });
  }
  return out;
}

/** The journal of a state commit, read by the oracle itself (01-engine §3.2 layout). */
async function journalOf(repo: GitRepo, state: string): Promise<Journal> {
  const root = await lsTree(repo, (await repo.readCommit(parseOid(state))).tree);
  const need = (name: string, m: Map<string, { type: string; oid: string }>): string => {
    const e = m.get(name);
    if (e === undefined) throw new Error(`oracle: state ${state} has no ${name}`);
    return e.oid;
  };
  const meta = parseMeta(await repo.readBlob(parseOid(need('meta', root))));
  const journal = await lsTree(repo, need('journal', root));
  const t = await lsTree(repo, need('t', journal));
  const ready: JournalPair[] = [];
  for (const [k, e] of await lsTree(repo, need('ready', journal))) {
    const csId = Buffer.from(k, 'base64url').toString('utf8');
    const m = HUMAN_CS.exec(csId);
    if (m === null) throw new Error(`oracle: state ${state} journals ready/${k}, not a human change-set`);
    const pair = await lsTree(repo, e.oid);
    const R = await readTree(repo, need('R', pair));
    const A = await readTree(repo, need('A', pair));
    ready.push({ csId, order: Number(m[1]), R, A, paths: [...new Set([...R.keys(), ...A.keys()])].sort() });
  }
  ready.sort((x, y) => x.order - y.order || (x.csId < y.csId ? -1 : x.csId > y.csId ? 1 : 0));
  let fold: unknown = null;
  const keep = await lsTree(repo, need('keep', journal));
  const f = keep.get('fold');
  if (f !== undefined) {
    const file = (await lsTree(repo, f.oid)).get('state.json');
    if (file !== undefined) fold = JSON.parse((await repo.readBlob(parseOid(file.oid))).toString('utf8'));
  }
  return { base: need('base', root), tP: t.get('P')?.oid ?? null, epochBase: meta.EPOCH_BASE, ready, fold };
}

const PATH_CLASSES: ReadonlySet<ScopeClass> = new Set<ScopeClass>(['QUARANTINED', 'SAVE_ONLY', 'UNMANAGED']);
const LIVE_STATES: ReadonlySet<string> = new Set(['ACTIVE', 'CONFLICTED']);

/**
 * The held PINs' path sets (Plan 3 Task 10, HLD-38: every non-terminal ON_DISK PIN with a guard holds its publication group; Plan 2's
 * P2-PIN named only join, phantom and host-reject) and the paths any ON_DISK record with a guard may mask, from the trace's hold events.
 */
function holdPaths(holds: ReadonlyMap<string, HoldEvent>): { pins: string[][]; masking: Set<string> } {
  const pins: string[][] = [];
  const masking = new Set<string>();
  for (const h of holds.values()) {
    if (h.residence !== 'ON_DISK' || h.guard === '' || !LIVE_STATES.has(h.state)) continue;
    for (const p of h.paths) masking.add(p);
    if (h.holdKind === 'PIN') pins.push([...h.paths]);
  }
  return { pins, masking };
}

/** HLD-38's closure over the journaled pairs and the held PINs sharing a path: the cs_ids of the groups a held PIN holds. */
function heldGroups(ready: readonly JournalPair[], pins: readonly string[][]): Set<string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (a: string, b: string): void => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const pair of ready) for (const p of pair.paths) union(`cs:${pair.csId}`, `p:${p}`);
  pins.forEach((paths, i) => { for (const p of paths) union(`pin:${i}`, `p:${p}`); });
  const heldRoots = new Set(pins.map((_, i) => find(`pin:${i}`)));
  return new Set(ready.filter((pair) => heldRoots.has(find(`cs:${pair.csId}`))).map((pair) => pair.csId));
}

/** journal/keep/cs/table.json of a state commit (R3-40), or null while no table is journaled. */
async function csTableOf(repo: GitRepo, state: string): Promise<CsTable | null> {
  const r = await repo.run(['cat-file', '-e', `${state}:journal/keep/cs/table.json`], { okCodes: [0, 1, 128] });
  if (r.code !== 0) return null;
  const blob = (await repo.run(['rev-parse', '--verify', `${state}:journal/keep/cs/table.json`])).stdout.toString('utf8').trim();
  return parseCsTable(await repo.readBlob(parseOid(blob)));
}

/** The not-stageable non-portable names (R3-53) a peer's `nonportable_name` ops wrote, each with the name its fix renamed it to (or null). */
function blockedNames(ctx: SimContext, peer: string): Array<{ bad: string; fixed: string | null }> {
  const out: Array<{ bad: string; fixed: string | null }> = [];
  for (const e of ctx.opLog) {
    // The op's own row, or a composite row of the generator's forced cleanup (`nonportable_name: <detail>; …`); the written name
    // np/ok-p<i>-<k>.txt names the peer.
    if (!e.detail.includes('np/') || (e.kind !== 'nonportable_name' && !e.detail.includes('nonportable_name: '))) continue;
    for (const made of e.detail.matchAll(/("(?:[^"\\]|\\.)*") np\/ok-p(\d+)-\S+ stageable=false /g)) {
      if (`p${made[2]}` === peer) out.push({ bad: JSON.parse(made[1]!) as string, fixed: null });
    }
    for (const fix of e.detail.matchAll(/("(?:[^"\\]|\\.)*") -> (np\/fixed-[^\s;]+)/g)) {
      const bad = JSON.parse(fix[1]!) as string;
      const entry = out.find((x) => x.bad === bad && x.fixed === null);
      if (entry !== undefined) entry.fixed = fix[2]!;
    }
  }
  return out;
}

/**
 * Why a publication group the engine's compose event marks not ready is not ready, found test-side (Plan 3 Task 16, the Task 10 carry),
 * or null. The group's membership is the event's (an open CS's paths are in no journal, R3-63); the reason must come from what the
 * oracle reads itself (HLD-38, HLD-39, R3-53; changesets.ts readyOf's rules): (a) a held PIN — a non-terminal ON_DISK PIN with guards of
 * the registry commit the compose event names — shares a path with the group or its journaled pairs; (b) a member's journaled pair is not
 * from a passing capture (the state's CS table `passing`); (c) a member has no journaled ready pair — an open change-set, or a closed
 * one not captured yet (R3-63: every csId of a composable group is among the pairs);
 * (d) R3-53's gate: the peer wrote a not-stageable non-portable name (its `nonportable_name` op) that is still on its disk, or whose fix
 * (the rename to np/fixed-<k>.txt) no landed live commit carries yet (the latch holds until the CS the fix opened closes, and that CS
 * publishes with the held-back groups in one commit, DAT-32). (Task 17's revert gate needs Plan 7's revert verb; no SIM op reaches it.)
 * Exported for its test (sim.exit.holds.test.ts).
 */
export async function notReadyReason(ctx: SimContext, peer: PeerClone, w: Waiting, j: Journal, g: ComposeEvent['groups'][number], cTree: TreeMap): Promise<string | null> {
  const repo = repoOf(ctx, peer);
  const groupPaths = new Set([...g.paths, ...j.ready.filter((p) => g.csIds.includes(p.csId)).flatMap((p) => p.paths)]);
  const registry = w.compose?.registry ?? null;
  if (registry !== null) {
    const reg = await readRegistry(oracleRunner(), peer.dir, 'main', parseOid(registry));
    for (const r of reg.records.values()) {
      if ((TERMINAL_STATES as ReadonlySet<string>).has(r.state) || r.residence !== 'ON_DISK' || r.kind !== 'PIN' || r.guards.length === 0) continue;
      if (r.paths.some((p) => groupPaths.has(p))) return `(a) held PIN ${r.id}`;
    }
  }
  const table = w.state === null ? null : await csTableOf(repo, w.state);
  if (table !== null) {
    for (const id of g.csIds) {
      if (table.passing[id] === false && j.ready.some((p) => p.csId === id)) return `(b) ${id}'s pair is not from a passing capture`;
    }
  }
  for (const id of g.csIds) if (!j.ready.some((p) => p.csId === id)) return `(c) ${id} has no journaled ready pair`;
  for (const n of blockedNames(ctx, peer.name)) {
    if (n.fixed === null) {
      if ((await lstat(join(peer.dir, ...n.bad.split('/'))).catch(() => null)) !== null) return `(d) ${JSON.stringify(n.bad)} is on disk`;
      continue;
    }
    if (!cTree.has(n.fixed)) return `(d) the fix ${n.fixed} of ${JSON.stringify(n.bad)} is not in this publish's C`;
  }
  return null;
}

/** D9 (c) at the publish: every active peer of the journaled fold announced the publisher's regionSpec. */
function concatAllowedBy(fold: unknown): boolean {
  const peers = (fold as { peers?: Record<string, { status?: unknown; regionSpec?: unknown }> } | null)?.peers;
  if (peers === undefined) return true;
  return Object.values(peers).every((p) => p.status !== 'active' || p.regionSpec === PLAN2_REGION_SPEC);
}

async function checkPublish(ctx: SimContext, w: Waiting): Promise<string | null> {
  const { e } = w;
  const peer = peerOf(ctx, e.peer);
  const repo = repoOf(ctx, peer);
  const who = `${peer.name}: publish ${e.bnew}`;
  const c = e.c as string;
  if (w.state === null) return `${who}: no state of the peer before it`;

  // P, recomputed from the push intent's journal.
  const j = await journalOf(repo, w.state);
  if (j.base !== e.aTree) return `${who}: its A ${e.aTree} is not the journaled A ${j.base}`;
  if (j.tP !== e.pTree) return `${who}: its P ${e.pTree} is not the journaled t/P ${String(j.tP)}`;
  const cInfo = await repo.readCommit(parseOid(c));
  if (cInfo.parents.length !== 1 || cInfo.parents[0] !== e.tip) return `${who}: C ${c} has parents ${JSON.stringify(cInfo.parents)}, not [TIP ${e.tip}]`;
  const A = await readTree(repo, j.base);
  const composed = new Set(cInfo.trailers.filter((t) => t.key === 'Cowork-CS').map((t) => t.value.split(' ')[0] ?? ''));
  const { pins, masking } = holdPaths(w.holds);
  const held = heldGroups(j.ready, pins);
  const groupOf = (csId: string): ComposeEvent['groups'][number] | undefined => w.compose?.groups.find((g) => g.csIds.includes(csId));
  let cTree: TreeMap | undefined;
  for (const id of composed) if (!j.ready.some((r) => r.csId === id)) return `${who}: C carries Cowork-CS ${id}, which the journal holds no ready pair for`;
  const X = new Map<string, TreeEntry>(A);
  for (const pair of j.ready) {
    if (!composed.has(pair.csId)) {
      // HLD-38/HLD-39 (Plan 3 Task 10): a pair whose publication group a held PIN holds stays out of C. Plan 3 Task 16 (the Task 10
      // carry; TST-07: an oracle never trusts the engine under test): a group the engine's compose event marks not ready (an open CS's
      // paths, which the journal does not show, can join groups; R3-63) is excused only when the test side finds why (notReadyReason).
      if (held.has(pair.csId)) continue;
      const g = groupOf(pair.csId);
      if (g?.ready === false) {
        cTree ??= await readTree(repo, cInfo.tree);
        const why = await notReadyReason(ctx, peer, w, j, g, cTree);
        if (why !== null) continue;
        return `${who}: the compose event marks the group ${g.key} of the journal's ready pair ${pair.csId} not ready, but the test side finds no reason (no held PIN of its registry ${String(w.compose?.registry ?? null)} in the group, no non-passing pair, no closed change-set without a pair, no R3-53 gate)`;
      }
      return `${who}: the journal's ready pair ${pair.csId} is in no held or not-ready group, but C does not carry it`;
    }
    if (held.has(pair.csId)) return `${who}: C carries ${pair.csId}, whose publication group a held PIN holds (HLD-38)`;
    if (groupOf(pair.csId)?.ready === false) return `${who}: C carries ${pair.csId}, whose group the compose event marks not ready`;
    for (const p of pair.paths) if (!same(pair.A.get(p), A.get(p))) return `${who}: the composed pair ${pair.csId} has A_cap[${p}] = ${show(pair.A.get(p))} != A[${p}] = ${show(A.get(p))} (ENG-39)`;
    for (const p of pair.paths) {
      const r = pair.R.get(p);
      if (r !== undefined) X.set(p, r);
      else X.delete(p);
    }
  }
  const P = await readTree(repo, e.pTree);
  const differ = diffPaths(X, P);
  if (differ.length > 0) {
    const inp = scopeInputs(j.epochBase);
    const sizes = await blobSizes(repo, [X, P, A]);
    // EF2 D1 (05 §3.4 item 2 step 5, HLD-42, HLD-28 "untainted edits on the same path publish normally"): a path an ON_DISK ACTIVE
    // PATCH with guards holds at step 5 (a `revert` record) publishes R minus the held hunks, P[p] = the step-5 chain from X[p] —
    // neither X[p] nor A[p]. It is recomputed test-side (testMask) over the registry the publish's own compose event names, read only
    // when a path is not already explained (and only when that compose event is this publish's composition: same P, same A).
    const compose = w.compose !== null && w.compose.pTree === e.pTree && w.compose.aTree === e.aTree ? w.compose : null;
    let step5: Map<string, { step: number | null; entry: { mode: string; oid: string } | null }> | null | undefined;
    for (const p of differ) {
      const x = X.get(p) ?? A.get(p) ?? P.get(p);
      const size = Math.max(...[X.get(p), P.get(p), A.get(p)].map((y) => (y === undefined ? 0 : (sizes.get(y.oid) ?? 0))));
      const masked = masking.has(p) || (x !== undefined && PATH_CLASSES.has(scopeOfTracked(p, x.mode, size, inp).cls));
      if (masked && same(P.get(p), A.get(p))) continue;
      // (A scope input simScope does not model — an EPOCH_BASE .gitattributes, a merge driver — leaves the path to the rule above.)
      if (step5 === undefined) step5 = compose === null ? null : await publishMaskOf(ctx, peer, compose.registry, j.epochBase, X, A, differ).catch(() => null);
      const m = step5?.get(p);
      if (m !== undefined && m.step === 5) {
        const o = P.get(p);
        if (m.entry === null ? o === undefined : o !== undefined && o.oid === m.entry.oid && o.mode === m.entry.mode) continue;
        return `${who}: P[${p}] = ${show(P.get(p))}, but the journal's composition gives ${show(X.get(p))} and MASK step 5 over registry ${String(compose!.registry)} gives ${m.entry === null ? 'absent' : `${m.entry.mode} ${m.entry.oid}`}`;
      }
      return `${who}: P[${p}] = ${show(P.get(p))}, but the journal's composition gives ${show(X.get(p))}${masked ? ` and MASK A[${p}] = ${show(A.get(p))}` : ''}`;
    }
  }

  // OUT, recomputed: merge-tree, the rename carry, the conflict function.
  const tipTree = await treeOf(repo, e.tip);
  const TIP = await readTree(repo, tipTree);
  const merged = await mergeTree(repo, parseOid(e.aTree), parseOid(e.pTree), parseOid(tipTree));
  const R = await readTree(repo, merged.tree);
  const OUT = new Map<string, TreeEntry>(R);
  const put = (p: string, x: TreeEntry | undefined): void => {
    if (x === undefined) OUT.delete(p);
    else OUT.set(p, { path: p, mode: x.mode, oid: x.oid });
  };
  const handled = new Set<string>();
  const sources: string[] = [];
  for (const p of [...new Set([...A.keys(), ...P.keys(), ...TIP.keys(), ...R.keys()])].sort()) {
    if (!editable(p)) continue;
    const a = A.get(p);
    const o = P.get(p);
    const t = TIP.get(p);
    if (same(o, a) && !same(R.get(p), t)) {
      put(p, t);
      handled.add(p);
    } else if (o !== undefined && !same(o, a) && t === undefined && R.get(p) === undefined) {
      sources.push(p);
    }
  }
  const config = (await readTeamConfig(repo, parseOid(j.epochBase))).config;
  let epochMap: TreeMap | null = null;
  const cctx: ConflictCtx = {
    repo,
    isText: () => true,   // no attributes in a Plan 2 SIM seed (R-31); conflict() itself treats NUL bytes as binary
    insertionMerge: (p) => config.merge.insertionMerge.some((g) => wildmatch(g, p)),
    concatAllowed: concatAllowedBy(j.fold),
    localOnly: () => false,
    ref: async (p) => {
      let x = A.get(p);
      if (x === undefined) {
        epochMap ??= await readTree(repo, await treeOf(repo, j.epochBase));
        x = epochMap.get(p);
      }
      return x === undefined || !isRegular(x) ? null : repo.readBlob(x.oid);
    },
    write: true,
  };
  const route = (p: string, v: ConflictVerdict): void => {
    if (v.kind === 'CONCAT') put(p, { path: p, mode: P.get(p)?.mode ?? TIP.get(p)?.mode ?? '100644', oid: v.blob });
    else if (v.kind === 'TAKE_TIP') put(p, v.entry === ABSENT ? undefined : TIP.get(p));
    else put(p, TIP.get(p));
  };
  for (const p of sources) {
    route(p, await conflict(cctx, p, (A.get(p)?.oid ?? ABSENT) as Oid, (P.get(p) as TreeEntry).oid, ABSENT, 'other'));
    handled.add(p);
  }
  for (const p of merged.conflicted) {
    if (handled.has(p)) continue;
    const a = A.get(p);
    const o = P.get(p);
    const t = TIP.get(p);
    const unit: UnitKind = isRegular(a) && isRegular(o) && isRegular(t) && a.mode === o.mode && o.mode === t.mode ? 'content' : 'other';
    route(p, await conflict(cctx, p, (a?.oid ?? ABSENT) as Oid, (o?.oid ?? ABSENT) as Oid, (t?.oid ?? ABSENT) as Oid, unit));
  }
  const pushed = await readTree(repo, cInfo.tree);
  for (const p of [...new Set([...OUT.keys(), ...pushed.keys()])].sort()) {
    if (!same(OUT.get(p), pushed.get(p))) {
      return `${peer.name}: landed ${c} has ${p} = ${show(pushed.get(p))}, the merge of A, P and TIP (rename carry, conflict function) gives ${show(OUT.get(p))}`;
    }
  }
  const published = new Set(diffPaths(A, P));
  const outside = diffPaths(TIP, pushed).filter((p) => !published.has(p));
  if (outside.length > 0) return `${peer.name}: landed ${c} changes ${JSON.stringify(outside)} that P does not (paths(diff(TIP, C)) ⊄ paths(diff(A, P)))`;
  return null;
}

// ---- INV-CONVERGE ---------------------------------------------------------------------------------------------------

/** No .gitattributes in a Plan 2 SIM seed (R-31: no filter attributes): every path has git's default attributes. */
const NO_ATTRS: PathAttrs = Object.freeze({ filter: null, merge: null, text: null, binary: false, eol: null, generated: false, coworkOff: false, workingTreeEncoding: null });

function scopeInputs(epochBase: string): ScopeInputs {
  const attrs: AttrSnapshot = { epochBase: parseOid(epochBase), get: () => NO_ATTRS };
  return { attrs, config: DEFAULT_TEAM_CONFIG, mergeDrivers: new Set(), localOnlyPaths: new Set(), hooksPathDir: null };
}

/**
 * Plan 2 Task 18 ruling (ENG-36) on R-32's LA_B == T*: a peer's LA_B is T*, or a board on T*'s first-parent chain whose live
 * code tree equals live_code(T*)'s (a teammate's board-only last change — an event, a join, a hold mirror — leaves LA_B behind).
 * null when it holds, else the reason.
 */
export async function laBAtTStar(ctx: SimContext, peer: PeerClone, laB: string, tStar: string): Promise<string | null> {
  if (laB === tStar) return null;
  const repo = repoOf(ctx, peer);
  const onChain = (await firstParentChain(ctx, peer, tStar)).has(laB);
  if (onChain && (await treeOf(repo, await liveCodeOf(repo, laB))) === (await treeOf(repo, await liveCodeOf(repo, tStar)))) return null;
  return `${peer.name}: LA_B ${laB} != T* ${tStar}${onChain ? ' and its live code tree differs' : ' (not on its first-parent chain)'}`;
}

/** ruling R-32 (atQuiescence): see the file header. */
export function oracleConverge(): Oracle {
  return {
    name: 'INV-CONVERGE',
    async atQuiescence(ctx: SimContext): Promise<string | null> {
      const q = ctx.quiescence;
      if (q === null) return 'no quiescence phase (runSim without opts.quiescence)';
      if (!q.reached || q.tStar === null) return `no T*: ${JSON.stringify(q)}`;
      if (q.tStar.includes(',')) return `several board refs at T*: ${q.tStar}`;
      if (q.pushAttemptsInExtra !== 0) return `${q.pushAttemptsInExtra} push attempt(s) in the extra loops after T*`;
      if (q.boardChangedInExtra) return 'the board tip changed in the extra loops after T*';
      const tStar = q.tStar;
      for (const engine of ctx.engines) {
        const peer = engine.peer;
        if (engine.inspect === undefined) return `${peer.name}: the engine cannot be inspected`;
        const ins = await engine.inspect();
        const repo = repoOf(ctx, peer);
        const live = await liveCodeOf(repo, tStar);
        const liveTree = await treeOf(repo, live);
        const liveMap = await readTree(repo, liveTree);

        const laB = await laBAtTStar(ctx, peer, ins.laB, tStar);
        if (laB !== null) return laB;
        const skip = new Set(ins.notConverged);
        const inp = scopeInputs(ins.epochBase);
        const aMap = await readTree(repo, ins.aTree);
        const sizes = await blobSizes(repo, [aMap, liveMap]);
        const sizeOf = (e: TreeEntry | undefined): number => (e === undefined ? 0 : (sizes.get(e.oid) ?? 0));
        const isLive = (p: string, m: TreeMap): boolean => {
          const e = m.get(p);
          return e === undefined || scopeOfTracked(p, e.mode, Math.max(sizeOf(aMap.get(p)), sizeOf(liveMap.get(p))), inp).cls === 'LIVE';
        };
        for (const p of [...new Set([...aMap.keys(), ...liveMap.keys()])].sort()) {
          if (skip.has(p) || !isLive(p, liveMap) || !isLive(p, aMap)) continue;
          if (entryOid(aMap, p) !== entryOid(liveMap, p)) return `${peer.name}: A[${p}] = ${entryOid(aMap, p)}, tree(live_code(T*))[${p}] = ${entryOid(liveMap, p)}`;
        }
        const disk = await workingTreeDiffers(ctx, peer, repo, liveTree, liveMap, skip, inp, sizeOf);
        if (disk !== null) return `${peer.name}: ${disk}`;
      }
      return null;
    },
  };
}

/**
 * The working tree's stored form against tree(live_code(T*)): a scratch index read from that tree, update-index
 * --refresh (rc 1 = some entry needs an update, normal) and diff-files -z in the peer's repo name the candidates; each
 * is compared through canon with the stored blob (DISK_EQ's rule: an ending or BOM flip that canon maps back is equal).
 * A tracked path is classed with the larger of its blob's size and the file's on disk. Untracked files (ls-files -o
 * --exclude-standard against the same index) must be NOT_ADMITTED.
 */
async function workingTreeDiffers(
  ctx: SimContext, peer: PeerClone, repo: GitRepo, liveTree: string, liveMap: TreeMap, skip: ReadonlySet<string>, inp: ScopeInputs,
  sizeOf: (e: TreeEntry | undefined) => number,
): Promise<string | null> {
  const index = join(ctx.root, `oracle-converge-${peer.name}.index`);
  await rm(index, { force: true });
  try {
    await repo.readTreeIntoIndex(index, parseOid(liveTree));
    await repo.run(['update-index', '--refresh'], { class: 'refupdate', indexFile: index, okCodes: [0, 1] });
    const dirty = (await repo.run(['diff-files', '-z', '--name-only'], { indexFile: index })).stdout.toString('utf8').split('\0').filter((p) => p.length > 0);
    for (const p of dirty.sort()) {
      if (skip.has(p)) continue;
      const e = liveMap.get(p);
      if (e === undefined) continue;
      const file = join(repo.paths.workTree, ...p.split('/'));
      const st = await lstat(file).catch(() => null);
      if (scopeOfTracked(p, e.mode, Math.max(sizeOf(e), st?.size ?? 0), inp).cls !== 'LIVE') continue;
      let bytes: Buffer;
      try {
        bytes = await readFile(file);
      } catch {
        return `${p} is missing on disk, T* has ${e.oid}`;
      }
      const stored = await repo.readBlob(e.oid);
      const c = canon(bytes, stored, false);
      if (!(c.ok && c.out.equals(stored))) return `${p} on disk is not T*'s ${e.oid} (not even through canon)`;
    }
    const others = (await repo.run(['ls-files', '-o', '--exclude-standard', '-z'], { indexFile: index })).stdout.toString('utf8').split('\0').filter((p) => p.length > 0);
    const all = new Set([...liveMap.keys(), ...others]);
    for (const p of others.sort()) {
      if (skip.has(p)) continue;
      const st = await lstat(join(repo.paths.workTree, ...p.split('/')));
      const s = admitNew(p, st.size, st.isSymbolicLink(), all, inp);
      if (s.cls !== 'NOT_ADMITTED') return `untracked ${p} is ${s.cls}, not in T*`;
    }
    return null;
  } finally {
    await rm(index, { force: true });
  }
}

// ---- O-STATE and O-REACH (Plan 3 Task 16; 11-testing §3.4, TST-06; INV-ENG-STATE, INV-ENG-REACH) ---------------------

/** The SIM's branch: every peer's local cowork refs live under refs/cowork-local/main/ (enc('main') = 'main'). */
const SIM_BRANCH_LOCAL = 'refs/cowork-local/main/';
const STATE_REF = `${SIM_BRANCH_LOCAL}state`;
const HOLDS_REF = `${SIM_BRANCH_LOCAL}holds`;
const ZERO = /^0+$/;

/** One reflog line: `<old> <new> <ident> <ts> <tz>\t<msg>`. */
interface ReflogEntry { old: string; new: string; line: string; }

/** The peer's reflog of `ref` (the file git writes under .git/logs; [] when it does not exist yet). */
async function reflogOf(peer: PeerClone, ref: string): Promise<ReflogEntry[]> {
  let text: string;
  try {
    text = await readFile(join(peer.dir, '.git', 'logs', ...ref.split('/')), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: ReflogEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) ([0-9a-f]{40}(?:[0-9a-f]{24})?) /.exec(line);
    out.push({ old: m?.[1] ?? '', new: m?.[2] ?? '', line });
  }
  return out;
}

/** The value of a local ref of the peer (null: absent). */
async function refValue(peer: PeerClone, ref: string): Promise<string | null> {
  const r = await oracleRunner().run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { class: 'local', cwd: peer.dir });
  return r.code === 0 ? r.stdout.toString('utf8').trim() : null;
}

/**
 * O-STATE (afterEveryOp; INV-ENG-STATE: "the state ref changes only by CAS update-ref; LA_C and LA_B are monotone on their first-parent
 * chains", across kill -9 and restart). Per peer, from its reflog file of refs/cowork-local/main/state (written by every update-ref
 * --create-reflog; a killed process leaves it as it was): (i) the chain — entry 0 creates the ref (old = 0…0) and entry k's old is entry
 * k−1's new; (ii) the ref's value is the last entry's new (no update outside the logged CAS chain); (iii) every new entry's state commit
 * has parents [LA_C, LA_B], and the previous entry's LA_C is on the new LA_C's first-parent chain (equal included), and so for LA_B —
 * except an entry written while the peer ran a human-typed `recover` op (its re-anchor moves both to the recovered chain, 01-engine
 * test 35; INV-FF's recover exemption). Entries already judged are not judged again.
 */
export function oracleState(): Oracle {
  interface PeerSeen { entries: number; last: { commit: string; laC: string; laB: string } | null; }
  const runs = new WeakMap<SimContext, { seen: Map<string, PeerSeen>; opLogAt: number }>();
  return {
    name: 'O-STATE',
    async afterEveryOp(ctx: SimContext): Promise<string | null> {
      let st = runs.get(ctx);
      if (st === undefined) {
        st = { seen: new Map(), opLogAt: 0 };
        runs.set(ctx, st);
      }
      const recovering = new Set(ctx.opLog.slice(st.opLogAt).filter((e) => e.kind === 'recover').map((e) => e.peer));
      st.opLogAt = ctx.opLog.length;
      for (const peer of ctx.peers) {
        const log = await reflogOf(peer, STATE_REF);
        const seen = st.seen.get(peer.name) ?? { entries: 0, last: null };
        st.seen.set(peer.name, seen);
        const repo = repoOf(ctx, peer);
        for (let k = seen.entries; k < log.length; k++) {
          const e = log[k]!;
          seen.entries = k + 1;
          const prevNew = k === 0 ? null : log[k - 1]!.new;
          if (prevNew === null ? !ZERO.test(e.old) : e.old !== prevNew) {
            return `O-STATE (i) ${peer.name}: reflog entry ${k} of ${STATE_REF} moves ${e.old} -> ${e.new}, but ${prevNew === null ? 'the first entry must create the ref' : `the previous entry left it at ${prevNew}`} (not a CAS chain)`;
          }
          if (ZERO.test(e.new)) return `O-STATE (i) ${peer.name}: reflog entry ${k} deletes ${STATE_REF}`;
          const info = await repo.readCommit(parseOid(e.new));
          if (info.parents.length !== 2) return `O-STATE (iii) ${peer.name}: state commit ${e.new} has parents ${JSON.stringify(info.parents)}, not [LA_C, LA_B]`;
          const [laC = '', laB = ''] = info.parents;
          const prev = seen.last;
          seen.last = { commit: e.new, laC, laB };
          if (prev === null || recovering.has(peer.name)) continue;
          for (const [which, before, now] of [['LA_C', prev.laC, laC], ['LA_B', prev.laB, laB]] as const) {
            if (before === now) continue;
            if (!(await firstParentChain(ctx, peer, now)).has(before)) {
              return `O-STATE (iii) ${peer.name}: state ${prev.commit} -> ${e.new} moves ${which} ${before} -> ${now}, which does not have ${before} on its first-parent chain (not monotone)`;
            }
          }
        }
        const value = await refValue(peer, STATE_REF);
        const tail = log[log.length - 1]?.new ?? null;
        if (value !== tail) return `O-STATE (ii) ${peer.name}: ${STATE_REF} is at ${value ?? 'absent'}, but its reflog's last CAS left it at ${tail ?? 'absent'} (an update outside the logged CAS chain)`;
      }
      return null;
    },
  };
}

/** Every oid a tree names, recursively (trees and blobs; gitlinks are not objects of this repo). */
async function treeOids(peer: PeerClone, treeish: string): Promise<string[]> {
  const r = await oracleRunner().run(['ls-tree', '-r', '-t', '-z', treeish], { class: 'local', cwd: peer.dir });
  const out: string[] = [];
  for (const rec of r.stdout.toString('utf8').split('\0')) {
    if (rec.length === 0) continue;
    const [mode = '', , oid = ''] = rec.slice(0, rec.indexOf('\t')).split(' ');
    if (mode !== '160000') out.push(oid);
  }
  return out;
}

/** The oids of `oids` the peer's object store lacks (cat-file --batch-check). */
async function missingOids(peer: PeerClone, oids: readonly string[]): Promise<string[]> {
  if (oids.length === 0) return [];
  const r = await oracleRunner().run(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { class: 'local', cwd: peer.dir, stdin: Buffer.from(`${oids.join('\n')}\n`, 'utf8') });
  return r.stdout.toString('utf8').split('\n').filter((l) => / missing$/.test(l)).map((l) => l.split(' ')[0] ?? l);
}

/**
 * O-REACH's verdict for one peer now (INV-ENG-REACH): every oid its state commit names — LA_C and LA_B, and every tree and blob of its
 * tree: base (A), snap, meta, journal/intent.json, journal/t/*, journal/ready/<k>/{R,A}, journal/keep/* — and every oid of its hold
 * registry — the registry commit's tree (records/, blobs/, local.json) and every h0/h1/s1/s2 oid each record's blob maps name — exists in
 * the peer's object store. null when it holds.
 */
export async function reachVerdict(ctx: SimContext, peer: PeerClone): Promise<string | null> {
  const want = new Map<string, string>();
  const state = await refValue(peer, STATE_REF);
  if (state !== null) {
    const info = await repoOf(ctx, peer).readCommit(parseOid(state));
    info.parents.forEach((p, i) => want.set(p, `state ${state} parent ${i === 0 ? 'LA_C' : 'LA_B'}`));
    for (const o of await treeOids(peer, state)) if (!want.has(o)) want.set(o, `state ${state} tree`);
  }
  const holds = await refValue(peer, HOLDS_REF);
  if (holds !== null) {
    for (const o of await treeOids(peer, holds)) if (!want.has(o)) want.set(o, `registry ${holds} tree`);
    const reg = await readRegistry(oracleRunner(), peer.dir, 'main', parseOid(holds));
    for (const r of reg.records.values()) {
      for (const [stage, map] of Object.entries(r.blobs) as Array<[string, Record<string, string>]>) {
        for (const [p, o] of Object.entries(map)) if (o !== ABSENT && !want.has(o)) want.set(o, `record ${r.id} ${stage}[${p}]`);
      }
    }
  }
  const missing = await missingOids(peer, [...want.keys()]);
  if (missing.length === 0) return null;
  return `O-REACH ${peer.name}: ${missing.length} named object(s) missing: ${missing.slice(0, 6).map((o) => `${o} (${want.get(o)})`).join(', ')}`;
}

/**
 * O-REACH (11-testing §3.4; INV-ENG-REACH, F-FS-4): after every op step that ran a `gc --prune=now` (an op-log row `gc_prune`: the
 * holds generator's, or the crash matrix's gc of every clone) and at quiescence, reachVerdict holds for every peer.
 */
export function oracleReach(): Oracle {
  const cursors = new WeakMap<SimContext, number>();
  const all = async (ctx: SimContext): Promise<string | null> => {
    for (const peer of ctx.peers) {
      const why = await reachVerdict(ctx, peer);
      if (why !== null) return why;
    }
    return null;
  };
  return {
    name: 'O-REACH',
    async afterEveryOp(ctx: SimContext): Promise<string | null> {
      const from = cursors.get(ctx) ?? 0;
      cursors.set(ctx, ctx.opLog.length);
      if (!ctx.opLog.slice(from).some((e) => e.kind === 'gc_prune')) return null;
      return all(ctx);
    },
    atQuiescence: all,
  };
}

// ---- the exit set -----------------------------------------------------------------------------------------------------

/**
 * X-112: the one options object of exitOracles, so the one-argument form stays valid and Plans 4–7 append their keys here
 * (claims?: {model: ClaimsModel}, claude?, coord?, lifecycle?). `holds` (Plan 3 Task 16, R3-49): the run's MarkerModel, which
 * INV-NOLOSS reads (the generator notes every marker it writes in it).
 */
export interface ExitOracleOptions { holds?: { markers: MarkerModel }; }

/**
 * The exit criterion's oracles for one namespace: Plan 2's six (R-31) — [FF, OID, FIRSTPARENT, BASE, PUSHED-IS-MERGE, CONVERGE] —
 * and, with `o.holds` (Plan 3, R3-49: every SIM run asserts every oracle of §3.4), those six followed by INV-MASK, INV-GROUP,
 * O-READY, O-AND, O-OFFDISK, O-LIVE-RECORD, O-ATOMIC-PUB, INV-NOSILENT, INV-NOLOSS (over o.holds.markers), INV-SECRET-HELD and
 * (F1 audit fix #28) O-RELEASED-ENDS. Every call builds fresh oracles (each keeps per-run cursors).
 */
export function exitOracles(ns: RefNamespace = RELEASE_NAMESPACE, o?: ExitOracleOptions): Oracle[] {
  const plan2: Oracle[] = [
    oracleFF(ns.remotePrefix),
    oracleOID([`${ns.remotePrefix}probe-`]),
    oracleFirstParent(),
    oracleBase(),
    oraclePushedIsMerge(),
    oracleConverge(),
  ];
  if (o?.holds === undefined) return plan2;
  return [...plan2, ...holdsOracles(), oracleNoloss(o.holds.markers, ns), oracleHeldSecret(ns), oracleReleasedEnds()];
}
