// What push.ts and fetch.ts share: the network-call wrapper and the argument checks every network argv passes
// before any git process starts. The refspec rules of each side stay in its own file (pushSpec's '+'/':' ban,
// fetchRefs' refs/cowork-remote/ destinations).
import { GitCommandError, type GitRepo } from './repo.js';
import type { GitResult } from './runner.js';

/** Every exit code of a network call is an outcome (a rejection exits 1, a transport failure 128, a killed git -1 or 1). */
const OUTCOME_CODES: readonly number[] = Object.freeze(Array.from({ length: 257 }, (_, i) => i - 1));

/**
 * One class 'network' git call (the runner's watchdog bounds it: push 90 s, fetch and ls-remote 45 s) that never
 * throws on its exit code: every code a git can exit with on POSIX (-1…255) is accepted; a code beyond (a Windows
 * NTSTATUS crash) arrives as GitCommandError and reads as a failure with no output. `abort` (ruling P2-ABORT) kills
 * the call like a watchdog kill; the result then says `aborted`.
 */
export async function runNetwork(repo: GitRepo, argv: readonly string[], abort?: AbortSignal): Promise<GitResult> {
  try {
    return await repo.run([...argv], { class: 'network', okCodes: OUTCOME_CODES, ...(abort !== undefined ? { abort } : {}) });
  } catch (e) {
    if (!(e instanceof GitCommandError)) throw e;
    return { code: e.code, stdout: Buffer.alloc(0), stderr: Buffer.from(e.stderrText, 'utf8'), killedByWatchdog: false, aborted: false, durationMs: 0 };
  }
}

/**
 * The refname check of every network argv: GitRepo's own (one function, so the local ref methods and the network
 * calls can never disagree on what a refname is). Defined in repo.ts, which this file already depends on.
 */
export { checkRefName } from './repo.js';

/** A URL git cannot read as an option (no leading '-') and that cannot break the argv (no NUL, CR or LF). */
export function checkUrl(what: string, url: string): void {
  if (typeof url !== 'string' || url.length === 0 || url.startsWith('-') || /[\0\r\n]/.test(url)) {
    throw new Error(`${what}: invalid url ${JSON.stringify(url)}`);
  }
}
