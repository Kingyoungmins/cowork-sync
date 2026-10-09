import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AttrCache, personalAttributeFiles } from '../../src/data/attrs.js';
import { discoverFilters } from '../../src/data/filters.js';
import { parseOid } from '../../src/git/oid.js';
import { realFs } from '../../src/ports/fs.js';
import { commitFiles } from '../helpers/commitFiles.js';
import { hermeticRepo } from '../helpers/hermetic.js';
import { makeRepoFixture } from '../helpers/repoFixture.js';

const NUL = String.fromCharCode(0);
const sha = (clean: string, smudge: string, proc: string, required: string): string =>
  createHash('sha256').update([clean, smudge, proc, required].join(NUL), 'utf8').digest('hex');
const NO_FILTERS = { drivers: [], fingerprint: {}, overCap: null };

test('discoverFilters finds drivers named at EPOCH_BASE and in info/attributes; the fingerprint changes when a clean command changes', async () => {
  const f = await makeRepoFixture('filters');
  try {
    const { repo } = hermeticRepo(f);
    const cfg = (k: string, v: string) => repo.run(['config', k, v]);
    await cfg('filter.crypt.clean', 'cat');
    await cfg('filter.crypt.smudge', 'cat');
    await cfg('filter.spaced.name.process', 'git-filter-server');
    await cfg('filter.spaced.name.required', 'true');
    await cfg('filter.personal.clean', 'tr a b');
    await cfg('filter.unused.clean', 'cat'); // configured but named nowhere: not discovered

    const base = await commitFiles(f, {
      '.gitattributes': '*.sec filter=crypt\n*.sn filter=spaced.name\n*.lfs filter=lfs diff=lfs merge=lfs -text\n*.x -filter\n# *.c filter=commented\n',
      'a.sec': 'x\n',
    });
    // a personal file names one more driver
    await mkdir(join(f.paths.gitDir, 'info'), { recursive: true });
    await writeFile(join(f.paths.gitDir, 'info', 'attributes'), '# comment filter=ignored\n*.pers filter=personal\n');

    const first = await discoverFilters(repo, realFs, base);
    assert.deepEqual(first.drivers, ['crypt', 'lfs', 'personal', 'spaced.name']);
    assert.equal(first.overCap, null);
    assert.deepEqual(Object.keys(first.fingerprint), first.drivers);
    assert.equal(first.fingerprint['crypt'], sha('cat', 'cat', '', ''));
    assert.equal(first.fingerprint['personal'], sha('tr a b', '', '', ''));
    assert.equal(first.fingerprint['spaced.name'], sha('', '', 'git-filter-server', 'true'));
    assert.equal(first.fingerprint['lfs'], sha('', '', '', ''), 'hermetic: no system or global git-lfs config');

    // stable
    assert.deepEqual(await discoverFilters(repo, realFs, base), first);

    // a changed clean command changes that driver's fingerprint only
    await cfg('filter.crypt.clean', 'cat -u');
    const second = await discoverFilters(repo, realFs, base);
    assert.deepEqual(second.drivers, first.drivers);
    assert.notEqual(second.fingerprint['crypt'], first.fingerprint['crypt']);
    assert.equal(second.fingerprint['crypt'], sha('cat -u', 'cat', '', ''));
    assert.equal(second.fingerprint['personal'], first.fingerprint['personal']);
    assert.equal(second.fingerprint['spaced.name'], first.fingerprint['spaced.name']);

    // an EPOCH_BASE without filters and without personal file names none
    await writeFile(join(f.paths.gitDir, 'info', 'attributes'), '');
    const plain = await commitFiles(f, { '.gitattributes': '*.txt text\n', 'a.txt': 'x\n' });
    assert.deepEqual(await discoverFilters(repo, realFs, plain), NO_FILTERS);
    // a commit with no .gitattributes at all
    const bare = await commitFiles(f, { 'a.txt': 'x\n' });
    assert.deepEqual(await discoverFilters(repo, realFs, bare), NO_FILTERS);
  } finally {
    await f.cleanup();
  }
});

test('the fingerprint ignores the runner\'s own forced -c filter.<d>.required flags (no spurious FREEZE)', async () => {
  const f = await makeRepoFixture('filters-cmdscope');
  try {
    const bareRepo = hermeticRepo(f).repo;
    await bareRepo.run(['config', 'filter.crypt.clean', 'cat']);
    await bareRepo.run(['config', 'filter.crypt.smudge', 'cat']);
    const base = await commitFiles(f, { '.gitattributes': '*.sec filter=crypt\n', 'a.sec': 'x\n' });
    const bare = await discoverFilters(bareRepo, realFs, base);
    assert.deepEqual(bare.drivers, ['crypt']);
    const forced = await discoverFilters(hermeticRepo(f, ['crypt', 'ghost']).repo, realFs, base);
    assert.deepEqual(forced.fingerprint['crypt'], bare.fingerprint['crypt']);
    assert.equal(forced.fingerprint['crypt'], sha('cat', 'cat', '', ''));
  } finally {
    await f.cleanup();
  }
});

