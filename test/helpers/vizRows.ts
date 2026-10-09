// The 12 §3.4 row fixtures of Plan 8a Task 6 (test/fixtures/viz/rows/<row>.json) and their goldens
// (test/golden/viz/rows/<row>.events.json). A fixture is one BoardDraft sequence from height 0, marked with the plan that
// first puts its row on a real board, written compactly: peers, epochs and seats by alias, op ids, writer seqs, cids and
// live-commit oids filled in here, every draft built through toDraft (R-V02). Task 16's `npm run viz:golden [-- --update]`
// regenerates the goldens only through rowGoldenFiles (X-91, F-8a-5).
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { BoardDraft, CsTrailer, WriterId } from '../../src/board/boardCommit.js';
import { canonicalJson, type Json } from '../../src/board/canonicalJson.js';
import { initialFoldState, type FoldState } from '../../src/board/fold.js';
import { eventCid, type EventKind } from '../../src/board/ops.js';
import { genesisProtocol, type ProtocolJson } from '../../src/board/protocol.js';
import { foldFrame, noopDraft, toDraft, ZERO_PEER, type Frame, type FrameCode, type FrameInput } from '../../src/viz/model/frame.js';
import { TimelineBuilder, type Timeline } from '../../src/viz/model/timeline.js';

/** A fixture frame: `repeat` copies of it at consecutive heights. */
export interface FixtureFrame {
  writer?: string | null;                        // 'A' (epoch 1) or 'A@2'; null or absent: no Cowork-Writer
  ops?: FixtureOp[];
  code?: { changed?: boolean; shape?: FrameCode['shape']; seats?: string[]; base?: string | null };   // seats: 'human' or seat aliases
  cs?: FixtureCs[];
  malformed?: boolean;                           // R-V19: the no-op draft of an unreadable board commit
  protocol?: Partial<ProtocolJson>;
  repeat?: number;
}
/** An op by type with its glossary §7 fields (defaults filled in), `times` copies of it; or a raw ops.jsonl line. */
export type FixtureOp = { line: string } | ({ type: string; times?: number } & { [field: string]: Json | undefined });
/** The raw ops.jsonl line of a fixture op written as one, else null. */
const rawLine = (op: FixtureOp): string | null => {
  const v = (op as { line?: unknown }).line;
  return typeof v === 'string' && !('type' in op) ? v : null;
};
/** A Cowork-CS trailer of the writer: a human change-set of `human` or a seat turn of `seat`, with its paths (or only a count, > 256). */
export interface FixtureCs { human?: string; n?: number; seat?: string; turn?: number; id?: string; state?: CsTrailer['state']; origin?: CsTrailer['origin']; checks?: CsTrailer['checks']; files?: string[]; count?: number; }
export interface RowFixture { row: string; plan: number; about: string; frames: FixtureFrame[]; }

/** Peer alias → 32 hex: the alias's first character's code as two hex digits, sixteen times ('A' → '4141…'). */
export const peerOf = (alias: string): string => alias.charCodeAt(0).toString(16).padStart(2, '0').repeat(16);
/** Epoch n of a peer → 32 hex ('e1e1…' for 1). */
export const epochOf = (n: number): string => (0xe0 + n).toString(16).repeat(16);
/** Seat alias 'S<n>' → 32 hex ('5151…' for S1). */
export const seatIdOf = (alias: string): string => `5${Number(alias.slice(1)).toString(16)}`.repeat(16);
/** The board seat key "<peer>/<epoch>/<seat_id>" of a writer alias and a seat alias. */
export function seatKeyOf(writer: string, seat: string): string {
  const w = parseWriterAlias(writer);
  return `${w.peer}/${w.epoch}/${seatIdOf(seat)}`;
}
function parseWriterAlias(a: string): { peer: string; epoch: string } {
  const [p, e] = a.split('@');
  return { peer: peerOf(p!), epoch: epochOf(e === undefined ? 1 : Number(e)) };
}
const oidOf = (tag: number, h: number): string => `${tag.toString(16)}${h.toString(16).padStart(8, '0')}`.padStart(40, '0');
/** The live commit oid a fixture gives the code commit of height h (genesis: h = 0). */
export const liveOidOf = (h: number): string => oidOf(0xa, h);
const boardOidOf = (h: number): string => oidOf(0xb, h);
export const FIXTURE_PROTOCOL: ProtocolJson = genesisProtocol(12, 'rs-1');
const OID = 'c'.repeat(40);

