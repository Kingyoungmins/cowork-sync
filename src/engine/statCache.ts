// The stat cache (01-engine §2 "stat cache"): in memory, per path, the lstat seen by the path's last staged read,
// its detection id and whether its stage copy equals S_raw[p]. It replaces the private index's stat data as the
// source of stat-dirtiness (private-index entries are written from stage copies, glossary §26.1 W1). Emptied at
// daemon start (it is never persisted), join, lost state and every private-index reseed.
import type { Oid } from '../git/oid.js';
import type { FsLstat } from '../ports/fs.js';

export interface StatEntry {
  stat: FsLstat | null;                          // null: missing at the last look
  id: Oid | null;                                // detection id (null for a removal)
  state: 'clean' | 'dirty';
  missingSinceMono?: number;                     // deletion confirmation
  shrink?: { stat: FsLstat; firstMono: number; ticks: number };   // shrink guard
}

export class StatCache {
  private readonly map = new Map<string, StatEntry>();

  get(path: string): StatEntry | undefined {
    return this.map.get(path);
  }

  set(path: string, e: StatEntry): void {
    this.map.set(path, e);
  }

  delete(path: string): void {
    this.map.delete(path);
  }

  clear(): void {
    this.map.clear();
  }

  entries(): IterableIterator<[string, StatEntry]> {
    return this.map.entries();
  }

  get size(): number {
    return this.map.size;
  }
}
