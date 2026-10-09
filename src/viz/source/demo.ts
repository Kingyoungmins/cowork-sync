// Demo logs `cowork-viz-demo/1` (12 §3.9.3 as amended by the owner's choice of 2026-10-08; VIZ-06, VIZ-27, VIZ-37; rulings
// R-V19, R-V30, R-V32): the strict parser and its serializer, the bounded read of a --demo file, and the demo room source,
// which folds every commit record as the BoardDraft a board commit gives (toDraft, foldFrame) — no git call and no file read.
// A demo log exported from a board folds to that board's timeline byte for byte (no oid reaches a seed or a timeline).
import { createHash } from 'node:crypto';
import { parseCsTrailers, parseWriter, type BoardDraft, type CsTrailer } from '../../board/boardCommit.js';
import { foldCommit, initialFoldState, type FoldState } from '../../board/fold.js';
import { base32c, type PeerId } from '../../board/ids.js';
import { OP_MAX_LINE_BYTES, OPS_MAX_BYTES, OPS_MAX_LINES } from '../../board/ops.js';
import type { ProtocolJson } from '../../board/protocol.js';
import { isOid } from '../../git/oid.js';
import { validId, validPathSyntax } from '../../sec/validators.js';
import { foldFrame, toDraft, ZERO_PEER, type Frame, type FrameCode } from '../model/frame.js';
import type { BoundedReader } from './boundedRead.js';
import type { Advance, DemoCaption, RoomSource, TipInfo } from './roomSource.js';

export type { DemoCaption } from './roomSource.js';

export const DEMO_FORMAT = 'cowork-viz-demo/1';
export const DEMO_MAX_BYTES = 4 * 1024 * 1024, BUNDLED_DEMO_MAX_BYTES = 64 * 1024, CAPTION_TEXT_MAX = 120;

export interface DemoRoomHeader { room: string; name: string; branch: string; }
/** owner choice of 2026-10-08 (12 §3.9.3 `claims`): the recorded answers of one commit's claim fold — oids, 'ABSENT', ids and booleans only. */
export interface DemoClaims { readonly trees: ReadonlyArray<readonly [string, string, string]>; readonly pairs: ReadonlyArray<readonly [string, string, boolean]>; }
export interface DemoCommit {
  room: string; height: number; writer: string | null; protocol: ProtocolJson | null;
  code: { changed: boolean; seats: string[]; base: string | null };
  cs: string[]; csPaths: Map<string, string[]>; ops: string[]; held: string[];   // csPaths: a Map (board-derived keys, VIZ-37)
  live: string | null;                            // owner choice of 2026-10-08: a changed record's live commit oid (unchanged records inherit it)
  claims: DemoClaims | null;                      // owner choice of 2026-10-08: used from Task 20 (demoClaimInputs)
  line: number;                                   // 1-based line in the file (refusals)
}
export interface DemoLog { rooms: DemoRoomHeader[]; commits: Map<string, DemoCommit[]>; captions: DemoCaption[]; }

const ROOMS_MAX = 32;
const ROOM_RE = /^[a-z0-9]{1,8}$/;
const NAME_MAX = 40;
const BRANCH_MAX = 80;
const CS_PATHS_MAX = 256;
const CAPTION_CODE_RE = /^UI_VIZ_DEMO_CAPTION_[0-9]{1,2}$/;
const CLAIM_TREES_MAX = 1_000;
const CLAIM_PAIRS_MAX = 4_096;
/** Plan 4's claim_id (R4-24: RFC 4648 lower-case base32, 16 characters), until src/sec/validators.ts gains validId('claim'). */
const CLAIM_ID_RE = /^[a-z2-7]{16}$/;
const ABSENT = 'ABSENT';
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const HEADER_KEYS = ['t', 'format', 'rooms'] as const;
const ROOM_KEYS = ['room', 'name', 'branch'] as const;
const COMMIT_KEYS: ReadonlySet<string> = new Set(['t', 'room', 'height', 'writer', 'protocol', 'code', 'cs', 'csPaths', 'ops', 'held', 'live', 'claims']);
const COMMIT_REQUIRED = ['t', 'room', 'height', 'writer', 'code', 'cs', 'csPaths', 'ops'] as const;
const CAPTION_KEYS: ReadonlySet<string> = new Set(['t', 'room', 'height', 'code', 'text']);
const PROTOCOL_KEYS = ['proto', 'regionSpec', 'budget', 'G_s', 'S_s'] as const;
const CODE_KEYS = ['changed', 'seats', 'base'] as const;
const CLAIMS_KEYS = ['trees', 'pairs'] as const;

