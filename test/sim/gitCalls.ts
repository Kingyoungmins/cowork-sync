// The git calls of a SIM run, as the oracles need them (Task 19; 11-testing §3.4 INV-OID's fault clause): the run's
// shared GitRunner (ctx.git, which every engine's ports hold) is wrapped once, and every call it finishes is recorded
// with its working directory (an engine's git calls run in its main-worktree root, glossary §25 F12), its subcommand,
// its exit code and whether stdout was empty. Recording changes no call, no result and no timing the op-log sees.
// realEngine starts the recording when its factory runs (before any step); an oracle calling recordGitCalls later sees
// the calls from then on.
import type { GitCallOptions } from '../../src/git/flags.js';
import type { GitResult, GitRunner } from '../../src/git/runner.js';

export interface GitCallRecord {
  readonly cwd: string;
  /** args[0]: the subcommand (GitRepo and the push helpers pass it first). */
  readonly sub: string;
  readonly code: number;
  readonly stdoutEmpty: boolean;
}

const logs = new WeakMap<GitRunner, GitCallRecord[]>();

/** Starts recording `git`'s calls (idempotent) and returns the live record list. */
export function recordGitCalls(git: GitRunner): GitCallRecord[] {
  const had = logs.get(git);
  if (had !== undefined) return had;
  const log: GitCallRecord[] = [];
  logs.set(git, log);
  const inner = git.run.bind(git);
  git.run = async (args: string[], opts: GitCallOptions): Promise<GitResult> => {
    const r = await inner(args, opts);
    log.push({ cwd: opts.cwd, sub: args[0] ?? '', code: r.code, stdoutEmpty: r.stdout.length === 0 });
    return r;
  };
  return log;
}

/** The calls recorded on `git` so far, or null when nothing records them. */
export function gitCallsOf(git: GitRunner): readonly GitCallRecord[] | null {
  return logs.get(git) ?? null;
}
