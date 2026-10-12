// The SIM board SB-F04 of 10-product §7 (peers A = you, B and C; T-F04-golden and its variants) and long random SIM boards
// for T-F04-incremental and T-F04-cap (F04-a Task A2). One board is a list of actions with two consumers that agree:
// - SbSim, the in-memory twin of tools/viz/boardWriter.ts: the same seeded peer ids and epochs, op ids, writer seqs,
//   change-set ids and trailers, folded with Plan 2's foldCommit into SinceSteps whose BoardRead fields equal what
//   readBoardCommits returns for the written board (oids and the checkpoint excepted: the report reads neither);
// - sbWrite, which writes the same actions into a real board through BoardWriter (runs of commits in one git fast-import).
// A report computed from either is therefore the same bytes (asserted by test/integration/since.walk.test.ts).
import type { BoardRead } from '../../src/board/batchRead.js';
import { BOARD_SUBJECT, boardTrailers, opsLinesOf, parseCsTrailers, type CsTrailer, type WriterId } from '../../src/board/boardCommit.js';
import { foldCommit, initialFoldState, type FoldState } from '../../src/board/fold.js';
import type { EpochId, PeerId } from '../../src/board/ids.js';
import { eventCid, serializeOps, type JoinOp, type Op, type OpDraft } from '../../src/board/ops.js';
import { genesisProtocol, PROTO, type ProtocolJson } from '../../src/board/protocol.js';
import type { Oid } from '../../src/git/oid.js';
import { randomHex, randomInt, seededRandom, type Random } from '../../src/ports/random.js';
import { sinceFinish, sinceInit, sincePush, type MyRecord, type SinceOptions, type SinceReport, type SinceRow, type SinceStep } from '../../src/since/report.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { BoardWriter, type ScriptCommit } from '../../tools/viz/boardWriter.js';
import type { RepoFixture } from './repoFixture.js';

/** One step of a board script: BoardWriter's genesis, join (a fresh epoch with newEpoch) or commit. */
export type SbAction =
  | { kind: 'genesis'; writer: string }
  | { kind: 'join'; name: string; newEpoch?: boolean }
  | { kind: 'commit'; c: ScriptCommit };

export interface SbPeer { name: string; peer: PeerId; epoch: EpochId; }

const PLUGIN_SHA = 'f'.repeat(64);
const REGION_SPEC = 'rs-1';
/** The fold's `self` for the twin: foldCommit's state does not depend on it (12 §9.7 item 6). */
const SELF = '0'.repeat(32);

/** BoardWriter's display of a peer name: its first letter upper-cased. */
export const displayOf = (name: string): string => (name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1));

/** A 40-hex placeholder object id: one tag hex digit and the counter (the report never reads an oid). */
const fakeOid = (tag: string, n: number): Oid => `${tag}${n.toString(16).padStart(39, '0')}` as Oid;

/** n distinct file paths under dir. */
export const many = (n: number, dir: string): string[] => Array.from({ length: n }, (_, i) => `${dir}/f${String(i).padStart(3, '0')}.txt`);

/** BoardWriter's join draft for a peer that was never re-announced (the plugin version, regionSpec and opt-in of a new peer). */
export function joinDraft(display: string): Omit<JoinOp, 'id'> {
  return {
    type: 'join', display, plugin_version: PLUGIN_VERSION, plugin_sha: PLUGIN_SHA, proto: PROTO, regionSpec: REGION_SPEC,
    config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '' }, coauthor_optin: false,
  };
}

/**
 * The peer ids and epochs BoardWriter.create({ seed }) gives `names` when they are first used in this order (two 16-byte draws
 * of seededRandom(seed) each). A later fresh epoch (join newEpoch) draws again; the board scripts below only need the peer ids.
 */
export function sbPeerIds(seed: string, names: readonly string[]): Map<string, SbPeer> {
  const r = seededRandom(seed);
  const out = new Map<string, SbPeer>();
  for (const name of names) out.set(name, { name, peer: randomHex(r, 16), epoch: randomHex(r, 16) });
  return out;
}

