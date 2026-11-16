// RegionService (Plan 4 Task 4; 04 §3.1 main-thread side, §3.3, §6 rows "Parse exceeds 400 ms or the worker crashes" and
// "Region read of an oid missing from the object store"; REG-05, REG-06, REG-31, REG-35, INV-REG-READ, R1-014, R1-035, R1-040,
// R1-041, R2-H01; T-REG-13, T-REG-27 (e), (f)). Real git on a file:// fixture clone, real grammars on inlineWorkers; the whole
// suite runs its git calls through readGuard and a recording wrapper, and checks after every test that nothing was written.
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttrCache } from '../../src/data/attrs.js';
import { parseOid, type Oid } from '../../src/git/oid.js';
import type { GitRepo } from '../../src/git/repo.js';
import { realFs } from '../../src/ports/fs.js';
import type { Log, LogParam } from '../../src/ports/log.js';
import { clockBudgets, testBudgetInjector, type BudgetInjector } from '../../src/regions/budgets.js';
import { TableCache } from '../../src/regions/cache.js';
import type { JobResult, RegionJob, RegionWorkers } from '../../src/regions/pool.js';
import { RegionService } from '../../src/regions/service.js';
import { SnapshotStore } from '../../src/regions/snapshots.js';
import type { BlobRef, NoTable, RegionTable, TableOrNone } from '../../src/regions/types.js';
import { inlineWorkers } from '../../src/regions/worker/inline.js';
import { lintSource } from '../../tools/lint/rules.js';
import { commitFiles } from '../helpers/commitFiles.js';
import { hermeticRepo } from '../helpers/hermetic.js';
import { looseObjectCount, readGuard, ReadGuardError } from '../helpers/regionAsserts.js';
import { fixture } from '../helpers/regionFixtures.js';
import { blobIdOf, testRegionRuntime, testSnapshot } from '../helpers/regionRuntime.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { VirtualClock } from '../sim/vclock.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const u8 = (s: string): Buffer => Buffer.from(s, 'utf8');
const PY = u8('import os\n\n\ndef f(a):\n    return a\n\n\nclass K:\n    def m(self):\n        return 1\n');
const MARKERS = u8('def f():\n<<<<<<< ours\n    return 1\n=======\n    return 2\n>>>>>>> theirs\n');
const BINARY = Buffer.concat([u8('def f():\n'), Buffer.from([0, 1, 2, 0x0a])]);

const FILES: Record<string, Buffer> = {
  '.gitattributes': fixture('special/attributes'),
  'a.py': PY,
  'b.py': u8('x = 1\n'),
  'markers.py': MARKERS,
  'bin.py': BINARY,
  'secret.env': u8('TOKEN=x\n'),
  'utf16.txt': u8('hello\n'),
  'm.py': fixture('rc_touch/py_append_after_last_line.post.py'),
  'special/small.md': fixture('special/small.md'),
  'special/big.md': fixture('special/big.md'),
  'special/legacy_cp949.cs': fixture('special/legacy_cp949.cs'),
  'special/nb.ipynb': fixture('special/nb.ipynb'),
};

interface Suite {
  f: RepoFixture;
  base: Oid;
  tree: Oid;
  /** A second tree (FILES plus c.py) that nothing but the view test reads, so its ls-tree reaches git. */
  tree2: Oid;
  plain: GitRepo;
  repo: GitRepo;
  calls: string[][];
  attrCache: AttrCache;
  objects: number;
  refs: string;
  workers: RegionWorkers;
}
let s: Suite;

/** git calls recorded below readGuard (the subcommand and argv of every exec). */
function recording(repo: GitRepo, calls: string[][]): GitRepo {
  return new Proxy(repo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== 'exec' || typeof value !== 'function') return value;
      const exec = value as (args: string[], opts?: unknown) => Promise<unknown>;
      return (args: string[], opts?: unknown): Promise<unknown> => {
        calls.push([...args]);
        return exec.call(receiver, args, opts);
      };
    },
  });
}

