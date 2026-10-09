// Scripted boards for the visualizer's tests and the storyboard (Plan 8a Task 2; V10, R-V19; never shipped).
// A BoardWriter writes a real board chain into a clone over Plan 2's own board writer: live commits with
// liveCommitTrailers, board commits by buildBoardCommit, checkpoints from the build's own foldCommit + serializeFold,
// every commit with a writer peer's SEC-03 identity (`<peer_id>@cowork.invalid`) and a wallMs date (honoured by the
// test-build runner). Long boards go through commitMany: one `git fast-import` that writes the same objects, so the
// same script gives the same oids either way (tested). The malformed fixtures of R-V19 are built with
// hash-object/mktree/commit-tree, because Plan 2's writer refuses to build them.
import { createHash } from 'node:crypto';
import { boardTrailers, buildBoardCommit, BOARD_SUBJECT, CODE_SUBJECT, liveCommitTrailers, opsLinesOf, type CsTrailer, type WriterId } from '../../src/board/boardCommit.js';
import { foldCommit, initialFoldState, serializeFold, CHECKPOINT_EVERY, type FoldState } from '../../src/board/fold.js';
import type { EpochId, PeerId } from '../../src/board/ids.js';
import { eventCid, OPS_MAX_BYTES, serializeOps, type CapsOp, type JoinOp, type Op, type OpDraft } from '../../src/board/ops.js';
import { genesisProtocol, PROTO, serializeProtocol, type ProtocolJson } from '../../src/board/protocol.js';
import { enc } from '../../src/git/enc.js';
import { parseOid, type Oid } from '../../src/git/oid.js';
import { GitRepo, type MktreeEntry, type RepoContext, type RepoPaths } from '../../src/git/repo.js';
import type { GitRunner } from '../../src/git/runner.js';
import { formatMessage, type Trailer } from '../../src/git/trailers.js';
import { randomHex, seededRandom, type Random } from '../../src/ports/random.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { noopDraft, toDraft, ZERO_PEER } from '../../src/viz/model/frame.js';
import { FIXTURE_WALL_MS } from '../../test/helpers/repoFixture.js';

export interface ScriptPeer { name: string; peer: PeerId; epoch: EpochId; seq: number; display: string; pluginVersion: string; regionSpec: string; coauthorOptin: false | string; }
/**
 * One change-set of a commit. csId defaults to `<peer>/human/<n>` (or `<seat>/<turn>` with a seat), counted per writer
 * and per seat; state 'closed', origin 'human' ('prompt' with a seat), checks 'skipped'. A list of more than 256 paths
 * gets no Cowork-CS-Paths trailer (glossary §5).
 */
export interface ScriptCs { csId?: string; seat?: string; state?: 'closed' | 'checkpoint'; origin?: 'prompt' | 'wake' | 'human'; checks?: 'pass' | 'fail' | 'skipped'; paths: readonly string[]; }
/**
 * One board commit. writer: a peer name (created on first use) or null (no Cowork-Writer; rawOps only, code unchanged).
 * ops get the writer's next seqs (an event draft's cid '' becomes eventCid(id, kind)); rawOps lines follow them verbatim.
 * code defaults to 'ordinary' when cs is given, else 'unchanged' (board-only); seats default to the change-sets' seats
 * ('human' for a human one). badWriterTrailer writes Cowork-Writer twice on the board commit (it reads as no writer).
 */
export interface ScriptCommit {
  writer: string | null; ops?: readonly OpDraft[]; rawOps?: readonly string[]; cs?: readonly ScriptCs[];
  code?: 'unchanged' | 'ordinary' | 'base_move'; seats?: readonly string[]; badWriterTrailer?: boolean;
}

/** One height of the written chain. liveCode: the board commit's last parent; live: the live chain's newest real commit. */
interface Height { board: Oid; liveCode: Oid; live: Oid; base: Oid; state: FoldState; checkpoint: Buffer; }

/** Everything a script commit writes, decided before any object exists (shared by commit() and commitMany()). */
interface Planned {
  height: number;
  /** The identity of every object of the commit. */
  author: ScriptPeer;
  writer: WriterId | null;
  ops: Op[];
  opsBytes: Buffer;
  cs: CsTrailer[];
  csPaths: Map<string, string[]>;
  code: 'unchanged' | 'ordinary' | 'base_move';
  liveTrailers: Trailer[] | null;
  boardTrailers: Trailer[];
  /** buildBoardCommit can write it (a writer, no raw lines, one Cowork-Writer). */
  plan2: boolean;
  checkpoint: Buffer | null;
  state: FoldState;
}

