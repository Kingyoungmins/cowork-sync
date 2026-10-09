// DISK_EQ and its many-candidates form (01-engine §3.3; ENG-11; 01-engine test 1, TC-ENG-08; mutant M18).
// Real git on a file:// clone; the working file is only ever read by a staged read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { join, sep } from 'node:path';
import type { FilterSet } from '../../src/data/filters.js';
import { DiskEq, type DiskEqDeps } from '../../src/engine/diskEq.js';
import type { MutantId } from '../../src/engine/deps.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import type { TreeEntry } from '../../src/git/repo.js';
import { seededRandom } from '../../src/ports/random.js';
import { generateBigBomCrlf } from '../sim/fixtures/bigBomCrlf.js';
import { makeSnapFixture, type SnapFixture } from '../helpers/snapFixture.js';

const NO_FILTERS: FilterSet = { drivers: [], fingerprint: {}, overCap: null };
const SECRET: FilterSet = { drivers: ['secret'], fingerprint: {}, overCap: null };

function diskEqFor(s: SnapFixture, opts: { filtered?: (p: string) => boolean; mutants?: MutantId[]; filters?: FilterSet; carried?: (p: string) => boolean } = {}): DiskEq {
  const d: DiskEqDeps = {
    repo: s.repo,
    fs: s.fs,
    stage: s.stage,
    statCache: s.statCache,
    cmpIndex: join(s.tmp, 'cmp.index'),
    addIndex: join(s.tmp, 'add.index'),
    isFiltered: opts.filtered ?? (() => false),
    isText: () => true,
    mutants: new Set(opts.mutants ?? []),
    filters: opts.filters ?? NO_FILTERS,
    isCarried: opts.carried ?? (() => false),
  };
  return new DiskEq(d);
}

function entry(s: SnapFixture, path: string): TreeEntry {
  const e = s.A.get(path);
  assert.ok(e, `A has ${path}`);
  return e;
}

const BIG = generateBigBomCrlf(2_000, seededRandom('t9-diskeq'));

test('DISK_EQ on an i/crlf BOM+CRLF file under core.autocrlf=true is equal across 200 rewrites; mutant M18 reports not equal', async () => {
  // The seed commits with autocrlf=false, so the blob is stored BOM+CRLF (i/crlf); the clone checks it out with autocrlf=true.
  const s = await makeSnapFixture('diskeq-icrlf', { autocrlf: true, files: { 'big.py': BIG, 'README.md': Buffer.from('r\n') } });
  try {
    const x = entry(s, 'big.py');
    assert.ok((await s.repo.readBlob(x.oid)).equals(BIG), 'stored i/crlf, byte-identical to the fixture');
    assert.ok((await fsp.readFile(s.abs('big.py'))).equals(BIG), 'the disk holds the same BOM+CRLF bytes');
    const eq = diskEqFor(s);
    const m18 = diskEqFor(s, { mutants: ['M18'] });
    let notEqual = 0;
    for (let i = 0; i < 200; i++) {
      await s.write('big.py', BIG); // a rewrite: same bytes, new stat
      const r = await eq.eq('big.py', x, x);
      if (!r.equal) notEqual++;
    }
    assert.equal(notEqual, 0, '200 rewrites, 0 "not equal" results (0 mismatch deferrals, 0 phantoms)');
    assert.deepEqual(await m18.eq('big.py', x, x), { equal: false, reason: 'differs' }, 'the hash-object --path comparator misreports i/crlf');
    // A real change is still seen.
    await s.write('big.py', Buffer.concat([BIG, Buffer.from('# one more\r\n')]));
    assert.deepEqual(await eq.eq('big.py', x, x), { equal: false, reason: 'differs' });
    // ABSENT matches ENOENT only.
    assert.deepEqual(await eq.eq('big.py', ABSENT, null), { equal: false, reason: 'differs' });
    await fsp.rm(s.abs('big.py'));
    assert.deepEqual(await eq.eq('big.py', ABSENT, null), { equal: true });
    assert.deepEqual(await eq.eq('big.py', x, x), { equal: false, reason: 'differs' });
    // Every comparison read a stage copy; no stage copy is left behind.
    assert.deepEqual(await fsp.readdir(s.stage.root, { recursive: true }).then((l) => l.filter((n) => n.endsWith('big.py'))), []);
  } finally {
    await s.cleanup();
  }
});

