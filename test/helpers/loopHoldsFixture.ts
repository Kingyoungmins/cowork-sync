// Shared helpers of the Plan 3 Task 12a loop tests (loop.holds, statusHolds, editcheckpoint.loop): status.json reads, the
// teammate-line scenario whose human removal the loop's revert detector holds, record queries and the remote's live files. Engines
// on real clones of one file:// remote (makeEngines); git is never mocked.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Engine } from '../../src/engine/loop.js';
import type { StartResult } from '../../src/engine/start.js';
import type { StatusJson } from '../../src/engine/status.js';
import type { Oid } from '../../src/git/oid.js';
import { guardName, type HoldRecord } from '../../src/holds/record.js';
import type { PeerFixture } from './coreFixture.js';
import { readWork, writeWork } from './coreFixture.js';
import type { EngineFixture } from './engineFixture.js';
import { remoteBoardTip } from './engineFixture.js';
import { liveOf } from './incidentFixture.js';
import { buf } from './publishHelpers.js';

export const T10 = { timeout: 10 * 60_000 };

export async function statusOf(p: PeerFixture): Promise<StatusJson> {
  return JSON.parse((await readFile(join(p.deps.paths.coworkDir, 'status.json'))).toString('utf8')) as StatusJson;
}

/** f.py: rows `row_<i> = <i>` for i = 1..n, with `extra` rows inserted after the row numbers given. */
export function fpy(n: number, o: { after?: Record<number, string>; replace?: Record<number, string>; drop?: readonly number[] } = {}): string {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    if (o.drop?.includes(i) !== true) out.push(o.replace?.[i] ?? `row_${i} = ${i}`);
    const extra = o.after?.[i];
    if (extra !== undefined) out.push(extra);
  }
  return out.map((r) => `${r}\n`).join('');
}

/** Non-terminal records carrying `guard` (by name). */
export function withGuard(p: PeerFixture, guard: string): HoldRecord[] {
  return p.core.holds.nonTerminal().filter((r) => r.guards.some((g) => guardName(g) === guard));
}

/** Every record (any state) carrying or having carried `guard` in its current guard set, any state. */
export function everWithGuard(p: PeerFixture, guard: string): HoldRecord[] {
  return p.core.holds.all().filter((r) => r.guards.some((g) => guardName(g) === guard));
}

/** Rounds until `cond` holds (at most `max`); fails with `what` otherwise. */
export async function roundsUntil(fx: EngineFixture, cond: () => boolean | Promise<boolean>, what: string, max = 16, loopMs = 2_500): Promise<number> {
  for (let i = 0; i < max; i++) {
    if (await cond()) return i;
    await fx.rounds(1, loopMs);
  }
  assert.ok(await cond(), `${what} within ${max} rounds`);
  return max;
}

/** The live code tree of the remote board tip, as path → text (fetched first by peer p). */
export async function remoteLiveFiles(fx: EngineFixture, p: PeerFixture): Promise<Map<string, string>> {
  const T = (await remoteBoardTip(fx)) as Oid;
  const repo = p.core.repo;
  await p.core.fetcher.fetch(true);
  const live = await liveOf(p, T);
  const out = new Map<string, string>();
  for (const [path, e] of await repo.readTreeMap((await repo.readCommit(live)).tree)) out.set(path, (await repo.readBlob(e.oid)).toString('utf8'));
  return out;
}

/**
 * The teammate's line (fx.pushTeamChange) applied on peer p's disk: f.py gains `TEAM = 1` after row `at`; rounds until it is on disk.
 * The provenance journal then holds the line as the teammate's (HLD-25).
 */
export async function teammateLine(fx: EngineFixture, p: PeerFixture, n: number, at: number, line = 'TEAM = 1'): Promise<string> {
  const text = fpy(n, { after: { [at]: line } });
  await fx.pushTeamChange({ 'f.py': buf(text) });
  await roundsUntil(fx, async () => (await readWork(p, 'f.py'))?.toString('utf8') === text, 'the teammate line applied');
  return text;
}

/** A human save of f.py without the teammate's line (a stale buffer): written, then rounds until the loop holds it in a `revert` record. */
export async function humanRemovesTeamLine(fx: EngineFixture, p: PeerFixture, n: number, extra: { after?: Record<number, string>; replace?: Record<number, string> } = {}): Promise<HoldRecord> {
  await writeWork(p, 'f.py', fpy(n, extra));
  await roundsUntil(fx, () => withGuard(p, 'revert').length > 0, 'a revert record', 16, 2_500);
  const recs = withGuard(p, 'revert');
  assert.equal(recs.length, 1, `one revert record: ${JSON.stringify(recs.map((r) => [r.id, r.paths]))}`);
  return recs[0]!;
}

/**
 * A daemon restart of peer p: a new Engine (a new core: every in-memory clock, the change-set memory and the S_pub of this run
 * start empty) built from the same deps, started under the fixture's daemon.lock (restart mode). Returns the start result.
 */
export async function restartEngine(p: EngineFixture['peers'][number]): Promise<StartResult> {
  const fresh = await Engine.create(p.deps);
  p.core = fresh.core;
  p.engine = fresh;
  const r = await fresh.start({ publishLocal: null });
  assert.ok(r.ok && r.mode === 'restart', `restart: ${JSON.stringify(r)}`);
  return r;
}