class Refusal {
  constructor(readonly line: number) {}
}
function refuse(line: number): never {
  throw new Refusal(line);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: Obj, k: string): boolean => Object.hasOwn(o, k);
const isStr = (v: unknown): v is string => typeof v === 'string';
const chars = (s: string): number => [...s].length;
/** Exactly these keys (own, enumerable), no other. */
const exactKeys = (o: Obj, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => has(o, k));
};
/** git's path order: UTF-8 bytes. */
const byUtf8 = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const sha1 = (s: string): string => createHash('sha1').update(s, 'utf8').digest('hex');

/** The lines of the file (an empty last segment after the final LF is not a line). */
function splitLines(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const lf = buf.indexOf(0x0a, pos);
    const end = lf < 0 ? buf.length : lf;
    out.push(buf.subarray(pos, end));
    pos = end + 1;
  }
  return out;
}

/** One line as a JSON object: no CR and no BOM byte sequence, strict UTF-8, JSON, an object. */
function record(bytes: Buffer, n: number): Obj {
  if (bytes.includes(0x0d) || bytes.includes(BOM)) refuse(n);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return refuse(n);
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return refuse(n);
  }
  if (!isObj(v)) refuse(n);
  return v;
}

function parseHeader(r: Obj, n: number): DemoRoomHeader[] {
  if (!exactKeys(r, HEADER_KEYS) || r['format'] !== DEMO_FORMAT) refuse(n);
  const rooms = r['rooms'];
  if (!Array.isArray(rooms) || rooms.length < 1 || rooms.length > ROOMS_MAX) refuse(n);
  const seen = new Set<string>();
  return rooms.map((x): DemoRoomHeader => {
    if (!isObj(x) || !exactKeys(x, ROOM_KEYS)) refuse(n);
    const { room, name, branch } = x;
    if (!isStr(room) || !ROOM_RE.test(room) || seen.has(room)) refuse(n);
    if (!isStr(name) || chars(name) < 1 || chars(name) > NAME_MAX || !isStr(branch) || chars(branch) < 1 || chars(branch) > BRANCH_MAX) refuse(n);
    seen.add(room);
    return { room, name, branch };
  });
}

function parseProtocol(v: unknown, n: number): ProtocolJson {
  if (!isObj(v) || !exactKeys(v, PROTOCOL_KEYS)) refuse(n);
  const { proto, regionSpec, budget, G_s: g, S_s: s } = v;
  const positive = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;
  if (typeof proto !== 'number' || !Number.isSafeInteger(proto) || proto < 0 || !isStr(regionSpec) || !positive(budget) || !positive(g) || !positive(s)) refuse(n);
  return { proto, regionSpec, budget, G_s: g, S_s: s };
}

/** One Cowork-CS value through the Plan 2 trailer parser, or null when it refuses it. */
function csTrailerOf(v: unknown): CsTrailer | null {
  if (!isStr(v)) return null;
  const { cs } = parseCsTrailers([{ key: 'Cowork-CS', value: v }]);
  return cs.length === 1 ? cs[0]! : null;
}

/** A pair id: an op id, or a Plan 4 claim_id (R4-24). */
const pairId = (v: unknown): v is string => isStr(v) && (validId('op', v) || CLAIM_ID_RE.test(v));