test('a filtered path compares a route (b) id with a route (b) id', async () => {
  const s = await makeSnapFixture('diskeq-filtered', {
    filter: true,
    drivers: ['secret'],
    files: { '.gitattributes': Buffer.from('*.sec filter=secret\n'), 'keys.sec': Buffer.from('k=@@SECRET@@\n'), 'plain.txt': Buffer.from('p\n') },
  });
  try {
    const x = entry(s, 'keys.sec');
    const disk = await fsp.readFile(s.abs('keys.sec'));
    assert.ok(disk.toString('latin1').startsWith('k=COWORK_CANARY_'), 'the working file holds the smudged secret');
    const eq = diskEqFor(s, { filtered: (p) => p.endsWith('.sec'), filters: SECRET });
    s.calls.length = 0;
    await fsp.rm(s.f.peer.filterCountFile, { force: true });
    assert.deepEqual(await eq.eq('keys.sec', x, x), { equal: true });
    // The driver is checked against the discovered set (P2-SNAPFILTERS), then one route (b) call on the stage copy at
    // the repository root: no index refresh, no work tree.
    const subs = s.calls.map((c) => c.args[0]);
    assert.deepEqual(subs, ['check-attr', 'hash-object']);
    const call = s.calls[1]!;
    assert.equal(call.args[1], '--path=keys.sec');
    assert.ok(!call.args.includes('-w'), 'no object written');
    assert.ok(call.args[call.args.length - 1]!.startsWith(s.stage.root), 'hashes the stage copy');
    assert.equal(call.opts.cwd, s.f.paths.workTree);
    assert.equal(call.opts.workTree, undefined);
    assert.match(await fsp.readFile(s.f.peer.filterCountFile, 'utf8'), /^clean keys\.sec$/m, 'the counting clean filter ran');
    // A changed secret: the route (b) id differs from S_raw[p].
    await s.write('keys.sec', Buffer.from(`k=${s.f.peer.canary} v2\n`));
    assert.deepEqual(await eq.eq('keys.sec', x, x), { equal: false, reason: 'differs' });
  } finally {
    await s.cleanup();
  }
});

test('manyCandidates picks the newest matching candidate, matches ABSENT to ENOENT and writes the raw blob only then', async () => {
  const s = await makeSnapFixture('diskeq-many', { files: { 'src/a.txt': Buffer.from('one\ntwo\n'), 'README.md': Buffer.from('r\n') } });
  try {
    const mk = async (bytes: string): Promise<TreeEntry> => ({ path: 'src/a.txt', mode: '100644', oid: await s.repo.hashBytes(Buffer.from(bytes), true) });
    const v3 = await mk('one\ntwo\nthree\n');
    const v2lf = await mk('one\nTWO\n');
    const v2crlf = await mk('one\r\nTWO\r\n');
    const v1 = entry(s, 'src/a.txt');
    const eq = diskEqFor(s);

    // Disk: v2's rows with a CRLF ending on an autocrlf=false clone, so the raw blob (stored as is) is new to the store.
    await s.write('src/a.txt', 'one\r\nTWO');
    const raw2 = await s.repo.hashBytes(Buffer.from('one\r\nTWO'), false);
    assert.equal(await s.repo.hasObject(raw2, 'blob'), false);
    const v2noeol = await mk('one\nTWO');
    const r1 = await eq.manyCandidates('src/a.txt', [v3, v2noeol, v1, ABSENT]);
    assert.equal(r1.read, 'ok');
    assert.deepEqual(r1.match, v2noeol, 'canon(r, c) == c for the newest matching candidate');
    assert.equal(r1.raw, raw2);
    assert.equal(await s.repo.hasObject(raw2, 'blob'), true, 'the raw blob is written in the many-candidates form');

    // Newest first: the first candidate that matches wins.
    await s.write('src/a.txt', 'one\nTWO\n');
    const r2 = await eq.manyCandidates('src/a.txt', [v3, v2crlf, v2lf, v1]);
    assert.deepEqual(r2.match, v2crlf);
    const r3 = await eq.manyCandidates('src/a.txt', [v3, v2lf, v2crlf, v1]);
    assert.deepEqual(r3.match, v2lf);
    const r4 = await eq.manyCandidates('src/a.txt', [v3, v1]);
    assert.equal(r4.match, null, 'no candidate matches');
    assert.ok(r4.raw !== null);

    // ENOENT: ABSENT matches, nothing is read and nothing is written.
    await fsp.rm(s.abs('src/a.txt'));
    const before = await s.loose();
    const calls = s.calls.length;
    const r5 = await eq.manyCandidates('src/a.txt', [v3, ABSENT, v1]);
    assert.deepEqual(r5, { match: ABSENT, raw: null, read: 'missing' });
    assert.deepEqual(await eq.manyCandidates('src/a.txt', [v3, v1]), { match: null, raw: null, read: 'missing' });
    assert.equal(s.calls.length, calls, 'no git call for a missing file');
    assert.deepEqual(await s.loose(), before);

    // A file read from elsewhere (a ring .old) is compared as if it were at p.
    const old = join(s.tmp, '7.old');
    await fsp.writeFile(old, 'one\r\nTWO\r\n');
    const r6 = await eq.manyCandidates('src/a.txt', [v3, v2lf], old);
    assert.deepEqual(r6.match, v2lf);
    assert.equal(r6.read, 'ok');
  } finally {
    await s.cleanup();
  }
});