interface SimPeer { name: string; peer: PeerId; epoch: EpochId; seq: number; display: string; }

/**
 * The in-memory twin of BoardWriter over the actions above (rawOps, writer-null commits, seats and base moves included;
 * badWriterTrailer is not modelled). Every commit becomes one SinceStep folded from the previous state; `start` is the
 * empty state B0 folds onto.
 */
export class SbSim {
  readonly protocol: ProtocolJson = genesisProtocol(12, REGION_SPEC);
  readonly start: FoldState;
  readonly steps: SinceStep[] = [];
  private readonly random: Random;
  private readonly peers = new Map<string, SimPeer>();
  private readonly counters = new Map<string, number>();
  private genesisName: string | null = null;
  private state: FoldState;
  private liveCount = 0;
  private liveCode: Oid = fakeOid('c', 0);
  private prevBoard: Oid | null = null;

  constructor(seed: string) {
    this.random = seededRandom(seed);
    this.start = initialFoldState(this.protocol);
    this.state = this.start;
  }

  /** The peer called `name` (created on first use, as BoardWriter does). */
  peer(name: string): SbPeer {
    const p = this.peerRec(name);
    return { name, peer: p.peer, epoch: p.epoch };
  }

  /** The fold state after the last commit. */
  fold(): FoldState {
    return this.state;
  }

  apply(a: SbAction): void {
    if (a.kind === 'genesis') this.genesis(a.writer);
    else if (a.kind === 'join') this.join(a.name, a.newEpoch === true);
    else this.commit(a.c);
  }

  private peerRec(name: string): SimPeer {
    let p = this.peers.get(name);
    if (p === undefined) {
      p = { name, peer: randomHex(this.random, 16), epoch: randomHex(this.random, 16), seq: 0, display: displayOf(name) };
      this.peers.set(name, p);
    }
    return p;
  }

  private next(key: string): number {
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return n;
  }

  private genesis(name: string): void {
    if (this.steps.length > 0) throw new Error('SbSim.genesis: the board exists');
    const p = this.peerRec(name);
    const w: WriterId = { peer: p.peer, epoch: p.epoch, seq: p.seq + 3 };
    const ops: Op[] = [
      { id: `${p.peer}/${p.epoch}/${p.seq + 1}`, ...joinDraft(p.display) },
      { id: `${p.peer}/${p.epoch}/${p.seq + 2}`, type: 'caps', custom_refs: true, lease: true, delete: true, push_options: false, two_parent_ok: true },
    ];
    p.seq += 3;
    this.genesisName = name;
    this.push(w, serializeOps(ops), [], new Map(), true);
  }

  private join(name: string, newEpoch: boolean): void {
    const p = this.peerRec(name);
    if (newEpoch) {
      p.epoch = randomHex(this.random, 16);
      p.seq = 0;
    }
    this.commit({ writer: name, ops: [joinDraft(p.display)] });
  }

  /** BoardWriter's plan(): op ids and the writer seq from the author's counter, change-set ids per writer and per seat. */
  private commit(c: ScriptCommit): void {
    if (this.genesisName === null) throw new Error('SbSim: no board yet (genesis first)');
    if (c.badWriterTrailer === true) throw new Error('SbSim: badWriterTrailer is not modelled');
    const scriptCs = c.cs ?? [];
    const code = c.code ?? (scriptCs.length > 0 ? 'ordinary' : 'unchanged');
    const author = this.peerRec(c.writer ?? this.genesisName);
    const drafts: readonly OpDraft[] = c.ops ?? [];
    if (c.writer === null && (drafts.length > 0 || code !== 'unchanged' || scriptCs.length > 0)) throw new Error('SbSim: a commit without a writer carries raw lines only');
    const ops: Op[] = drafts.map((d) => {
      const id = `${author.peer}/${author.epoch}/${++author.seq}`;
      const op = { id, ...d } as Op;
      if (op.type === 'event' && op.cid === '') op.cid = eventCid(id, op.kind);
      return op;
    });
    const writer: WriterId | null = c.writer === null ? null : { peer: author.peer, epoch: author.epoch, seq: ++author.seq };
    const cs: CsTrailer[] = [];
    const csPaths = new Map<string, string[]>();
    for (const s of scriptCs) {
      const csId = s.csId ?? (s.seat !== undefined ? `${s.seat}/${this.next(`seat:${s.seat}`)}` : `${author.peer}/human/${this.next(`human:${author.peer}`)}`);
      cs.push({ csId, state: s.state ?? 'closed', seq: 0, origin: s.origin ?? (s.seat !== undefined ? 'prompt' : 'human'), checks: s.checks ?? 'skipped', paths: new Set(s.paths).size });
      csPaths.set(csId, [...s.paths]);
    }
    const raw = (c.rawOps ?? []).map((l) => `${l}\n`).join('');
    this.push(writer, Buffer.concat([serializeOps(ops), Buffer.from(raw, 'utf8')]), cs, csPaths, code !== 'unchanged');
  }