function parseClaims(v: unknown, n: number): DemoClaims {
  if (!isObj(v) || !exactKeys(v, CLAIMS_KEYS)) refuse(n);
  const { trees, pairs } = v;
  if (!Array.isArray(trees) || trees.length > CLAIM_TREES_MAX || !Array.isArray(pairs) || pairs.length > CLAIM_PAIRS_MAX) refuse(n);
  const treeKeys = new Set<string>();
  const outTrees = trees.map((t): readonly [string, string, string] => {
    if (!Array.isArray(t) || t.length !== 3) refuse(n);
    const [commit, path, entry] = t as unknown[];
    if (!isOid(commit) || !isStr(path) || !validPathSyntax(path) || !(entry === ABSENT || isOid(entry))) refuse(n);
    const key = `${commit}\0${path}`;
    if (treeKeys.has(key)) refuse(n);
    treeKeys.add(key);
    return [commit, path, entry as string];
  });
  const pairKeys = new Set<string>();
  const outPairs = pairs.map((p): readonly [string, string, boolean] => {
    if (!Array.isArray(p) || p.length !== 3) refuse(n);
    const [c1, c2, overlap] = p as unknown[];
    if (!pairId(c1) || !pairId(c2) || typeof overlap !== 'boolean') refuse(n);
    const key = `${c1}\0${c2}`;
    if (pairKeys.has(key)) refuse(n);
    pairKeys.add(key);
    return [c1, c2, overlap];
  });
  return { trees: outTrees, pairs: outPairs };
}

function parseCommit(r: Obj, n: number, commits: ReadonlyMap<string, DemoCommit[]>): DemoCommit {
  for (const k of Object.keys(r)) if (!COMMIT_KEYS.has(k)) refuse(n);
  for (const k of COMMIT_REQUIRED) if (!has(r, k)) refuse(n);
  const room = r['room'];
  const list = isStr(room) ? commits.get(room) : undefined;
  if (list === undefined) return refuse(n);
  const height = r['height'];
  if (typeof height !== 'number' || height !== list.length) refuse(n);
  const writer = r['writer'];
  if (!(writer === null || (isStr(writer) && parseWriter(writer) !== null))) refuse(n);
  if (has(r, 'protocol') !== (height === 0)) refuse(n);
  const protocol = height === 0 ? parseProtocol(r['protocol'], n) : null;

  const code = r['code'];
  if (!isObj(code) || !exactKeys(code, CODE_KEYS)) return refuse(n);
  const { changed, seats, base } = code;
  if (typeof changed !== 'boolean' || !Array.isArray(seats) || !seats.every(isStr) || !(base === null || isOid(base))) refuse(n);

  const cs = r['cs'];
  if (!Array.isArray(cs)) return refuse(n);
  const csIds = new Set<string>();
  for (const v of cs) {
    const t = csTrailerOf(v);
    if (t === null) refuse(n);
    csIds.add(t.csId);
  }
  const rawPaths = r['csPaths'];
  if (!isObj(rawPaths)) return refuse(n);
  const csPaths = new Map<string, string[]>();
  for (const key of Object.keys(rawPaths)) {
    if (!csIds.has(key)) refuse(n);
    const paths = rawPaths[key];
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > CS_PATHS_MAX) refuse(n);
    for (let i = 0; i < paths.length; i++) {
      const p: unknown = paths[i];
      if (!isStr(p) || !validPathSyntax(p) || (i > 0 && byUtf8(paths[i - 1] as string, p) >= 0)) refuse(n);
    }
    csPaths.set(key, [...(paths as string[])]);
  }

  const ops = r['ops'];
  if (!Array.isArray(ops) || ops.length > OPS_MAX_LINES) return refuse(n);
  let bytes = 0;
  for (const o of ops) {
    if (!isStr(o)) refuse(n);
    const b = Buffer.byteLength(o, 'utf8');
    bytes += b + 1;
    if (b > OP_MAX_LINE_BYTES || bytes > OPS_MAX_BYTES) refuse(n);
  }
  const held = has(r, 'held') ? r['held'] : [];
  if (!Array.isArray(held) || !held.every(isStr)) return refuse(n);
  let live: string | null = null;
  if (has(r, 'live')) {
    const l = r['live'];
    if (!isOid(l) || changed !== true) refuse(n);
    live = l;
  }
  const claims = has(r, 'claims') ? parseClaims(r['claims'], n) : null;
  return {
    room: room as string, height, writer: writer as string | null, protocol,
    code: { changed, seats: [...(seats as string[])], base: base as string | null },
    cs: [...(cs as string[])], csPaths, ops: [...(ops as string[])], held: [...(held as string[])], live, claims, line: n,
  };
}

