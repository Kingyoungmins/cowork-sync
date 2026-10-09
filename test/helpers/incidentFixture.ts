// Shared helpers of the incident and recover tests (Plan 2 Task 16): one loop iteration composed the way Task 17's
// Engine.iterate composes steps 1–6 (prepareIteration, enterIncident / clearIncidentIfHealed, applyStep, publishStep),
// board and live commits built with the Task 5 builders by test code (a rewrite, a jumped last parent, a fork), remote
// refs set with plain leased pushes or update-ref on the bare remote, and reads of the displaced and incident refs.
// Git is never mocked.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildBoardCommit, CODE_SUBJECT, liveCommitTrailers, type WriterId } from '../../src/board/boardCommit.js';
import { newEpoch, newPeerId, type PeerId } from '../../src/board/ids.js';
import type { Op } from '../../src/board/ops.js';
import { applyStep, type ApplyReport } from '../../src/engine/apply.js';
import { prepareIteration, type IterationCtx } from '../../src/engine/core.js';
import { PLAN2_REGION_SPEC } from '../../src/engine/deps.js';
import { publishStep, resolvePushIntent, type PublishReport } from '../../src/engine/publish.js';
import { clearIncidentIfHealed, enterIncident } from '../../src/engine/recover.js';
import type { Oid } from '../../src/git/oid.js';
import { KilledAt } from '../../src/ports/crashpoint.js';
import type { LogLevel, LogParam } from '../../src/ports/log.js';
import { seededRandom } from '../../src/ports/random.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import type { CoreFixture, PeerFixture } from './coreFixture.js';
import { LogRecorder } from './publishHelpers.js';
import { gitIn, gitRemote } from './startFixture.js';

let iteration = 5_000;

export interface Poll {
  incident: boolean;
  why: string | null;
  cleared: boolean;
  it: IterationCtx | null;
  apply: ApplyReport | null;
  publish: PublishReport | null;
}

/**
 * One loop iteration as Task 17's iterate composes it (steps 1–6): prepareIteration with a fresh fetch; the incident
 * branch enters (or keeps) the incident and stops; otherwise clearIncidentIfHealed, a kept push intent resolved first
 * (P2-PUSHINTENT-FIRST), applyStep, publishStep.
 */
export async function poll(p: PeerFixture): Promise<Poll> {
  const r = await prepareIteration(p.core, ++iteration, { materialize: 'auto', forceFetch: true });
  if (!r.ok) {
    assert.equal(r.why, 'incident', `${p.name}: prepareIteration failed with ${r.why}`);
    if (r.why !== 'incident') throw new Error('unreachable');
    await enterIncident(p.core, r.verdict, r.T);
    return { incident: true, why: r.verdict.why, cleared: false, it: null, apply: null, publish: null };
  }
  const it = r.it;
  const cleared = await clearIncidentIfHealed(p.core, it);
  if (p.core.view!.intent.kind === 'push') await resolvePushIntent(p.core, it);
  const apply = await applyStep(p.core, it);
  const publish = await publishStep(p.core, it);
  return { incident: false, why: null, cleared, it, apply, publish };
}

/** The peer's freeze reasons include INCIDENT. */
export function inIncident(p: PeerFixture): boolean {
  return p.core.view!.meta.freeze_reasons.includes('INCIDENT');
}

/** The apply coalescing window (10 s) passed, then one prepared iteration and its apply: the peer catches up with the board. */
export async function catchUp(fx: CoreFixture, p: PeerFixture): Promise<void> {
  fx.advance(10_000);
  const r = await poll(p);
  assert.equal(r.incident, false, `${p.name}: unexpected incident while catching up`);
  assert.equal(p.core.view!.laB, r.it!.T, `${p.name}: LA_B follows the board`);
}

const writers = new Map<string, () => WriterId>();

/** A writer id of a synthetic test writer (its own peer id and epoch per label), seq incremented per call. */
export function testWriter(label: string): WriterId {
  let next = writers.get(label);
  if (next === undefined) {
    const r = seededRandom(`incident-writer/${label}`);
    const peer = newPeerId(r);
    const epoch = newEpoch(r);
    let seq = 0;
    next = () => ({ peer, epoch, seq: ++seq });
    writers.set(label, next);
  }
  return next();
}

/** A live code commit (glossary §5 markers) with the given parents and tree (default: the first parent's tree). */
export async function liveOn(p: PeerFixture, parents: readonly Oid[], tree?: Oid): Promise<Oid> {
  const repo = p.core.repo;
  const t = tree ?? (await repo.readCommit(parents[0]!)).tree;
  return repo.commitTree({ tree: t, parents: [...parents], subject: CODE_SUBJECT, trailers: liveCommitTrailers(testWriter('live'), ['human'], [], new Map(), null) });
}