const PLUGIN_SHA = 'f'.repeat(64);
const BASE_SUBJECT = 'boardWriter base move';
const SIDE_SUBJECT = 'boardWriter side commit';
const OPS_FILE = 'ops.jsonl';
const PROTOCOL_FILE = 'protocol.json';
/** What commit-tree and fast-import both write verbatim (git trims crud such as '.', ',' or quotes off a name's ends). */
const SAFE_DISPLAY = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,62}[A-Za-z0-9])?$/;
/** The fold never reads BoardDraft.liveCode, so the writer's own fold of a planned commit names this placeholder. */
const NO_LIVE = parseOid('0'.repeat(40));

function displayOf(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
}

export class BoardWriter {
  readonly ref: string;
  private readonly runner: GitRunner;
  private readonly paths: RepoPaths;
  private readonly branch: string;
  private readonly seed: string;
  private random: Random;
  /** 16-byte draws taken from `random` (peer ids and epochs), so a failed write can rewind it. */
  private draws = 0;
  private readonly wallMs: () => number;
  private readonly protocol: ProtocolJson;
  private readonly regionSpec: string;
  private readonly peers = new Map<string, ScriptPeer>();
  private readonly repos = new Map<string, GitRepo>();
  private readonly counters = new Map<string, number>();
  private readonly heights: Height[] = [];
  private genesisName: string | null = null;
  /** The tree of the branch tip at genesis: every live and base commit the writer makes has it. */
  private tree: Oid | null = null;
  private tagCount = 0;

  private constructor(o: { runner: GitRunner; paths: RepoPaths; branch: string; seed: string; budget?: number; regionSpec?: string; wallMs?: () => number }) {
    this.runner = o.runner;
    this.paths = o.paths;
    this.branch = o.branch;
    this.ref = `refs/cowork-remote/${enc(o.branch)}/board`;
    this.seed = o.seed;
    this.random = seededRandom(o.seed);
    this.wallMs = o.wallMs ?? ((): number => FIXTURE_WALL_MS);
    this.regionSpec = o.regionSpec ?? 'rs-1';
    this.protocol = genesisProtocol(o.budget ?? 12, this.regionSpec);
  }

  /**
   * V10: over a runner and the paths of a clone (makeRepoFixture().runner and .paths; the runner must be a test build for
   * the dates); one GitRepo per writer peer; ref refs/cowork-remote/<enc(branch)>/board; ids from seededRandom(seed).
   */
  static async create(o: { runner: GitRunner; paths: RepoPaths; branch: string; seed: string; budget?: number; regionSpec?: string; wallMs?: () => number }): Promise<BoardWriter> {
    return new BoardWriter(o);
  }

  /** The peer called `name`, created on first use (its ids come from the seed, in order of first use). A copy. */
  peer(name: string): ScriptPeer {
    return { ...this.peerRec(name) };
  }

  tip(): { oid: Oid; height: number } {
    const top = this.top();
    return { oid: top.board, height: this.heights.length - 1 };
  }

  /** The fold state after the tip (the writer's own foldCommit; a copy). */
  fold(): FoldState {
    return structuredClone(this.top().state);
  }

  /** L0 (no parents, Cowork-Base: the branch tip) and B0 (join, caps; writer seq 3), checkpoint at 0 (PRO-07). */
  async genesis(writer: string): Promise<Oid> {
    return this.atomically(() => this.writeGenesis(writer));
  }

