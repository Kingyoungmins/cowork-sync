// The board mirror of a hold record (glossary §7, §9; 05-holds HLD-04, HLD-10, HLD-62; 02-protocol PRO-21 writer side,
// PRO-24; rulings R3-24…R3-29). Pure: the record → `hold` op projection, its held/<hold_id>/<stage>/<path> blobs, the
// mirror key the engine compares (R3-26: durability without a mirrored-rev field), the R3-25 emission rule, the R3-29
// creation delay, the PRO-21 writer check and the HLD-62 durability test. Engine facts (the iteration's scope, the fold,
// the tip's held/ tree) arrive as parameters; this module reads no git and no claim state (HLD-06).
import { createHash } from 'node:crypto';
import type { HeldBlob } from '../board/boardCommit.js';
import { canonicalJson, type Json } from '../board/canonicalJson.js';
import type { FoldedHold } from '../board/fold.js';
import { formatOpId } from '../board/ids.js';
import { parseOpLine, type HoldOp } from '../board/ops.js';
import { ABSENT, type Oid } from '../git/oid.js';
import { blobAt, guardName, isTerminal, type BlobMap, type HoldRecord } from './record.js';
import type { MirrorRejectReason } from './registry.js';

/** HLD-10/HLD-54, R3-29: a not-applicable INCOMING record's creation op waits until the record is this old. */
const CREATION_DELAY_MS = 60_000;
/** The guards of INCOMING records created at once for a not-applicable path (HLD-54, R3-31): their creation op waits (R3-29). */
const NOT_APPLICABLE_GUARDS: ReadonlySet<string> = new Set(['unmaterializable', 'collision', 'quarantine-review']);
/** The stages a held/<id>/ subtree may hold, in the board's order (boardCommit.ts heldOrder). */
const STAGES: readonly HeldBlob['stage'][] = ['h0', 'h1', 's1', 's2', 's3'];
/** The widest op id any writer can give a draft (16-digit seq): sizing a line under it bounds the real line (outbox.ts does the same). */
const WIDEST_ID = formatOpId({ peer: '0'.repeat(32), epoch: '0'.repeat(32), seq: Number.MAX_SAFE_INTEGER });

/**
 * The glossary §7 `hold` op of record r at its current rev (R3-24): exactly the §7 fields, the guards as `{name, class,
 * owner}` copies (an unknown name included, HLD-05); a local_only record is the content-free stub (its paths, no oid: an op
 * never carries one). `declines`, `displaced_by`, `blobs`, `age_anchor` and `owner` are not in it. `rev` is the registry's
 * rev, raised to prevRev + 1 when the board's rev has run ahead of the registry's (a planted or re-anchored chain, R3-27,
 * PRO-25), so the op always parses (prev_rev < rev).
 */
export function projectOp(r: HoldRecord, prevRev: number | null): Omit<HoldOp, 'id'> {
  return {
    type: 'hold', hold_id: r.id, rev: prevRev === null ? r.rev : Math.max(r.rev, prevRev + 1), prev_rev: prevRev,
    kind: r.kind, residence: r.residence, state: r.state, offer: r.offer,
    guards: r.guards.map((g) => ({ name: g.name, class: g.class, owner: g.owner })),
    paths: [...r.paths], origin: r.origin, cs_ids: [...r.cs_ids], peer_authors: [...r.peer_authors], local_only: r.local_only,
  };
}

const byUtf8 = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** Stage order, then the repo path by UTF-8 bytes (git's order; the order readHeldAll returns). */
function heldOrder(a: HeldBlob, b: HeldBlob): number {
  return a.stage === b.stage ? byUtf8(a.path, b.path) : STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage);
}

/**
 * held/<id>/<stage>/<path> blobs of a non-local_only record (HLD-04): every stage of its blob maps (h0/h1, or s1/s2/s3 for a
 * stage record), one entry per path whose side is a blob — never one for an ABSENT side; [] for a local_only record (D-12,
 * D-19) and for the pathless host-reject PIN (R3-56). In the board's order.
 */
export function heldBlobs(r: HoldRecord): HeldBlob[] {
  if (r.local_only) return [];
  const maps: Array<[HeldBlob['stage'], BlobMap]> = 'h1' in r.blobs ? [['h0', r.blobs.h0], ['h1', r.blobs.h1]] : [['s1', r.blobs.s1], ['s2', r.blobs.s2], ['s3', r.blobs.s3]];
  const out: HeldBlob[] = [];
  for (const [stage, m] of maps) {
    for (const path of r.paths) {
      const oid = blobAt(m, path);
      if (oid !== undefined && oid !== ABSENT) out.push({ stage, path, oid: oid as Oid });
    }
  }
  return out.sort(heldOrder);
}

/** The projection's fields every rev shares (no rev/prev_rev), canonical. */
function projectionKey(op: Omit<HoldOp, 'id'> | FoldedHold): string {
  const { kind, residence, state, offer, guards, paths, origin, cs_ids: csIds, peer_authors: authors, local_only: localOnly } = op;
  return canonicalJson({
    kind, residence, state, offer, guards: guards.map((g) => ({ name: g.name, class: g.class, owner: g.owner })), paths, origin,
    cs_ids: csIds, peer_authors: authors, local_only: localOnly,
  } as unknown as Json);
}

