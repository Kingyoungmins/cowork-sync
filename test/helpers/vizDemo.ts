// cowork-viz-demo/1 logs for the demo tests (Plan 8a Task 7; 12 §3.9.3): records written as the format writes them, op lines
// as Plan 2's canonical ops.jsonl lines, and a small valid storyboard per room (joins, human change-sets with and without
// paths on the board, a freeze and a thaw, a board-only commit).
import { canonicalJson, type Json } from '../../src/board/canonicalJson.js';
import { eventCid, type EventKind } from '../../src/board/ops.js';
import type { ProtocolJson } from '../../src/board/protocol.js';

export const DEMO_PROTOCOL: ProtocolJson = { proto: 1, regionSpec: 'rs-1', budget: 12, G_s: 5, S_s: 1.5 };
export const CAPTION_CODES: ReadonlySet<string> = new Set(['UI_VIZ_DEMO_CAPTION_1', 'UI_VIZ_DEMO_CAPTION_2']);

/** A demo peer: its peer id and epoch (32 hex each) and the next op/writer seq. */
export interface DemoPeer { peer: string; epoch: string; seq: number; display: string; }
export function demoPeer(tag: string, display: string): DemoPeer {
  return { peer: tag.repeat(16), epoch: `e${tag[1]}`.repeat(16), seq: 0, display };
}
const idOf = (p: DemoPeer): string => `${p.peer}/${p.epoch}/${++p.seq}`;
const line = (v: Json): string => canonicalJson(v);

export function joinOp(p: DemoPeer): string {
  return line({
    id: idOf(p), type: 'join', display: p.display, plugin_version: '0.0.0', plugin_sha: '0'.repeat(64), proto: 1, regionSpec: 'rs-1',
    config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '2.43.0' }, coauthor_optin: false,
  });
}
export function capsOp(p: DemoPeer): string {
  return line({ id: idOf(p), type: 'caps', custom_refs: true, lease: true, delete: true, push_options: false, two_parent_ok: true });
}
export function eventOp(p: DemoPeer, kind: EventKind, reason: string, refs: string[] = []): string {
  const id = idOf(p);
  return line({ id, type: 'event', cid: eventCid(id, kind), kind, refs, reason_code: reason });
}
/** The writer value of the commit carrying ops written just before: the writer's next seq. */
export const writerOf = (p: DemoPeer): string => `${p.peer}/${p.epoch}/${++p.seq}`;
/** A Cowork-CS trailer value of a human change-set. */
export const csOf = (p: DemoPeer, n: number, paths: number): string => `${p.peer}/human/${n} state=closed seq=${n} origin=human checks=skipped paths=${paths}`;
export const csIdOf = (p: DemoPeer, n: number): string => `${p.peer}/human/${n}`;

export const headerLine = (rooms: Array<{ room: string; name: string; branch: string }>): string => JSON.stringify({ t: 'header', format: 'cowork-viz-demo/1', rooms });

export interface CommitFields {
  room: string; height: number; writer: string | null; protocol?: ProtocolJson; code?: { changed: boolean; seats: string[]; base: string | null };
  cs?: string[]; csPaths?: Record<string, string[]>; ops?: string[]; held?: string[]; live?: string; claims?: unknown;
}
/** A commit record in the format's own key order (absent optional fields left out). */
export function commitRecord(c: CommitFields): Record<string, unknown> {
  const r: Record<string, unknown> = { t: 'commit', room: c.room, height: c.height, writer: c.writer };
  if (c.protocol !== undefined) r['protocol'] = c.protocol;
  r['code'] = c.code ?? { changed: false, seats: [], base: null };
  r['cs'] = c.cs ?? [];
  r['csPaths'] = c.csPaths ?? {};
  r['ops'] = c.ops ?? [];
  if (c.held !== undefined) r['held'] = c.held;
  if (c.live !== undefined) r['live'] = c.live;
  if (c.claims !== undefined) r['claims'] = c.claims;
  return r;
}
export const commitLine = (c: CommitFields): string => JSON.stringify(commitRecord(c));
export const captionLine = (room: string, height: number, x: { code: string } | { text: string }): string => JSON.stringify({ t: 'caption', room, height, ...x });
export const demoBuffer = (lines: readonly string[]): Buffer => Buffer.from(`${lines.join('\n')}\n`, 'utf8');

/**
 * A valid six-height story of one room (heights 0–5): ann opens the room, bob joins, ann publishes two paths of src/,
 * bob publishes 300 paths (no list on the board: the big table), ann is frozen (EPOCH) and thawed in one commit, then a
 * board-only commit of bob.
 */
export function storyLines(room: string): string[] {
  const ann = demoPeer('a1', 'Ann');
  const bob = demoPeer('b2', 'Bob');
  const g = [joinOp(ann), capsOp(ann)];
  const out: string[] = [];
  out.push(commitLine({ room, height: 0, writer: writerOf(ann), protocol: DEMO_PROTOCOL, code: { changed: false, seats: [], base: 'f'.repeat(40) }, ops: g }));
  const bj = [joinOp(bob)];
  out.push(commitLine({ room, height: 1, writer: writerOf(bob), ops: bj }));
  out.push(commitLine({ room, height: 2, writer: writerOf(ann), code: { changed: true, seats: ['human'], base: null }, cs: [csOf(ann, 1, 2)], csPaths: { [csIdOf(ann, 1)]: ['src/a.ts', 'src/b.ts'] } }));
  out.push(commitLine({ room, height: 3, writer: writerOf(bob), code: { changed: true, seats: ['human'], base: null }, cs: [csOf(bob, 1, 300)] }));
  const fz = [eventOp(ann, 'freeze', 'EPOCH'), eventOp(ann, 'unfreeze', 'EPOCH')];
  out.push(commitLine({ room, height: 4, writer: writerOf(ann), ops: fz }));
  out.push(commitLine({ room, height: 5, writer: writerOf(bob) }));
  return out;
}