  private async writeGenesis(writer: string): Promise<Oid> {
    if (this.heights.length > 0) throw new Error('BoardWriter.genesis: the board exists');
    const p = this.peerRec(writer);
    const repo = this.repoOf(p);
    const base = await repo.resolve(`refs/heads/${this.branch}`);
    if (base === null) throw new Error(`BoardWriter.genesis: no branch ${this.branch}`);
    this.tree = (await repo.readCommit(base)).tree;
    const w: WriterId = { peer: p.peer, epoch: p.epoch, seq: p.seq + 3 };
    const joinOp: JoinOp = { id: `${p.peer}/${p.epoch}/${p.seq + 1}`, ...this.joinDraft(p) };
    const capsOp: CapsOp = { id: `${p.peer}/${p.epoch}/${p.seq + 2}`, type: 'caps', custom_refs: true, lease: true, delete: true, push_options: false, two_parent_ok: true };
    p.seq += 3;
    const ops: Op[] = [joinOp, capsOp];
    const l0 = await repo.commitTree({ tree: this.tree, parents: [], subject: CODE_SUBJECT, trailers: liveCommitTrailers(w, [], [], new Map(), base) });
    const draft = toDraft({ liveCode: l0, writer: w, cs: [], protocol: this.protocol, opsLines: opsLinesOf(serializeOps(ops)), checkpoint: null, heldIds: [] });
    const state = foldCommit(initialFoldState(this.protocol), draft, ZERO_PEER).state;
    const checkpoint = serializeFold(state);
    const b0 = await buildBoardCommit(repo, { prevBoard: null, liveCode: l0, writer: w, ops, cs: [], csPaths: new Map(), protocol: this.protocol, checkpoint });
    if (!(await repo.casRef(this.ref, b0, null, 'boardWriter genesis'))) throw new Error(`BoardWriter.genesis: ${this.ref} exists`);
    this.genesisName = writer;
    this.heights.push({ board: b0, liveCode: l0, live: l0, base, state, checkpoint });
    return b0;
  }

  /** A board-only commit of `name` with its join op (newEpoch: a fresh epoch, seqs from 1); the options update the peer first. */
  async join(name: string, o: { newEpoch?: boolean; pluginVersion?: string; regionSpec?: string; coauthorOptin?: false | string; display?: string } = {}): Promise<Oid> {
    return this.atomically(() => {
      const p = this.peerRec(name);
      if (o.newEpoch === true) {
        p.epoch = this.draw16();
        p.seq = 0;
      }
      if (o.pluginVersion !== undefined) p.pluginVersion = o.pluginVersion;
      if (o.regionSpec !== undefined) p.regionSpec = o.regionSpec;
      if (o.coauthorOptin !== undefined) p.coauthorOptin = o.coauthorOptin;
      if (o.display !== undefined) p.display = BoardWriter.checkDisplay(o.display);
      return this.write({ writer: name, ops: [this.joinDraft(p)] }, this.top().board);
    });
  }

  /**
   * A live commit per `code` (ordinary: [prevLive]; base_move: [prevLive, X] with Cowork-Base X, X a new commit on the
   * base; unchanged: none) with liveCommitTrailers, and a board commit by buildBoardCommit (a hand-built tree of the same
   * entries when it has raw lines, no writer or a doubled Cowork-Writer), its checkpoint the writer's own foldCommit +
   * serializeFold at heights % 256 === 0; update-ref of the ref.
   */
  async commit(c: ScriptCommit): Promise<Oid> {
    return this.atomically(() => this.write(c, this.top().board));
  }

  /** A non-fast-forward board diverging at fromHeight (1 ≤ fromHeight ≤ tip): one new board-only commit of the genesis writer there. */
  async rewrite(fromHeight: number): Promise<Oid> {
    const old = this.top().board;
    if (!Number.isSafeInteger(fromHeight) || fromHeight < 1 || fromHeight > this.heights.length - 1) {
      throw new RangeError(`BoardWriter.rewrite: fromHeight ${fromHeight} outside 1..${this.heights.length - 1}`);
    }
    return this.atomically(() => {
      this.heights.length = fromHeight;
      return this.write({ writer: this.genesisWriter() }, old);
    });
  }

  /**
   * R-V19/F8 fixtures on top of the tip, written as the genesis writer (dev tooling): a board commit whose ops.jsonl is
   * over 64 KiB ('board_ops_too_large'; the fold takes it as noopDraft), a board commit naming an annotated tag of the live
   * commit as its live commit ('live_not_commit') or a three-parent live commit ('live_three_parents').
   */
  async malformed(kind: 'board_ops_too_large' | 'live_not_commit' | 'live_three_parents'): Promise<Oid> {
    return this.atomically(() => this.writeMalformed(kind));
  }

  /** One git fast-import for long fixture boards; the same identities, dates and oids as step-by-step commit() (tested). */
  async commitMany(cs: readonly ScriptCommit[]): Promise<Oid> {
    return this.atomically(() => this.importMany(cs));
  }

  // ---- internals ------------------------------------------------------------------------------------------------