const refsOf = async (repo: GitRepo): Promise<string> => (await repo.run(['for-each-ref', '--format=%(refname) %(objectname)'])).stdout.toString('utf8');

before(async () => {
  const f = await makeRepoFixture('region-service');
  const { repo: plain } = hermeticRepo(f);
  const base = await commitFiles(f, FILES);
  const tree = (await plain.readCommit(base)).tree;
  const tree2 = (await plain.readCommit(await commitFiles(f, { ...FILES, 'c.py': u8('y = 2\n') }))).tree;
  const calls: string[][] = [];
  // every service of the suite runs on readGuard over this recording repo
  const repo = recording(plain, calls);
  const attrCache = new AttrCache(repo, realFs);
  await attrCache.snapshot(base, ['a.py']);   // warms git var GIT_ATTR_GLOBAL (AttrCache's one-time personal-files lookup)
  const runtime = await testRegionRuntime();
  s = { f, base, tree, tree2, plain, repo, calls, attrCache, objects: await looseObjectCount(f.paths.gitDir), refs: await refsOf(plain), workers: await inlineWorkers(runtime) };
  calls.length = 0;
});

after(async () => {
  await s.workers.close();
  await s.f.cleanup();
});

/** The region module's git commands (REG-35, R1-040): its reads only. */
const READ_COMMANDS = ['cat-file', 'check-attr', 'ls-tree'];
/** How many recorded calls afterEach has checked; s.calls is never cleared, so the last test sees every call of the suite. */
let checked = 0;

afterEach(async () => {
  assert.equal(await looseObjectCount(s.f.paths.gitDir), s.objects, 'no object was written');
  assert.equal(await refsOf(s.plain), s.refs, 'no ref changed');
  const fresh = s.calls.slice(checked);
  checked = s.calls.length;
  for (const argv of fresh) assert.ok(READ_COMMANDS.includes(argv[0] ?? ''), `a region read ran git ${JSON.stringify(argv)}`);
});

interface Harness {
  service: RegionService;
  jobs: RegionJob[];
  budget: Array<[string, string]>;
  log: Array<{ level: string; code: string; params: Readonly<Record<string, LogParam>> | undefined }>;
  snapshots: SnapshotStore;
  inject: BudgetInjector;
  cache: TableCache;
}

/** A RegionService over the guarded, recording repo and inlineWorkers (or a stub), with a job spy. */
async function harness(o: { workers?: RegionWorkers } = {}): Promise<Harness> {
  const runtime = await testRegionRuntime();
  const jobs: RegionJob[] = [];
  const inner = o.workers ?? s.workers;
  const workers: RegionWorkers = {
    run: <J extends RegionJob>(job: J, priority: Parameters<RegionWorkers['run']>[1], deadline: Parameters<RegionWorkers['run']>[2]): Promise<JobResult<J>> => {
      jobs.push(job);
      return inner.run(job, priority, deadline);
    },
    availability: () => inner.availability(),
    close: async () => undefined,
  };
  const snapshots = new SnapshotStore();
  const inject = testBudgetInjector();
  const clock = new VirtualClock();
  const budget: Array<[string, string]> = [];
  const log: Harness['log'] = [];
  const logPort: Log = { write: (level, code, params) => log.push({ level, code, params }) };
  const cache = new TableCache();
  const service = new RegionService({
    repo: readGuard(s.repo, snapshots), workers, budgets: clockBudgets(clock, inject), cache, snapshots, regionSpec: runtime.regionSpec, log: logPort, clock,
    attrs: (epochBase, paths) => s.attrCache.snapshot(epochBase, paths), privateIndex: join(s.f.paths.gitDir, 'cowork', 'private.index'),
    onBudget: (path, b) => budget.push([path, b]),
  });
  return { service, jobs, budget, log, snapshots, inject, cache };
}

const oidOf = async (path: string): Promise<Oid> => {
  const e = (await s.plain.readTreeMap(s.tree)).get(path);
  assert.ok(e !== undefined, path);
  return e.oid;
};
const isTable = (t: TableOrNone): t is RegionTable => !('kind' in t);
const noTable = (reason: NoTable['reason'], t: TableOrNone): void => {
  assert.ok(!isTable(t), `expected NO_TABLE{${reason}}`);
  assert.equal(t.reason, reason);
};