function parseCaption(r: Obj, n: number, commits: ReadonlyMap<string, DemoCommit[]>, captionCodes: ReadonlySet<string>): DemoCaption {
  for (const k of Object.keys(r)) if (!CAPTION_KEYS.has(k)) refuse(n);
  if (!has(r, 'room') || !has(r, 'height') || has(r, 'code') === has(r, 'text')) refuse(n);
  const { room, height, code, text } = r;
  if (!isStr(room) || !commits.has(room) || typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0) refuse(n);
  if (has(r, 'code')) {
    if (!isStr(code) || !CAPTION_CODE_RE.test(code) || !captionCodes.has(code)) refuse(n);
    return { room, height, code, text: null };
  }
  if (!isStr(text) || chars(text) < 1 || chars(text) > CAPTION_TEXT_MAX) refuse(n);
  return { room, height, code: null, text };
}

function parse(buf: Buffer, captionCodes: ReadonlySet<string>): DemoLog {
  const lines = splitLines(buf);
  if (lines.length === 0) refuse(0);
  const head = record(lines[0]!, 1);
  if (head['t'] !== 'header') refuse(1);
  const rooms = parseHeader(head, 1);
  const commits = new Map<string, DemoCommit[]>(rooms.map((r) => [r.room, []]));
  const captions: Array<{ c: DemoCaption; line: number }> = [];
  for (let i = 1; i < lines.length; i++) {
    const n = i + 1;
    const r = record(lines[i]!, n);
    if (r['t'] === 'commit') {
      const c = parseCommit(r, n, commits);
      commits.get(c.room)!.push(c);
    } else if (r['t'] === 'caption') {
      captions.push({ c: parseCaption(r, n, commits, captionCodes), line: n });
    } else {
      refuse(n);
    }
  }
  // A caption's height must be one its room's commits reach (the whole file decides).
  for (const { c, line } of captions) if (c.height >= commits.get(c.room)!.length) refuse(line);
  return { rooms, commits, captions: captions.map((x) => x.c) };
}

/** Strict: an unknown t or field, a rule of the §3.9.3 table broken, or a non-UTF-8 or CR or BOM byte → { line } of the first bad record (0 = file level). */
export function parseDemoLog(buf: Buffer, captionCodes: ReadonlySet<string>): DemoLog | { line: number } {
  try {
    return parse(buf, captionCodes);
  } catch (e) {
    if (e instanceof Refusal) return { line: e.line };
    throw e;
  }
}

/** JSON text with U+FEFF escaped, so no line ever holds a BOM byte sequence (parseDemoLog refuses one). */
const J = (v: unknown): string => JSON.stringify(v).replace(/﻿/g, '\\ufeff');