test('a driver named only in the default global attributes file is discovered (git var GIT_ATTR_GLOBAL)', async () => {
  const f = await makeRepoFixture('filters-xdg');
  try {
    const { repo, xdg } = hermeticRepo(f);
    await writeFile(join(xdg, 'git', 'attributes'), '*.xdg filter=xdgdrv\n');
    await repo.run(['config', 'filter.xdgdrv.clean', 'cat']);
    const base = await commitFiles(f, { 'a.txt': 'x\n' });
    const found = await discoverFilters(repo, realFs, base);
    assert.deepEqual(found.drivers, ['xdgdrv']);
    assert.equal(found.fingerprint['xdgdrv'], sha('cat', '', '', ''));

    // and an edit of that file drops the attribute cache
    const cache = new AttrCache(repo, realFs);
    assert.equal((await cache.snapshot(base, ['p.xdg'])).get('p.xdg').filter, 'xdgdrv');
    await writeFile(join(xdg, 'git', 'attributes'), '*.xdg cowork-sync=off\n');
    const after = (await cache.snapshot(base, ['p.xdg'])).get('p.xdg');
    assert.deepEqual([after.filter, after.coworkOff], [null, true]);
  } finally {
    await f.cleanup();
  }
});

test('hostile .gitattributes content cannot stop the engine: invalid driver names and gitlinks are skipped', async () => {
  const f = await makeRepoFixture('filters-hostile');
  try {
    const good = await f.repo.hashBytes(Buffer.from('*.ok filter=fine\n', 'utf8'), true);
    const bad = await f.repo.hashBytes(Buffer.from('*.x filter=a=b\n*.y filter=\n', 'utf8'), true);
    const scratch = join(f.paths.coworkDir, 'tmp', 'hostile.idx');
    await mkdir(join(f.paths.coworkDir, 'tmp'), { recursive: true });
    const tree = await f.repo.writeTreeMap(new Map([
      ['.gitattributes', { path: '.gitattributes', mode: '100644' as const, oid: good }],
      ['nested/.gitattributes', { path: 'nested/.gitattributes', mode: '100644' as const, oid: bad }],
      ['sub/.gitattributes', { path: 'sub/.gitattributes', mode: '160000' as const, oid: parseOid('2'.repeat(40)) }],
    ]), scratch);
    const base = await f.repo.commitTree({ tree, parents: [], subject: 'hostile', trailers: [] });
    const found = await discoverFilters(hermeticRepo(f).repo, realFs, base);
    assert.deepEqual(found.drivers, ['fine']);
    // later git calls still run with the discovered set
    assert.ok(await hermeticRepo(f, found.drivers).repo.resolve('HEAD'));
  } finally {
    await f.cleanup();
  }
});

test('discovery is capped at 64 drivers and fails closed above the cap (no argv overflow)', async () => {
  const f = await makeRepoFixture('filters-cap');
  try {
    const pad = (i: number): string => String(i).padStart(3, '0');
    const lines = Array.from({ length: 200 }, (_, i) => `*.e${pad(i)} filter=d${pad(i)}`);
    const base = await commitFiles(f, { '.gitattributes': `${lines.join('\n')}\n` });
    const { repo } = hermeticRepo(f);
    const found = await discoverFilters(repo, realFs, base);
    assert.equal(found.overCap, 200, 'the discovered count is reported so the engine can fail closed');
    assert.equal(found.drivers.length, 64);
    assert.deepEqual(found.drivers, [...found.drivers].sort());
    assert.equal(Object.keys(found.fingerprint).length, 64);
    // the capped set is small enough for every later git call
    assert.ok(await hermeticRepo(f, found.drivers).repo.resolve('HEAD'));
    // under the cap nothing is reported
    const small = await commitFiles(f, { '.gitattributes': '*.a filter=one\n' });
    assert.equal((await discoverFilters(repo, realFs, small)).overCap, null);
  } finally {
    await f.cleanup();
  }
});