test('table() builds class 4 and class 6 tables in a worker, cached by blobRef', async () => {
  const h = await harness();
  const o = { epochBase: s.base };
  const a = await h.service.table(await oidOf('a.py'), 'a.py', o);
  assert.ok(isTable(a) && a.grammar === 'python' && a.units.some((u) => u.label.qualname === 'K.m'));
  assert.deepEqual(h.jobs.map((j) => [j.kind, j.kind === 'table' ? j.cls : null]), [['table', 4]]);
  assert.equal(await h.service.table(await oidOf('a.py'), 'a.py', o), a, 'a second call is a cache hit');
  assert.equal(h.jobs.length, 1, 'and runs no job');

  h.jobs.length = 0;
  noTable('grammarless_small', await h.service.table(await oidOf('special/small.md'), 'special/small.md', o));
  noTable('conflict_markers', await h.service.table(await oidOf('markers.py'), 'markers.py', o));
  noTable('binary', await h.service.table(await oidOf('bin.py'), 'bin.py', o));
  noTable('special', await h.service.table(await oidOf('special/nb.ipynb'), 'special/nb.ipynb', o));
  // T-REG-13's attribute rows through the real AttrCache at EPOCH_BASE (special/attributes)
  noTable('special', await h.service.table(await oidOf('secret.env'), 'secret.env', o));
  noTable('special', await h.service.table(await oidOf('utf16.txt'), 'utf16.txt', o));
  noTable('special', await h.service.table(await oidOf('a.py'), 'a.py', { ...o, mode: '120000' }));
  assert.equal(h.jobs.length, 0, 'classes 1, 2, 3 and 5 run no worker job');

  for (const path of ['special/big.md', 'special/legacy_cp949.cs']) {
    h.jobs.length = 0;
    const t = await h.service.table(await oidOf(path), path, o);
    assert.deepEqual(h.jobs.map((j) => [j.kind, j.kind === 'table' ? j.cls : null]), [['table', 6]], path);
    assert.ok(isTable(t), path);
    assert.equal(t.grammar, null, path);
    assert.equal(t.decodable, path.endsWith('.md'), path);
    assert.ok(t.units.length > 1 && t.units.every((u) => u.granularity === 'block' && u.kind === 'block'), path);
  }
  const cp = await h.service.table(await oidOf('special/legacy_cp949.cs'), 'special/legacy_cp949.cs', o);
  assert.ok(isTable(cp) && cp.lineCount === 320);
  assert.equal(h.service.availability().get('python'), 'ok');
  assert.ok(h.log.length === 0 && h.budget.length === 0);
});

test('a parse overrun, a worker crash or a missing object gives NO_TABLE{budget}', async () => {
  const o = { epochBase: s.base };
  // an injected parse overrun
  const h = await harness();
  h.inject.expire('parse', 1);
  noTable('budget', await h.service.table(await oidOf('a.py'), 'a.py', o));
  assert.deepEqual(h.budget, [['a.py', 'parse']]);
  // not cached: the next call parses
  h.jobs.length = 0;
  assert.ok(isTable(await h.service.table(await oidOf('a.py'), 'a.py', o)));
  assert.equal(h.jobs.length, 1);
  assert.equal(h.budget.length, 1);

  // a worker that crashes
  const crashing: RegionWorkers = {
    run: async <J extends RegionJob>(): Promise<JobResult<J>> => ({ kind: 'crashed' }),
    availability: () => s.workers.availability(),
    close: async () => undefined,
  };
  const c = await harness({ workers: crashing });
  noTable('budget', await c.service.table(await oidOf('a.py'), 'a.py', o));
  assert.deepEqual(c.budget, [['a.py', 'parse']]);
  noTable('budget', await c.service.table(await oidOf('a.py'), 'a.py', o));
  assert.equal(c.jobs.length, 2, 'a crash is not cached');

  // a 40-hex oid absent from the object store
  const m = await harness();
  const absent = parseOid('0123456789abcdef0123456789abcdef01234567');
  assert.equal(await m.service.bytes(absent, 'gone.py'), 'MISSING');
  assert.deepEqual(m.log, [{ level: 'warn', code: 'REGION_OBJECT_MISSING', params: { oid: absent, path: 'gone.py' } }]);
  m.log.length = 0;
  noTable('budget', await m.service.table(absent, 'gone.py', o));
  assert.deepEqual(m.log, [{ level: 'warn', code: 'REGION_OBJECT_MISSING', params: { oid: absent, path: 'gone.py' } }], 'exactly one line naming the oid and the path');
  assert.equal(m.jobs.length, 0);
  assert.deepEqual(m.budget, [], 'a missing object is a log line, not REGION_BUDGET');
  assert.equal(await m.service.lines(absent), 'MISSING');
  assert.deepEqual(m.log.at(-1)?.params, { oid: absent }, 'a call without a path logs {oid} only');
  assert.equal(m.cache.get(absent, 'gone.py'), undefined, 'not cached');
});