  /** One board commit as readBoardCommits reads it (trailers through the reader's own parser), folded. */
  private push(writer: WriterId | null, opsBytes: Buffer, cs: readonly CsTrailer[], csPaths: ReadonlyMap<string, readonly string[]>, codeChanged: boolean): void {
    const height = this.steps.length;
    if (height === 0 || codeChanged) this.liveCode = fakeOid('c', ++this.liveCount);
    const oid = fakeOid('b', height);
    const parents = this.prevBoard === null ? [this.liveCode] : [this.prevBoard, this.liveCode];
    const trailers = writer === null ? [] : boardTrailers(writer, cs, csPaths);
    const decoded = parseCsTrailers(trailers);
    const data: BoardRead = {
      oid, parents, firstParent: this.prevBoard, liveCode: this.liveCode, writer, cs: decoded.cs, protocol: this.protocol,
      opsLines: opsLinesOf(opsBytes), checkpoint: null, heldIds: [],
      height, info: { oid, tree: fakeOid('e', 0), parents, subject: BOARD_SUBJECT, trailers }, csPaths: decoded.paths, live: null,
    };
    const r = foldCommit(this.state, data, SELF);
    this.steps.push({ data, verdicts: r.opVerdicts, after: r.state });
    this.state = r.state;
    this.prevBoard = oid;
  }
}

/** The actions folded in memory. */
export function sbSteps(seed: string, actions: readonly SbAction[]): SbSim {
  const sim = new SbSim(seed);
  for (const a of actions) sim.apply(a);
  return sim;
}

/**
 * The actions written into fx's clone through BoardWriter on `branch` (created at main's commit when it is not main): a join
 * without a fresh epoch is the commit of BoardWriter's own join draft, and every run of commits is one commitMany.
 */
export async function sbWrite(fx: RepoFixture, seed: string, actions: readonly SbAction[], branch = 'main'): Promise<BoardWriter> {
  if (branch !== 'main') {
    const main = await fx.repo.resolve('refs/heads/main');
    if (main === null) throw new Error('sbWrite: no main branch');
    await fx.repo.run(['update-ref', `refs/heads/${branch}`, main]);
  }
  const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch, seed });
  let run: ScriptCommit[] = [];
  const flush = async (): Promise<void> => {
    if (run.length > 0) await w.commitMany(run);
    run = [];
  };
  for (const a of actions) {
    if (a.kind === 'genesis') {
      await w.genesis(a.writer);
    } else if (a.kind === 'join' && a.newEpoch === true) {
      await flush();
      await w.join(a.name, { newEpoch: true });
    } else if (a.kind === 'join') {
      run.push({ writer: a.name, ops: [joinDraft(displayOf(a.name))] });
    } else {
      run.push(a.c);
    }
  }
  await flush();
  return w;
}

/** The batch report over in-memory steps: sinceFinish(steps.reduce(sincePush, sinceInit(…))). */
export function batchReport(start: FoldState, steps: readonly SinceStep[], o: { from: number; you: PeerId; mine?: readonly MyRecord[]; capFrom?: number | null; label?: SinceOptions['verifiedLabel'] }): SinceReport {
  const init = sinceInit(start, o.from, o.you, o.mine ?? [], o.label === undefined ? undefined : { verifiedLabel: o.label });
  return sinceFinish(steps.reduce(sincePush, init), o.capFrom ?? null);
}