test('manyCandidates stages a tracked path the user ignores (info/exclude) with add -f', async () => {
  const s = await makeSnapFixture('diskeq-ignored', { files: { 'logs/app.log': Buffer.from('line 1\nline 2\n'), 'README.md': Buffer.from('r\n') } });
  try {
    await fsp.mkdir(join(s.f.paths.gitDir, 'info'), { recursive: true });
    await fsp.appendFile(join(s.f.paths.gitDir, 'info', 'exclude'), '\n*.log\n');
    const x = entry(s, 'logs/app.log');
    const other: TreeEntry = { path: 'logs/app.log', mode: '100644', oid: await s.repo.hashBytes(Buffer.from('older\n'), true) };
    const eq = diskEqFor(s);
    s.calls.length = 0;
    const r = await eq.manyCandidates('logs/app.log', [other, x]);
    assert.deepEqual(r, { match: x, raw: x.oid, read: 'ok' }, 'the ignore rule does not stop the raw blob of a tracked path');
    const add = s.calls.find((c) => c.args[0] === 'add');
    assert.ok(add !== undefined && add.args.includes('-f'), 'add -f');
    assert.equal(add.opts.literalPathspecs, true, 'the pathspec stays literal');
  } finally {
    await s.cleanup();
  }
});

test('a carried or dotgit-alias path is refused in every DISK_EQ form (carried) without an fs or git call, fast path included', async () => {
  const s = await makeSnapFixture('diskeq-carried', { files: { 'README.md': Buffer.from('r\n') } });
  try {
    // aux.c stands for a path of the snapshot's current carry set (DiskEqDeps.isCarried): on Windows a look at it
    // would open the AUX device. The others are carried by their name alone (P2-CARRY, P2-DOTGIT).
    const eq = diskEqFor(s, { carried: (p) => p === 'aux.c' });
    const blob = await s.repo.hashBytes(Buffer.from('x\n'), true);
    const st = await s.fs.lstat(s.abs('README.md'));
    assert.ok(st);
    const PATHS = ['.claude/12:30.md', '.claude/cafe\u{301}.md', 'bad\u{fffd}.txt', 'GIT~1/config', 'git~1/hooks/post-checkout', '.Git/config', 'src/.git./x', 'aux.c'];
    // A clean stat-cache entry must not open the fast path either (the reviewer's GIT~1/config "EQUAL").
    for (const p of PATHS) s.statCache.set(p, { stat: st, id: blob, state: 'clean' });
    s.calls.length = 0;
    s.fs.calls.length = 0;
    for (const p of PATHS) {
      const x: TreeEntry = { path: p, mode: '100644', oid: blob };
      assert.deepEqual(await eq.eq(p, x, x), { equal: false, reason: 'carried' }, p);
      assert.deepEqual(await eq.eq(p, ABSENT, null), { equal: false, reason: 'carried' }, p);
      assert.deepEqual(await eq.eqFile(p, join(s.tmp, '1.old'), x), { equal: false, reason: 'carried' }, p);
      assert.deepEqual(await eq.manyCandidates(p, [x, ABSENT]), { match: null, raw: null, read: 'carried' }, p);
    }
    assert.deepEqual(s.calls, [], 'no git call');
    assert.deepEqual(s.fs.calls, [], 'nothing is read, written or even looked at');
  } finally {
    await s.cleanup();
  }
});

