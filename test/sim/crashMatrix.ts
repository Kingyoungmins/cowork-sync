// The SIM crash matrix driver (Plan 2 Task 19, extracted and parameterised by Plan 3 Task 16; 01-engine test 26, ENG-59; 11-testing
// TST-06 (SIM form), §3.6; TC-ENG-12 (SIM form); rulings R-31, R-32, R3-52). One driver for every crash matrix: a setup function
// composes each seed's run — its tuple, engine factory, oracles, SimOptions (the generator around the per-name lead-ins) and its kill
// rule — and runCrashMatrix runs the seeds one after another, each with one crash handler (and the Scheduler's yield hook) that asks the
// seed's rule at every crashpoint hit whether the peer dies there: a KilledAt ends that peer's engine step (the process died: engine
// dropped, daemon.lock released or left), and the peer's next step restarts it from disk (startDispatch, the engine adapter).
//
// The per-name lead-ins (Plan 2 Task 19's prologue, cut into its segments so every matrix can call the ones it needs; the segments
// keep Plan 2's steps exactly): `joinLeadIn` (genesis and two joins: join.first_apply and the genesis yield point), `groupsLeadIn` (a
// 2-path change-set and an independent one that a third peer applies in one apply: apply.group.mid, apply.between_groups), `k4LeadIn`
// (the same line edited on two peers: the later apply displaces its row into a K4 hold record, registry.cas), `rewindLeadIn` (a
// board-rewind incident and a human Engine.recover: recover.displaced) and `reanchorLeadIn` (a late peer whose own commits a second
// rewind and recover left off the chain, re-anchored by its recover: recover.reanchor, 01-engine test 35).
//
// The crashpoints a matrix kills are read from the catalogue test/crashpoints.json — the names with a crashpoint() call site in src/
// (X-116: the catalogue is the single list, which later plans append to; L-CRASHPOINTS keeps every call site in it), never a list
// of its own.
//
// Real git against a file:// bare remote; git is never mocked.
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { RELEASE_NAMESPACE } from '../../src/engine/refs.js';
import { guardName, isTerminal } from '../../src/holds/record.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { randomInt, seededRandom } from '../../src/ports/random.js';
import type { Step } from '../helpers/holdsScript.js';
import { editRowStep, recoverStep, rewindBoardStep, rounds, scripted, writeFileStep, type ScriptStep } from '../helpers/simOps.js';
import { realEngineOf } from './engineAdapter.js';
import { holdsOp, holdsSetup, resumeMassFrozen } from './generators.js';
import { runSim, type EngineFactory, type OpGenerator, type OpLogEntry, type Oracle, type SeedTuple, type SimContext, type SimOp, type SimOptions, type SimPhase, type SimResult } from './harness.js';
import { findMarkers, type MarkerModel } from './markers.js';
import { currentRemoteDir, exitOracles, oracleReach, oracleState } from './oracles.js';
import type { PeerClone } from './peers.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** The genesis yield point (L0 and B0 built, before their push; the Scheduler port's onYield), which Plan 2's matrix kills too. */
export const GENESIS_YIELD = 'start.beforeGenesisPush';

/** The op-log kinds the engine adapter adds inside an op (never the op itself). */
export const ADAPTER_KINDS: ReadonlySet<string> = new Set(['start', 'start_refused', 'killed', 'crash_armed', 'crash_disarmed']);

// ---- the catalogue -------------------------------------------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(full));
    else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Every crashpoint('<literal>') call in src/ outside the port itself (the AST: comments do not count). */