test('a DiskSnapshotId table equals the stored blob\'s table and never reaches cat-file', async () => {
  const h = await harness();
  const o = { epochBase: s.base };
  const stored = await h.service.table(await oidOf('m.py'), 'm.py', o);
  const id = testSnapshot(h.snapshots, 'm.py', FILES['m.py'] as Buffer);
  const mark = s.calls.length;   // never cleared: the suite's last test checks every call
  const disk = await h.service.table(id, 'm.py', o);
  assert.ok(isTable(disk));
  assert.deepEqual(disk, stored);
  assert.deepEqual(s.calls.slice(mark).filter((a) => a[0] === 'cat-file'), [], 'the snapshot path makes no cat-file call');
  assert.equal(await h.service.bytes(id), FILES['m.py']);
  assert.equal((await h.service.lines(id) as readonly Buffer[]).length, 5_961);
  // the same snapshot read again comes from the cache
  h.jobs.length = 0;
  assert.equal(await h.service.table(id, 'm.py', o), disk);
  assert.equal(h.jobs.length, 0);
});

test('T-REG-27 (e): a snapshot-tick oid passed instead of a DiskSnapshotId degrades, never passes', async () => {
  const h = await harness();
  const bytes = u8('def never_written():\n    return 1\n');
  const tick = blobIdOf(bytes);   // computed in memory: no object exists for it
  assert.equal(await s.plain.hasObject(tick, 'blob'), false);
  noTable('budget', await h.service.table(tick, 'tick.py', { epochBase: s.base }));
  assert.deepEqual(h.log, [{ level: 'warn', code: 'REGION_OBJECT_MISSING', params: { oid: tick, path: 'tick.py' } }]);
});

test('readGuard enforces INV-REG-READ', async () => {
  const snapshots = new SnapshotStore();
  const guarded = readGuard(s.plain, snapshots);   // not the recording repo: these calls are the guard's, not the service's
  const id = testSnapshot(snapshots, 'w.py', u8('working bytes\n'));
  const stored = await oidOf('a.py');
  // a registered DiskSnapshotId oid in a cat-file argv or on its --batch stdin
  await assert.rejects(guarded.run(['cat-file', '-t', id.oid], { okCodes: [0, 1, 128] }), ReadGuardError);
  await assert.rejects(guarded.readBlobs([stored, id.oid]), ReadGuardError);
  await assert.rejects(guarded.hasObject(id.oid, 'blob'), ReadGuardError);
  // a grep that names neither a tree oid nor --cached
  await assert.rejects(guarded.run(['grep', '-e', 'x'], { okCodes: [0, 1] }), ReadGuardError);
  // check-attr without attr.tree reads the working tree's .gitattributes
  await assert.rejects(guarded.run(['check-attr', '-z', '--stdin', 'filter'], { stdin: u8('a.py\u{0}') }), ReadGuardError);
  // let through: cat-file --batch with stored oids, ls-tree <tree>, check-attr under attr.tree, grep with a tree or --cached
  assert.deepEqual(await guarded.readBlobs([stored]), [PY]);
  assert.ok((await guarded.readTreeMap(s.tree)).has('a.py'));
  await guarded.run(['check-attr', '-z', '--stdin', 'filter'], { class: 'attr', attrTree: s.base, stdin: u8('a.py\u{0}') });
  await guarded.run(['grep', '-z', '-n', '-e', 'def', s.tree, '--', 'a.py'], { okCodes: [0, 1] });
  await guarded.run(['grep', '-z', '-n', '-e', 'def', '--cached'], { okCodes: [0, 1, 128] });
  // a released handle's oid is no longer guarded (it names no in-memory bytes)
  snapshots.release('test');
  assert.equal(await guarded.hasObject(id.oid, 'blob'), false);
});

