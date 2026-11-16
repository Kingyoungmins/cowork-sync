// Shared helpers of the Plan 3 Task 12b tests (escalation, S6, the stop primitives, start and restart): the HOLD_REVERT_HELD events
// of a record (folded and queued), the 100-file tree with eleven teammate lines a human removes in batches under the MASS window,
// durability waits and the private-index / state:snap entries of a path. Engines on real clones of one file:// remote
// (makeEngines); git is never mocked.
import assert from 'node:assert/strict';
import type { EventOp } from '../../src/board/ops.js';
import { foldPatch } from '../../src/engine/core.js';
import type { Oid } from '../../src/git/oid.js';
import type { HoldRecord } from '../../src/holds/record.js';
import { readWork, writeWork, type PeerFixture } from './coreFixture.js';
import type { EngineFixture } from './engineFixture.js';
import { roundsUntil, withGuard } from './loopHoldsFixture.js';
import { buf } from './publishHelpers.js';

export const DAY = 86_400_000;
export const MIN = 60_000;

type EnginePeer = EngineFixture['peers'][number];

/** HOLD_REVERT_HELD health events naming `id`: in this peer's newest fold (any writer) and queued in its outbox. */
export function revertEvents(p: PeerFixture, id: string): { folded: number; queued: number } {
  const fold = foldPatch(p.core)?.fold ?? p.core.view?.fold ?? null;
  const folded = fold === null ? 0 : Object.values(fold.events).filter((e) => e.kind === 'health' && e.reason_code === 'HOLD_REVERT_HELD' && e.refs.includes(id)).length;
  const queued = p.core.outbox.drafts().filter((d) => {
    if (d.type !== 'event') return false;
    const e = d as Omit<EventOp, 'id'>;
    return e.kind === 'health' && e.reason_code === 'HOLD_REVERT_HELD' && e.refs.includes(id);
  }).length;
  return { folded, queued };
}

/** Rounds until every id is durable on the fetched board (Engine.inspect().mirror, R3-26). */
export async function untilDurable(fx: EngineFixture, p: EnginePeer, ids: readonly string[], max = 16): Promise<void> {
  await roundsUntil(fx, async () => {
    const m = (await p.engine.inspect()).mirror;
    return ids.every((id) => m[id]?.durable === true);
  }, `durable: ${ids.join(',')}`, max);
}

/** The 100-file tree: README.md and 99 small files t/f<nnn>.py, each with TEAM_<i> = 1 in its middle when `team`. */
export const tFile = (i: number): string => `t/f${String(i).padStart(3, '0')}.py`;
export const tText = (i: number, team: boolean): string => `a_${i} = 1\nb_${i} = 2\nc_${i} = 3\n${team ? `TEAM_${i} = 1\n` : ''}d_${i} = 4\ne_${i} = 5\nf_${i} = 6\n`;
export const HUNDRED: Record<string, Buffer> = {
  'README.md': buf('# a 100-file tree\n'),
  ...Object.fromEntries(Array.from({ length: 99 }, (_, i) => [tFile(i), buf(tText(i, false))])),
};
export const ELEVEN = Array.from({ length: 11 }, (_, i) => i);

/**
 * Eleven ON_DISK `revert` PATCHes on peer p over t/f000.py…t/f010.py of the 100-file tree (above max(10, 2 %), so never created in one
 * MASS window): the teammate adds TEAM_<i> = 1 to the eleven files in one change, applied on p; the human removes the lines in
 * batches of 5, 5 and 1 files 31 s apart (each under the breaker's threshold), rounds until each batch's records exist. Their ids
 * in file order; MASS never set.
 */
export async function elevenReverts(fx: EngineFixture, p: EnginePeer): Promise<string[]> {
  await fx.pushTeamChange(Object.fromEntries(ELEVEN.map((i) => [tFile(i), buf(tText(i, true))])));
  await roundsUntil(fx, async () => (await readWork(p, tFile(10)))?.toString('utf8') === tText(10, true), 'the eleven teammate lines applied');
  for (const batch of [ELEVEN.slice(0, 5), ELEVEN.slice(5, 10), ELEVEN.slice(10)]) {
    fx.advance(31_000);
    for (const i of batch) await writeWork(p, tFile(i), tText(i, false));
    await roundsUntil(fx, () => batch.every((i) => withGuard(p, 'revert').some((r) => r.paths[0] === tFile(i))), 'the batch\'s revert records', 24);
  }
  const ids = ELEVEN.map((i) => withGuard(p, 'revert').find((r) => r.paths[0] === tFile(i))!.id);
  assert.equal(new Set(ids).size, 11, 'eleven records');
  assert.ok(!p.core.view!.meta.freeze_reasons.includes('MASS'), 'no MASS while the records were made');
  return ids;
}

/** Rounds until no change-set is open on p (the human CS of the removals closed and captured). */
export async function untilNoOpenCs(fx: EngineFixture, p: EnginePeer, max = 24): Promise<void> {
  try {
    await roundsUntil(fx, () => p.core.cs.openPaths().size === 0, 'no open change-set', max);
  } catch (e) {
    assert.fail(`${(e as Error).message}: ${JSON.stringify(p.core.cs.table().cs.map((c) => [c.cs_id, c.kind, c.state, c.paths]))}`);
  }
}

/** The private index's entry of each path (the snapshot's S_raw entries). */
export async function privateEntries(p: PeerFixture, paths: readonly string[]): Promise<Map<string, Oid | undefined>> {
  const index = await p.core.repo.listIndex(p.core.path(`${p.core.refs.e}.index`));
  return new Map(paths.map((x) => [x, index.get(x)?.oid]));
}

/** state:snap's entry of each path. */
export async function snapEntries(p: PeerFixture, paths: readonly string[]): Promise<Map<string, Oid | undefined>> {
  const snap = await p.core.repo.readTreeMap(p.core.view!.snap);
  return new Map(paths.map((x) => [x, snap.get(x)?.oid]));
}

/** The record (must exist). */
export function rec(p: PeerFixture, id: string): HoldRecord {
  const r = p.core.holds.get(id);
  assert.ok(r !== undefined, `record ${id}`);
  return r;
}
