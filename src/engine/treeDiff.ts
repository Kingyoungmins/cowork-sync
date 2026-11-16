// Pure comparisons of tree maps (no git, no I/O), shared by publish and the ENG-41 pre-push asserts.
import type { TreeEntry, TreeMap } from '../git/repo.js';

/** A regular file entry (100644 or 100755): defined once in git/repo.ts (src/data uses it too), re-exported here for src/engine. */
export { isRegularEntry } from '../git/repo.js';

/** The same entry (oid and mode), or both absent. */
export function sameTreeEntry(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && a.oid === b.oid && a.mode === b.mode;
}

/** The paths where two maps differ (either side may lack the path), sorted by code unit. */
export function diffPaths(x: TreeMap, y: TreeMap): string[] {
  const out: string[] = [];
  for (const [p, e] of x) if (!sameTreeEntry(e, y.get(p))) out.push(p);
  for (const p of y.keys()) if (!x.has(p)) out.push(p);
  return out.sort();
}
