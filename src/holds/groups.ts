// HLD-53 receiver write groups and the 01-engine §3.11 defer reasons. Task 8 seeded the reason type that
// meta.pending persists; Task 11 adds the write-group computation.
import type { Oid } from '../git/oid.js';

/**
 * Why an applicable path keeps A[p] at an apply (01-engine §3.11 defer table, ruling R-05). 'collision',
 * 'unmaterializable' and 'quarantine' are the not-applicable reasons (ruling P2-QUARANTINE-IN adds 'quarantine': an
 * incoming change to a QUARANTINED path is never written live and is listed in meta.pending like the other two).
 */
export type DeferReason = 'fence' | 'read_lease' | 'txn' | 'unreadable' | 'unstable' | 'conflicted_leased' | 'eol_form' | 'local_only_conflict'
  | 'disk_low' | 'locked' | 'mismatch' | 'race' | 'closure' | 'filter_failure' | 'collision' | 'unmaterializable' | 'quarantine';

/** Cowork-CS(-Paths) of LA_C..TIP; a commit without them is one CS of paths(diff(parent, commit)) (HLD-37), built by the caller. */
export interface IncomingCs { commit: Oid; csId: string; paths: string[]; }
export interface WriteGroupsResult { groups: string[][]; deferred: Array<{ paths: string[]; reason: DeferReason }>; }

/**
 * HLD-53, INV-GROUP: connected components of the incoming CSs over the applicable paths of W ∪ D (`applicable`
 * plus the keys of `deferred`), so a closure is iterated to its fixed point; a CS links only its paths in that set.
 * A group with a deferred path is deferred whole: each deferred path keeps its own reason, the rest of the group
 * gets 'closure'; other groups are unaffected (a closure never blocks other closures). A path in no incoming CS
 * is a singleton group. Deterministic: paths sorted within a group, groups ordered by their first path, a
 * deferred group's entries in order of their first path. Pure.
 */
export function writeGroups(incoming: readonly IncomingCs[], applicable: ReadonlySet<string>, deferred: ReadonlyMap<string, DeferReason>): WriteGroupsResult {
  const universe = new Set<string>([...applicable, ...deferred.keys()]);
  // Union-find over the universe.
  const parent = new Map<string, string>();
  for (const p of universe) parent.set(p, p);
  const find = (p: string): string => {
    let root = p;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = p;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // The smaller path is the root, so roots do not depend on the CS order.
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  for (const cs of incoming) {
    let first: string | null = null;
    for (const p of cs.paths) {
      if (!universe.has(p)) continue;
      if (first === null) first = p;
      else union(first, p);
    }
  }

  const components = new Map<string, string[]>();
  for (const p of universe) {
    const root = find(p);
    const members = components.get(root);
    if (members === undefined) components.set(root, [p]);
    else members.push(p);
  }
  const ordered = [...components.values()].map((g) => g.sort()).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));

  const result: WriteGroupsResult = { groups: [], deferred: [] };
  for (const group of ordered) {
    if (!group.some((p) => deferred.has(p))) {
      result.groups.push(group);
      continue;
    }
    const byReason = new Map<DeferReason, string[]>();
    for (const p of group) {
      const reason = deferred.get(p) ?? 'closure';
      const paths = byReason.get(reason);
      if (paths === undefined) byReason.set(reason, [p]);
      else paths.push(p);
    }
    for (const [reason, paths] of byReason) result.deferred.push({ paths, reason });
  }
  return result;
}