  /**
   * Runs one public write so that the writer changes only when it succeeds: a git call that fails (or a refusal) puts
   * back every peer record, counter, height, the tag count and the seeded random stream as they were.
   */
  private async atomically<T>(fn: () => Promise<T>): Promise<T> {
    const peers = new Map([...this.peers].map(([k, p]) => [k, { ...p }] as const));
    const counters = new Map(this.counters);
    const heights = [...this.heights];
    const { genesisName, tree, tagCount, draws } = this;
    try {
      return await fn();
    } catch (e) {
      for (const [k, p] of [...this.peers]) {
        const was = peers.get(k);
        if (was === undefined) {
          this.peers.delete(k);
          this.repos.delete(k);
        } else {
          Object.assign(p, was);
        }
      }
      this.counters.clear();
      for (const [k, v] of counters) this.counters.set(k, v);
      this.heights.length = 0;
      this.heights.push(...heights);
      this.genesisName = genesisName;
      this.tree = tree;
      this.tagCount = tagCount;
      if (this.draws !== draws) {
        this.random = seededRandom(this.seed);
        for (let i = 0; i < draws; i++) randomHex(this.random, 16);
        this.draws = draws;
      }
      throw e;
    }
  }

  /** 16 bytes of the seeded stream, as hex (a peer id or an epoch). */
  private draw16(): string {
    this.draws++;
    return randomHex(this.random, 16);
  }

  private async writeMalformed(kind: 'board_ops_too_large' | 'live_not_commit' | 'live_three_parents'): Promise<Oid> {
    const prev = this.top();
    const h = this.heights.length;
    const p = this.peerRec(this.genesisWriter());
    const repo = this.repoOf(p);
    const w: WriterId = { peer: p.peer, epoch: p.epoch, seq: ++p.seq };
    let board: Oid;
    let liveCode: Oid;
    let live = prev.live;
    let state: FoldState;
    if (kind === 'live_three_parents') {
      const side = await repo.commitTree({ tree: this.tree!, parents: [prev.base], subject: SIDE_SUBJECT, trailers: [] });
      liveCode = await repo.commitTree({ tree: this.tree!, parents: [prev.live, prev.base, side], subject: CODE_SUBJECT, trailers: liveCommitTrailers(w, ['human'], [], new Map(), null) });
      live = liveCode;
      state = this.foldDraft(prev.state, w, Buffer.alloc(0));
      const checkpoint = h % CHECKPOINT_EVERY === 0 ? serializeFold(state) : null;
      board = await buildBoardCommit(repo, { prevBoard: prev.board, liveCode, writer: w, ops: [], cs: [], csPaths: new Map(), protocol: null, checkpoint });
      await this.move(repo, board, prev.board);
      this.heights.push({ board, liveCode, live, base: prev.base, state, checkpoint: checkpoint ?? prev.checkpoint });
      return board;
    }
    const big = kind === 'board_ops_too_large';
    const opsBytes = big ? Buffer.from(`${'x'.repeat(1_023)}\n`.repeat(70), 'utf8') : Buffer.alloc(0);
    state = big
      ? foldCommit(prev.state, noopDraft({ protocol: this.protocol, liveCode: prev.liveCode }), ZERO_PEER).state
      : this.foldDraft(prev.state, w, opsBytes);
    const checkpoint = h % CHECKPOINT_EVERY === 0 ? serializeFold(state) : prev.checkpoint;
    const tree = await this.boardTree(repo, opsBytes, checkpoint);
    const trailers = boardTrailers(w, [], new Map());
    if (big) {
      liveCode = prev.live;
      board = await repo.commitTree({ tree, parents: [prev.board, liveCode], subject: BOARD_SUBJECT, trailers });
    } else {
      // commit-tree -p would peel the tag to its commit: the board commit object is hashed as written.
      const tagDate = this.dateLine(this.wallMs());
      const tag = Buffer.from(`object ${prev.live}\ntype commit\ntag boardwriter-${++this.tagCount}\ntagger ${this.ident(p)} ${tagDate}\n\nnot a live commit\n`, 'utf8');
      liveCode = this.oidOf(await repo.run(['hash-object', '-t', 'tag', '-w', '--stdin'], { stdin: tag }));
      const raw = this.commitBytes(tree, [prev.board, liveCode], p, this.dateLine(this.wallMs()), formatMessage(BOARD_SUBJECT, trailers));
      board = this.oidOf(await repo.run(['hash-object', '-t', 'commit', '-w', '--stdin'], { stdin: raw }));
    }
    await this.move(repo, board, prev.board);
    this.heights.push({ board, liveCode, live, base: prev.base, state, checkpoint });
    return board;
  }