function opDefaults(type: string, id: string, f: Record<string, Json | undefined>): Record<string, Json> {
  const o: Record<string, Json | undefined> = { ...f };
  delete o['times'];
  const base: Record<string, Json> = { id, type };
  switch (type) {
    case 'join':
      Object.assign(base, {
        display: 'Peer', plugin_version: '0.0.0', plugin_sha: '0'.repeat(64), proto: 1, regionSpec: 'rs-1',
        config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '2.43.0' }, coauthor_optin: false,
      });
      break;
    case 'caps':
      Object.assign(base, { custom_refs: true, lease: true, delete: true, push_options: false, two_parent_ok: true });
      break;
    case 'seat_start':
    case 'seat_end':
      Object.assign(base, { permission_mode: 'default' });
      if (typeof o['seat'] === 'string') base['seat_id'] = seatIdOf(o['seat']);
      delete o['seat'];
      break;
    case 'event': {
      const kind = (o['kind'] ?? 'freeze') as EventKind;
      Object.assign(base, { kind, refs: [], reason_code: 'EPOCH', cid: eventCid(id, kind) });
      break;
    }
    case 'save':
      Object.assign(base, { save_commit: OID, saved_live: OID, chain_base: OID, released_claim_ids: [] });
      break;
    default:
      break;
  }
  for (const [k, v] of Object.entries(o)) if (v !== undefined) base[k] = v;
  return base;
}

function csIdOf(c: FixtureCs): string {
  if (c.id !== undefined) return c.id;
  if (c.human !== undefined) return `${peerOf(c.human)}/human/${c.n ?? 1}`;
  if (c.seat !== undefined) return `${seatIdOf(c.seat)}/${c.turn ?? 1}`;
  throw new Error('fixture cs: no id, human or seat');
}

/** The frame inputs of a fixture: heights 0, 1, …; op ids and writer seqs per (peer, epoch); live oids change with code.changed. */
export function fixtureInputs(fx: RowFixture): FrameInput[] {
  const seqs = new Map<string, number>();
  const out: FrameInput[] = [];
  let prev: BoardDraft | null = null;
  let live = liveOidOf(0);
  let h = 0;
  for (const spec of fx.frames) {
    for (let r = 0; r < (spec.repeat ?? 1); r++, h++) {
      const protocol: ProtocolJson = { ...FIXTURE_PROTOCOL, ...(spec.protocol ?? {}) };
      if (spec.malformed === true) {
        if (prev === null) throw new Error('fixture: a malformed frame needs a previous draft');
        const d = noopDraft(prev);
        out.push({ height: h, oid: boardOidOf(h), draft: d, csPaths: new Map(), code: { changed: false, shape: null, seats: [], base: null }, malformed: true });
        prev = d;
        continue;
      }
      let writer: WriterId | null = null;
      const lines: string[] = [];
      if (typeof spec.writer === 'string') {
        const w = parseWriterAlias(spec.writer);
        const key = `${w.peer}/${w.epoch}`;
        let seq = seqs.get(key) ?? 0;
        for (const op of spec.ops ?? []) {
          const raw = rawLine(op);
          if (raw !== null) {
            lines.push(raw);
            continue;
          }
          const { type, times } = op as { type: string; times?: number } & { [field: string]: Json | undefined };
          for (let i = 0; i < (typeof times === 'number' ? times : 1); i++) {
            const id = `${w.peer}/${w.epoch}/${++seq}`;
            lines.push(canonicalJson(opDefaults(type, id, op)));
          }
        }
        writer = { peer: w.peer, epoch: w.epoch, seq: ++seq };
        seqs.set(key, seq);
      } else {
        for (const op of spec.ops ?? []) {
          const raw = rawLine(op);
          if (raw !== null) lines.push(raw);
        }
      }
      const cs: CsTrailer[] = [];
      const csPaths = new Map<string, string[]>();
      for (const c of spec.cs ?? []) {
        const id = csIdOf(c);
        cs.push({ csId: id, state: c.state ?? 'closed', seq: c.n ?? c.turn ?? 1, origin: c.origin ?? (c.seat !== undefined ? 'prompt' : 'human'), checks: c.checks ?? 'pass', paths: c.files?.length ?? c.count ?? 0 });
        if (c.files !== undefined) csPaths.set(id, [...c.files]);
      }
      const fc = spec.code ?? (spec.cs !== undefined ? { changed: true, shape: 'ordinary' as const } : {});
      const seats = (fc.seats ?? []).map((s) => (s === 'human' ? s : seatIdOf(s)));
      const code: FrameCode = h === 0
        ? { changed: false, shape: fc.shape ?? 'genesis', seats, base: fc.base ?? OID }
        : { changed: fc.changed ?? fc.shape !== undefined, shape: fc.shape ?? null, seats, base: fc.base ?? null };
      if (h > 0 && code.changed) live = liveOidOf(h);
      const d = toDraft({ liveCode: live, writer, cs, protocol, opsLines: lines, checkpoint: null, heldIds: [] });
      out.push({ height: h, oid: boardOidOf(h), draft: d, csPaths, code, malformed: false });
      prev = d;
    }
  }
  return out;
}