function commitText(c: DemoCommit): string {
  const parts = [`"t":"commit","room":${J(c.room)},"height":${J(c.height)},"writer":${J(c.writer)}`];
  if (c.protocol !== null) {
    const p = c.protocol;
    parts.push(`"protocol":${J({ proto: p.proto, regionSpec: p.regionSpec, budget: p.budget, G_s: p.G_s, S_s: p.S_s })}`);
  }
  parts.push(`"code":${J({ changed: c.code.changed, seats: c.code.seats, base: c.code.base })}`);
  parts.push(`"cs":${J(c.cs)}`);
  parts.push(`"csPaths":{${[...c.csPaths].map(([k, v]) => `${J(k)}:${J(v)}`).join(',')}}`);
  parts.push(`"ops":${J(c.ops)}`, `"held":${J(c.held)}`);
  if (c.live !== null) parts.push(`"live":${J(c.live)}`);
  if (c.claims !== null) parts.push(`"claims":${J({ trees: c.claims.trees, pairs: c.claims.pairs })}`);
  return `{${parts.join(',')}}`;
}

/**
 * LF, no BOM, fixed key order (commit: t, room, height, writer, protocol at height 0, code, cs, csPaths, ops, held, then live
 * and claims when present): the header, every commit in `line` order (then header room order and height), then the captions
 * in order. parseDemoLog(serializeDemoLog(x)) deep-equals x for every log it wrote and every parsed log whose captions follow
 * its commits.
 */
