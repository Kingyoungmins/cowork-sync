// Shared helpers of the F10 revert kernel tests (Plan 3 Task 17): a human change-set of a peer captured and published by the
// engine's own steps, a teammate's change applied, a live commit of this peer crafted under another (retired) epoch, and the
// confirmed revert write the way Plan 7's confirm makes it (Algorithm REV step 8: hash-object -w of each result, one
// writeLocalGroup with origin `revert:<of>` and the digested disk blobs as expected values, then openRevertCs). Real clones of
// one file:// remote; git is never mocked.
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { buildBoardCommit, CODE_SUBJECT, liveCommitTrailers, type CsTrailer } from '../../src/board/boardCommit.js';
import type { OpDraft } from '../../src/board/ops.js';
import { applyStep, type ApplyReport } from '../../src/engine/apply.js';
import { joinDraft } from '../../src/engine/core.js';
import { captureStep } from '../../src/engine/csStep.js';
import { publishStep, type PublishReport } from '../../src/engine/publish.js';
import { fetchRefs } from '../../src/git/fetch.js';
import { ABSENT, type Oid, type OidOrAbsent } from '../../src/git/oid.js';
import { pushSpec, runPush } from '../../src/git/push.js';
import { GitRepo, type FileMode, type IndexEdit, type RepoContext } from '../../src/git/repo.js';
import { openRevertCs, type RevertResult } from '../../src/holds/revertCs.js';
import { clonePeer } from '../sim/peers.js';
import { writeWork, workPath, type CoreFixture, type PeerFixture } from './coreFixture.js';
import { buf, prep } from './publishHelpers.js';
import { testRunner } from './tmp.js';

export const T10 = { timeout: 10 * 60_000 };

/** A human edit (null deletes) of peer p closed by its 20 s quiet period and captured by captureStep (a deletion read twice ≥ 1 s apart). */
export async function humanCapture(fx: CoreFixture, p: PeerFixture, files: Readonly<Record<string, string | Buffer | null>>): Promise<string[]> {
  for (const [path, bytes] of Object.entries(files)) {
    if (bytes === null) await unlink(workPath(p, path));
    else await writeWork(p, path, bytes);
  }
  await prep(p);
  if (Object.values(files).some((b) => b === null)) {
    fx.advance(1_500);
    await prep(p);
  }
  fx.advance(20_000);
  const it = await prep(p, true);
  return (await captureStep(p.core, it)).captured;
}

/** publishStep in a fresh window (6 s later). */
export async function publishNow(fx: CoreFixture, p: PeerFixture): Promise<PublishReport> {
  fx.advance(6_000);
  return publishStep(p.core, await prep(p));
}

/** humanCapture, then a landed publish: the CS id and its live commit. */
export async function humanCs(fx: CoreFixture, p: PeerFixture, files: Readonly<Record<string, string | Buffer | null>>): Promise<{ csId: string; live: Oid }> {
  const captured = await humanCapture(fx, p, files);
  assert.equal(captured.length, 1, `one CS captured: ${JSON.stringify(captured)}`);
  const r = await publishNow(fx, p);
  assert.equal(r.outcome, 'landed', JSON.stringify(r));
  return { csId: captured[0]!, live: r.c! };
}

/** The peer fetches and applies (10 s after its last apply). */
export async function applyNow(fx: CoreFixture, p: PeerFixture): Promise<ApplyReport> {
  fx.advance(10_000);
  const r = await applyStep(p.core, await prep(p));
  assert.ok(r.ran, `the apply ran: ${r.skipped ?? ''}`);
  return r;
}

/** The teammate (the fixture's synthetic writer) lands `changes` and peer p applies them. */
export async function teamApplied(fx: CoreFixture, p: PeerFixture, changes: Readonly<Record<string, string | Buffer | null>>, csId?: string): Promise<{ live: Oid; board: Oid }> {
  const r = await fx.pushTeamChange(Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v === null ? null : typeof v === 'string' ? buf(v) : v])),
    csId === undefined ? undefined : { csId });
  await applyNow(fx, p);
  return r;
}

const ghosts = new WeakMap<CoreFixture, GitRepo>();

/** A clone of its own for crafted commits (never a peer's core repository). */
async function ghostRepo(fx: CoreFixture): Promise<GitRepo> {
  const hit = ghosts.get(fx);
  if (hit !== undefined) return hit;
  const clone = await clonePeer(fx.remote, fx.root, { name: 'ghost', autocrlf: false, withFilter: false }, testRunner());
  const workTree = realpathSync.native(clone.dir);
  const paths = { workTree, gitDir: join(workTree, '.git'), coworkDir: join(workTree, '.git', 'cowork') };
  await mkdir(paths.coworkDir, { recursive: true });
  const ctx = (): RepoContext => ({ attrTree: null, filterDrivers: [], identity: { name: 'Ghost', email: 'ghost@cowork.invalid' }, wallMs: () => fx.peers[0]!.clock.wallMs() });
  const repo = new GitRepo(testRunner(), paths, ctx);
  ghosts.set(fx, repo);
  return repo;
}