/** A board commit [prev, live] with no ops (Task 5 builder; heights here are far below a checkpoint height). */
export async function boardOn(p: PeerFixture, prev: Oid, live: Oid): Promise<Oid> {
  return buildBoardCommit(p.core.repo, { prevBoard: prev, liveCode: live, writer: testWriter('board'), ops: [], cs: [], csPaths: new Map(), protocol: null, checkpoint: null });
}

/** The live code commit of a board commit (its last parent). */
export async function liveOf(p: PeerFixture, board: Oid): Promise<Oid> {
  const c = await p.core.repo.readCommit(board);
  return c.parents[c.parents.length - 1]!;
}

/**
 * A board-only commit on `prev` (its live code repeats prev's) carrying one join op of a new synthetic teammate named
 * `display` (its own peer id and epoch; writer seq 2 over op seq 1, the bootstrap's form). The fold adds that peer.
 */
export async function joinBoard(p: PeerFixture, prev: Oid, display: string): Promise<{ board: Oid; peer: PeerId }> {
  const r = seededRandom(`incident-join/${display}`);
  const peer = newPeerId(r);
  const epoch = newEpoch(r);
  const ops: Op[] = [{
    id: `${peer}/${epoch}/1`, type: 'join', display, plugin_version: PLUGIN_VERSION, plugin_sha: 'f'.repeat(64), proto: 1,
    regionSpec: PLAN2_REGION_SPEC, config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '' }, coauthor_optin: false,
  }];
  const board = await buildBoardCommit(p.core.repo, {
    prevBoard: prev, liveCode: await liveOf(p, prev), writer: { peer, epoch, seq: 2 }, ops, cs: [], csPaths: new Map(), protocol: null, checkpoint: null,
  });
  return { board, peer };
}

/** recover's own copy of the observed V number k: displaced/<peer>/v-<k> (Task 16 fix-round ruling). */
export function vCopyRef(p: PeerFixture, k: number): string {
  return `${p.core.refs.displacedPrefix}${p.core.peerId}/v-${k}`;
}

/** The peer's local copies of the remote's displaced refs (refs/cowork-remote/<e>/displaced/*). */
export async function localDisplaced(p: PeerFixture): Promise<string[]> {
  return (await p.core.repo.listRefs(`refs/cowork-remote/${p.core.refs.e}/displaced/`)).map((r) => r.ref);
}

/**
 * Adds refs to the bare remote's packed-refs file (test code): names git accepts that a file system may refuse to hold as
 * loose ref files (e.g. `x|y` on Windows). The file keeps git's sorted form.
 */
export async function addPackedRefs(fx: CoreFixture, refs: Readonly<Record<string, Oid>>): Promise<void> {
  const file = join(fx.remote.dir, 'packed-refs');
  let text = '';
  try {
    text = (await readFile(file)).toString('utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const entries = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line.length === 0 || line.startsWith('#')) continue;
    assert.ok(!line.startsWith('^'), 'addPackedRefs: no peeled tags expected in the test remote');
    const sp = line.indexOf(' ');
    entries.set(line.slice(sp + 1), line.slice(0, sp));
  }
  for (const [ref, oid] of Object.entries(refs)) entries.set(ref, oid);
  const body = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([ref, oid]) => `${oid} ${ref}\n`).join('');
  await writeFile(file, `# pack-refs with: peeled fully-peeled sorted \n${body}`);
}

/** A log that records every line and dies (KilledAt) right after the line `code`: the process killed at that point. */
export class KillAfterLog extends LogRecorder {
  constructor(private readonly code: string) {
    super();
  }

  override write(level: LogLevel, code: string, params?: Readonly<Record<string, LogParam>>): void {
    super.write(level, code, params);
    if (code === this.code) throw new KilledAt(`log:${code}`);
  }
}

/**
 * Sets a remote ref to `to` (objects pushed from the peer's clone) with a lease on its current value; null deletes it on
 * the bare remote. Test code's own git (gitIn), outside the peer's recorded runner, so push counts stay the engine's.
 */
export async function forceRemote(fx: CoreFixture, p: PeerFixture, ref: string, to: Oid | null): Promise<void> {
  if (to === null) {
    await gitRemote(fx, ['update-ref', '-d', ref]);
    return;
  }
  const cur = (await fx.remote.refs())[ref] ?? '';
  await gitIn(p, ['push', '--porcelain', '--no-verify', `--force-with-lease=${ref}:${cur}`, fx.remote.url, `${to}:${ref}`]);
  assert.equal((await fx.remote.refs())[ref], to, `forceRemote ${ref}`);
}

/** The remote's displaced refs: ref → oid. */
export async function remoteDisplaced(fx: CoreFixture, p: PeerFixture): Promise<Record<string, string>> {
  const all = await fx.remote.refs();
  return Object.fromEntries(Object.entries(all).filter(([r]) => r.startsWith(p.core.refs.displacedPrefix)));
}

/** Every git push the peer's runner spawned so far. */
export function pushSpawnsOf(calls: ReadonlyArray<{ args: readonly string[] }>): number {
  return calls.filter((c) => c.args[0] === 'push').length;
}