/** A held/ list as canonical text (sorted: the tip's list compares as a set of entries). */
function heldKey(blobs: readonly HeldBlob[]): string {
  return canonicalJson([...blobs].sort(heldOrder).map((b) => ({ stage: b.stage, path: b.path, oid: b.oid })) as unknown as Json);
}

/**
 * Digest of the projection without rev/prev_rev plus heldBlobs(r) (R3-26): what the board must show for r to be durable.
 * A change of age_anchor, declines, displaced_by or rev alone leaves it unchanged (R3-25). SHA-256 hex.
 */
export function mirrorKey(r: HoldRecord): string {
  return createHash('sha256').update(`${projectionKey(projectOp(r, null))}\n${heldKey(heldBlobs(r))}`, 'utf8').digest('hex');
}

/**
 * HLD-10 + R3-25: a revision is mirror-worthy when it creates the record or changes what the mirror shows — residence,
 * state, offer, the guard set, the held side (h1, or s2 of a stage record) or local_only (and the other op fields: paths,
 * cs_ids, peer_authors, origin, kind); never a change of age_anchor, declines, displaced_by or rev alone. Exactly
 * "mirrorKey changed", the rule mirrorSync drafts by.
 */
export function mirrorWorthy(prev: HoldRecord | null, next: HoldRecord): boolean {
  return prev === null || mirrorKey(prev) !== mirrorKey(next);
}

/**
 * HLD-10/HLD-54, R3-29: an INCOMING record created at once for a not-applicable path (guard `unmaterializable`, `collision`
 * or `quarantine-review`) has its creation op due only at age ≥ 60 s; every other record — closure INCOMING records (`lock`,
 * `eol-form`, `local-only-conflict`) and `unreadable`/`unstable` PINs, which are created only after their condition
 * persisted 60 s, included — is due at once. Only the creation op waits (the caller asks only for a creation).
 */
export function creationDue(r: HoldRecord, ageMs: number): boolean {
  const waits = r.kind === 'INCOMING' && r.guards.some((g) => NOT_APPLICABLE_GUARDS.has(guardName(g)));
  return !waits || ageMs >= CREATION_DELAY_MS;
}

/**
 * PRO-21 writer check (SEC-09 serializer form), before anything is pushed: a non-local_only record names only LIVE paths
 * (else it must be the stub: 'local_only_stub'); a non-terminal, non-local_only record with paths has a held/ subtree to
 * put (else 'held_subtree': the fold would refuse it); the op line, sized under the widest op id with the widest rev and
 * prev_rev, parses within 16 KiB (else 'validator', R3-25: a deterministic local rejection, never pushed). A local_only
 * record over a non-LIVE path is fine: it mirrors as the stub.
 */
export function checkMirror(r: HoldRecord, live: (path: string) => boolean): { ok: true } | { ok: false; reason: MirrorRejectReason } {
  if (!r.local_only && r.paths.some((p) => !live(p))) return { ok: false, reason: 'local_only_stub' };
  if (!r.local_only && !isTerminal(r) && r.paths.length > 0 && heldBlobs(r).length === 0) return { ok: false, reason: 'held_subtree' };
  const widest = { ...projectOp(r, null), rev: Number.MAX_SAFE_INTEGER, prev_rev: Number.MAX_SAFE_INTEGER - 1, id: WIDEST_ID };
  let line: string;
  try {
    line = canonicalJson(widest as unknown as Json);
  } catch {
    return { ok: false, reason: 'validator' };
  }
  return parseOpLine(line) === null ? { ok: false, reason: 'validator' } : { ok: true };
}

/**
 * HLD-62 / R3-26: r is DURABLE when the fold of the fetched board tip holds an entry equal to r's projection (every field but
 * rev/prev_rev; an older folded rev after an age flush counts) and the tip's held/<id>/ entries equal heldBlobs(r) (tipHeld
 * null counts as [], so the pathless host-reject PIN is durable on its folded entry alone). A local_only record is never
 * durable (HLD-62).
 */
export function isDurable(r: HoldRecord, folded: FoldedHold | undefined, tipHeld: readonly HeldBlob[] | null): boolean {
  return !r.local_only && mirrorShown(r, folded, tipHeld);
}

/**
 * The board shows r's mirror key (R3-26): the folded entry equals r's projection (every field but rev/prev_rev) and the tip's
 * held/<id>/ entries equal heldBlobs(r) (tipHeld null counts as []; for a local_only stub, no held/<id>/ at all). isDurable
 * without HLD-62's local_only rule: what mirrorSync compares, so a folded stub is not re-mirrored although it is never durable.
 */
export function mirrorShown(r: HoldRecord, folded: FoldedHold | undefined, tipHeld: readonly HeldBlob[] | null): boolean {
  if (folded === undefined) return false;
  if (projectionKey(folded) !== projectionKey(projectOp(r, null))) return false;
  return heldKey(tipHeld ?? []) === heldKey(heldBlobs(r));
}
