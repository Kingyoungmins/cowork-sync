// The minimal epoch guard (ruling R-09; 01-engine §3.5 step 0b/0c, ENG-15, ENG-16; 08-lifecycle §3.4.1 / LIF-10, the
// Plan 2 subset of LIF-11). Loop step 0 reads the observation set with GIT_OPTIONAL_LOCKS=0 (forced on every git call):
// symbolic HEAD, the HEAD oid, refs/stash, the operation markers and .git/index.lock. E1 — the observation equals
// meta.expected_epoch and no marker exists — lets the iteration proceed; anything else is FREEZE(EPOCH) (the HEAD
// decision table rows E2–E6 and RECONCILE are Plan 7). index.lock is not an epoch class: while it exists the iteration
// only fetches and folds (ENG-15), and the loop raises INDEX_LOCK_WAIT once it kept one mtime for INDEX_LOCK_NOTICE_MS.
// Nothing here writes, and the lock is never deleted.
import { join } from 'node:path';
import type { Oid } from '../git/oid.js';
import type { GitRepo } from '../git/repo.js';
import type { Fs } from '../ports/fs.js';
import type { Meta } from './meta.js';
import { OP_MARKERS } from './restart.js';

/** MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, REBASE_HEAD, BISECT_LOG, rebase-merge, rebase-apply, sequencer (the one list restart's HEAD check reads too). */
export const OPERATION_MARKERS: readonly string[] = OP_MARKERS;
/** ENG-15 / LIF-10: one INDEX_LOCK_WAIT notice after the lock kept the same mtime this long (Δmono). */
export const INDEX_LOCK_NOTICE_MS = 30_000;

export interface EpochObservation { symref: string | null; head: Oid | null; stash: Oid | null; markers: string[]; indexLock: { present: boolean; mtimeNs: bigint | null }; }

const INDEX_LOCK = 'index.lock';

/** One lstat that reads a failure (EACCES on a held file) as present: a marker or lock that cannot be looked at is never assumed away. */
async function look(fs: Fs, p: string): Promise<{ present: boolean; mtimeNs: bigint | null }> {
  try {
    const st = await fs.lstat(p);
    return st === null ? { present: false, mtimeNs: null } : { present: true, mtimeNs: st.mtimeNs };
  } catch {
    return { present: true, mtimeNs: null };
  }
}

/**
 * The R-09 observation set (no write; GIT_OPTIONAL_LOCKS=0). symref: the full ref HEAD points to, null when detached
 * (symbolic-ref -q exits 1). Any other failure (rc 128: a HEAD git cannot read) throws GitCommandError: an observation
 * that failed is never read as a detached HEAD.
 */
export async function observeEpoch(repo: GitRepo, fs: Fs): Promise<EpochObservation> {
  const gitDir = repo.paths.gitDir;
  const sym = await repo.run(['symbolic-ref', '-q', 'HEAD'], { okCodes: [0, 1] });
  const symref = sym.code === 0 ? sym.stdout.toString('utf8').trim() : null;
  const head = await repo.resolve('HEAD');
  const stash = await repo.readRef('refs/stash');
  const markers: string[] = [];
  for (const m of OPERATION_MARKERS) if ((await look(fs, join(gitDir, m))).present) markers.push(m);
  const indexLock = await look(fs, join(gitDir, INDEX_LOCK));
  return { symref: symref === '' ? null : symref, head, stash, markers, indexLock };
}

/** E1 (the expected epoch, no marker) or FREEZE (anything else: FREEZE(EPOCH), R-09). */
export function epochVerdict(o: EpochObservation, expected: Meta['expected_epoch']): 'E1' | 'FREEZE' {
  const symref = o.symref ?? '';
  const ok = symref === expected.symref && o.head === expected.head && o.stash === expected.stash && o.markers.length === 0;
  return ok ? 'E1' : 'FREEZE';
}
