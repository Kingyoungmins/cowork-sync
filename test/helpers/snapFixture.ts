// Test helper for the staged-read engine pieces (Task 9): a real clone on a file:// bare remote whose GitRepo
// records every git call, a FaultFs over the real disk, a settable clock, and an edit helper that moves the file's
// mtime out of the 300 ms quiet window (the quiet rule compares the PC's wall clock with the file mtime).
import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GitCallOptions } from '../../src/git/flags.js';
import type { Oid } from '../../src/git/oid.js';
import { GitRepo, type TreeMap } from '../../src/git/repo.js';
import type { GitRunner } from '../../src/git/runner.js';
import type { Clock } from '../../src/ports/clock.js';
import { realFs } from '../../src/ports/fs.js';
import { StageDir } from '../../src/engine/stagedRead.js';
import { StatCache } from '../../src/engine/statCache.js';
import { FaultFs } from '../sim/faultfs.js';
import { fixtureContext, makeRepoFixture, type RepoFixture } from './repoFixture.js';

/** Settable mono and wall time. Wall starts 10 s after the real now, so checked-out files are past the quiet window. */
export class TestClock implements Clock {
  mono = 1_000;
  wall: number;

  constructor() {
    this.wall = Date.now() + 10_000;
  }

  monoMs(): number {
    return this.mono;
  }

  wallMs(): number {
    return this.wall;
  }

  async sleep(ms: number): Promise<void> {
    this.advance(Math.max(0, ms));
  }

  advance(ms: number): void {
    this.mono += ms;
    this.wall += ms;
  }
}

export interface GitCall { args: string[]; opts: GitCallOptions; }

/** Records every call; with `timeline`, also appends `git <subcommand>` to it (FaultFs.calls), so fs and git calls share one order. */
export function spyRunner(inner: GitRunner, calls: GitCall[], timeline?: string[]): GitRunner {
  return {
    run(args, opts) {
      calls.push({ args: [...args], opts: { ...opts } });
      timeline?.push(`git ${args[0] ?? ''}`);
      return inner.run(args, opts);
    },
  };
}

export interface SnapFixture {
  f: RepoFixture;
  repo: GitRepo;
  calls: GitCall[];
  fs: FaultFs;
  clock: TestClock;
  head: Oid;
  /** tree(HEAD) */
  A: TreeMap;
  tmp: string;
  stage: StageDir;
  statCache: StatCache;
  abs(path: string): string;
  /** Writes the working file and sets its mtime 900–1000 ms before the clock's wall time (distinct per call). */
  write(path: string, bytes: Buffer | string): Promise<void>;
  /** Sets the mtime of an existing working file as write() does. */
  settle(path: string): Promise<void>;
  loose(): Promise<{ count: number; size: number }>;
  /** Every object id in the store (loose and packed) with its type. */
  objects(): Promise<Map<string, string>>;
  cleanup(): Promise<void>;
}

let seq = 0;

export async function makeSnapFixture(
  label: string,
  opts: { files?: Record<string, Buffer>; autocrlf?: boolean; filter?: boolean; drivers?: string[] } = {},
): Promise<SnapFixture> {
  const f = await makeRepoFixture(label, opts);
  try {
    const calls: GitCall[] = [];
    const head = await f.repo.resolve('HEAD');
    if (head === null) throw new Error('fixture has no HEAD');
    const fs = new FaultFs(realFs);
    const repo = new GitRepo(spyRunner(f.runner, calls, fs.calls), f.paths, () => ({ ...fixtureContext(), attrTree: head, filterDrivers: opts.drivers ?? [] }));
    const A = await f.repo.readTreeMap(head);
    const tmp = join(f.paths.coworkDir, 'tmp');
    await fsp.mkdir(tmp, { recursive: true });
    const clock = new TestClock();
    const stage = new StageDir(fs, join(tmp, 'stage'));
    const abs = (p: string): string => join(f.paths.workTree, ...p.split('/'));
    const settle = async (p: string): Promise<void> => {
      const t = (clock.wall - 1_000 + (seq++ % 100_000) / 1_000) / 1_000;
      await fsp.utimes(abs(p), t, t);
    };
    const count = async (): Promise<{ count: number; size: number }> => {
      const out = (await f.repo.run(['count-objects', '-v'])).stdout.toString('utf8');
      const c = /^count: (\d+)$/m.exec(out);
      const s = /^size: (\d+)$/m.exec(out);
      if (c === null || s === null) throw new Error(`count-objects: ${out}`);
      return { count: Number(c[1]), size: Number(s[1]) };
    };
    const objects = async (): Promise<Map<string, string>> => {
      const r = await f.repo.run(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']);
      const m = new Map<string, string>();
      for (const line of r.stdout.toString('utf8').split('\n')) {
        const [oid, type] = line.split(' ');
        if (oid !== undefined && type !== undefined) m.set(oid, type);
      }
      return m;
    };
    return {
      f, repo, calls, fs, clock, head, A, tmp, stage, statCache: new StatCache(), abs,
      async write(p, bytes) {
        await fsp.mkdir(dirname(abs(p)), { recursive: true });
        await fsp.writeFile(abs(p), typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes);
        await settle(p);
      },
      settle,
      loose: count,
      objects,
      cleanup: () => f.cleanup(),
    };
  } catch (e) {
    await f.cleanup();
    throw e;
  }
}

/** The git calls whose argv or work tree reads content, for the "no git on working files" checks. */
export function contentCalls(calls: readonly GitCall[]): GitCall[] {
  return calls.filter((c) => {
    const sub = c.args[0];
    return sub === 'add' || sub === 'hash-object' || sub === 'diff-files' || (sub === 'update-index' && c.args.includes('--refresh'));
  });
}