// ---------------------------------------------------------------------------------------------------------------------------
// SB-F04 (10-product §7, T-F04-golden): B starts the board, C joins at 1, A (you) at 4; A's last activity is at 10 (from);
// B's change-set publishes `checkpoint` at 12 and `closed` at 13 on src/engine/loop.ts; C saves at 20; B rejoins with a new
// epoch at 25; C freezes (EPOCH) at 30 (to). Every other height is a board-only commit of one of the peers.

export const SB_SEED = 'sb-f04';
export const LOOP = 'src/engine/loop.ts';
/** C's save commit (any object id: the fold reads no save commit, and neither does since). */
export const SAVE_C = 'c0ffee00' + 'd'.repeat(32);
/** A second save commit sharing SAVE_C's first seven hex digits (the anchor variants' ambiguous prefix c0ffee0). */
export const SAVE_C0FFEE01 = 'c0ffee01' + 'f'.repeat(32);

/** The draft of a save op of `saveCommit` (its other fields are placeholders: since reads only save_commit). */
export function saveDraft(saveCommit: string): OpDraft {
  return { type: 'save', save_commit: saveCommit, saved_live: 'a'.repeat(40), chain_base: 'b'.repeat(40), released_claim_ids: [] };
}

/**
 * SB-F04 with A's (this peer's) rejoin in a new epoch at 25 in place of B's, so A's newest join lies above C's save at 20;
 * with save27, B saves SAVE_C0FFEE01 at 27, above that join (the F04-a final review's I1 reproduction).
 */
export function sbF04ARejoins(o: { save27?: boolean } = {}, seed = SB_SEED): SbAction[] {
  const actions = sbF04({}, seed);
  actions[25] = { kind: 'join', name: 'a', newEpoch: true };
  if (o.save27 === true) actions[27] = { kind: 'commit', c: { writer: 'b', ops: [saveDraft(SAVE_C0FFEE01)] } };
  return actions;
}

export interface SbF04Variant {
  /** A's own change-set on loop.ts at 8 (below from): loop.ts is one of my paths, so B's group is a touch. */
  aCsAt8?: boolean;
  /** A board-only commit at 14 repeating B's `closed` trailer (live code unchanged): not a second publish. */
  boardOnlyRepeat?: boolean;
  /** C's change-set of 300 paths (loop.ts among them) at 18: no Cowork-CS-Paths, so area '…' and never a touch. */
  bigGroupOfC?: boolean;
  /** C's change-set on docs/guide.md at 11 and a second group of B on src/engine/fold.ts at 15: C is listed first. */
  cFirst?: boolean;
  /** C's change-set at 16 on src/ui/app.ts (path of a PARKED record of mine) and src/ui/old.ts (of a resolved one). */
  cOnMyRecords?: boolean;
}

export const SB_NAMES = ['b', 'c', 'a'] as const;

/** The peer ids of SB-F04 (B, C, A in first-use order). */
export function sbF04Peers(seed = SB_SEED): { a: SbPeer; b: SbPeer; c: SbPeer } {
  const m = sbPeerIds(seed, SB_NAMES);
  return { a: m.get('a')!, b: m.get('b')!, c: m.get('c')! };
}

/** The records of mine used by the cOnMyRecords variant: one non-terminal, one terminal. */
export const SB_MINE: readonly MyRecord[] = [
  { id: '01HZ0000000000000000000001', paths: ['src/ui/app.ts'], state: 'PARKED', offer: 'none' },
  { id: '01HZ0000000000000000000002', paths: ['src/ui/old.ts'], state: 'RESOLVED_DISCARD', offer: 'none' },
];