/**
 * A live commit written as peer p under `epoch` (another epoch of p: a retired one, so p's fold record and seq counter are untouched)
 * with the given Cowork-CS trailers and Cowork-CS-Paths lists, carrying `changes` (null deletes) on top of the remote's live code, and its
 * board commit (no op), pushed with leases. The peer applies it like any teammate commit; its journal entry's writer is p.
 */
export async function pushAs(fx: CoreFixture, p: PeerFixture, o: {
  epoch: string; seq: number; cs: readonly CsTrailer[]; csPaths?: ReadonlyMap<string, readonly string[]>; changes: Readonly<Record<string, string | Buffer | null>>;
  modes?: Readonly<Record<string, FileMode>>;
}): Promise<{ live: Oid; board: Oid }> {
  const repo = await ghostRepo(fx);
  const refs = p.core.refs;
  const f = await fetchRefs(repo, fx.remote.url, refs.fetchSpecs);
  const T = f.values.get(refs.remoteBoard);
  assert.ok(f.ok && T !== undefined && T !== ABSENT, 'a board on the remote');
  const mirror: OidOrAbsent = f.values.get(refs.remoteCode) ?? ABSENT;
  const tip = (await repo.readCommit(T as Oid)).parents.at(-1)!;
  const tipTree = (await repo.readCommit(tip)).tree;
  const tipMap = await repo.readTreeMap(tipTree);
  const edits: IndexEdit[] = [];
  for (const [path, v] of Object.entries(o.changes)) {
    if (v === null) edits.push({ path, remove: true });
    else edits.push({ path, mode: o.modes?.[path] ?? tipMap.get(path)?.mode ?? '100644', oid: await repo.hashBytes(typeof v === 'string' ? buf(v) : v, true) });
  }
  const tree = await repo.editTree(tipTree, edits, join(repo.paths.gitDir, 'ghost.index'));
  const writer = { peer: p.core.peerId, epoch: o.epoch, seq: o.seq };
  const live = await repo.commitTree({ tree, parents: [tip], subject: CODE_SUBJECT, trailers: liveCommitTrailers(writer, ['human'], o.cs, o.csPaths ?? new Map(), null) });
  const board = await buildBoardCommit(repo, { prevBoard: T as Oid, liveCode: live, writer, ops: [], cs: [...o.cs], csPaths: o.csPaths ?? new Map(), protocol: null, checkpoint: null });
  const out = await runPush(repo, fx.remote.url, [pushSpec(board, refs.remoteBoard, T as Oid), pushSpec(live, refs.remoteCode, mirror)], []);
  assert.equal(out.statuses.get(refs.remoteBoard), 'ok', `the crafted push landed (exit ${out.code})`);
  return { live, board };
}

/**
 * The core fixture creates every peer's state without the join procedure, so a peer other than the first has no join op on the board
 * and no display name in any fold: queue the join draft of its epoch (glossary §7), which rides its next publish (as after a join).
 */
export async function announce(p: PeerFixture): Promise<void> {
  p.core.outbox.add((await joinDraft(p.core)) as OpDraft);
}

/** One Cowork-CS trailer (closed, human). */
export function csTrailer(csId: string, paths: number, o: { state?: 'closed' | 'checkpoint'; seq?: number } = {}): CsTrailer {
  return { csId, state: o.state ?? 'closed', seq: o.seq ?? 1, origin: 'human', checks: 'skipped', paths };
}

/**
 * Plan 7's confirm, as Algorithm REV step 8 orders it: `hash-object -w` of each result (§8 Q17 (b)), one writeLocalGroup with origin
 * `revert:<of>` and the digested disk blobs as expected values (human evidence), and on WRITTEN openRevertCs(core, of, written).
 */
export async function confirmRevert(p: PeerFixture, of: string, r: RevertResult): Promise<{ cs: string; written: Map<string, Oid | 'ABSENT'> }> {
  const core = p.core;
  const written = new Map<string, Oid | 'ABSENT'>();
  const entries: Array<{ path: string; expected: OidOrAbsent; target: Oid | 'DELETE' }> = [];
  for (const row of r.paths) {
    const res = r.results.get(row.path)!;
    const oid = res === ABSENT ? ABSENT : await core.repo.hashBytes(res, true);
    written.set(row.path, oid);
    entries.push({ path: row.path, expected: row.disk, target: oid === ABSENT ? 'DELETE' : oid });
  }
  const w = await core.writer.writeLocalGroup(entries, `revert:${of}`, true);
  assert.equal(w.kind, 'WRITTEN', JSON.stringify(w));
  return { cs: await openRevertCs(core, of, written), written };
}
