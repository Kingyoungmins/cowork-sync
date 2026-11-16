// Shared helpers of the Plan 3 Task 5 tests (record evaluation and the hold operators): peers on real clones (makeCores with
// the test bootstrap), iterations that materialize the hold paths, records born through the registry with blobs hashed into
// the peer's store, records planted as a newer daemon could have written them, and counters over the peer's git calls. Git is
// never mocked. Notation (Task 1 notes): T9 is "1\n…9\n" at src/t9.txt; T9{2:two} replaces line 2.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { prepareIteration, type IterationCtx } from '../../src/engine/core.js';
import { ABSENT, type Oid, type OidOrAbsent } from '../../src/git/oid.js';
import type { MktreeEntry, TreeEntry, TreeMap } from '../../src/git/repo.js';
import { parseRecord, serializeRecord, type BlobMap, type HoldBlobs, type HoldRecord } from '../../src/holds/record.js';
import type { NewRecord } from '../../src/holds/registry.js';
import { setCrashHandler } from '../../src/ports/crashpoint.js';
import { gitCallsOf, makeCores, type CoreFixture, type CoreOptions, type PeerFixture } from './coreFixture.js';
import { T9 } from './maskFixture.js';
import { LogRecorder } from './publishHelpers.js';
import { testRunner } from './tmp.js';

export const P = 'src/t9.txt';
export const FILES: Record<string, Buffer> = {
  'README.md': Buffer.from('# hold operators\n', 'utf8'),
  [P]: Buffer.from(T9, 'utf8'),
  'src/u9.txt': Buffer.from(T9, 'utf8'),
  'src/other.txt': Buffer.from('other\n', 'utf8'),
};

/** makeCores + bootstrap; cleanup, the crash handler and the scheduler hook always reset. */
export async function withPeers(label: string, opts: Partial<CoreOptions>, fn: (fx: CoreFixture) => Promise<void>): Promise<void> {
  const fx = await makeCores(label, { n: 1, files: FILES, ...opts });
  try {
    await fx.bootstrap();
    await fn(fx);
  } finally {
    setCrashHandler(null);
    fx.scheduler.onYield = null;
    await fx.cleanup();
  }
}

let iteration = 1_000;

/** prepareIteration that must succeed: materialize as given (default 'auto'), hold paths optional, no forced fetch unless asked. */
export async function prepIt(p: PeerFixture, o: { materialize?: boolean | 'auto'; holdPaths?: readonly string[]; forceFetch?: boolean } = {}): Promise<IterationCtx> {
  const r = await prepareIteration(p.core, ++iteration, {
    materialize: o.materialize ?? 'auto', forceFetch: o.forceFetch ?? false, ...(o.holdPaths !== undefined ? { holdPaths: new Set(o.holdPaths) } : {}),
  });
  assert.ok(r.ok, `prepareIteration: ${JSON.stringify(r)}`);
  return r.it;
}

/** A blob written to the peer's store (route (c) bytes). */
export function blob(p: PeerFixture, s: string | Buffer): Promise<Oid> {
  return p.core.repo.hashBytes(typeof s === 'string' ? Buffer.from(s, 'utf8') : s, true);
}

/** A blob's text ('<ABSENT>' for ABSENT). */
export async function text(p: PeerFixture, o: OidOrAbsent | undefined): Promise<string> {
  return o === undefined || o === ABSENT ? '<ABSENT>' : (await p.core.repo.readBlob(o)).toString('utf8');
}

/** A one-path h0/h1 pair. */
export const pair = (h0: OidOrAbsent, h1: OidOrAbsent, path = P): HoldBlobs => ({ h0: { [path]: h0 }, h1: { [path]: h1 } });
/** One-path stages. */
export const stages = (s1: OidOrAbsent, s2: OidOrAbsent, s3: OidOrAbsent, path = P): HoldBlobs => ({ s1: { [path]: s1 }, s2: { [path]: s2 }, s3: { [path]: s3 } });

/** A NewRecord: an ON_DISK ACTIVE `revert` PATCH over P unless overridden. */
export function nr(o: Partial<NewRecord> & { blobs: HoldBlobs }): NewRecord {
  return { kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: [P], guard: 'revert', origin: 'human', cs_ids: [], displaced_by: null, ...o };
}

/** A tree map with one regular entry per path (ABSENT: no entry). */
export function tmap(entries: Record<string, OidOrAbsent>): Map<string, TreeEntry> {
  const m = new Map<string, TreeEntry>();
  for (const [path, oid] of Object.entries(entries)) if (oid !== ABSENT) m.set(path, { path, mode: '100644', oid });
  return m;
}

/** The iteration with A and/or the materialized S_disk replaced (what R1 and the operators read), every other path kept. */
export function withMaps(it: IterationCtx, o: { A?: Record<string, OidOrAbsent>; sDisk?: Record<string, OidOrAbsent> }): IterationCtx {
  const over = (m: TreeMap, e: Record<string, OidOrAbsent>): TreeMap => {
    const out = new Map(m);
    for (const [path, oid] of Object.entries(e)) {
      if (oid === ABSENT) out.delete(path);
      else out.set(path, { path, mode: '100644', oid });
    }
    return out;
  };
  const mat = it.mat ?? null;
  return {
    ...it,
    A: o.A === undefined ? it.A : over(it.A, o.A),
    mat: mat === null || o.sDisk === undefined ? mat : { ...mat, sDiskMap: over(mat.sDiskMap, o.sDisk) },
  };
}