function placedNames(): Set<string> {
  const out = new Set<string>();
  for (const full of sourceFiles(join(REPO, 'src'))) {
    const file = relative(REPO, full).split('\\').join('/');
    if (file === 'src/ports/crashpoint.ts') continue;
    const sf = ts.createSourceFile(file, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'crashpoint') {
        const arg0 = node.arguments[0];
        if (arg0 !== undefined && ts.isStringLiteral(arg0)) out.add(arg0.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/**
 * The crashpoints the matrix kills: the names of the catalogue test/crashpoints.json that src/ places (X-116), in catalogue order.
 * At Plan 3's exit these are Plan 2's 14 — the 13 of ENG-59 and registry.cas (HLD-01, two call sites).
 */
export function catalogueCrashpoints(): string[] {
  const catalogue = JSON.parse(readFileSync(join(REPO, 'test', 'crashpoints.json'), 'utf8')) as string[];
  const placed = placedNames();
  return catalogue.filter((n) => placed.has(n));
}

// ---- the per-name lead-ins (Plan 2 Task 19's prologue segments) -----------------------------------------------------------

const rows = (tag: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${tag} row ${i}`);

/** Every peer at the same board tip: rounds with nothing new to publish. */
export const settle = (n: number, peers: number): ScriptStep[] => rounds(n, peers, 5_000);

/** Genesis (the first peer, twice: a kill at the genesis yield runs it again from scratch) and the joins of p1 and p2. */
export function joinLeadIn(peers: number): ScriptStep[] {
  return [{ iterate: 0 }, { iterate: 0 }, { iterate: 1 }, { iterate: 1 }, { iterate: 2 }, ...settle(6, peers)];
}

/** A 2-path change-set on p0 and an independent one on p1; p2 applies both in one apply (two groups): apply.group.mid, apply.between_groups. */
export function groupsLeadIn(peers: number, tag = 'cm'): ScriptStep[] {
  return [
    writeFileStep(0, `own/${tag}-p0-a.txt`, rows('p0 a', 4)),
    writeFileStep(0, `own/${tag}-p0-b.txt`, rows('p0 b', 4)),
    writeFileStep(1, `own/${tag}-p1-a.txt`, rows('p1 a', 4)),
    { iterate: 0 }, { iterate: 1 }, { wait: 25_000 },
    { iterate: 0 }, { wait: 6_000 }, { iterate: 0 },
    ...Array.from({ length: 8 }, (): ScriptStep[] => [{ wait: 11_000 }, { iterate: 1 }]).flat(),
    { wait: 11_000 }, { iterate: 2 }, { wait: 11_000 }, { iterate: 2 }, { wait: 11_000 }, { iterate: 2 },
    ...settle(6, peers),
  ];
}

/** The same line of notes.txt edited on p0 and p1: the later one's apply displaces its row (K4, a hold record): registry.cas. */
export function k4LeadIn(peers: number, tag = 'crash-matrix', row = 4): ScriptStep[] {
  return [
    editRowStep(0, 'notes.txt', row, `note row ${row} p0 ${tag}`),
    editRowStep(1, 'notes.txt', row, `note row ${row} p1 ${tag}`),
    { iterate: 0 }, { iterate: 1 }, { wait: 25_000 },
    { iterate: 0 }, { wait: 11_000 }, { iterate: 1 }, { wait: 11_000 }, { iterate: 1 },
    ...settle(6, peers),
  ];
}

/** A rewound board: INCIDENT everywhere, a human recover on p0 (dies at recover.displaced, restarts, is re-run). */
export function rewindLeadIn(peers: number): ScriptStep[] {
  return [rewindBoardStep(1), ...rounds(2, peers, 6_000), recoverStep(0), recoverStep(0), ...settle(6, peers)];
}

/**
 * Re-anchor (01-engine test 35): p1 alone publishes twice; the board is rewound below everyone's LA_B; p0 detects, pushes its displaced
 * copy and restores its LA_B; p0 publishes on it; p1 wakes, detects and re-anchors (recover.reanchor).
 */
export function reanchorLeadIn(peers: number, tag = 'cm'): ScriptStep[] {
  return [
    writeFileStep(1, `own/${tag}-p1-late-1.txt`, rows('p1 late 1', 3)), { iterate: 1 }, { wait: 25_000 }, { iterate: 1 },
    writeFileStep(1, `own/${tag}-p1-late-2.txt`, rows('p1 late 2', 3)), { iterate: 1 }, { wait: 25_000 }, { iterate: 1 },
    rewindBoardStep(3),
    { wait: 3_000 }, { iterate: 0 }, { wait: 6_000 }, { iterate: 0 }, { wait: 6_000 }, { iterate: 0 },
    recoverStep(0),
    { wait: 6_000 }, { iterate: 0 }, { iterate: 2 },
    writeFileStep(0, `own/${tag}-p0-after.txt`, rows('p0 after', 3)), { iterate: 0 }, { wait: 25_000 }, { iterate: 0 },
    { wait: 6_000 }, { iterate: 2 }, { iterate: 0 },
    { wait: 3_000 }, { iterate: 1 }, { wait: 6_000 }, { iterate: 1 }, { wait: 6_000 }, { iterate: 1 },
    recoverStep(1), recoverStep(1),
    ...settle(4, peers),
  ];
}

/**
 * The holds matrix's lead-out after its rewind and re-anchor lead-ins (never part of Plan 2's segments above): a human recover on every
 * peer the rewind left in INCIDENT, twice each (a kill inside the first restarts the peer, the second completes it), then settle rounds.
 * Plan 2's prologue recovers p0 and p1 only — there p2 never publishes; in a holds run any peer may hold a board commit the rewind
 * displaced (a board-only hold op, say), and nothing else would ever bring it back to the board (INV-CONVERGE).
 */
export function incidentLeadOut(peers: number): ScriptStep[] {
  const ifIncident = (i: number): ScriptStep => ({
    op: (ctx) => {
      const base = (recoverStep(i) as { op: (c: SimContext) => SimOp }).op(ctx);
      return {
        ...base,
        run: async (c) => {
          const live = realEngineOf(c.engines[i]!);
          if (live !== null && !(await live.inspect()).freeze.includes('INCIDENT')) return 'not in INCIDENT (no recover)';
          return base.run(c);
        },
      };
    },
  });
  return [...rounds(2, peers, 6_000), ...Array.from({ length: peers }, (_, i) => [ifIncident(i), ifIncident(i)]).flat(), ...settle(4, peers)];
}

// ---- op-log readers --------------------------------------------------------------------------------------------------------

/** The op the harness is running now (the last op-log entry the adapter did not add) and its step. */
export function currentOp(ctx: SimContext): { step: number; kind: string; peer: string } {
  for (let i = ctx.opLog.length - 1; i >= 0; i--) {
    const e = ctx.opLog[i]!;
    if (!ADAPTER_KINDS.has(e.kind)) return { step: e.step, kind: e.kind, peer: e.peer };
  }
  return { step: -1, kind: '', peer: '' };
}

/** `first` for its steps, then `rest`. */
export function then(first: OpGenerator, steps: number, rest: OpGenerator): OpGenerator {
  return { next: (ctx, step) => (step < steps ? first.next(ctx, step) : rest.next(ctx, step)) };
}

// ---- the driver ----------------------------------------------------------------------------------------------------------------

/** One kill: the point, the peer whose engine step died, the op-log step and phase, the op running and the setup's note. */
export interface Kill { name: string; peer: string | null; step: number; phase: SimPhase; op: string; note: string; }

/** What a seed's kill rule sees at a crashpoint hit. */
export interface MatrixView {
  readonly seed: string;
  /** The run (from the engine factory's first call on). */
  readonly ctx: SimContext;
  /** The peer whose engine call runs now (an engine step, a scripted iterate or a recover), or null. */
  readonly active: string | null;
  /** Every kill of this seed so far, in order. */
  readonly kills: readonly Kill[];
}

/** A seed's run, composed by the setup. `kill` answers every crashpoint hit (and the genesis yield): a string kills there (its note). */
export interface MatrixRun {
  tuple: SeedTuple; factory: EngineFactory; oracles: Oracle[]; options: SimOptions;
  kill(name: string, v: MatrixView): string | null;
}

export interface MatrixOutcome<S> { seed: S; r: SimResult; kills: Kill[]; }

/**
 * Runs the matrix: per seed, setup(seed) composes the run; the driver tracks which peer's engine call is running (it wraps step and
 * recover on each SimEngine the factory makes, keeping the object: realEngineOf and the holds ops still find it), installs one crash
 * handler and the Scheduler's onYield hook for the run, and throws KilledAt wherever the seed's rule says so. A setup must leave
 * SimOptions.crash unset (the harness's random injection would replace the handler). Returns each seed's SimResult and kills.
 */
export async function runCrashMatrix<S extends { seed: string }>(setup: (seed: S) => MatrixRun, seeds: readonly S[]): Promise<Array<MatrixOutcome<S>>> {
  const out: Array<MatrixOutcome<S>> = [];
  for (const seed of seeds) {
    const run = setup(seed);
    if (run.options.crash !== undefined) throw new Error('runCrashMatrix: a matrix run takes no SimOptions.crash (the driver owns the crash handler)');
    const kills: Kill[] = [];
    let ctxOf: SimContext | null = null;
    let active: string | null = null;
    const hit = (name: string): void => {
      const ctx = ctxOf;
      if (ctx === null) return;
      const view: MatrixView = { seed: seed.seed, ctx, active, kills };
      const note = run.kill(name, view);
      if (note === null) return;
      const op = currentOp(ctx);
      kills.push({ name, peer: active, step: op.step, phase: ctx.phase, op: op.kind, note });
      throw new KilledAt(name);
    };
    const factory: EngineFactory = (ctx, peer) => {
      if (ctxOf === null) {
        ctxOf = ctx;
        ctx.scheduler.onYield = (name) => hit(name);
      }
      const e = run.factory(ctx, peer);
      const wrap = <A extends unknown[], R>(fn: (...a: A) => Promise<R>): ((...a: A) => Promise<R>) => async (...a: A) => {
        const before = active;
        active = peer.name;
        try {
          return await fn(...a);
        } finally {
          active = before;
        }
      };
      e.step = wrap(e.step.bind(e));
      const rec = (e as { recover?: (c: SimContext) => Promise<unknown> }).recover;
      if (typeof rec === 'function') (e as { recover?: (c: SimContext) => Promise<unknown> }).recover = wrap(rec.bind(e));
      return e;
    };
    const handler = (name: string): void => hit(name);
    const previous = setCrashHandler(handler);
    let r: SimResult;
    try {
      r = await runSim(run.tuple, factory, run.oracles, run.options);
    } finally {
      restoreHandler(handler, previous);
    }
    out.push({ seed, r, kills });
  }
  return out;
}

/**
 * Puts `previous` back only while `mine` is still the process's crash handler: a run that ended late (its test timed out and the next
 * one installed its own handler) leaves the newer handler in place instead of disarming the run that is going on now.
 */
function restoreHandler(mine: (name: string) => void, previous: ((name: string) => void) | null): void {
  const current = setCrashHandler(previous);
  if (current !== mine) setCrashHandler(current);
}

/** The op-log's `killed` rows (the adapter's: `<point> <instance> lock=… log=…`). */
export const killedRows = (opLog: readonly OpLogEntry[]): OpLogEntry[] => opLog.filter((e) => e.kind === 'killed');

// ---- the `holds` crash matrix (Plan 3 Task 16; R3-52, TST-06 SIM form, TC-ENG-12 SIM form, 05 F7) --------------------------------

/** One kill slot: a catalogue name; registry.cas twice — at an odd hit (before its CAS) and at an even hit (after it). */
export interface Slot { name: string; cas?: 'before' | 'after'; }

/**
 * The slots of the holds matrix, in arming order: the catalogue's names (catalogueCrashpoints), the frequent iteration points first
 * (they die inside the generated ops), then the names only a lead-in reaches; registry.cas as two slots. join.first_apply comes first:
 * only a peer's first start reaches it.
 */
export function holdsSlots(names: readonly string[] = catalogueCrashpoints()): Slot[] {
  const rank = ['join.first_apply', 'snapshot.index_written', 'publish.out_built', 'publish.sent', 'publish.landed', 'apply.intent', 'apply.group.phase1',
    'apply.group.phase2', 'apply.state', 'registry.cas', 'apply.group.mid', 'apply.between_groups', 'recover.displaced', 'recover.reanchor'];
  const order = (n: string): number => (rank.includes(n) ? rank.indexOf(n) : rank.length);
  const sorted = [...names].sort((a, b) => order(a) - order(b) || names.indexOf(a) - names.indexOf(b));
  return sorted.flatMap((name): Slot[] => (name === 'registry.cas' ? [{ name, cas: 'before' }, { name, cas: 'after' }] : [{ name }]));
}

const slotLabel = (s: Slot): string => (s.cas === undefined ? s.name : `${s.name}#${s.cas}`);

/** A row deletion after an even kill: the author, the path, the marker of the row, and where its deletion landed. */
export interface RowDeletion {
  afterKill: number; killed: string; author: string; path: string; marker: string;
  /** The remote live code commit that held the row when it was deleted (proof the row had landed). */
  liveBefore: string;
  /** The first remote live code commit without the row, once the deletion landed (null until then). */
  landedIn: string | null;
}

/**
 * One row search after an even counted kill (fix round 1: every search is recorded): the row it found, or null with the reason each
 * candidate row was passed over; and what came of it — `deleted` (the author's informed delete ran; RowDeletion tracks its landing),
 * `no row`, or the edit_own detail when the author's write deleted nothing. A search that deletes nothing un-counts its kill, so the next
 * kill searches again.
 */
export interface RowAttempt {
  afterKill: number; killed: string;
  row: { author: string; path: string; marker: string } | null;
  rejected: string[];
  outcome: 'pending' | 'deleted' | 'no row' | string;
}

/** What the holds matrix saw, for the test's assertions. */
export interface HoldsMatrixFacts {
  slots: Slot[];
  /** Per slot (by label): killed (with the kill's index), or why it was given up. */
  outcome: Map<string, { killed: number } | { unreached: string }>;
  /** Every row search, in order. */
  attempts: RowAttempt[];
  deletions: RowDeletion[];
  /** gc --prune=now runs in every clone and the remote (op-log steps). */
  gcs: number[];
  /** Lead-in segments played (slot label → count). */
  leadIns: Map<string, number>;
}

/** The generated phase's steps before the lead-ins (PROFILES.holds.steps) and the op budget for the lead-ins after it. */
export const HOLDS_MATRIX_LEADIN_STEPS = 320;
/** A slot armed on a drawn peer goes to any peer when that peer has not reached it within this many op steps. */
const REDRAW_STEPS = 8;
/** A slot whose lead-in ran this many times without reaching the point is given up (the test names it). */
const MAX_LEADINS = 3;
/** Op steps a kill inside a lead-in may inject ahead of its remaining steps (the row search, the deletion, the gc). */
const LEADIN_SLACK_STEPS = 4;

interface Armed { slot: Slot; index: number; peer: string | null; from: number; armedAt: number; casHits: number; }

/** The remote board tip, its live code commit and that commit's blob at `path` (a test-side read of the bare remote). */
async function remoteLive(ctx: SimContext, path: string): Promise<{ board: string; live: string; blob: Buffer | null } | null> {
  const dir = await currentRemoteDir(ctx);
  const git = async (args: string[], ok: number[] = [0]): Promise<{ code: number; out: Buffer }> => {
    const r = await ctx.git.run(args, { class: 'local', cwd: dir });
    if (!ok.includes(r.code)) throw new Error(`git ${args.join(' ')} in the remote: ${r.stderr.toString('utf8')}`);
    return { code: r.code, out: r.stdout };
  };
  const tip = await git(['rev-parse', '--verify', '--quiet', 'refs/cowork/main/board^{commit}'], [0, 1]);
  if (tip.code !== 0) return null;
  const board = tip.out.toString('utf8').trim();
  const parents = (await git(['rev-list', '--parents', '-n', '1', board])).out.toString('utf8').trim().split(' ').slice(1);
  const live = parents[parents.length - 1];
  if (live === undefined) return null;
  const blob = await git(['cat-file', 'blob', `${live}:${path}`], [0, 128]);
  return { board, live, blob: blob.code === 0 ? blob.out : null };
}

/**
 * The `holds` crash matrix of one seed (R3-52, TST-06's SIM form): holdsSetup's run (3 peers, its 60 generated steps, the R-32
 * quiescence; no random crash injection — the driver owns the kills) followed by up to HOLDS_MATRIX_LEADIN_STEPS lead-in steps. The
 * slots (holdsSlots) are armed one after another on a peer and step drawn from seededRandom(`${seed}/matrix`) — the next only after the
 * previous kill's restart (the killed peer's next `start`); a slot the drawn peer does not reach within REDRAW_STEPS goes to any peer;
 * once the generated ops end, a slot not killed yet gets its lead-in (groupsLeadIn for apply.group.mid/apply.between_groups, k4LeadIn
 * for registry.cas, rewindLeadIn/reanchorLeadIn for recover.*, else a new file and rounds), played with the slot armed on any peer.
 * After every second kill the author of one row the killed peer's last writing `apply` wrote — found from the row's marker; never the
 * team writer's or the killed peer's own rows; the kill counts toward the half only when such a row exists — deletes that row by an
 * informed edit_own write of its own line, and `git gc --prune=now` runs in every clone and the remote (one op-log row `gc_prune` per
 * clone). `oracles` are exitOracles(ns, {holds: {markers}}), oracleState(), oracleReach() and the deletion oracle (each deleted row's
 * deletion lands in live_code and the row never comes back in a later one).
 */
export function holdsCrashRun(seed: string, o: { steps?: number; leadInSteps?: number } = {}): MatrixRun & { facts: HoldsMatrixFacts; markers: MarkerModel } {
  const h = holdsSetup(seed, { crashRate: 0, ...(o.steps !== undefined ? { steps: o.steps } : {}) });
  const S = h.tuple.ops;
  /** The op budget: the generated steps, then the lead-in steps. */
  const budget = S + (o.leadInSteps ?? HOLDS_MATRIX_LEADIN_STEPS);
  const peers = h.tuple.peers;
  const slots = holdsSlots();
  const facts: HoldsMatrixFacts = { slots, outcome: new Map(), attempts: [], deletions: [], gcs: [], leadIns: new Map() };
  const rnd = seededRandom(`${seed}/matrix`);
  const base = h.options.generator!;
  let next = 0;   // the next slot to arm
  let armed: Armed | null = null;
  let waiting: { peer: string; killedRows: number } | null = null;
  let counted = 0;
  const injected: Array<(ctx: SimContext) => SimOp> = [];
  let leadIn: { label: string; steps: ScriptStep[]; at: number } | null = null;

  const arm = (ctx: SimContext, step: number): void => {
    const slot = slots[next];
    if (slot === undefined) return;
    const anyPeer = slot.name === 'join.first_apply' || step >= S;
    armed = { slot, index: next, peer: anyPeer ? null : ctx.peers[randomInt(rnd, ctx.peers.length)]!.name, from: step + (anyPeer ? 0 : randomInt(rnd, 3)), armedAt: step, casHits: 0 };
    next++;
  };
  const giveUp = (why: string): void => {
    if (armed === null) return;
    facts.outcome.set(slotLabel(armed.slot), { unreached: why });
    armed = null;
  };
  const leadInFor = (slot: Slot, k: number): ScriptStep[] => {
    const tag = `cmh${k}`;
    switch (slot.name) {
      case 'apply.group.mid':
      case 'apply.between_groups': return groupsLeadIn(peers, tag);
      case 'registry.cas': return k4LeadIn(peers, `${tag} crash-matrix`, [1, 4, 7][k % 3]);
      case 'recover.displaced': return [...rewindLeadIn(peers), ...incidentLeadOut(peers)];
      case 'recover.reanchor': return [...reanchorLeadIn(peers, tag), ...incidentLeadOut(peers)];
      default: return [writeFileStep(k % peers, `own/${tag}-p${k % peers}.txt`, rows(`${tag} lead-in`, 4)), ...rounds(6, peers)];
    }
  };
  /** The deletion after an even kill: finds the row (async), then the author's edit_own delete and the gc of every clone. */
  const deletionFinder = (killedPeer: string, killIndex: number): ((ctx: SimContext) => SimOp) => () => ({
    peer: killedPeer, kind: 'delete_row_find',
    run: async (ctx) => {
      const { found, rejected } = await findRow(ctx, h.markers, killedPeer);
      const attempt: RowAttempt = { afterKill: killIndex, killed: killedPeer, row: found, rejected, outcome: 'pending' };
      facts.attempts.push(attempt);
      if (found === null) {
        counted--;   // the kill does not count toward the half: no row the rule allows (the next kill searches again)
        attempt.outcome = 'no row';
        return `no row (kill ${killIndex})${rejected.length > 0 ? `: ${rejected.join('; ')}` : ''}`;
      }
      const before = await remoteLive(ctx, found.path);
      const authorIdx = ctx.peers.findIndex((p) => p.name === found.author);
      injected.unshift((c) => {
        const inner = holdsOp({ kind: 'edit_own', peer: authorIdx, params: { path: found.path, marker: found.marker, delete: true } }, h.markers);
        return {
          peer: inner.peer, kind: inner.kind,
          run: async () => {
            const detail = await inner.run(c);
            if (/ deleted /.test(detail) && before !== null) {
              facts.deletions.push({ afterKill: killIndex, killed: killedPeer, author: found.author, path: found.path, marker: found.marker, liveBefore: before.live, landedIn: null });
              attempt.outcome = 'deleted';
              injected.unshift(gcAll);
            } else {
              counted--;
              attempt.outcome = detail;
            }
            return detail;
          },
        };
      });
      return `${found.author} ${found.path} ${found.marker} (kill ${killIndex})`;
    },
  });
  const gcAll = (): SimOp => ({
    peer: '*', kind: 'gc_all',
    run: async (ctx) => {
      const step = ctx.opLog[ctx.opLog.length - 1]?.step ?? -1;
      const out: string[] = [];
      for (const p of ctx.peers) {
        const r = await ctx.git.run(['gc', '--prune=now', '--quiet'], { class: 'local', cwd: p.dir });
        ctx.opLog.push({ step, peer: p.name, kind: 'gc_prune', detail: `rc=${r.code}` });
        out.push(`${p.name} rc=${r.code}`);
      }
      const remote = await ctx.git.run(['gc', '--prune=now', '--quiet'], { class: 'local', cwd: await currentRemoteDir(ctx) });
      out.push(`remote rc=${remote.code}`);
      facts.gcs.push(step);
      return out.join(' ');
    },
  });

  const generator: OpGenerator = {
    next(ctx: SimContext, step: number): SimOp | null {
      // The killed peer restarted (its next `start` row): arm the next slot.
      if (waiting !== null) {
        const w = waiting;
        const startedAgain = ctx.opLog.slice(w.killedRows).some((e) => e.kind === 'start' && e.peer === w.peer);
        if (startedAgain) waiting = null;
      }
      if (armed === null && waiting === null && next < slots.length) arm(ctx, step);
      const a = armed as Armed | null;
      if (a !== null && a.peer !== null && step - a.armedAt >= REDRAW_STEPS) a.peer = null;
      const inj = injected.shift();
      if (inj !== undefined) return inj(ctx);
      if (step < S) return base.next(ctx, step);
      // The lead-in phase: a lead-in, once started, plays to its end (a kill inside it — a recover's, say — leaves the rest to
      // finish what it began: the second recover, the settle rounds); then the armed slot's next lead-in, with the slot armed on any
      // peer, until it is reached or MAX_LEADINS ran.
      if (a !== null) a.peer = null;
      const playing = leadIn as { label: string; steps: ScriptStep[]; at: number } | null;
      if (playing !== null && playing.at < playing.steps.length) return scripted([playing.steps[playing.at++]!]).next(ctx, 0);
      if (a !== null) {
        const label = slotLabel(a.slot);
        const played = facts.leadIns.get(label) ?? 0;
        if (played >= MAX_LEADINS) {
          giveUp(`not reached after ${played} lead-ins`);
          return null;
        }
        const fresh = { label, steps: leadInFor(a.slot, a.index * MAX_LEADINS + played), at: 1 };
        // A lead-in starts only when it can play to its end inside the op budget (with room for the deletion and gc a kill inside it
        // injects): one cut short could leave the board rewound with its recover never run.
        if (step + fresh.steps.length + LEADIN_SLACK_STEPS > budget) {
          giveUp(`no op budget left for its lead-in (${fresh.steps.length} steps at step ${step} of ${budget})`);
          return null;
        }
        facts.leadIns.set(label, played + 1);
        leadIn = fresh;
        // The lead-ins need every peer live: a peer the generated phase's formatter op froze MASS (its batch tripped the breaker after
        // a kill or restart, past the generator's own resume) gets the scripted resume first — holdsSetup's resumeMassFrozen, the one
        // the quiescence rounds run (EF2 D2), with its attribution rule (an unattributed freeze is left for that hook to report).
        const first = scripted([fresh.steps[0]!]).next(ctx, 0)!;
        return {
          peer: first.peer, kind: first.kind,
          run: async (c) => {
            const why = await resumeMassFrozen(c, step);
            const detail = await first.run(c);
            return why === null ? detail : `${detail} (MASS not resumed: ${why})`;
          },
        };
      }
      // Waiting for a killed peer's restart in the lead-in phase: its next engine step restarts it.
      const w = waiting as { peer: string; killedRows: number } | null;
      if (w !== null) return scripted([{ iterate: Math.max(0, ctx.peers.findIndex((p) => p.name === w.peer)) }]).next(ctx, 0);
      // Every slot done: the rest of the lead-in budget passes without engine steps (the R-32 quiescence follows the op budget).
      return { peer: '*', kind: 'idle', run: async () => '' };
    },
  };

  return {
    tuple: { ...h.tuple, ops: budget },
    factory: h.factory,
    markers: h.markers,
    facts,
    oracles: [...exitOracles(RELEASE_NAMESPACE, { holds: { markers: h.markers } }), oracleState(), oracleReach(), deletionOracle(facts)],
    options: { ...h.options, crash: undefined, generator },
    kill(name: string, v: MatrixView): string | null {
      const a = armed;
      if (a === null || a.slot.name !== name || v.active === null) return null;
      if (a.peer !== null && a.peer !== v.active) return null;
      const step = currentOp(v.ctx).step;
      if (step < a.from) return null;
      if (a.slot.cas !== undefined) {
        a.casHits++;
        // Each registry commit passes registry.cas twice in one engine call: an odd hit before its CAS, an even hit after it.
        if ((a.slot.cas === 'before') !== (a.casHits % 2 === 1)) return null;
      }
      const index = v.kills.length;
      facts.outcome.set(slotLabel(a.slot), { killed: index });
      armed = null;
      waiting = { peer: v.active, killedRows: v.ctx.opLog.length };
      counted++;
      if (counted % 2 === 0) injected.push(deletionFinder(v.active, index));
      return `${slotLabel(a.slot)} hit=${a.casHits}`;
    },
  };
}

/**
 * A row the killed peer's last writing `apply` wrote whose author may delete it: rows of the written paths at that apply's TIP (in the
 * killed peer's repo) carrying a live marker of another clone's author (never the team writer's, never the killed peer's own), whose
 * author's working file still holds that row as its own line (every marker on it the author's) and is the remote's current live code
 * of the path (line endings aside), so the deletion is a clean change-set, and who can publish it now (authorGated). The first in path,
 * then row order; with no row, why each candidate (a live marker of another clone's author) was passed over (at most 12, then a count).
 */
async function findRow(ctx: SimContext, markers: MarkerModel, killed: string): Promise<{ found: { author: string; path: string; marker: string } | null; rejected: string[] }> {
  const rejected: string[] = [];
  const none = (why: string): { found: null; rejected: string[] } => ({ found: null, rejected: rejected.length > 0 ? rejected : [why] });
  const id = [...ctx.trace.names].find(([, n]) => n === killed)?.[0];
  if (id === undefined) return none(`${killed} has no trace id`);
  const ev = ctx.trace.ofKind('apply').filter((e) => e.peer === id && e.written.length > 0).pop();
  if (ev === undefined) return none(`${killed} has no writing apply`);
  const peer = ctx.peers.find((p) => p.name === killed)!;
  const names = new Set(ctx.peers.map((p) => p.name));
  let passed = 0;
  const pass = (m: string, author: string, path: string, why: string): void => {
    if (++passed <= 12) rejected.push(`${m} (${author}, ${path}): ${why}`);
    else rejected[12] = `… ${passed - 12} more`;
  };
  for (const path of [...ev.written].sort()) {
    const r = await ctx.git.run(['cat-file', 'blob', `${ev.tip}:${path}`], { class: 'local', cwd: peer.dir });
    if (r.code !== 0) continue;
    for (const m of findMarkers(r.stdout)) {
      const owner = markers.live().get(m);
      if (owner === undefined || owner.peer === killed || !names.has(owner.peer)) continue;
      const author = ctx.peers.find((p) => p.name === owner.peer)!;
      const gated = await authorGated(ctx, author);
      if (gated !== null) {
        pass(m, owner.peer, path, `author gated: ${gated}`);
        continue;
      }
      let disk: Buffer;
      try {
        disk = await readFile(join(author.dir, ...path.split('/')));
      } catch {
        pass(m, owner.peer, path, 'no file on the author\'s disk');
        continue;
      }
      const line = disk.toString('latin1').split('\n').find((l) => l.includes(m));
      if (line === undefined) {
        pass(m, owner.peer, path, 'the row is not on the author\'s disk');
        continue;
      }
      if (!findMarkers(Buffer.from(line, 'latin1')).every((x) => x.endsWith(`_${owner.peer}`))) {
        pass(m, owner.peer, path, 'the row carries another author\'s marker');
        continue;
      }
      // The author's copy is the current live code's (line endings aside): the deletion is its only change of the path, so it publishes
      // as a clean change-set. A copy behind TIP (an apply it has not made yet, a deferred group after a restart) would meet that apply
      // as a conflict and stay in a CONFLICTED record, never landing (holds-crash-0, kill 7: p1's notes.md).
      const now = await remoteLive(ctx, path);
      const lf = (b: Buffer): string => b.toString('latin1').replace(/\r\n/g, '\n');
      if (now?.blob == null || lf(disk) !== lf(now.blob)) {
        pass(m, owner.peer, path, 'the author\'s copy is not the live code\'s');
        continue;
      }
      return { found: { author: owner.peer, path, marker: m }, rejected };
    }
  }
  return none(`no live marker of another clone's author in ${killed}'s last writing apply (${ev.written.length} path(s))`);
}

/**
 * The kills after which the matrix's rule makes a row search (holdsCrashRun's `counted`): the first of every two counted kills is
 * skipped, and a search that deletes nothing (no row, or a write that deleted nothing) un-counts its kill, so the next kill searches.
 * From each search's outcome, the kill indices that must have one, in order.
 */
export function expectedSearches(kills: number, attempts: readonly RowAttempt[]): number[] {
  const out: number[] = [];
  let counted = 0;
  for (let k = 0; k < kills; k++) {
    counted++;
    if (counted % 2 !== 0) continue;
    out.push(k);
    const a = attempts.find((x) => x.afterKill === k);
    if (a?.outcome !== 'deleted') counted--;
  }
  return out;
}

/**
 * Why an author cannot publish its deletion now, or null: no running engine, any freeze (MASS, INCIDENT, …), or R3-53's latch — a
 * non-terminal ON_DISK `portability` record (a not-stageable non-portable name on its disk holds back every publication group of the
 * peer until the fix lands; holds-crash-1's p2, whose deletions never landed). A gated author's row is not chosen.
 */
async function authorGated(ctx: SimContext, author: PeerClone): Promise<string | null> {
  const engine = ctx.engines[ctx.peers.indexOf(author)];
  const live = engine === undefined ? null : realEngineOf(engine);
  if (live === null) return 'no running engine';
  const ins = await live.inspect();
  if (ins.freeze.length > 0) return `frozen ${ins.freeze.join(',')}`;
  if (ins.holds.some((r) => !isTerminal(r) && r.residence === 'ON_DISK' && r.guards.some((g) => guardName(g) === 'portability'))) return 'R3-53 latch';
  return null;
}

/**
 * The matrix's deletion oracle (TC-ENG-12 SIM form: "no resurrection"): after every op, each deleted row's deletion is looked for in
 * the remote's live code (the first live code commit without the row is where it landed), and once landed the row never appears in a
 * later live code commit. At quiescence every deletion has landed. A board tip the remote moved back to — one already judged as an
 * earlier tip, or an ancestor of the previous tip (the matrix's recover lead-ins rewind the board, F-BR-3's fault: a server-side ref
 * move, never an engine push) — is not judged while it stays the tip; a commit a peer builds on it is new and judged.
 */
export function deletionOracle(facts: Pick<HoldsMatrixFacts, 'deletions'>): Oracle {
  const seen = new Set<string>();
  const back = new Set<string>();
  let at: string | null = null;
  return {
    name: 'MATRIX-DELETION',
    async afterEveryOp(ctx) {
      if (facts.deletions.length === 0) return null;
      const tip = await remoteLive(ctx, facts.deletions[0]!.path);
      if (tip === null) return null;
      if (at !== null && tip.board !== at) {
        // The new tip is an ancestor of the previous one when nothing it reaches is new.
        const fresh = await ctx.git.run(['rev-list', '-n', '1', tip.board, `^${at}`], { class: 'local', cwd: await currentRemoteDir(ctx) });
        const ancestor = fresh.code === 0 && fresh.stdout.toString('utf8').trim() === '';
        if (seen.has(tip.board) || ancestor) back.add(tip.board);
      }
      at = tip.board;
      seen.add(tip.board);
      if (back.has(tip.board)) return null;
      for (const d of facts.deletions) {
        const now = await remoteLive(ctx, d.path);
        if (now === null) continue;
        const has = now.blob !== null && now.blob.toString('latin1').includes(d.marker);
        if (d.landedIn === null) {
          if (!has) d.landedIn = now.live;
        } else if (has) {
          return `MATRIX-DELETION: ${d.author} deleted the row ${d.marker} of ${d.path} (landed in ${d.landedIn}), but live code ${now.live} has it again`;
        }
      }
      return null;
    },
    async atQuiescence() {
      const open = facts.deletions.filter((d) => d.landedIn === null);
      return open.length === 0 ? null : `MATRIX-DELETION: ${open.map((d) => `${d.author}'s deletion of ${d.marker} (${d.path})`).join(', ')} never landed in live_code`;
    },
  };
}

// ---- the hold operators' crash tests (05 F7, Review Focus 3, the O-STATE and O-REACH plants) ------------------------------------------

/**
 * A holds script (test/helpers/holdsScript.ts steps): p0 creates `path`, p1 applies it, p1 rewrites one of p0's lines — p1's next
 * materializing iteration creates a revert record.
 */
export function revertSetup(path: string): Step[] {
  return [
    { rounds: 2 },
    { kind: 'new_file', peer: 0, params: { path, rows: 4 } },
    { rounds: 14 },
    { kind: 'edit_peer_line', peer: 1, params: { path } },
  ];
}

/**
 * A test crash handler armed by a probe step: a KilledAt at the `nth` hit of `point` while armed (only the probe's own peer steps run
 * then). `install` replaces the process's crash handler until its return value restores the previous one.
 */
export function armedKill(): { arm(point: string, nth: number): void; disarm(): { killed: boolean; hits: number }; install(): () => void } {
  let armed: { point: string; nth: number; hits: number; killed: boolean } | null = null;
  return {
    arm(point, nth) { armed = { point, nth, hits: 0, killed: false }; },
    disarm() {
      const a = armed;
      armed = null;
      return { killed: a?.killed ?? false, hits: a?.hits ?? 0 };
    },
    install() {
      const mine = (name: string): void => {
        const a = armed;
        if (a === null || a.killed || name !== a.point) return;
        a.hits++;
        if (a.hits === a.nth) {
          a.killed = true;
          throw new KilledAt(name);
        }
      };
      const prev = setCrashHandler(mine);
      return () => { restoreHandler(mine, prev); };
    },
  };
}