  private async importMany(cs: readonly ScriptCommit[]): Promise<Oid> {
    if (cs.length === 0) return this.top().board;
    const parts: Buffer[] = [];
    const text = (s: string): void => { parts.push(Buffer.from(s, 'utf8')); };
    const data = (b: Buffer): void => {
      text(`data ${b.length}\n`);
      parts.push(b);
      text('\n');
    };
    let mark = 0;
    type Ref = { mark: number } | { oid: Oid };
    const at = (r: Ref): string => ('mark' in r ? `:${r.mark}` : r.oid);
    const prev = this.top();
    let board: Ref = { oid: prev.board };
    let live: Ref = { oid: prev.live };
    let base: Ref = { oid: prev.base };
    /** The base's oid: a base-move commit X of this import is hashed here, because the live commit's Cowork-Base names it. */
    let baseOid: Oid = prev.base;
    const computed = new Map<number, Oid>();
    let state = prev.state;
    let checkpoint = prev.checkpoint;
    const rows: Array<{ board: number; live: Ref; base: Ref; state: FoldState; checkpoint: Buffer }> = [];
    const commitHeader = (who: ScriptPeer, message: Buffer, from: Ref, oidOf?: (date: string) => Oid): number => {
      const date = this.dateLine(this.wallMs());
      text(`commit ${this.ref}\nmark :${++mark}\nauthor ${this.ident(who)} ${date}\ncommitter ${this.ident(who)} ${date}\n`);
      data(message);
      text(`from ${at(from)}\n`);
      if (oidOf !== undefined) computed.set(mark, oidOf(date));
      return mark;
    };
    for (let i = 0; i < cs.length; i++) {
      const p = this.plan(cs[i]!, this.heights.length + i, state);
      if (p.code === 'base_move') {
        const message = formatMessage(BASE_SUBJECT, []);
        const parentOid = baseOid;
        const x = commitHeader(p.author, message, base, (date) => this.commitOid(this.commitBytes(this.tree!, [parentOid], p.author, date, message)));
        base = { mark: x };
        baseOid = computed.get(x)!;
      }
      if (p.liveTrailers !== null) {
        live = { mark: commitHeader(p.author, formatMessage(CODE_SUBJECT, this.withBase(p, baseOid)), live) };
        if (p.code === 'base_move') text(`merge ${at(base)}\n`);
      }
      const b = commitHeader(p.author, formatMessage(BOARD_SUBJECT, p.boardTrailers), board);
      text(`merge ${at(live)}\nM 100644 inline ${OPS_FILE}\n`);
      data(p.opsBytes);
      if (p.checkpoint !== null) {
        text('M 100644 inline checkpoint/state.json\n');
        data(p.checkpoint);
        checkpoint = p.checkpoint;
      }
      board = { mark: b };
      state = p.state;
      rows.push({ board: b, live, base, state, checkpoint });
    }
    for (let m = 1; m <= mark; m++) text(`get-mark :${m}\n`);
    text('done\n');
    const repo = this.repoOf(this.peerRec(this.genesisWriter()));
    const r = await repo.run(['fast-import', '--quiet', '--done'], { stdin: Buffer.concat(parts) });
    const marks = r.stdout.toString('utf8').split('\n').filter((l) => l.length > 0).map((l) => parseOid(l));
    if (marks.length !== mark) throw new Error(`BoardWriter.commitMany: ${marks.length} marks for ${mark} commits`);
    for (const [m, o] of computed) {
      if (marks[m - 1] !== o) throw new Error(`BoardWriter.commitMany: base-move commit :${m} is ${marks[m - 1]!}, its live commit names ${o}`);
    }
    const oid = (x: Ref): Oid => ('mark' in x ? marks[x.mark - 1]! : x.oid);
    for (const row of rows) {
      const l = oid(row.live);
      this.heights.push({ board: marks[row.board - 1]!, liveCode: l, live: l, base: oid(row.base), state: row.state, checkpoint: row.checkpoint });
    }
    const tip = this.top().board;
    if ((await repo.readRef(this.ref)) !== tip) throw new Error(`BoardWriter.commitMany: ${this.ref} is not at the imported tip`);
    return tip;
  }

  /** The date commit-tree records for GIT_AUTHOR_DATE=@<s> +0000 (the runner's test-build dates). */
  private dateLine(ms: number): string {
    return `${Math.floor(ms / 1000)} +0000`;
  }