test('view() overlays in-memory entries on a stored tree', async () => {
  const h = await harness();
  const id = testSnapshot(h.snapshots, 'a.py', u8('def a():\n    return 2\n'));
  const v = h.service.view(s.tree2, new Map<string, BlobRef | 'ABSENT'>([['a.py', id], ['gone.py', 'ABSENT']]));
  assert.equal(v.tree, s.tree2);
  assert.deepEqual(await v.entry('a.py'), { blob: id, mode: '100644' });
  assert.equal(await v.entry('gone.py'), 'ABSENT');
  assert.deepEqual(await v.entry('b.py'), { blob: await oidOf('b.py'), mode: '100644' });
  assert.equal(await v.entry('none.py'), 'ABSENT');
  // no stored tree: only the overlay
  const bare = h.service.view(null, new Map<string, BlobRef | 'ABSENT'>([['x.py', id]]));
  assert.deepEqual(await bare.entry('x.py'), { blob: id, mode: '100644' });
  assert.equal(await bare.entry('b.py'), 'ABSENT');
  assert.equal(h.service.view(s.tree).overlay.size, 0);
});

test('the service writes nothing', () => {
  // every git call the services of this suite made went through the recording wrapper, from the first test on (nothing
  // clears s.calls; afterEach checked objects, refs and each test's own calls): only the region module's reads
  assert.ok(s.calls.length > 0);
  assert.deepEqual([...new Set(s.calls.map((a) => a[0]))].sort(), READ_COMMANDS);
});

/** src/regions/** files (repo-relative, forward slashes). */
function regionFiles(dir = 'src/regions'): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(REPO, ...dir.split('/')), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...regionFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('the tree passes L-OFFSETS and L-REGION-WRITE', () => {
  const files = regionFiles();
  assert.ok(files.includes('src/regions/service.ts') && files.includes('src/regions/worker/tables.ts'));
  for (const f of files) {
    const text = readFileSync(join(REPO, ...f.split('/')), 'utf8');
    assert.deepEqual(lintSource(f, text), [], `${f} passes every lint rule`);
    if (f !== 'src/regions/worker/lineTable.ts') assert.doesNotMatch(text, /\bstartIndex\b|\bendIndex\b|\.column\b/u, `${f}: offsets only in lineTable.ts`);
  }
  const lineTable = readFileSync(join(REPO, 'src', 'regions', 'worker', 'lineTable.ts'), 'utf8');
  assert.match(lineTable, /startIndex/u);
  // the rules guard the real code: a planted offset or write fails
  const tables = readFileSync(join(REPO, 'src', 'regions', 'worker', 'tables.ts'), 'utf8');
  assert.deepEqual(lintSource('src/regions/worker/tables.ts', `${tables}\nexport const probe = (n: { startIndex: number }): number => n.startIndex;\n`).map((x) => x.rule), ['L-OFFSETS', 'L-OFFSETS']);
  const service = readFileSync(join(REPO, 'src', 'regions', 'service.ts'), 'utf8');
  assert.deepEqual(lintSource('src/regions/service.ts', `${service}\nexport const probe = (r: GitRepo): unknown => r.run(['update-ref', 'refs/x', 'y']);\n`).map((x) => x.rule), ['L-REGION-WRITE']);
});