/** The fixture folded by foldFrame from initialFoldState(protocol of its B0). */
export function fixtureFrames(fx: RowFixture, self: string = ZERO_PEER): Frame[] {
  const inputs = fixtureInputs(fx);
  let s: FoldState = initialFoldState(inputs[0]?.draft.protocol ?? FIXTURE_PROTOCOL);
  return inputs.map((x) => {
    const f = foldFrame(s, x, self);
    s = f.after;
    return f;
  });
}

export function startOf(fx: RowFixture): FoldState {
  return initialFoldState(fixtureInputs(fx)[0]?.draft.protocol ?? FIXTURE_PROTOCOL);
}

/** A fixture's timeline (h0 = 0, the whole board) and its per-height unknown counts (nonzero only). */
export interface RowTimeline { timeline: Timeline; unknown: Array<[number, number]>; }

/** The fixture's timeline, each frame folded and pushed in turn (no frame or fold state is kept: long fixtures stay small). */
export function fixtureTimeline(fx: RowFixture, self: string = ZERO_PEER): RowTimeline {
  const inputs = fixtureInputs(fx);
  let s: FoldState = initialFoldState(inputs[0]?.draft.protocol ?? FIXTURE_PROTOCOL);
  const b = TimelineBuilder.open(0, s);
  const unknown: Array<[number, number]> = [];
  for (const x of inputs) {
    const f = foldFrame(s, x, self);
    s = f.after;
    const o = b.push(f);
    if (o.unknown > 0) unknown.push([f.height, o.unknown]);
  }
  return { timeline: b.timeline(), unknown };
}

export function loadRowFixture(file: string): RowFixture {
  return JSON.parse(readFileSync(file, 'utf8')) as RowFixture;
}

/** Repo-relative, '/'-separated on every OS (fs accepts it everywhere; viz:golden reports it). */
export const ROW_FIXTURE_DIR = posix.join('test', 'fixtures', 'viz', 'rows');
export const ROW_GOLDEN_DIR = posix.join('test', 'golden', 'viz', 'rows');

/** Every fixture file name (sorted by code unit) under <root>/test/fixtures/viz/rows. */
export function rowFixtureNames(root: string): string[] {
  return readdirSync(join(root, ROW_FIXTURE_DIR)).filter((n) => n.endsWith('.json')).sort();
}

/** The golden text of one fixture (from its timeline when the caller has it): its row, plan, nonzero unknown counts, events and
 *  cards, one event or card per line, LF. */
export function rowGolden(fx: RowFixture, t: RowTimeline = fixtureTimeline(fx)): string {
  const { timeline, unknown } = t;
  const list = (xs: readonly unknown[]): string => (xs.length === 0 ? '[]' : `[\n${xs.map((x) => canonicalJson(x as Json)).join(',\n')}\n]`);
  return `{"row":${JSON.stringify(fx.row)},"plan":${fx.plan},"unknown":${canonicalJson(unknown as unknown as Json)},\n"events":${list(timeline.events)},\n"cards":${list(timeline.cards)}}\n`;
}

/** What `npm run viz:golden` compares or writes for Task 6: one golden per row fixture, by repo-relative path. */
export function rowGoldenFiles(root: string): Array<{ path: string; text: string }> {
  return rowFixtureNames(root).map((n) => ({
    path: posix.join(ROW_GOLDEN_DIR, n.replace(/\.json$/, '.events.json')),
    text: rowGolden(loadRowFixture(join(root, ROW_FIXTURE_DIR, n))),
  }));
}