  /** A commit object as commit-tree and fast-import write it (no encoding header: the runner forces UTF-8). */
  private commitBytes(tree: Oid, parents: readonly string[], who: ScriptPeer, date: string, message: Buffer): Buffer {
    const head = [`tree ${tree}`, ...parents.map((x) => `parent ${x}`), `author ${this.ident(who)} ${date}`, `committer ${this.ident(who)} ${date}`];
    return Buffer.concat([Buffer.from(`${head.join('\n')}\n\n`, 'utf8'), message]);
  }

  /** The object id git gives a commit object (sha1, or sha256 in a sha256 repository). */
  private commitOid(content: Buffer): Oid {
    const algo = this.tree!.length === 64 ? 'sha256' : 'sha1';
    return parseOid(createHash(algo).update(`commit ${content.length}`, 'utf8').update(Buffer.from([0])).update(content).digest('hex'));
  }

  private ident(p: ScriptPeer): string {
    return `${p.display} <${p.peer}@cowork.invalid>`;
  }

  private oidOf(r: { stdout: Buffer }): Oid {
    return parseOid(r.stdout.toString('utf8'));
  }

  private static checkDisplay(d: string): string {
    if (!SAFE_DISPLAY.test(d)) throw new Error(`BoardWriter: display ${JSON.stringify(d)} is not one commit-tree and fast-import write alike`);
    return d;
  }

  private top(): Height {
    const t = this.heights[this.heights.length - 1];
    if (t === undefined) throw new Error('BoardWriter: no board yet (call genesis first)');
    return t;
  }

  private genesisWriter(): string {
    if (this.genesisName === null) throw new Error('BoardWriter: no board yet (call genesis first)');
    return this.genesisName;
  }

  private peerRec(name: string): ScriptPeer {
    let p = this.peers.get(name);
    if (p === undefined) {
      p = {
        name, peer: this.draw16(), epoch: this.draw16(), seq: 0, display: BoardWriter.checkDisplay(displayOf(name)),
        pluginVersion: PLUGIN_VERSION, regionSpec: this.regionSpec, coauthorOptin: false,
      };
      this.peers.set(name, p);
    }
    return p;
  }

  private repoOf(p: ScriptPeer): GitRepo {
    let repo = this.repos.get(p.name);
    if (repo === undefined) {
      const ctx = (): RepoContext => ({ attrTree: null, filterDrivers: [], identity: { name: p.display, email: `${p.peer}@cowork.invalid` }, wallMs: this.wallMs });
      repo = new GitRepo(this.runner, this.paths, ctx);
      this.repos.set(p.name, repo);
    }
    return repo;
  }

