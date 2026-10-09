// Frames (12 §3.3.4): one per board commit in the window, streamed into the timeline builder. Server only: it reaches
// Plan 2's board types. R-V25 adds the transient protoMismatch, checkpoint and malformed. R-V02: every BoardDraft 8a builds
// (git source, demo source, tests) goes through toDraft or noopDraft, so a later BoardDraft change has one call site.
// foldFrame turns one board commit into a frame: foldCommit, its per-line verdicts and the PRO-28 checkpoint compare.
import type { BoardDraft, CsTrailer, WriterId } from '../../board/boardCommit.js';
import type { Json } from '../../board/canonicalJson.js';
import { CHECKPOINT_EVERY, foldCommit, serializeFold, type FoldState } from '../../board/fold.js';
import type { PeerId } from '../../board/ids.js';
import { parseOpLine } from '../../board/ops.js';
import type { ProtocolJson } from '../../board/protocol.js';
import { parseOid } from '../../git/oid.js';

export interface Frame {
  height: number;
  oid: string;                                    // transient: never in a timeline, seed, card or response (demo: synthesized)
  writer: { peer: string; epoch: string; seq: number } | null;   // BoardCommitData.writer
  cs: CsTrailer[];                                // board commit Cowork-CS trailers, in trailer order
  csPaths: ReadonlyMap<string, readonly string[]>;   // decoded Cowork-CS-Paths (≤ 256 paths each)
  code: FrameCode;
  ops: Array<{ line: number; type: string; op: Json | null; verdict: 'effective' | 'unfolded' | 'rejected' }>;   // every ops.jsonl line
  before: FoldState; after: FoldState;            // transient: only checkpoint-height states are retained
  protoMismatch: boolean;                         // the fold's protoMismatch (UI_VIZ_NEWER_PROTOCOL)
  checkpoint: 'match' | 'mismatch' | null;        // PRO-28 byte compare at heights % 256 === 0 when the commit carries one
  malformed: boolean;                             // R-V19: a no-op draft standing in for an unreadable board commit
}
export interface FrameCode {
  changed: boolean;                               // liveCode ≠ the previous board commit's liveCode; false at height 0
  shape: 'genesis' | 'ordinary' | 'base_move' | null;   // liveShape(live commit, previous liveCode) when changed, 'genesis' at height 0; null = malformed
  seats: string[];                                // Cowork-Seat values
  base: string | null;                            // Cowork-Base
}
export interface FrameInput { height: number; oid: string; draft: BoardDraft; csPaths: ReadonlyMap<string, readonly string[]>; code: FrameCode; malformed: boolean; }

/** The fold's `self` when the room's own peer id is unknown (R-V46). */
export const ZERO_PEER = '00000000000000000000000000000000';

/**
 * Exactly Plan 2's BoardDraft fields, every array and record copied so the draft never aliases its input. liveCode must
 * be an object id (parseOid; it throws otherwise).
 */
export function toDraft(o: { liveCode: string; writer: WriterId | null; cs: readonly CsTrailer[]; protocol: ProtocolJson; opsLines: readonly string[];
                             checkpoint: Buffer | null; heldIds: readonly string[] }): BoardDraft {
  const d: BoardDraft = {
    liveCode: parseOid(o.liveCode),
    writer: o.writer === null ? null : { peer: o.writer.peer, epoch: o.writer.epoch, seq: o.writer.seq },
    cs: o.cs.map((c) => ({ csId: c.csId, state: c.state, seq: c.seq, origin: c.origin, checks: c.checks, paths: c.paths })),
    protocol: { proto: o.protocol.proto, regionSpec: o.protocol.regionSpec, budget: o.protocol.budget, G_s: o.protocol.G_s, S_s: o.protocol.S_s },
    opsLines: [...o.opsLines],
    checkpoint: o.checkpoint,
    heldIds: [...o.heldIds],
  };
  return d;
}

/** R-V19: the no-op draft of an unreadable board commit: writer null, no ops, no trailers, heldIds [], checkpoint null, prev's protocol and liveCode. */
export function noopDraft(prev: Pick<BoardDraft, 'protocol' | 'liveCode'>): BoardDraft {
  return toDraft({ liveCode: prev.liveCode, writer: null, cs: [], protocol: prev.protocol, opsLines: [], checkpoint: null, heldIds: [] });
}

/**
 * foldCommit(prev, draft, self) as one frame (12 §3.3.3, §3.3.4) — the only place a frame calls foldCommit. before is prev
 * itself; ops come from the fold's opVerdicts, with op = parseOpLine(line) for every line the fold parsed (opId ≠ null) and
 * null otherwise. code: changed is false at height 0 (the genesis L0 is never a change) and its shape is kept; at later heights
 * an unchanged frame's shape is not read (null). checkpoint (PRO-28): at a height divisible by 256 whose draft carries one,
 * 'match' when its bytes equal serializeFold(after), else 'mismatch' — display-only: after is always the viewer's own fold, so
 * later frames never fold from a checkpoint (the owner's 2026-10-08 choice withdrew the X-92 re-seed). Only the fold's state and
 * verdicts are read, so the frame does not depend on `self` beyond them (R-V04). x.height must be prev.height + 1.
 */
export function foldFrame(prev: FoldState, x: FrameInput, self: PeerId): Frame {
  if (x.height !== prev.height + 1) throw new RangeError(`foldFrame: a frame at height ${x.height} does not follow a state at height ${prev.height}`);
  const r = foldCommit(prev, x.draft, self);
  const after = r.state;
  const cp = x.draft.checkpoint;
  const checkpoint: Frame['checkpoint'] = cp !== null && x.height % CHECKPOINT_EVERY === 0 ? (serializeFold(after).equals(cp) ? 'match' : 'mismatch') : null;
  const ops: Frame['ops'] = r.opVerdicts.map((v) => {
    const op = v.opId === null ? null : parseOpLine(x.draft.opsLines[v.line]!);
    return { line: v.line, type: v.type, op: op === null ? null : (op as unknown as Json), verdict: v.verdict };
  });
  const code: FrameCode = x.height === 0
    ? { changed: false, shape: x.code.shape, seats: [...x.code.seats], base: x.code.base }
    : { changed: x.code.changed, shape: x.code.changed ? x.code.shape : null, seats: [...x.code.seats], base: x.code.base };
  const w = x.draft.writer;
  return {
    height: x.height,
    oid: x.oid,
    writer: w === null ? null : { peer: w.peer, epoch: w.epoch, seq: w.seq },
    cs: x.draft.cs.map((c) => ({ ...c })),
    csPaths: x.csPaths,
    code,
    ops,
    before: prev,
    after,
    protoMismatch: r.protoMismatch,
    checkpoint,
    malformed: x.malformed,
  };
}
