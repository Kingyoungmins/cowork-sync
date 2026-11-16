// SnapshotStore (04-regions §2 "diskSnapshotId"; REG-35, INV-REG-READ, INV-SECRET; ruling R4-46): the in-memory bytes behind
// every DiskSnapshotId (a working read of the daemon, an F10 result buffer, an edit check's merged M[p]). The bytes never
// leave this store: the handle is (kind, path, oid) only, so it crosses IPC, a board op, a log line or status.json as
// (path, oid), and its oid — computed without writing an object — is never read through cat-file. A handle lives while
// at least one owner token retains it.
import type { DiskSnapshotId, Oid } from './types.js';

/** The bytes of a handle no owner retains any more. Error's own constructor (the contract's `extends Error {}`); the store
 *  throws it with a message naming the handle's path and oid. */
export class SnapshotGoneError extends Error {
  override name = 'SnapshotGoneError';
}

interface Held { readonly id: DiskSnapshotId; readonly bytes: Buffer; readonly owners: Set<string>; }

/** One key per (path, oid): the same content under two paths is two handles. */
const keyOf = (path: string, oid: Oid): string => `${path}\u{0}${oid}`;

export class SnapshotStore {
  private readonly held = new Map<string, Held>();
  private readonly byOwner = new Map<string, Set<string>>();
  /** Live handles per oid (has(oid), the INV-REG-READ guard's question). */
  private readonly oidCount = new Map<Oid, number>();

  /** Registers working bytes under the oid the caller computed without -w (01-engine "Hook requests"); the same (path, oid) returns the same handle; an owner token keeps it alive. */
  register(path: string, oid: Oid, bytes: Buffer, owner: string): DiskSnapshotId {
    const key = keyOf(path, oid);
    let h = this.held.get(key);
    if (h === undefined) {
      h = { id: Object.freeze({ kind: 'disk', path, oid }), bytes, owners: new Set() };
      this.held.set(key, h);
      this.oidCount.set(oid, (this.oidCount.get(oid) ?? 0) + 1);
    }
    this.own(key, h, owner);
    return h.id;
  }

  /** Throws SnapshotGoneError once released. */
  bytes(id: DiskSnapshotId): Buffer {
    return this.live(id).bytes;
  }

  /** Adds an owner to a live handle; a released handle cannot be revived (SnapshotGoneError). */
  retain(id: DiskSnapshotId, owner: string): void {
    this.own(keyOf(id.path, id.oid), this.live(id), owner);
  }

  /** Drops every handle no owner retains. */
  release(owner: string): void {
    const keys = this.byOwner.get(owner);
    if (keys === undefined) return;
    this.byOwner.delete(owner);
    for (const key of keys) {
      const h = this.held.get(key);
      if (h === undefined) continue;
      h.owners.delete(owner);
      if (h.owners.size > 0) continue;
      this.held.delete(key);
      const n = (this.oidCount.get(h.id.oid) ?? 1) - 1;
      if (n > 0) this.oidCount.set(h.id.oid, n);
      else this.oidCount.delete(h.id.oid);
    }
  }

  /** Contract addition (Task 4, for test/helpers/regionAsserts.ts readGuard): whether a live handle carries this oid. */
  has(oid: Oid): boolean {
    return this.oidCount.has(oid);
  }

  /** The number of live handles. */
  get size(): number {
    return this.held.size;
  }

  private live(id: DiskSnapshotId): Held {
    const h = this.held.get(keyOf(id.path, id.oid));
    if (h === undefined) throw new SnapshotGoneError(`disk snapshot released: ${id.path} ${id.oid}`);
    return h;
  }

  private own(key: string, h: Held, owner: string): void {
    h.owners.add(owner);
    let keys = this.byOwner.get(owner);
    if (keys === undefined) {
      keys = new Set();
      this.byOwner.set(owner, keys);
    }
    keys.add(key);
  }
}