test('a valueless config key does not desynchronise the --show-scope parse; a symlinked .gitattributes is read as git reads it', async () => {
  const f = await makeRepoFixture('filters-valueless');
  try {
    const { repo } = hermeticRepo(f);
    await appendFile(join(f.paths.gitDir, 'config'), '[filter "vl"]\n\trequired\n\tclean = cat\n[filter "after"]\n\tclean = tr a b\n');
    const good = await f.repo.hashBytes(Buffer.from('*.v filter=vl\n*.w filter=after\n', 'utf8'), true);
    const linkOnly = await f.repo.hashBytes(Buffer.from('*.q filter=throughlink\n', 'utf8'), true);
    await mkdir(join(f.paths.coworkDir, 'tmp'), { recursive: true });
    const tree = await f.repo.writeTreeMap(new Map([
      ['.gitattributes', { path: '.gitattributes', mode: '100644' as const, oid: good }],
      ['lnk/.gitattributes', { path: 'lnk/.gitattributes', mode: '120000' as const, oid: linkOnly }],
    ]), join(f.paths.coworkDir, 'tmp', 'vl.idx'));
    const base = await f.repo.commitTree({ tree, parents: [], subject: 'vl', trailers: [] });
    const found = await discoverFilters(repo, realFs, base);
    // under -c attr.tree git reads a 120000 .gitattributes blob as attribute text, so discovery must too (never looser than git)
    assert.deepEqual(found.drivers, ['after', 'throughlink', 'vl']);
    assert.equal(found.fingerprint['vl'], sha('cat', '', '', 'true'));
    assert.equal(found.fingerprint['after'], sha('tr a b', '', '', ''));
  } finally {
    await f.cleanup();
  }
});

test('the test harness is hermetic: only the private global config and attributes are read', async () => {
  const f = await makeRepoFixture('filters-hermetic');
  try {
    const { repo, xdg, home } = hermeticRepo(f);
    const [, global] = await personalAttributeFiles(repo);
    const norm = (p: string): string => p.split('\\').join('/');
    assert.ok(global !== undefined && norm(global).startsWith(norm(xdg)), `global attributes file ${String(global)} is under the temp XDG dir`);
    // every config value git sees comes from the repo's own config, the private global config or the command line:
    // a leaked system or real global config would show another origin
    const list = (await repo.run(['config', '--list', '--show-origin', '-z'])).stdout.toString('utf8');
    const origins = list.split(NUL).filter((x) => x.startsWith('file:') || x === 'command line:').map((x) => norm(x));
    assert.ok(origins.length > 0);
    for (const o of origins) assert.ok(o === 'command line:' || o.includes(norm(f.root)), `config origin ${o} is not private`);
    // the private files ARE read: a driver named only in the private attributes, configured in the private global config
    await writeFile(join(xdg, 'git', 'attributes'), '*.d filter=decoy\n');
    await writeFile(join(home, 'gitconfig'), '[filter "decoy"]\n\tclean = cat\n');
    const base = await commitFiles(f, { 'a.txt': 'x\n' });
    const found = await discoverFilters(repo, realFs, base);
    assert.deepEqual(found.drivers, ['decoy']);
    assert.equal(found.fingerprint['decoy'], sha('cat', '', '', ''));
  } finally {
    await f.cleanup();
  }
});

test('discovery bounds name length and the total argv bytes, not only the count', async () => {
  const f = await makeRepoFixture('filters-bytes');
  try {
    const { repo } = hermeticRepo(f);
    const attrs = (n: number, len: number): string =>
      `${Array.from({ length: n }, (_, i) => `*.e${i} filter=${String(i).padStart(3, '0')}${'x'.repeat(len - 3)}`).join('\n')}\n`;

    // 64 names of 600 characters: fits the count cap but not the byte bound
    const longNames = await commitFiles(f, { '.gitattributes': attrs(64, 600) });
    const a = await discoverFilters(repo, realFs, longNames);
    assert.equal(a.overCap, 64);
    assert.deepEqual(a.drivers, []);
    assert.ok(await hermeticRepo(f, a.drivers).repo.resolve('HEAD'), 'a later git spawn with the returned drivers works');

    // one name of 200 characters is over the per-name bound
    const one = await commitFiles(f, { '.gitattributes': attrs(1, 200) });
    const b = await discoverFilters(repo, realFs, one);
    assert.equal(b.overCap, 1);
    assert.deepEqual(b.drivers, []);

    // 60 names of 120 characters (within the per-name bound) exceed 8 KiB in total: the returned set stays within it
    const many = await commitFiles(f, { '.gitattributes': attrs(60, 120) });
    const c = await discoverFilters(repo, realFs, many);
    assert.equal(c.overCap, 60);
    const bytes = c.drivers.reduce((n, d) => n + Buffer.byteLength(d, 'utf8') + 24, 0);
    assert.ok(c.drivers.length > 0 && bytes <= 8192, `argv contribution ${bytes}`);

    // 128 characters exactly is allowed
    const edge = await commitFiles(f, { '.gitattributes': attrs(1, 128) });
    const d = await discoverFilters(repo, realFs, edge);
    assert.equal(d.overCap, null);
    assert.equal(d.drivers.length, 1);
  } finally {
    await f.cleanup();
  }
});