/** The registry commits (CAS update-refs of the holds ref) the peer made while `fn` ran, and fn's result. */
export async function registryCommits<T>(p: PeerFixture, fn: () => Promise<T>): Promise<{ commits: number; result: T }> {
  const from = gitCallsOf(p).length;
  const result = await fn();
  const commits = gitCallsOf(p).slice(from).filter((c) => c.args[0] === 'update-ref' && c.args.includes(p.core.refs.holds)).length;
  return { commits, result };
}

/** The git calls the peer made while `fn` ran. */
export async function callsDuring<T>(p: PeerFixture, fn: () => Promise<T>): Promise<{ calls: ReturnType<typeof gitCallsOf>; result: T }> {
  const from = gitCallsOf(p).length;
  const result = await fn();
  return { calls: gitCallsOf(p).slice(from), result };
}

/** A log recorder installed as the peer's daemon log (core.deps.log is read at each write). */
export function recordLog(p: PeerFixture): LogRecorder {
  const rec = new LogRecorder();
  p.deps.log = rec;
  return rec;
}

/** Every loose object id of the peer's store. */
export function looseObjects(p: PeerFixture): Set<string> {
  const dir = join(p.deps.paths.gitDir, 'objects');
  const out = new Set<string>();
  for (const d of readdirSync(dir)) {
    if (!/^[0-9a-f]{2}$/.test(d)) continue;
    for (const rest of readdirSync(join(dir, d))) out.add(`${d}${rest}`);
  }
  return out;
}

/**
 * Plants `record` in the peer's registry as one more registry commit (as a newer daemon could have written it, e.g. with a guard
 * outside Table 3), keeping every record, blob and local.json entry already there; the registry is then reloaded.
 */
export async function plantRecord(p: PeerFixture, record: HoldRecord): Promise<void> {
  const repo = p.core.repo;
  const ref = p.core.refs.holds;
  const head = await repo.readRef(ref);
  const records = new Map<string, Oid>();
  let local: Oid | null = null;
  if (head !== null) {
    for (const [path, e] of await repo.readTreeMap((await repo.readCommit(head)).tree)) {
      if (path.startsWith('records/')) records.set(path.slice('records/'.length, -'.json'.length), e.oid);
      else if (path === 'local.json') local = e.oid;
    }
  }
  records.set(record.id, await repo.hashBytes(serializeRecord(record), true));
  const named = new Set<string>();
  for (const b of await repo.readBlobs([...records.values()])) {
    for (const m of Object.values(parseRecord(b).blobs) as BlobMap[]) for (const o of Object.values(m)) if (o !== ABSENT) named.add(o);
  }
  const recordEntries: MktreeEntry[] = [...records.keys()].sort().map((id) => ({ name: `${id}.json`, mode: '100644', type: 'blob', oid: records.get(id)! }));
  const blobEntries: MktreeEntry[] = [...named].sort().map((o) => ({ name: o, mode: '100644', type: 'blob', oid: o as Oid }));
  const root = await repo.mktree([
    { name: 'blobs', mode: '040000', type: 'tree', oid: await repo.mktree(blobEntries) },
    ...(local === null ? [] : [{ name: 'local.json', mode: '100644', type: 'blob', oid: local } as MktreeEntry]),
    { name: 'records', mode: '040000', type: 'tree', oid: await repo.mktree(recordEntries) },
  ]);
  const commit = await repo.commitTree({ tree: root, parents: head === null ? [] : [head], subject: 'cowork-holds', trailers: [] });
  assert.equal(await repo.casRef(ref, commit, head, 'cowork-holds'), true);
  await p.core.holds.load();
}

/**
 * Every blob reachable from the bare remote's refs/cowork/* (what left this PC: live code, board commits, held/ subtrees), read
 * test-side with plain git in the remote (`for-each-ref`, `rev-list --objects`, one `cat-file --batch`).
 */
export async function remoteCoworkBlobs(fx: CoreFixture): Promise<Buffer[]> {
  const runner = testRunner();
  const git = async (args: string[], stdin?: Buffer): Promise<Buffer> => {
    const r = await runner.run(args, { class: 'local', cwd: fx.remote.dir, ...(stdin !== undefined ? { stdin } : {}) });
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} in the remote failed (${r.code})`);
    return r.stdout;
  };
  const LF = String.fromCharCode(10);
  const refs = (await git(['for-each-ref', '--format=%(refname)', 'refs/cowork/'])).toString('utf8').split(LF).filter((l) => l.length > 0);
  assert.ok(refs.length > 0, 'the remote has refs/cowork/*');
  const objects = (await git(['rev-list', '--objects', ...refs])).toString('utf8').split(LF).map((l) => l.split(' ')[0]!).filter((o) => o.length > 0);
  const out = await git(['cat-file', '--batch'], Buffer.from(`${objects.join(LF)}${LF}`, 'utf8'));
  const blobs: Buffer[] = [];
  let pos = 0;
  while (pos < out.length) {
    const nl = out.indexOf(0x0a, pos);
    const [, type, size] = out.subarray(pos, nl).toString('latin1').split(' ');
    const n = Number(size);
    if (type === 'blob') blobs.push(out.subarray(nl + 1, nl + 1 + n));
    pos = nl + 1 + n + 1;
  }
  return blobs;
}