test('an over-cap or unknown filter driver is refused in every DISK_EQ form (filter_failure): never read, never hashed, no raw object', async () => {
  for (const variant of ['unknown', 'overCap'] as const) {
    // unknown: the attribute names `secret`, the discovered set does not, so git would run it without
    // filter.secret.required=true and a failing clean filter would let route (b) -w store the RAW bytes.
    const s = await makeSnapFixture(`diskeq-refused-${variant}`, {
      filter: true,
      drivers: variant === 'overCap' ? ['secret'] : [],
      files: { '.gitattributes': Buffer.from('*.sec filter=secret\n'), 'keys.sec': Buffer.from('k=@@SECRET@@\n'), 'plain.txt': Buffer.from('p\n') },
    });
    try {
      const filters: FilterSet = variant === 'overCap' ? { drivers: ['secret'], fingerprint: {}, overCap: 65 } : { drivers: ['other'], fingerprint: {}, overCap: null };
      const eq = diskEqFor(s, { filtered: (p) => p.endsWith('.sec'), filters });
      const canary = Buffer.from(s.f.peer.canary, 'latin1');
      const plaintextObjects = async (): Promise<number> => {
        const r = await s.f.repo.run(['cat-file', '--batch-all-objects', '--batch']);
        return r.stdout.includes(canary) ? 1 : 0;
      };
      await s.f.repo.run(['config', 'filter.secret.clean', 'node -e "process.exit(3)"']);
      await s.write('keys.sec', `k=${s.f.peer.canary} raw\n`);
      const old = join(s.tmp, '2.old');
      await fsp.writeFile(old, `k=${s.f.peer.canary} old\n`);
      const x = entry(s, 'keys.sec');
      const before = await s.loose();
      s.calls.length = 0;
      s.fs.calls.length = 0;
      const refused = { equal: false, reason: 'filter_failure' };
      assert.deepEqual(await eq.eq('keys.sec', x, x), refused, variant);
      assert.deepEqual(await eq.eq('keys.sec', ABSENT, null), refused, variant);
      assert.deepEqual(await eq.eqFile('keys.sec', old, x), refused, variant);
      assert.deepEqual(await eq.manyCandidates('keys.sec', [x, ABSENT]), { match: null, raw: null, read: 'filter_failure' }, variant);
      assert.ok(!s.calls.some((c) => c.args[0] === 'hash-object' || c.args[0] === 'add'), `${variant}: never hashed or added`);
      assert.deepEqual(s.fs.calls.filter((c) => !c.startsWith('git ')), [], `${variant}: nothing is read or looked at`);
      assert.deepEqual(s.calls.map((c) => c.args[0]), variant === 'overCap' ? [] : ['check-attr', 'check-attr', 'check-attr', 'check-attr'], `${variant}: only the driver lookup`);
      assert.deepEqual(await s.loose(), before, `${variant}: no object`);
      assert.equal(await plaintextObjects(), 0, `${variant}: no object holds the plaintext`);
      // An unfiltered path still compares.
      assert.deepEqual(await eq.eq('plain.txt', entry(s, 'plain.txt'), entry(s, 'plain.txt')), { equal: true });
    } finally {
      await s.cleanup();
    }
  }
});

test('eqFile compares a .old file as if it were at p', async () => {
  const s = await makeSnapFixture('diskeq-old', { autocrlf: true, files: { 'big.py': BIG, 'README.md': Buffer.from('r\n') } });
  try {
    const x = entry(s, 'big.py');
    const eq = diskEqFor(s);
    const m18 = diskEqFor(s, { mutants: ['M18'] });
    const old = join(s.tmp, '3.old');
    await fsp.writeFile(old, BIG);
    s.fs.calls.length = 0;
    // p's index context (i/crlf under autocrlf=true) applies to the bytes of the .old file.
    assert.deepEqual(await eq.eqFile('big.py', old, x), { equal: true });
    assert.deepEqual(await m18.eqFile('big.py', old, x), { equal: false, reason: 'differs' });
    assert.ok(!s.fs.calls.some((c) => c.includes(s.abs('big.py'))), 'the working file at p is never touched');
    assert.ok(s.fs.calls.includes(`readFile ${old}`));
    await fsp.writeFile(old, Buffer.concat([BIG, Buffer.from('# late write\r\n')]));
    assert.deepEqual(await eq.eqFile('big.py', old, x), { equal: false, reason: 'differs' });
    await fsp.rm(old);
    assert.deepEqual(await eq.eqFile('big.py', old, ABSENT), { equal: true });
    assert.deepEqual(await eq.eqFile('big.py', old, x), { equal: false, reason: 'differs' });
  } finally {
    await s.cleanup();
  }
});

