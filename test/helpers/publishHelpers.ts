// Shared helpers of the publish tests (Plan 2 Task 14): preparing iterations, capturing a human change-set's ready pair
// (the capture is the loop's, Task 17), wrapping a peer's git runner to inject outcomes (the core's GitRepo holds the very
// runner object of PeerFixture.deps.ports.git, so replacing its `run` reaches every call the core makes), a log recorder,
// and reads of the remote and of trees. Git is never mocked: a wrapper only rewrites what a real call reported, or
// refuses one call the way git does (exit code, empty stdout).
import assert from 'node:assert/strict';
import { unlink } from 'node:fs/promises';
import { prepareIteration, tickInputOf, type IterationCtx } from '../../src/engine/core.js';
import type { MutantId } from '../../src/engine/deps.js';
import type { Oid } from '../../src/git/oid.js';
import type { TreeMap } from '../../src/git/repo.js';
import type { GitCallOptions } from '../../src/git/flags.js';
import type { GitResult } from '../../src/git/runner.js';
import type { ReadyPair } from '../../src/holds/changesets.js';
import type { Log, LogLevel, LogParam } from '../../src/ports/log.js';
import { gitCallsOf, makeCores, workPath, writeWork, type CoreFixture, type PeerFixture } from './coreFixture.js';

export const buf = (s: string): Buffer => Buffer.from(s, 'utf8');
export const lines = (n: number, f: (i: number) => string = (i) => `line ${i}`): string => Array.from({ length: n }, (_, i) => `${f(i + 1)}\n`).join('');

let iter = 0;

/** prepareIteration with a fresh fetch; the iteration must be prepared. */
export async function prep(p: PeerFixture, materialize: boolean | 'auto' = false): Promise<IterationCtx> {
  const r = await prepareIteration(p.core, ++iter, { materialize, forceFetch: true });
  assert.ok(r.ok, `prepareIteration failed: ${JSON.stringify(r)}`);
  return r.it;
}

/** HLD-40 at the close of the open human CS: materialize when the iteration has not, capture, journal the pair. */
export async function captureReady(p: PeerFixture, it: IterationCtx): Promise<ReadyPair> {
  const core = p.core;
  if (it.mat === null) it.mat = await core.snapshot.materialize(tickInputOf(core, it));
  const r = await core.cs.capture(core.repo, it.mat.sDiskMap, it.A, core.scratch('r'));
  assert.ok(r !== null && r.pair !== null, 'a ready-pair capture was due');
  await core.commit({ ready: core.cs.ready(), meta: { ...core.view!.meta, cs_human_next: r.nextN } });
  return r.pair;
}

/** Edits working files (null deletes), observes them, waits the 20 s quiet period and captures one ready pair. */
export async function editAndCapture(fx: CoreFixture, p: PeerFixture, files: Readonly<Record<string, Buffer | string | null>>): Promise<{ pair: ReadyPair; it: IterationCtx }> {
  for (const [path, bytes] of Object.entries(files)) {
    if (bytes === null) await unlink(workPath(p, path));
    else await writeWork(p, path, bytes);
  }
  await prep(p);
  if (Object.values(files).some((b) => b === null)) {
    fx.advance(1_500);   // a deletion is confirmed by a second read ≥ 1 s later
    await prep(p);
  }
  fx.advance(20_000);
  const it = await prep(p, true);
  const pair = await captureReady(p, it);
  return { pair, it };
}

export type GitRun = (args: string[], opts: GitCallOptions) => Promise<GitResult>;

/** Replaces the peer's runner `run` with `wrap(args, opts, inner)`; returns the restore function. */
export function wrapGit(p: PeerFixture, wrap: (args: string[], opts: GitCallOptions, inner: GitRun) => Promise<GitResult>): () => void {
  const git = p.deps.ports.git;
  const orig: GitRun = git.run.bind(git);
  git.run = (args, opts) => wrap(args, opts, orig);
  return () => {
    git.run = orig;
  };
}

/** A git process that printed nothing to stdout and exited `code` (git's way of refusing; ENG-09's empty-oid case). */
export function failedResult(code: number, stderr = ''): GitResult {
  return { code, stdout: Buffer.alloc(0), stderr: buf(stderr), killedByWatchdog: false, aborted: false, durationMs: 1 };
}

const pushesAtStart = new WeakMap<PeerFixture, number>();
const allPushes = (p: PeerFixture): number => gitCallsOf(p).filter((c) => c.args[0] === 'push').length;

/** Every push this peer's runner spawned since withCores' bootstrap (the first peer's genesis push is not counted). */
export function pushCalls(p: PeerFixture): number {
  return allPushes(p) - (pushesAtStart.get(p) ?? 0);
}

export async function remoteBoard(fx: CoreFixture, p: PeerFixture): Promise<string | undefined> {
  return (await fx.remote.refs())[p.core.refs.remoteBoard];
}

export async function remoteCode(fx: CoreFixture, p: PeerFixture): Promise<string | undefined> {
  return (await fx.remote.refs())[p.core.refs.remoteCode];
}

export async function treeOf(p: PeerFixture, commit: Oid): Promise<TreeMap> {
  return p.core.repo.readTreeMap((await p.core.repo.readCommit(commit)).tree);
}

export async function blobText(p: PeerFixture, map: TreeMap, path: string): Promise<string | null> {
  const e = map.get(path);
  return e === undefined ? null : (await p.core.repo.readBlob(e.oid)).toString('utf8');
}

export async function stateA(p: PeerFixture): Promise<TreeMap> {
  const view = p.core.view;
  assert.ok(view !== null);
  return p.core.repo.readTreeMap(view.base);
}

export function setMutants(p: PeerFixture, m: MutantId[]): void {
  p.deps.testMutants = new Set(m);
}

export class LogRecorder implements Log {
  readonly lines: Array<{ level: LogLevel; code: string; params: Readonly<Record<string, LogParam>> }> = [];
  write(level: LogLevel, code: string, params?: Readonly<Record<string, LogParam>>): void {
    this.lines.push({ level, code, params: params ?? {} });
  }
  text(): string {
    return JSON.stringify(this.lines);
  }
}

export async function withCores<T>(label: string, opts: Parameters<typeof makeCores>[1], fn: (fx: CoreFixture) => Promise<T>): Promise<T> {
  const fx = await makeCores(label, opts);
  try {
    await fx.bootstrap();
    for (const p of fx.peers) pushesAtStart.set(p, allPushes(p));
    return await fn(fx);
  } finally {
    fx.scheduler.onYield = null;
    await fx.cleanup();
  }
}
