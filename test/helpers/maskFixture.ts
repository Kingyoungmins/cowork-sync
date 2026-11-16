// Shared helpers of the Plan 3 Task 2 MASK tests (05-holds §3.4 item 2, HLD-15, HLD-19, HLD-21): the Task 1 notation, hand-built
// hold records, a real clone whose GitRepo records every git call, and the loose objects of its store. Git is never mocked.
//
// Notation (Task 1 notes): T9 is the 9-line LF text "1\n…9\n" at src/t9.txt; T9{2:two,6:six} replaces lines 2 and 6;
// T9+{4:x1,x2} inserts "x1\nx2\n" after line 4; T9-{3} deletes line 3; B0…B3 are 64-byte binary blobs with a NUL at byte 10.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ABSENT, type Oid, type OidOrAbsent } from '../../src/git/oid.js';
import { GitRepo, type TreeEntry, type TreeMap } from '../../src/git/repo.js';
import type { ScopeClass } from '../../src/data/scope.js';
import type { MaskInputs } from '../../src/holds/mask.js';
import { makeGuard, type HoldBlobs, type HoldKind, type HoldRecord, type HoldState, type Residence } from '../../src/holds/record.js';
import { fixtureContext, makeRepoFixture, type RepoFixture } from './repoFixture.js';
import { spyRunner, type GitCall } from './snapFixture.js';

export const PEER = '0123456789abcdef0123456789abcdef';
export const P = 'src/t9.txt';
export const T9 = '1\n2\n3\n4\n5\n6\n7\n8\n9\n';

/** T9 with line n replaced by text, for every [n, text]. */
export function t9(...edits: Array<[number, string]>): string {
  const rows = T9.split('\n').slice(0, 9);
  for (const [n, s] of edits) rows[n - 1] = s;
  return `${rows.join('\n')}\n`;
}

/** T9+{after: lines…}: the lines inserted after line `after`. */
export function t9Insert(after: number, ...lines: string[]): string {
  const rows = T9.split('\n').slice(0, 9);
  rows.splice(after, 0, ...lines);
  return `${rows.join('\n')}\n`;
}

/** T9-{n}: line n deleted. */
export function t9Delete(n: number): string {
  const rows = T9.split('\n').slice(0, 9);
  rows.splice(n - 1, 1);
  return `${rows.join('\n')}\n`;
}

/** B<k>: 64 bytes of one letter with a NUL at byte 10. */
export function binary(k: number): Buffer {
  const b = Buffer.alloc(64, 0x41 + k);
  b[10] = 0;
  return b;
}

const ULID_TAIL = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** The k-th test ULID (0 ≤ k < 1024): ascending k gives ascending ids (ULID order). */
export function ulidOf(k: number): string {
  return `01ARZ3NDEKTSV4RRFFQ69G5F${ULID_TAIL[Math.floor(k / 32)]}${ULID_TAIL[k % 32]}`;
}

let nextId = 100;

export interface RecordOpts {
  id?: string; rev?: number; kind?: HoldKind; residence?: Residence | null; state?: HoldState; paths?: string[];
  guards?: string[]; local_only?: boolean;
}

/** A hold record as the registry stores it (glossary §9); default: an ON_DISK ACTIVE revert PATCH over src/t9.txt. */
export function record(blobs: HoldBlobs, o: RecordOpts = {}): HoldRecord {
  return {
    id: o.id ?? ulidOf(nextId++), rev: o.rev ?? 1, owner: PEER, kind: o.kind ?? 'PATCH',
    residence: o.residence === undefined ? 'ON_DISK' : o.residence, state: o.state ?? 'ACTIVE', offer: 'none',
    declines: 0, displaced_by: null, paths: [...(o.paths ?? [P])].sort(), blobs, guards: (o.guards ?? ['revert']).map((g) => makeGuard(g)),
    origin: 'human', cs_ids: [], peer_authors: [], local_only: o.local_only ?? false,
    age_anchor: { since_rev: 1, anchor_wall_ms: 0, mono_accum_ms: 0 }, proto: 1,
  };
}

/** The h0/h1 pair of a one-path record. */
export const pair = (h0: OidOrAbsent, h1: OidOrAbsent, path = P): HoldBlobs => ({ h0: { [path]: h0 }, h1: { [path]: h1 } });

/** A tree map with one regular entry per path (ABSENT: no entry). */
export function tmap(entries: Record<string, OidOrAbsent>): Map<string, TreeEntry> {
  const m = new Map<string, TreeEntry>();
  for (const [path, oid] of Object.entries(entries)) if (oid !== ABSENT) m.set(path, { path, mode: '100644', oid });
  return m;
}

/** MaskInputs with every path LIVE and mergeable unless told otherwise. */
export function inputs(A: TreeMap, records: readonly HoldRecord[], o: { scope?: Record<string, ScopeClass>; mergeable?: (p: string) => boolean } = {}): MaskInputs {
  const classes = o.scope ?? {};
  return { A, records, scope: (p) => classes[p] ?? 'LIVE', mergeable: o.mergeable ?? (() => true) };
}

export interface MaskCtx {
  f: RepoFixture; repo: GitRepo; calls: GitCall[];
  blob(s: string | Buffer): Promise<Oid>;
  text(o: OidOrAbsent | undefined): Promise<string>;
}

/** A real clone with a GitRepo recording every call (args and options). */
export async function withMaskRepo(label: string, fn: (c: MaskCtx) => Promise<void>, opts: { files?: Record<string, Buffer>; autocrlf?: boolean } = {}): Promise<void> {
  const f = await makeRepoFixture(label, opts);
  try {
    const calls: GitCall[] = [];
    const repo = new GitRepo(spyRunner(f.runner, calls), f.paths, fixtureContext);
    await fn({
      f, repo, calls,
      blob: (s) => repo.hashBytes(typeof s === 'string' ? Buffer.from(s, 'utf8') : s, true),
      text: async (o) => (o === undefined || o === ABSENT ? '<ABSENT>' : (await repo.readBlob(o)).toString('utf8')),
    });
  } finally {
    await f.cleanup();
  }
}

export const mergeCalls = (calls: readonly GitCall[]): GitCall[] => calls.filter((x) => x.args[0] === 'merge-file');

/** Every loose object id of the clone's store. */
export function looseObjects(f: RepoFixture): Set<string> {
  const dir = join(f.paths.gitDir, 'objects');
  const out = new Set<string>();
  for (const d of readdirSync(dir)) {
    if (!/^[0-9a-f]{2}$/.test(d)) continue;
    for (const rest of readdirSync(join(dir, d))) out.add(`${d}${rest}`);
  }
  return out;
}