/** SB-F04 heights 0–30 as board actions. */
export function sbF04(v: SbF04Variant = {}, seed = SB_SEED): SbAction[] {
  const { a, b, c } = sbF04Peers(seed);
  const bGroup = `${b.peer}/human/1`;
  const commit = (x: ScriptCommit): SbAction => ({ kind: 'commit', c: x });
  const at = new Map<number, SbAction>([
    [0, { kind: 'genesis', writer: 'b' }],
    [1, { kind: 'join', name: 'c' }],
    [4, { kind: 'join', name: 'a' }],
    [12, commit({ writer: 'b', cs: [{ csId: bGroup, state: 'checkpoint', paths: [LOOP] }] })],
    [13, commit({ writer: 'b', cs: [{ csId: bGroup, state: 'closed', paths: [LOOP] }] })],
    [20, commit({ writer: 'c', ops: [{ type: 'save', save_commit: SAVE_C, saved_live: 'a'.repeat(40), chain_base: 'b'.repeat(40), released_claim_ids: [] }] })],
    [25, { kind: 'join', name: 'b', newEpoch: true }],
    [30, commit({ writer: 'c', ops: [{ type: 'event', cid: '', kind: 'freeze', refs: [], reason_code: 'EPOCH' }] })],
  ]);
  if (v.aCsAt8 === true) at.set(8, commit({ writer: 'a', cs: [{ csId: `${a.peer}/human/1`, paths: [LOOP] }] }));
  if (v.boardOnlyRepeat === true) at.set(14, commit({ writer: 'b', code: 'unchanged', cs: [{ csId: bGroup, state: 'closed', paths: [LOOP] }] }));
  if (v.bigGroupOfC === true) at.set(18, commit({ writer: 'c', cs: [{ csId: `${c.peer}/human/1`, paths: [...many(299, 'big'), LOOP] }] }));
  if (v.cFirst === true) {
    at.set(11, commit({ writer: 'c', cs: [{ csId: `${c.peer}/human/2`, paths: ['docs/guide.md'] }] }));
    at.set(15, commit({ writer: 'b', cs: [{ csId: `${b.peer}/human/2`, paths: ['src/engine/fold.ts'] }] }));
  }
  if (v.cOnMyRecords === true) at.set(16, commit({ writer: 'c', cs: [{ csId: `${c.peer}/human/3`, paths: ['src/ui/app.ts', 'src/ui/old.ts'] }] }));
  const out: SbAction[] = [];
  for (let h = 0; h <= 30; h++) out.push(at.get(h) ?? commit({ writer: h < 4 ? (h % 2 === 0 ? 'b' : 'c') : ['a', 'b', 'c'][h % 3]! }));
  return out;
}

const row = (code: string, params: SinceRow['params'], csIds?: readonly string[]): SinceRow => (csIds === undefined ? { code, params } : { code, params, csIds });

/**
 * T-F04-golden's expected report (10-product §7) for SB-F04 with from 10 (A's last activity), to 30, you = A, in code form:
 * `team` = [{B, areas [{src/engine, 1}]}] (one group); `saves` = [{C, save8, 20}] with no subject; `events` = rejoin B,
 * freeze C; `you.touches` = []; and each variant's change.
 */
