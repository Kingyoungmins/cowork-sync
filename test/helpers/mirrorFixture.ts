// Shared helpers of the hold-mirror tests (Plan 3 Task 4): publish windows past the governor, the hold ops and held/
// subtrees of board commits, hold records made with hold() over the peer's A, the durability of a record against the fold
// and the tip of the newest prepared iteration, a test-written board commit under the peer's own writer id (the "planted"
// op of the R3-27 races and the PRO-24 validator case), and Plan 2's loop composition for the long tests (makeEngines and
// Engine.iterate do not exist on this base: Plan 2 Tasks 17–20, R3-72). Git is never mocked.
import assert from 'node:assert/strict';
import { BOARD_SUBJECT, boardTrailers, readBoardCommit, readHeld, type HeldBlob, type WriterId } from '../../src/board/boardCommit.js';
import { canonicalJson, type Json } from '../../src/board/canonicalJson.js';
import { parseOpLine, type HoldOp } from '../../src/board/ops.js';
import { applyStep } from '../../src/engine/apply.js';
import { captureDue, tickInputOf, type IterationCtx } from '../../src/engine/core.js';
import { heldOfTip, publishStep, type PublishReport } from '../../src/engine/publish.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import type { MktreeEntry } from '../../src/git/repo.js';
import { pushSpec, runPush } from '../../src/git/push.js';
import { isDurable } from '../../src/holds/mirror.js';
import type { HoldBlobs } from '../../src/holds/record.js';
import type { CoreFixture, PeerFixture } from './coreFixture.js';
import { buf, prep, stateA } from './publishHelpers.js';

/** Advances past the governor window (G = 5 s at budget 12) and runs one prepared iteration's publishStep. */
export async function win(fx: CoreFixture, p: PeerFixture, advanceMs = 6_000): Promise<{ it: IterationCtx; r: PublishReport }> {
  fx.advance(advanceMs);
  const it = await prep(p);
  return { it, r: await publishStep(p.core, it) };
}

/** The `hold` ops of one board commit, in ops.jsonl order. */
export async function holdOpsOf(p: PeerFixture, board: Oid): Promise<HoldOp[]> {
  const b = await readBoardCommit(p.core.repo, board);
  return b.opsLines.map((l) => parseOpLine(l)).filter((o): o is HoldOp => o !== null && o.type === 'hold');
}

/** The held/<id>/ entries of a board commit (null when absent). */
export function heldIn(p: PeerFixture, board: Oid, id: string): Promise<HeldBlob[] | null> {
  return readHeld(p.core.repo, board, id);
}

/** The remote board tip. */
export async function remoteTip(fx: CoreFixture, p: PeerFixture): Promise<Oid> {
  const b = (await fx.remote.refs())[p.core.refs.remoteBoard];
  assert.ok(b !== undefined, 'a remote board');
  return b as Oid;
}

/** Every board commit after `from` up to `to` on to's first-parent chain, oldest first. */
export async function boardsSince(p: PeerFixture, from: Oid, to: Oid): Promise<Oid[]> {
  return (await p.core.repo.firstParents(to, from, 100_000)).reverse();
}

/** Every hold op of the board commits after `from` up to `to`, oldest first, with the commit carrying it. */
export async function holdOpsSince(p: PeerFixture, from: Oid, to: Oid): Promise<Array<{ board: Oid; op: HoldOp }>> {
  const out: Array<{ board: Oid; op: HoldOp }> = [];
  for (const b of await boardsSince(p, from, to)) for (const op of await holdOpsOf(p, b)) out.push({ board: b, op });
  return out;
}

/** An ON_DISK ACTIVE PATCH over `path` (h0 = A[path], h1 = `held`, stored by route (c)) with `guard`; the registry computes local_only. */
export async function holdPatch(p: PeerFixture, path: string, held: string | Buffer, guard = 'revert'): Promise<{ id: string; h0: Oid | typeof ABSENT; h1: Oid }> {
  const A = await stateA(p);
  const h0 = A.get(path)?.oid ?? ABSENT;
  const h1 = await p.core.repo.hashBytes(typeof held === 'string' ? buf(held) : held, true);
  const blobs: HoldBlobs = { h0: { [path]: h0 }, h1: { [path]: h1 } };
  const id = await p.core.holds.hold({ kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: [path], blobs, guard, origin: 'human', cs_ids: [], displaced_by: null });
  return { id, h0, h1 };
}

