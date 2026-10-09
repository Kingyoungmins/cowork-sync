// Retry for the git network calls of test fixtures (seedRemote's push, clonePeer's clone, the
// NaiveEngine's fetch). Under heavy parallel load on Windows, a push to the local file:// remote
// was seen to exit 1 with an empty stderr while nothing landed. A non-zero exit is retried only
// while the remote shows that nothing landed; the error thrown at the end lists the exit code and
// stderr of every failed attempt.
import { setTimeout as delay } from 'node:timers/promises';

export interface GitAttempt { code: number; stderr: string; }

export class RetryGitError extends Error {
  constructor(message: string, readonly attempts: GitAttempt[]) {
    super(message);
    this.name = 'RetryGitError';
  }
}

export interface RetryGitOptions {
  /** Total number of attempts, at least 1. */
  attempts: number;
  /** Names the call in the error message. */
  label: string;
  /**
   * Asked after each failed attempt: true when the remote shows that nothing landed, so the
   * same call may run again. Omit it for calls that write nothing to the remote (fetch, clone).
   */
  nothingLanded?: () => Promise<boolean>;
  /** Real-time pause before a retry, default 200 ms. It never reaches an op-log or a commit. */
  pauseMs?: number;
}

function report(head: string, failed: GitAttempt[]): string {
  return [head, ...failed.map((a, i) => `  attempt ${i + 1}: code=${a.code} stderr: ${a.stderr === '' ? '(empty)' : a.stderr}`)].join('\n');
}

/** Runs `run` until it exits 0, at most `opts.attempts` times, and returns that result. */
export async function retryGit<R extends { code: number; stderr: Buffer }>(run: () => Promise<R>, opts: RetryGitOptions): Promise<R> {
  if (!Number.isInteger(opts.attempts) || opts.attempts < 1) {
    throw new RangeError(`retryGit: attempts must be a positive integer, got ${opts.attempts}`);
  }
  const failed: GitAttempt[] = [];
  for (;;) {
    const r = await run();
    if (r.code === 0) return r;
    failed.push({ code: r.code, stderr: r.stderr.toString('utf8').replace(/\s+/g, ' ').trim() });
    if (failed.length >= opts.attempts) {
      throw new RetryGitError(report(`${opts.label}: failed ${failed.length} of ${opts.attempts} attempts`, failed), failed);
    }
    if (opts.nothingLanded !== undefined && !(await opts.nothingLanded())) {
      throw new RetryGitError(report(`${opts.label}: attempt ${failed.length} failed and the remote changed, so it was not retried`, failed), failed);
    }
    await delay(opts.pauseMs ?? 200);
  }
}