export function sbF04Golden(v: SbF04Variant = {}, seed = SB_SEED): SinceReport {
  const { b, c } = sbF04Peers(seed);
  const bGroup = `${b.peer}/human/1`;
  const bGroups = v.cFirst === true ? [bGroup, `${b.peer}/human/2`] : [bGroup];
  const bTeam = { row: row('UI_SINCE_TEAM_ROW', { peer: b.peer, name: 'B', k: bGroups.length }, bGroups), areas: [row('UI_SINCE_TEAM_AREA_NOLABEL', { area: 'src/engine', n: bGroups.length }, bGroups)] };
  const team: Array<{ row: SinceRow; areas: SinceRow[] }> = [];
  const cGroups: Array<{ id: string; areas: SinceRow[] }> = [];
  if (v.cFirst === true) cGroups.push({ id: `${c.peer}/human/2`, areas: [row('UI_SINCE_TEAM_AREA_NOLABEL', { area: 'docs', n: 1 }, [`${c.peer}/human/2`])] });
  if (v.cOnMyRecords === true) cGroups.push({ id: `${c.peer}/human/3`, areas: [row('UI_SINCE_TEAM_AREA_NOLABEL', { area: 'src/ui', n: 1 }, [`${c.peer}/human/3`])] });
  if (v.bigGroupOfC === true) cGroups.push({ id: `${c.peer}/human/1`, areas: [row('UI_SINCE_TEAM_AREA_NOLABEL', { area: '…', n: 1, paths: 300 }, [`${c.peer}/human/1`])] });
  const cTeam = cGroups.length === 0 ? null : {
    row: row('UI_SINCE_TEAM_ROW', { peer: c.peer, name: 'C', k: cGroups.length }, cGroups.map((g) => g.id)),
    areas: cGroups.flatMap((g) => g.areas),
  };
  if (cTeam !== null && v.cFirst === true) team.push(cTeam, bTeam);
  else if (cTeam !== null) team.push(bTeam, cTeam);
  else team.push(bTeam);
  const touches: SinceRow[] = [];
  if (v.aCsAt8 === true) touches.push(row('UI_SINCE_TOUCH', { peer: b.peer, name: 'B', path: LOOP, k: 1 }, [bGroup]));
  if (v.cOnMyRecords === true) touches.push(row('UI_SINCE_TOUCH', { peer: c.peer, name: 'C', path: 'src/ui/app.ts', k: 1 }, [`${c.peer}/human/3`]));
  return {
    from: 10, to: 30, truncatedFrom: null,
    you: { requests: [], records: [], touches, notes: [], wake: 0 },
    saves: [row('UI_SINCE_SAVE', { peer: c.peer, name: 'C', c8: SAVE_C.slice(0, 8), h: 20 })],
    team,
    events: [row('UI_SINCE_EV_REJOIN', { h: 25, peer: b.peer, name: 'B' }), row('UI_SINCE_EV_FREEZE', { h: 30, peer: c.peer, name: 'C' })],
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Long random SIM boards (T-F04-incremental, T-F04-cap): peers a (you), b, c and d; change-sets of one or two heights
// (checkpoint then closed), board-only trailer repeats, groups of more than 256 paths, seat change-sets, saves, freezes,
// unfreezes, incidents and other events, leaves, same-epoch rejoins and new epochs, writer-less commits and malformed lines.

const AREA_PATHS: readonly string[] = [
  'src/engine/loop.ts', 'src/engine/fold.ts', 'src/engine/apply.ts', 'src/ui/app.ts', 'src/ui/menu.ts', 'src/ui/deep/x.ts',
  'docs/guide.md', 'docs/api.md', 'README.md', 'package.json', 'tools/lint/a.ts', 'tools/build/b.mjs', 'test/unit/x.test.ts',
  'lib/one.ts', 'lib/two.ts',
];
const SEATS: Readonly<Record<string, string>> = { a: 'a1'.repeat(16), b: 'b2'.repeat(16), c: 'c3'.repeat(16), d: 'd4'.repeat(16) };
const OTHER_EVENTS = ['health', 'nonretryable', 'K1', 'breach'] as const;

/**
 * A seeded board of `height + 1` commits (heights 0..height) over seed's peer ids (sbPeerIds(seed, ['b', 'c', 'a', 'd'])):
 * b starts it, c, a and d join at 1–3, then each height is one random fact of an active peer. freshEpochs false: every rejoin
 * keeps its epoch (a fresh epoch is one BoardWriter.join call of its own, so a long written board keeps them out).
 */
export function sbRandom(seed: string, height: number, o: { freshEpochs?: boolean } = {}): SbAction[] {
  const fresh = o.freshEpochs !== false;
  const ids = sbPeerIds(seed, ['b', 'c', 'a', 'd']);
  const r = seededRandom(`${seed}/script`);
  const pick = <T>(xs: readonly T[]): T => xs[randomInt(r, xs.length)]!;
  const hex40 = (): string => randomHex(r, 20);
  const status = new Map<string, 'active' | 'left'>([['b', 'active']]);
  const counter = new Map<string, number>();
  const open = new Map<string, { csId: string; paths: string[] }>();
  const recent: Array<{ writer: string; csId: string; paths: string[] }> = [];
  const nextCs = (name: string): string => {
    const n = (counter.get(name) ?? 0) + 1;
    counter.set(name, n);
    return `${ids.get(name)!.peer}/human/${n}`;
  };
  const paths = (): string[] => [...new Set(Array.from({ length: 1 + randomInt(r, 4) }, () => pick(AREA_PATHS)))];
  const out: SbAction[] = [{ kind: 'genesis', writer: 'b' }, { kind: 'join', name: 'c' }, { kind: 'join', name: 'a' }, { kind: 'join', name: 'd' }];
  for (const n of ['c', 'a', 'd']) status.set(n, 'active');
  const commit = (c: ScriptCommit): void => { out.push({ kind: 'commit', c }); };
  while (out.length <= height) {
    const active = [...status].filter(([, s]) => s === 'active').map(([n]) => n);
    const w = pick(active);
    const roll = randomInt(r, 100);
    if (roll < 22) {
      const cs = { csId: nextCs(w), paths: paths() };
      if (randomInt(r, 3) === 0) {
        open.set(w, cs);
        commit({ writer: w, cs: [{ ...cs, state: 'checkpoint' }] });
      } else {
        commit({ writer: w, cs: [cs] });
      }
      recent.push({ writer: w, ...cs });
    } else if (roll < 30 && open.has(w)) {
      const cs = open.get(w)!;
      open.delete(w);
      commit({ writer: w, cs: [{ ...cs, state: 'closed', paths: [...new Set([...cs.paths, ...paths()])] }] });
    } else if (roll < 34) {
      commit({ writer: w, cs: [{ csId: nextCs(w), paths: paths() }, { csId: nextCs(w), paths: paths() }] });
    } else if (roll < 36) {
      commit({ writer: w, cs: [{ csId: nextCs(w), paths: many(257 + randomInt(r, 60), 'big') }] });
    } else if (roll < 39 && recent.length > 0) {
      const x = recent[recent.length - 1 - randomInt(r, Math.min(recent.length, 8))]!;
      commit({ writer: x.writer, code: 'unchanged', cs: [{ csId: x.csId, paths: x.paths }] });
    } else if (roll < 43) {
      commit({ writer: w, ops: [{ type: 'seat_start', seat_id: SEATS[w]!, permission_mode: 'default' }], cs: [{ seat: SEATS[w]!, origin: randomInt(r, 2) === 0 ? 'prompt' : 'wake', paths: paths() }] });
    } else if (roll < 48) {
      commit({ writer: w, ops: [{ type: 'save', save_commit: hex40(), saved_live: hex40(), chain_base: hex40(), released_claim_ids: [] }], code: randomInt(r, 2) === 0 ? 'base_move' : 'unchanged' });
    } else if (roll < 53) {
      const kind = pick(['freeze', 'unfreeze', 'incident'] as const);
      commit({ writer: w, ops: [{ type: 'event', cid: '', kind, refs: [], reason_code: 'EPOCH' }] });
    } else if (roll < 55) {
      commit({ writer: w, ops: [{ type: 'event', cid: '', kind: pick(OTHER_EVENTS), refs: [], reason_code: 'TEST_REASON' }] });
    } else if (roll < 57 && w !== 'b' && active.length > 2) {
      commit({ writer: w, ops: [{ type: 'leave' }] });
      status.set(w, 'left');
    } else if (roll < 59) {
      const back = [...status].filter(([, s]) => s === 'left').map(([n]) => n);
      if (back.length > 0) {
        const n = pick(back);
        status.set(n, 'active');
        out.push(randomInt(r, 2) === 0 || !fresh ? { kind: 'join', name: n } : { kind: 'join', name: n, newEpoch: true });
      } else if (fresh) {
        out.push({ kind: 'join', name: w, newEpoch: true });
        open.delete(w);
      } else {
        commit({ writer: w });
      }
    } else if (roll < 60) {
      commit({ writer: null, rawOps: ['{"id":"x"}'] });
    } else if (roll < 61) {
      commit({ writer: w, rawOps: ['{"truncated":'] });
    } else {
      commit({ writer: w });
    }
  }
  return out.slice(0, height + 1);
}