  private joinDraft(p: ScriptPeer): Omit<JoinOp, 'id'> {
    return {
      type: 'join', display: p.display, plugin_version: p.pluginVersion, plugin_sha: PLUGIN_SHA, proto: PROTO, regionSpec: p.regionSpec,
      config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '' }, coauthor_optin: p.coauthorOptin,
    };
  }

  private next(key: string): number {
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return n;
  }

  /** The fold of a board commit the reader takes as it is (opsLinesOf of its stored bytes; a > 64 KiB ops.jsonl is malformed: R-V19). */
  private foldDraft(prev: FoldState, writer: WriterId | null, opsBytes: Buffer): FoldState {
    const draft = opsBytes.length > OPS_MAX_BYTES
      ? noopDraft({ protocol: this.protocol, liveCode: NO_LIVE })
      : toDraft({ liveCode: NO_LIVE, writer, cs: [], protocol: this.protocol, opsLines: opsLinesOf(opsBytes), checkpoint: null, heldIds: [] });
    return foldCommit(prev, draft, ZERO_PEER).state;
  }

  /** Decides every byte of a script commit (seqs, ids, trailers, ops.jsonl, checkpoint) and folds it; writes nothing. */
  private plan(c: ScriptCommit, height: number, prevState: FoldState): Planned {
    const rawOps = c.rawOps ?? [];
    const drafts = c.ops ?? [];
    const scriptCs = c.cs ?? [];
    const code = c.code ?? (scriptCs.length > 0 ? 'ordinary' : 'unchanged');
    const author = this.peerRec(c.writer ?? this.genesisWriter());
    if (c.writer === null && (drafts.length > 0 || code !== 'unchanged' || scriptCs.length > 0 || c.badWriterTrailer === true)) {
      throw new Error('BoardWriter: a commit without a writer carries raw lines only');
    }
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
    const lines = rawOps.map((l) => `${l}\n`).join('');
    const opsBytes = Buffer.concat([serializeOps(ops), Buffer.from(lines, 'utf8')]);
    const seats = c.seats ?? (scriptCs.length === 0 ? ['human'] : [...new Set(scriptCs.map((s) => s.seat ?? 'human'))]);
    const someWriter: WriterId = writer ?? { peer: author.peer, epoch: author.epoch, seq: author.seq + 1 };
    const full = boardTrailers(someWriter, cs, csPaths);
    let trailers: Trailer[] = full;
    if (writer === null) trailers = full.filter((t) => t.key !== 'Cowork-Writer');
    else if (c.badWriterTrailer === true) trailers = [...full.slice(0, 3), full[2]!, ...full.slice(3)];
    const plan2 = writer !== null && rawOps.length === 0 && c.badWriterTrailer !== true;
    const state = this.foldDraft(prevState, c.badWriterTrailer === true ? null : writer, opsBytes);
    return {
      height, author, writer, ops, opsBytes, cs, csPaths, code,
      liveTrailers: code === 'unchanged' ? null : liveCommitTrailers(writer!, seats, cs, csPaths, null),
      boardTrailers: trailers, plan2,
      checkpoint: height % CHECKPOINT_EVERY === 0 ? serializeFold(state) : null,
      state,
    };
  }

  /** The live trailers with Cowork-Base: base for a base move (liveCommitTrailers puts it last). */
  private withBase(p: Planned, base: string): Trailer[] {
    return p.code === 'base_move' ? [...p.liveTrailers!, { key: 'Cowork-Base', value: base }] : p.liveTrailers!;
  }

  /** ops.jsonl, the genesis protocol.json and checkpoint/state.json: the entries buildBoardCommit writes for a scripted board. */
  private async boardTree(repo: GitRepo, opsBytes: Buffer, checkpoint: Buffer): Promise<Oid> {
    const state = await repo.mktree([{ name: 'state.json', mode: '100644', type: 'blob', oid: await repo.hashBytes(checkpoint, true) }]);
    const entries: MktreeEntry[] = [
      { name: OPS_FILE, mode: '100644', type: 'blob', oid: await repo.hashBytes(opsBytes, true) },
      { name: PROTOCOL_FILE, mode: '100644', type: 'blob', oid: await repo.hashBytes(serializeProtocol(this.protocol), true) },
      { name: 'checkpoint', mode: '040000', type: 'tree', oid: state },
    ];
    return repo.mktree(entries);
  }

  private async move(repo: GitRepo, next: Oid, prev: Oid): Promise<void> {
    if (!(await repo.casRef(this.ref, next, prev, 'boardWriter'))) throw new Error(`BoardWriter: ${this.ref} moved under the writer`);
  }

  private async write(c: ScriptCommit, refPrev: Oid): Promise<Oid> {
    const prev = this.top();
    const p = this.plan(c, this.heights.length, prev.state);
    const repo = this.repoOf(p.author);
    let base = prev.base;
    let live = prev.live;
    if (p.code === 'base_move') {
      base = await repo.commitTree({ tree: this.tree!, parents: [prev.base], subject: BASE_SUBJECT, trailers: [] });
    }
    if (p.liveTrailers !== null) {
      live = await repo.commitTree({ tree: this.tree!, parents: p.code === 'base_move' ? [prev.live, base] : [prev.live], subject: CODE_SUBJECT, trailers: this.withBase(p, base) });
    }
    let board: Oid;
    if (p.plan2) {
      board = await buildBoardCommit(repo, { prevBoard: prev.board, liveCode: live, writer: p.writer!, ops: p.ops, cs: p.cs, csPaths: p.csPaths, protocol: null, checkpoint: p.checkpoint });
    } else {
      const tree = await this.boardTree(repo, p.opsBytes, p.checkpoint ?? prev.checkpoint);
      board = await repo.commitTree({ tree, parents: [prev.board, live], subject: BOARD_SUBJECT, trailers: p.boardTrailers });
    }
    await this.move(repo, board, refPrev);
    this.heights.push({ board, liveCode: live, live, base, state: p.state, checkpoint: p.checkpoint ?? prev.checkpoint });
    return board;
  }
}
