// The viewer's real git for the source tests (Plan 8a Task 7): VizGit over the absolute git the CLI would resolve (R-V13),
// with a data directory outside the repository, and a runner spy that records every argv (and stdin) and can run a hook
// before a call reaches git (a ref moved between two calls, Review Focus 4).
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { buildDaemonEnv } from '../../src/git/env.js';
import type { GitCallOptions } from '../../src/git/flags.js';
import type { GitResult, GitRunner } from '../../src/git/runner.js';
import { realClock, type Clock } from '../../src/ports/clock.js';
import { realFs } from '../../src/ports/fs.js';
import type { Frame } from '../../src/viz/model/frame.js';
import { GitRoomSource } from '../../src/viz/source/git.js';
import type { RoomSpec } from '../../src/viz/source/roomSource.js';
import { createVizGit, vizGitRunner, type VizGit } from '../../src/viz/source/vizGit.js';
import type { ScriptCommit } from '../../tools/viz/boardWriter.js';
import type { RepoFixture } from './repoFixture.js';
import { many, SEAT } from './vizBatchRead.js';

/** The absolute git the CLI would resolve (R-V13): the first git on PATH, by realpath. */
export function absoluteGit(): string {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const name = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const dir of (process.env[key] ?? '').split(delimiter)) {
    if (dir.length === 0) continue;
    const p = join(dir, name);
    if (existsSync(p)) return realpathSync.native(p);
  }
  throw new Error('no git on PATH');
}

export interface VizCall { args: string[]; stdin: string; }
export interface SpiedVizGit { git: VizGit; calls: VizCall[]; before: ((args: readonly string[]) => Promise<void>) | null; }

/** One runner for every room of a test (the data directory is created). */
export function vizRunner(dataDir: string, clock: Clock = realClock): GitRunner {
  mkdirSync(dataDir, { recursive: true });
  return vizGitRunner({ clock, dataDir, env: buildDaemonEnv(process.env as Record<string, string | undefined>, []), gitPath: absoluteGit() });
}

/** createVizGit over a recording runner; set `before` to run something just before the next calls reach git. */
export function spiedVizGit(runner: GitRunner, gitDir: string, dataDir: string): SpiedVizGit {
  const s: SpiedVizGit = { git: null as unknown as VizGit, calls: [], before: null };
  const spy: GitRunner = {
    async run(args: string[], opts: GitCallOptions): Promise<GitResult> {
      s.calls.push({ args: [...args], stdin: opts.stdin?.toString('utf8') ?? '' });
      if (s.before !== null) await s.before(args);
      return runner.run(args, opts);
    },
  };
  s.git = createVizGit({ runner: spy, gitDir, dataDir });
  return s;
}

/** Each call as its first two words (`rev-parse --verify`, `cat-file --batch-check`, …). */
export const kinds = (calls: readonly VizCall[]): string[] => calls.map((c) => `${c.args[0]} ${c.args[1] ?? ''}`.trim());

/** A git room of the given gitdir and board ref (id, label and branch fixed). */
export function specOf(gitDir: string, boardRef: string): RoomSpec {
  return { id: 'r00000000', kind: 'git', label: 'shop-app', branch: 'main', gitDir, boardRef, canonicalRoot: null };
}

/** A GitRoomSource over a spied VizGit of the fixture's clone. */
export function sourceOf(fx: RepoFixture, ref: string, clock = realClock): { src: GitRoomSource; sg: SpiedVizGit } {
  const dataDir = join(fx.root, 'viz data');
  const sg = spiedVizGit(vizRunner(dataDir), fx.paths.gitDir, dataDir);
  return { src: new GitRoomSource(specOf(fx.paths.gitDir, ref), sg.git, { fs: realFs, clock }), sg };
}

/** Every frame of an iteration, in order. */
export async function collect(it: AsyncIterable<Frame>): Promise<Frame[]> {
  const out: Frame[] = [];
  for await (const f of it) out.push(f);
  return out;
}

/** A mix of everything a Plan 2 board carries (the batchReadLarge script plus freezes and thaws). */
export function script(n: number): ScriptCommit[] {
  const kinds_: ScriptCommit[] = [
    { writer: 'ann', cs: [{ paths: ['src/a.txt'] }, { paths: ['src/b.txt', 'docs/x.md'], checks: 'pass' }] },
    { writer: 'bob', code: 'base_move' },
    { writer: 'bob', cs: [{ paths: many(300, 'big') }] },
    { writer: 'ann', ops: [{ type: 'seat_start', seat_id: SEAT, permission_mode: 'default' }] },
    { writer: 'ann', cs: [{ seat: SEAT, origin: 'wake', paths: ['src/c.txt'] }] },
    { writer: 'ann', ops: [{ type: 'seat_end', seat_id: SEAT, permission_mode: 'default' }] },
    { writer: 'bob', ops: [{ type: 'event', cid: '', kind: 'freeze', refs: [], reason_code: 'EPOCH' }] },
    { writer: 'bob', ops: [{ type: 'event', cid: '', kind: 'unfreeze', refs: [], reason_code: 'EPOCH' }] },
    { writer: 'bob', rawOps: ['{"truncated":', '[]'] },
    { writer: null, rawOps: ['{}'] },
    { writer: 'ann', badWriterTrailer: true },
    { writer: 'bob', cs: [{ paths: many(256, 'edge') }] },
    { writer: 'ann' },
  ];
  return Array.from({ length: n }, (_, i) => kinds_[i % kinds_.length]!);
}
