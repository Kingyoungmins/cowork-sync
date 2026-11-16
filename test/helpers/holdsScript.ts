// Shared helpers of the scripted holds SIM tests (Plan 3 Task 13; fix round 1 split sim.holds.ops.test.ts by area so its files run in
// parallel, R3-55): a script is a list of ScriptSteps and probes (test code run between harness steps), played through holdsSetup's
// composition (crash rate 0) on real git against file:// bare remotes; watches are afterEveryOp oracles. Readers of the remote's live
// code, a peer's disk, its registry and its daemon log, as the sim.holds.ops*.test.ts files use them.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { refNames, RELEASE_NAMESPACE } from '../../src/engine/refs.js';
import type { Oid } from '../../src/git/oid.js';
import { isTerminal, type HoldRecord } from '../../src/holds/record.js';
import { realEngineOf } from '../sim/engineAdapter.js';
import { holdsSetup, scriptedGenerator, type ScriptStep } from '../sim/generators.js';
import { advanceClocks, runSim, type OpGenerator, type Oracle, type SimContext, type SimOptions, type SimResult } from '../sim/harness.js';
import { readBlob, treeEntries } from '../sim/holdsView.js';
import { findMarkers, type MarkerModel } from '../sim/markers.js';


export const REFS = refNames('main', RELEASE_NAMESPACE);

/** A scripted SIM run on a loaded CI machine can outlast node:test's 10-minute default (R3-55: such a test sets its own timeout). */
export const SIM_TIMEOUT = 30 * 60_000;

export function okOrFail(r: SimResult): void {
  assert.ok(r.ok, `run failed: ${JSON.stringify(r.failure)}; artifacts kept in ${String(r.artifactsDir)}; op-log tail ${JSON.stringify(r.opLog.slice(-8))}`);
}

export interface Probe { probe: string; run(ctx: SimContext): Promise<string | void>; }
export type Step = ScriptStep | Probe;

export function play(steps: readonly Step[], markers: MarkerModel): OpGenerator {
  const inner = scriptedGenerator(steps.map((s): ScriptStep => ('probe' in s ? { advance: 0 } : s)), markers);
  return {
    next(ctx, step) {
      const s = steps[step];
      if (s !== undefined && 'probe' in s) return { peer: '*', kind: 'probe', run: async (c) => `${s.probe} ${(await s.run(c)) ?? ''}`.trim() };
      return inner.next(ctx, step);
    },
  };
}

export interface Run { r: SimResult; markers: MarkerModel; }

/** A scripted holds run; `make` builds the steps with the run's MarkerModel (probes that run holdsOp need it). */
export async function scriptRun(seed: string, make: (markers: MarkerModel) => Step[], o: { oracles?: Oracle[]; quiescence?: boolean; seedFiles?: Record<string, Buffer> } = {}): Promise<Run> {
  const s = holdsSetup(seed, { script: [], ...(o.seedFiles === undefined ? {} : { seedFiles: o.seedFiles }) });
  const steps = make(s.markers);
  const options: SimOptions = { ...s.options, generator: play(steps, s.markers) };
  if (o.quiescence !== true) delete options.quiescence;
  const r = await runSim({ ...s.tuple, ops: steps.length }, s.factory, o.oracles ?? [], options);
  return { r, markers: s.markers };
}

export const engineAt = (ctx: SimContext, i: number) => {
  const e = realEngineOf(ctx.engines[i]!);
  assert.ok(e !== null, `p${i} has a running engine`);
  return e;
};

/** A probe that iterates peer i alone (2.5 s apart) until `cond` holds, at most `max` times. */
export function until(i: number, label: string, cond: (ctx: SimContext) => Promise<boolean>, max = 30): Probe {
  return {
    probe: label,
    run: async (ctx) => {
      for (let n = 1; n <= max; n++) {
        advanceClocks(ctx, 2_500);
        await ctx.engines[i]!.step(ctx);
        await ctx.scheduler.runUntilIdle(10_000);
        if (await cond(ctx)) return `after ${n}`;
      }
      throw new Error(`${label}: not within ${max} iterations of p${i}`);
    },
  };
}

/** `n` iterations of peer i alone, 2.5 s of virtual time before each. */
export const alone = (i: number, n: number): Step[] => Array.from({ length: n }, () => [{ advance: 2_500 }, { iterate: i }] as Step[]).flat();

export const has = (r: HoldRecord, g: string): boolean => r.guards.some((x) => x.name === g || x.name.startsWith(`${g}:`));
export const holdsOf = async (ctx: SimContext, i: number): Promise<HoldRecord[]> => (await engineAt(ctx, i).inspect()).holds;
export const live = (rs: readonly HoldRecord[]): HoldRecord[] => rs.filter((r) => !isTerminal(r));

/** The remote board tip's live code tree (read in the bare remote). */
export async function liveTree(ctx: SimContext): Promise<{ commit: string; files: Map<string, { mode: string; oid: Oid }> }> {
  const board = (await ctx.git.run(['rev-parse', '--verify', `${REFS.remoteBoard}^{commit}`], { class: 'local', cwd: ctx.remote.dir })).stdout.toString('utf8').trim();
  const parents = (await ctx.git.run(['log', '-1', '--format=%P', board], { class: 'local', cwd: ctx.remote.dir })).stdout.toString('utf8').trim().split(' ');
  const commit = parents[parents.length - 1]!;
  return { commit, files: await treeEntries(ctx.git, ctx.remote.dir, `${commit}^{tree}`) };
}
export async function liveFile(ctx: SimContext, path: string): Promise<Buffer | null> {
  const e = (await liveTree(ctx)).files.get(path);
  return e === undefined ? null : readBlob(ctx.git, ctx.remote.dir, e.oid);
}
export const rowsOf = (b: Buffer): string[] => {
  const rows = b.toString('latin1').split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  return rows;
};
export async function disk(ctx: SimContext, i: number, path: string): Promise<Buffer | null> {
  return readFile(join(ctx.peers[i]!.dir, ...path.split('/'))).catch(() => null);
}
export async function blobOf(ctx: SimContext, i: number, oid: string | undefined): Promise<Buffer | null> {
  return oid === undefined || oid === 'ABSENT' ? null : readBlob(ctx.git, ctx.peers[i]!.dir, oid as Oid);
}
/** The last token of the newest op-log entry of `kind` by `peer` whose detail mentions `path` (the op's marker). */
export function opMarker(ctx: SimContext, kind: string, peer: string, path: string): string {
  const e = [...ctx.opLog].reverse().find((x) => x.kind === kind && x.peer === peer && x.detail.includes(path));
  assert.ok(e !== undefined, `no ${kind} by ${peer} on ${path}`);
  const m = findMarkers(Buffer.from(e.detail, 'latin1'));
  assert.ok(m.length > 0, `${kind} ${e.detail} names no marker`);
  return m[m.length - 1]!;
}
export async function logCodes(ctx: SimContext, i: number): Promise<Array<{ code: string; params: Record<string, unknown> }>> {
  const text = await readFile(join(ctx.peers[i]!.dir, '.git', 'cowork', 'log', 'daemon-0.jsonl'), 'utf8').catch(() => '');
  return text.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as { code: string; params: Record<string, unknown> });
}

/** An afterEveryOp watch that starts once `armed()` and fails the run with `check`'s message. */
export function watch(name: string, armed: () => boolean, check: (ctx: SimContext) => Promise<string | null>): Oracle {
  return { name, async afterEveryOp(ctx) { return armed() ? check(ctx) : null; } };
}