/** isDurable of record `id` against the fold and the board tip of the iteration `it` (R3-26). */
export async function durableAt(p: PeerFixture, it: IterationCtx, id: string): Promise<boolean> {
  const r = p.core.holds.get(id);
  assert.ok(r !== undefined, `record ${id}`);
  const folded = Object.hasOwn(it.fold.holds, id) ? it.fold.holds[id] : undefined;
  const tip = it.T === ABSENT ? new Map<string, readonly HeldBlob[]>() : await heldOfTip(p.core, it.T);
  return isDurable(r, folded, tip.get(id) ?? null);
}

/** A fresh prepared iteration (forced fetch) and the durability of `id` there. */
export async function durableNow(p: PeerFixture, id: string): Promise<boolean> {
  return durableAt(p, await prep(p), id);
}

/**
 * A board commit written by test code under the peer's OWN writer id (its peer and epoch, the next free seqs) on the remote
 * board tip, carrying `lines` as its ops.jsonl verbatim (a malformed line included), protocol.json, checkpoint/ and held/
 * carried by oid, board-only (live code = TIP), pushed leased (the push is this peer's runner's: pushCalls counts it). `lines`
 * receives each line's op id. Returns the new board.
 */
export async function plantOwn(fx: CoreFixture, p: PeerFixture, it: IterationCtx, lines: (opId: (k: number) => string) => string[]): Promise<Oid> {
  const repo = p.core.repo;
  const view = p.core.view!;
  const self = { peer: p.core.peerId, epoch: view.meta.epoch };
  const rec = it.fold.peers[self.peer];
  const first = Math.max(view.meta.seq_next, p.core.outbox.maxOwnSeq(self) + 1, (rec !== undefined && rec.epoch === self.epoch ? rec.last_seq : 0) + 1);
  let used = 0;
  const opsLines = lines((k) => {
    used = Math.max(used, k + 1);
    return `${self.peer}/${self.epoch}/${first + k}`;
  });
  const writer: WriterId = { ...self, seq: first + Math.max(used, 1) };
  const T = await remoteTip(fx, p);
  const top = (await repo.run(['ls-tree', '-z', `${T}^{tree}`])).stdout.toString('utf8').split('\0').filter((l) => l.length > 0);
  const entries: MktreeEntry[] = [];
  for (const rec2 of top) {
    const tab = rec2.indexOf('\t');
    const [mode, type, oid] = rec2.slice(0, tab).split(' ') as [MktreeEntry['mode'], MktreeEntry['type'], Oid];
    const name = rec2.slice(tab + 1);
    if (name === 'protocol.json' || name === 'checkpoint' || name === 'held') entries.push({ name, mode, type, oid });
  }
  const ops = await repo.hashBytes(Buffer.from(opsLines.map((l) => `${l}\n`).join(''), 'utf8'), true);
  entries.push({ name: 'ops.jsonl', mode: '100644', type: 'blob', oid: ops });
  const tree = await repo.mktree(entries);
  const tip = (await readBoardCommit(repo, T)).liveCode;   // B0's parents are [L0]; every later board's are [prevBoard, liveCode]
  const B = await repo.commitTree({ tree, parents: [T, tip], subject: BOARD_SUBJECT, trailers: boardTrailers(writer, [], new Map()) });
  const out = await runPush(repo, fx.remote.url, [pushSpec(B, p.core.refs.remoteBoard, T)], []);
  assert.equal(out.statuses.get(p.core.refs.remoteBoard), 'ok', 'the planted board commit landed');
  return B;
}

/** A canonical op line: `fields` with `id`. */
export function opLine(id: string, fields: Record<string, unknown>): string {
  return canonicalJson({ ...fields, id } as unknown as Json);
}

/**
 * One loop iteration as Plan 2's iterate composes steps 1–6 for these tests (Engine.iterate is Plan 2 Task 17's, not on this
 * base): prepareIteration ('auto' materialize, a fresh fetch), the HLD-40 capture when due, applyStep, publishStep.
 */
export async function loopOnce(p: PeerFixture): Promise<{ it: IterationCtx; r: PublishReport }> {
  const it = await prep(p, 'auto');
  const core = p.core;
  if (captureDue(core)) {
    if (it.mat === null) it.mat = await core.snapshot.materialize(tickInputOf(core, it));
    const c = await core.cs.capture(core.repo, it.mat.sDiskMap, it.A, core.scratch('r'));
    if (c !== null) await core.commit({ ready: core.cs.ready(), meta: { ...core.view!.meta, cs_human_next: c.nextN } });
  }
  await applyStep(core, it);
  return { it, r: await publishStep(core, it) };
}
