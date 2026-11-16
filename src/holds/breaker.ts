// The mass-change breaker (05-holds HLD-30; glossary §8 FREEZE `MASS`, §20 "mass-change breaker", "MASS breaker window"; CS-29;
// rulings R3-38, R3-50): on every detection tick's dirty set (paths only, no object read or written), FREEZE(MASS) trips when
//   (a) the union of paths with unobserved deltas first seen within any 30 s local-monotonic window exceeds
//       max(10 files, 2 % of tracked files) → 'window'; or
//   (b) an unobserved deletion removes a file holding a non-trivial line the journal lists as added by another writer
//       (the caller's peerLinesIn reads the deleted file's last private-index blob) → 'peer_lines'.
// `.git/index.lock` and `.git/logs/HEAD` (anything under `.git/`) are never triggers (HLD-30: a commit-message editor holds
// index.lock legitimately). An observed delta (a Claude edit, an attributed local write) never counts. A path seen again keeps its
// first-seen time; a first sighting older than the window is forgotten, so the same path counts again in a later burst (a
// `git checkout .` over files edited an hour ago). Memory only: a daemon start begins with an empty window (INV-CLOCK).
import type { Clock } from '../ports/clock.js';

export const MASS_WINDOW_MS = 30_000;
export const MASS_MIN_FILES = 10;
export const MASS_TRACKED_RATIO = 0.02;

export interface BreakerInput { path: string; deletion: boolean; observed: boolean; }

/** A path inside the git directory (index.lock, logs/HEAD, …): never a trigger. */
function gitInternal(path: string): boolean {
  const p = path.toLowerCase();
  return p === '.git' || p.startsWith('.git/');
}

export class MassBreaker {
  private readonly clock: Clock;
  /** Unobserved-delta paths by their first-seen Δmono time, inside the window. */
  private readonly firstSeen = new Map<string, number>();
  private tripPaths = 0;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  /**
   * One tick's dirty-set changes: (a) the window rule over every unobserved path, then (b) peerLinesIn for each unobserved
   * deletion of this tick. `tracked` = the number of tracked files (A's paths). The first trip reason, or null.
   */
  async observe(dirty: readonly BreakerInput[], tracked: number, peerLinesIn: (path: string) => Promise<boolean>): Promise<'window' | 'peer_lines' | null> {
    const now = this.clock.monoMs();
    for (const [p, t] of this.firstSeen) if (now - t > MASS_WINDOW_MS) this.firstSeen.delete(p);
    const deletions: string[] = [];
    for (const d of dirty) {
      if (d.observed || gitInternal(d.path)) continue;
      if (!this.firstSeen.has(d.path)) this.firstSeen.set(d.path, now);
      if (d.deletion) deletions.push(d.path);
    }
    const threshold = Math.max(MASS_MIN_FILES, MASS_TRACKED_RATIO * tracked);
    if (this.firstSeen.size > threshold) {
      this.tripPaths = this.firstSeen.size;
      return 'window';
    }
    for (const p of deletions) {
      if (await peerLinesIn(p)) {
        this.tripPaths = 1;
        return 'peer_lines';
      }
    }
    return null;
  }

  /** Forgets every first-seen time (resume, R3-38). */
  reset(): void {
    this.firstSeen.clear();
    this.tripPaths = 0;
  }

  /** The paths the last trip counted (the window's paths, or 1 for a peer-line deletion); 0 before any trip. Read by enterMass's trace. */
  lastTripPaths(): number {
    return this.tripPaths;
  }
}