export function serializeDemoLog(log: DemoLog): Buffer {
  const order = new Map(log.rooms.map((r, i) => [r.room, i]));
  const all = [...log.commits.values()].flat().sort((a, b) => a.line - b.line || (order.get(a.room) ?? 0) - (order.get(b.room) ?? 0) || a.height - b.height);
  const lines = [J({ t: 'header', format: DEMO_FORMAT, rooms: log.rooms.map((r) => ({ room: r.room, name: r.name, branch: r.branch })) })];
  for (const c of all) lines.push(commitText(c));
  for (const c of log.captions) {
    lines.push(`{"t":"caption","room":${J(c.room)},"height":${J(c.height)},${c.code !== null ? `"code":${J(c.code)}` : `"text":${J(c.text)}`}}`);
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

/** One BoundedReader read with max DEMO_MAX_BYTES (R-V30): not_file, too_large, absent or a read error → { line: 0 }. */
export async function readDemoFile(path: string, reader: BoundedReader): Promise<Buffer | { line: 0 }> {
  try {
    const r = await reader.read(path, DEMO_MAX_BYTES);
    return Buffer.isBuffer(r) ? r : { line: 0 };
  } catch {
    return { line: 0 };
  }
}

/** 'r' + base32c(sha256(salt ‖ "demo:" ‖ room))[0:8]. */
export function demoRoomId(salt: Uint8Array, room: string): string {
  return `r${base32c(createHash('sha256').update(salt).update(Buffer.from(`demo:${room}`, 'utf8')).digest()).slice(0, 8)}`;
}

/** What one demo commit folds as: its draft, its synthesized transient oid, its trailers' code and path lists. */
interface DemoStep { draft: BoardDraft; oid: string; code: FrameCode; csPaths: ReadonlyMap<string, readonly string[]>; }

/**
 * Each commit → a BoardDraft through toDraft (writer through parseWriter, cs through parseCsTrailers of Cowork-CS trailers,
 * opsLines = ops, checkpoint null, heldIds = held, protocol carried from height 0, liveCode = a changed record's live when
 * present, else hex sha1("<room>:<height>:live") at 0 and when code.changed, else the previous draft's); oid = hex
 * sha1("<room>:<height>:board"); code.changed false at 0 (foldFrame); shape 'genesis' at 0, 'base_move' when base ≠ null, else
 * 'ordinary'; csPaths as a board keeps them (a list of a listed change-set with its paths count). No git call, no file read.
 */
export class DemoRoomSource implements RoomSource {
  readonly kind = 'demo' as const;
  private readonly room: string;
  private readonly steps: DemoStep[];
  private readonly protocol: ProtocolJson | null;

  constructor(room: DemoRoomHeader, commits: readonly DemoCommit[]) {
    this.room = room.room;
    commits.forEach((c, i) => {
      if (c.room !== room.room || c.height !== i) throw new RangeError(`DemoRoomSource: commit ${i} of room ${room.room} is ${c.room}:${c.height}`);
    });
    this.protocol = commits[0]?.protocol ?? null;
    if (commits.length > 0 && this.protocol === null) throw new RangeError(`DemoRoomSource: room ${room.room} has no height-0 protocol`);
    let liveCode = '';
    this.steps = commits.map((c): DemoStep => {
      if (c.height === 0 || c.code.changed) liveCode = c.live ?? sha1(`${this.room}:${c.height}:live`);
      const { cs, paths: counts } = csOf(c.cs);
      const csPaths = new Map<string, string[]>();
      for (const [id, list] of c.csPaths) if (counts.get(id) === list.length) csPaths.set(id, [...list]);
      return {
        draft: toDraft({ liveCode, writer: c.writer === null ? null : parseWriter(c.writer), cs, protocol: this.protocol!, opsLines: c.ops, checkpoint: null, heldIds: c.held }),
        oid: sha1(`${this.room}:${c.height}:board`),
        code: { changed: c.code.changed, shape: c.height === 0 ? 'genesis' : c.code.base !== null ? 'base_move' : 'ordinary', seats: [...c.code.seats], base: c.code.base },
        csPaths,
      };
    });
  }

  async tip(): Promise<TipInfo | null> {
    const h = this.steps.length - 1;
    return h < 0 ? null : { height: h, key: `${this.room}:${h}` };
  }

  async changed(): Promise<boolean> {
    return false;
  }

  /** A demo never moves: the tip itself is 'none', an earlier height of this room 'ff', anything else 'rewrite'. */
  async advance(last: TipInfo): Promise<Advance> {
    const t = await this.tip();
    if (t === null) return { kind: 'gone' };
    if (last.key === t.key && last.height === t.height) return { kind: 'none' };
    if (last.height >= 0 && last.height < t.height && last.key === `${this.room}:${last.height}`) return { kind: 'ff', to: t };
    return { kind: 'rewrite', to: t };
  }

  /** initialFoldState(protocol of height 0) at 0 (the state before B0); the fold state after height h for h > 0. */
  async startAt(h: number): Promise<FoldState> {
    if (!Number.isSafeInteger(h) || h < 0 || h >= this.steps.length) throw new RangeError(`DemoRoomSource.startAt: no height ${h} in room ${this.room}`);
    let s = initialFoldState(this.protocol!);
    if (h === 0) return s;
    for (let i = 0; i <= h; i++) s = foldCommit(s, this.steps[i]!.draft, ZERO_PEER).state;
    return s;
  }

  /** Frames of heights from…to (inclusive), folded from `start` (the state at from − 1). */
  async *frames(start: FoldState, from: number, to: number, self: PeerId): AsyncIterable<Frame> {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to >= this.steps.length || from > to + 1) {
      throw new RangeError(`DemoRoomSource.frames: ${from}…${to} outside room ${this.room}'s heights 0…${this.steps.length - 1}`);
    }
    let prev = start;
    for (let h = from; h <= to; h++) {
      const s = this.steps[h]!;
      const f = foldFrame(prev, { height: h, oid: s.oid, draft: s.draft, csPaths: s.csPaths, code: s.code, malformed: false }, self);
      prev = f.after;
      yield f;
    }
  }
}

/** The change-sets a board keeps from these Cowork-CS values (parseCsTrailers: valid, first of a repeated id) and their paths counts. */
function csOf(values: readonly string[]): { cs: CsTrailer[]; paths: Map<string, number> } {
  const { cs } = parseCsTrailers(values.map((value) => ({ key: 'Cowork-CS', value })));
  return { cs, paths: new Map(cs.map((c) => [c.csId, c.paths])) };
}