test('the clean stat-cache fast path reads nothing, and a comparison never clobbers a dirty stage copy', async () => {
  const s = await makeSnapFixture('diskeq-fast', { files: { 'src/a.txt': Buffer.from('one\n'), 'README.md': Buffer.from('r\n') } });
  try {
    const x = entry(s, 'src/a.txt');
    const st = await s.fs.lstat(s.abs('src/a.txt'));
    assert.ok(st);
    s.statCache.set('src/a.txt', { stat: st, id: x.oid, state: 'clean' });
    const eq = diskEqFor(s);
    s.calls.length = 0;
    s.fs.calls.length = 0;
    assert.deepEqual(await eq.eq('src/a.txt', x, x), { equal: true });
    assert.equal(s.calls.length, 0, 'no git');
    // FB-7: the parent's lstat (a real directory, never a link) precedes the fast path's lstat of p.
    assert.deepEqual(s.fs.calls, [`lstat ${s.abs('src')}`, `lstat ${s.abs('src/a.txt')}`], 'the parent and p lstat\'d, no read');
    // X != S_raw[p]: no fast path.
    const other: TreeEntry = { path: 'src/a.txt', mode: '100644', oid: (await s.repo.hashBytes(Buffer.from('zzz\n'), false)) as Oid };
    assert.deepEqual(await eq.eq('src/a.txt', other, x), { equal: false, reason: 'differs' });

    // The snapshot keeps a dirty copy of p; DISK_EQ reads newer bytes but leaves that copy as it was.
    const copy = await s.stage.write('src/a.txt', Buffer.from('dirty copy\n'));
    s.statCache.set('src/a.txt', { stat: st, id: null, state: 'dirty' });
    await s.write('src/a.txt', 'newer\n');
    assert.deepEqual(await eq.eq('src/a.txt', x, x), { equal: false, reason: 'differs' });
    assert.equal(await fsp.readFile(copy, 'utf8'), 'dirty copy\n');
    // A clean path's copy is deleted after the comparison.
    s.statCache.set('src/a.txt', { stat: st, id: x.oid, state: 'clean' });
    await eq.eq('src/a.txt', x, x);
    await assert.rejects(fsp.stat(copy));
  } finally {
    await s.cleanup();
  }
});

test('final review FB-7: every DISK_EQ form refuses a path beneath a symlink or junction (unreadable) without reading through it, fast path included', async () => {
  const s = await makeSnapFixture('diskeq-fb7-link', { files: { 'README.md': Buffer.from('r\n'), 'src/a.txt': Buffer.from('one\n') } });
  try {
    const d = diskEqFor(s);
    const a = entry(s, 'src/a.txt');
    const st = await s.fs.lstat(s.abs('src/a.txt'));
    s.statCache.set('src/a.txt', { stat: st, id: a.oid, state: 'clean' });
    const root = join(s.f.paths.workTree, '..');
    const outside = join(root, 'outside-diskeq-fb7');
    await fsp.mkdir(outside, { recursive: true });
    await fsp.writeFile(join(outside, 'a.txt'), 'one\n');
    await fsp.rename(s.abs('src'), join(root, 'moved-diskeq-fb7'));
    await fsp.symlink(outside, s.abs('src'), 'junction');
    s.fs.calls.length = 0;
    assert.deepEqual(await d.eq('src/a.txt', a, a), { equal: false, reason: 'unreadable' }, 'eq (and its fast path) refuses');
    assert.deepEqual(await d.eq('src/x.txt', ABSENT, null), { equal: false, reason: 'unreadable' }, 'eq against ABSENT refuses');
    assert.deepEqual(await d.manyCandidates('src/a.txt', [a]), { match: null, raw: null, read: 'unreadable' }, 'manyCandidates refuses');
    assert.equal(s.fs.calls.some((c) => c.startsWith('readFile ') && c.includes(outside)), false);
    assert.equal(s.fs.calls.some((c) => c.startsWith('readFile ') && c.includes(`${sep}src${sep}a.txt`) && !c.includes(s.stage.root)), false, 'nothing beneath the link was read');
  } finally {
    await s.cleanup();
  }
});
