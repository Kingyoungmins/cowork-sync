// Builders for hand-written scene events and board drafts (Plan 8a Task 4; 12 §3.3.7). Every BoardDraft a viz test
// builds goes through toDraft (R-V02), so a later BoardDraft change has one call site.
import type { BoardDraft, WriterId } from '../../src/board/boardCommit.js';
import { genesisProtocol, type ProtocolJson } from '../../src/board/protocol.js';
import type { Oid } from '../../src/git/oid.js';
import type { SceneEvent, SceneEventKind } from '../../src/viz/model/events.js';
import { toDraft } from '../../src/viz/model/frame.js';

/**
 * The member of the SceneEvent union whose kind set contains K. A plain Extract<SceneEvent, { kind: K }> is never
 * for the grouped kinds ('person_enter' | 'person_respawn' | …, 'pet_spawn' | 'pet_poof', …), so ev() distributes.
 */
export type EventOf<K extends SceneEventKind> = SceneEvent extends infer E ? (E extends { kind: infer EK } ? (K extends EK ? E : never) : never) : never;

/** A scene event at the position [height, sub, k] with seed 0 (a hand-written event has no op id or writer to seed from). */
export function ev<K extends SceneEventKind>(kind: K, at: [number, number, number], fields: Omit<EventOf<K>, 'kind' | 'height' | 'sub' | 'k' | 'seed'>): SceneEvent {
  const [height, sub, k] = at;
  return { height, sub, k, seed: 0, kind, ...fields } as unknown as SceneEvent;
}

/** The protocol and live commit a draft() gets when the test names none. */
export const DRAFT_PROTOCOL: ProtocolJson = genesisProtocol(12, 'rs-1');
export const DRAFT_LIVE_CODE = '1'.repeat(40) as Oid;

/** A BoardDraft through toDraft: the fields the test leaves out are no ops, no trailers, no checkpoint, no held ids. */
export function draft(o: Partial<BoardDraft> & { writer: WriterId | null }): BoardDraft {
  return toDraft({
    liveCode: o.liveCode ?? DRAFT_LIVE_CODE,
    writer: o.writer,
    cs: o.cs ?? [],
    protocol: o.protocol ?? DRAFT_PROTOCOL,
    opsLines: o.opsLines ?? [],
    checkpoint: o.checkpoint ?? null,
    heldIds: o.heldIds ?? [],
  });
}
