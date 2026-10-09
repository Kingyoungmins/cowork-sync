import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AttrCache, type PathAttrs } from '../../src/data/attrs.js';
import { realFs } from '../../src/ports/fs.js';
import { commitFiles } from '../helpers/commitFiles.js';
import { hermeticRepo } from '../helpers/hermetic.js';
import { makeRepoFixture } from '../helpers/repoFixture.js';

const NONE: PathAttrs = { filter: null, merge: null, text: null, binary: false, eol: null, generated: false, coworkOff: false };

const ATTRIBUTES = [
  '*.sec filter=crypt',
  '*.lfsfile filter=lfs',
  '*.gen linguist-generated',
  '*.nogen -linguist-generated',
  'off.txt cowork-sync=off',
  '*.dat merge=ours',
  '*.union merge=union',
  '*.bin binary',
  '*.txt text',
  '*.rawtxt -text',
  '*.autotxt text=auto',
  '*.crlf text eol=crlf',
  '*.lf eol=lf',
  'docs/*.sec -filter',
  '',
].join('\n');

test('AttrCache: check-attr under attr.tree reads the attributes of EPOCH_BASE for every path', async () => {
  const f = await makeRepoFixture('attrs-basic');
  const { repo } = hermeticRepo(f);
  try {
    const base = await commitFiles(f, { '.gitattributes': ATTRIBUTES, 'a.txt': 'x\n' });
    const cache = new AttrCache(repo, realFs);
    const snap = await cache.snapshot(base, ['k.sec', 'k.lfsfile', 'k.gen', 'k.nogen', 'off.txt', 'k.dat', 'k.union', 'k.bin', 'k.txt', 'k.rawtxt', 'k.autotxt', 'k.crlf', 'k.lf', 'plain.c', 'docs/k.sec', 'sub/deep/k.sec']);
    assert.equal(snap.epochBase, base);
    assert.deepEqual(snap.get('k.sec'), { ...NONE, filter: 'crypt' });
    assert.deepEqual(snap.get('sub/deep/k.sec'), { ...NONE, filter: 'crypt' });
    assert.deepEqual(snap.get('k.lfsfile'), { ...NONE, filter: 'lfs' });
    assert.equal(snap.get('k.gen').generated, true);
    assert.equal(snap.get('k.nogen').generated, false);
    assert.equal(snap.get('off.txt').coworkOff, true);
    assert.equal(snap.get('off.txt').text, 'set');
    assert.equal(snap.get('k.dat').merge, 'ours');
    assert.equal(snap.get('k.union').merge, 'union');
    assert.equal(snap.get('k.bin').binary, true);
    assert.equal(snap.get('k.bin').merge, 'binary', 'the binary macro unsets merge; reported as the builtin binary driver');
    assert.equal(snap.get('k.txt').text, 'set');
    assert.equal(snap.get('k.rawtxt').text, 'unset');
    assert.equal(snap.get('k.autotxt').text, 'auto');
    assert.deepEqual([snap.get('k.crlf').text, snap.get('k.crlf').eol], ['set', 'crlf']);
    assert.equal(snap.get('k.lf').eol, 'lf');
    assert.deepEqual(snap.get('plain.c'), NONE);
    assert.equal(snap.get('docs/k.sec').filter, null, 'a later line unsets the filter');
    assert.throws(() => snap.get('never-asked.c'), /never-asked\.c/);
    // an empty path list is a snapshot with no git call and no entries
    assert.equal((await cache.snapshot(base, [])).epochBase, base);
  } finally {
    await f.cleanup();
  }
});

test('check-attr under attr.tree ignores a working-tree .gitattributes edit', async () => {
  const f = await makeRepoFixture('attrs-worktree');
  const { repo } = hermeticRepo(f);
  try {
    const base = await commitFiles(f, { '.gitattributes': '*.sec filter=crypt\n*.bin binary\n' });
    // a peer's edit lands in the working tree: it empties the file and adds a subdirectory file
    await writeFile(join(f.paths.workTree, '.gitattributes'), '');
    await mkdir(join(f.paths.workTree, 'sub'), { recursive: true });
    await writeFile(join(f.paths.workTree, 'sub', '.gitattributes'), '*.sec -filter\n*.zzz filter=evil\n');
    const snap = await new AttrCache(repo, realFs).snapshot(base, ['k.sec', 'sub/k.sec', 'sub/k.zzz', 'a.bin']);
    assert.equal(snap.get('k.sec').filter, 'crypt');
    assert.equal(snap.get('sub/k.sec').filter, 'crypt');
    assert.equal(snap.get('sub/k.zzz').filter, null);
    assert.equal(snap.get('a.bin').binary, true);

    // without attr.tree the same call would have read the emptied file: prove the test can fail
    const raw = (await f.repo.run(['check-attr', '-z', 'filter', '--', 'k.sec'], { class: 'attr' })).stdout.toString('utf8');
    assert.equal(raw, 'k.sec\0filter\0unspecified\0');
  } finally {
    await f.cleanup();
  }
});

test('personal info/attributes still apply and invalidate the cache when they change', async () => {
  const f = await makeRepoFixture('attrs-personal');
  const { repo } = hermeticRepo(f);
  try {
    const base = await commitFiles(f, { '.gitattributes': '*.sec filter=crypt\n' });
    const info = join(f.paths.gitDir, 'info');
    await mkdir(info, { recursive: true });
    const cache = new AttrCache(repo, realFs);

    // no personal file yet
    let snap = await cache.snapshot(base, ['p.pers', 'k.sec']);
    assert.equal(snap.get('p.pers').coworkOff, false);

    // a personal attribute narrows this peer's decisions, EPOCH_BASE's still apply
    await writeFile(join(info, 'attributes'), '*.pers cowork-sync=off\n');
    snap = await cache.snapshot(base, ['p.pers', 'k.sec']);
    assert.equal(snap.get('p.pers').coworkOff, true, 'info/attributes applies on top of attr.tree');
    assert.equal(snap.get('k.sec').filter, 'crypt');

    // the cached answers are reused while nothing changed (same object content)
    const again = await cache.snapshot(base, ['p.pers']);
    assert.equal(again.get('p.pers').coworkOff, true);

    // the file changes (size differs): the cache is dropped and the new answer is read
    await writeFile(join(info, 'attributes'), '*.other cowork-sync=off\n# no longer p.pers\n');
    snap = await cache.snapshot(base, ['p.pers', 'k.sec', 'x.other']);
    assert.equal(snap.get('p.pers').coworkOff, false, 'a stale cached answer must not survive an info/attributes edit');
    assert.equal(snap.get('x.other').coworkOff, true);

    // core.attributesFile: set, then changed
    const personal = join(f.root, 'my attributes');
    await writeFile(personal, '*.cfgattr merge=mine\n');
    await repo.run(['config', 'core.attributesFile', personal]);
    cache.invalidate();
    snap = await cache.snapshot(base, ['a.cfgattr']);
    assert.equal(snap.get('a.cfgattr').merge, 'mine');
    await writeFile(personal, '*.cfgattr merge=yours-longer\n');
    snap = await cache.snapshot(base, ['a.cfgattr']);
    assert.equal(snap.get('a.cfgattr').merge, 'yours-longer');

    // another EPOCH_BASE drops everything cached for the old one
    const base2 = await commitFiles(f, { '.gitattributes': '*.sec filter=other\n' });
    const s2 = await cache.snapshot(base2, ['k.sec']);
    assert.equal(s2.epochBase, base2);
    assert.equal(s2.get('k.sec').filter, 'other');
  } finally {
    await f.cleanup();
  }
});
