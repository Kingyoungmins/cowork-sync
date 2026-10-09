// Shared helpers of the start, probe, restart and lost-state tests (Plan 2 Task 15): peers WITHOUT the test bootstrap
// (genesis and join need clones with no state), a process restart of one peer (a fresh EngineCore over the same clone,
// ports and runner), plain git on a peer's clone or on the bare remote (test code; git is never mocked), and reads of
// the local cowork refs. Git is never mocked.
import assert from 'node:assert/strict';
import { createEngineCore } from '../../src/engine/core.js';
import { startDispatch, type StartOptions, type StartResult } from '../../src/engine/start.js';
import type { GitResult } from '../../src/git/runner.js';
import { makeCores, type CoreFixture, type CoreOptions, type PeerFixture } from './coreFixture.js';
import { testRunner } from './tmp.js';

const runner = testRunner();

/** makeCores without the test bootstrap: no peer has a state; cleanup and the scheduler hook are always reset. */
export async function withStart<T>(label: string, opts: CoreOptions, fn: (fx: CoreFixture) => Promise<T>): Promise<T> {
  const fx = await makeCores(label, opts);
  try {
    return await fn(fx);
  } finally {
    fx.scheduler.onYield = null;
    await fx.cleanup();
  }
}

/** A process restart of the peer: a fresh EngineCore built from the same deps (same clone, ports, runner and trace). */
export async function restartCore(p: PeerFixture): Promise<void> {
  p.core = await createEngineCore(p.deps);
}

/** startDispatch that must succeed with `mode`. */
export async function startOk(p: PeerFixture, mode: 'genesis' | 'join' | 'restart', opts: StartOptions = { publishLocal: null }): Promise<StartResult & { ok: true }> {
  const r = await startDispatch(p.core, opts);
  assert.ok(r.ok, `${p.name}: start refused ${JSON.stringify(r)}`);
  assert.equal(r.mode, mode, `${p.name}: start mode`);
  return r;
}

/** Peer 0 performs genesis, every other peer joins (no local work). */
export async function startAll(fx: CoreFixture): Promise<void> {
  for (const [i, p] of fx.peers.entries()) await startOk(p, i === 0 ? 'genesis' : 'join');
}

/** git in the peer's clone (cwd = its work tree); a non-zero exit throws. */
export async function gitIn(p: PeerFixture, args: string[], identity = true): Promise<string> {
  const r: GitResult = await runner.run(args, {
    class: args[0] === 'push' || args[0] === 'fetch' ? 'network' : 'local', cwd: p.deps.paths.workTree,
    ...(identity ? { identity: { name: 'Test Human', email: 'human@cowork.invalid' } } : {}),
  });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr.toString('utf8')}`);
  return r.stdout.toString('utf8').trim();
}

/** git in the bare remote; a non-zero exit throws. */
export async function gitRemote(fx: CoreFixture, args: string[]): Promise<string> {
  const r = await runner.run(args, { class: 'local', cwd: fx.remote.dir });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} in the remote failed (${r.code}): ${r.stderr.toString('utf8')}`);
  return r.stdout.toString('utf8').trim();
}

/** Every refs/cowork-local/* ref of the peer, sorted. */
export async function localCoworkRefs(p: PeerFixture): Promise<string[]> {
  return (await p.core.repo.listRefs('refs/cowork-local/')).map((r) => r.ref).sort();
}

/** Every push process the peer's runner spawned so far. */
export function pushSpawns(calls: ReadonlyArray<{ args: readonly string[] }>): number {
  return calls.filter((c) => c.args[0] === 'push').length;
}
