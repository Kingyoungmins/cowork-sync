// PathAttrs.workingTreeEncoding (Plan 4 Task 4; R4-20, OQ-14, R1-004; 04 §3.3 path class 3): AttrCache's one check-attr
// call reads working-tree-encoding with the other attributes, under attr.tree = EPOCH_BASE. Real git, file:// remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttrCache, type PathAttrs } from '../../src/data/attrs.js';
import type { GitRepo } from '../../src/git/repo.js';
import { realFs } from '../../src/ports/fs.js';
import { pathClassOf } from '../../src/regions/pathClass.js';
import { commitFiles } from '../helpers/commitFiles.js';
import { hermeticRepo } from '../helpers/hermetic.js';
import { makeRepoFixture } from '../helpers/repoFixture.js';

const NONE: PathAttrs = { filter: null, merge: null, text: null, binary: false, eol: null, generated: false, coworkOff: false, workingTreeEncoding: null };

/** The repo with every run() argv recorded (AttrCache calls git only through GitRepo.run). */
function spyRepo(repo: GitRepo, calls: string[][]): GitRepo {
  return new Proxy(repo, {
    get(target, prop, receiver) {
      if (prop === 'run') return (args: string[], opts?: Parameters<GitRepo['run']>[1]) => {
        calls.push([...args]);
        return target.run(args, opts);
      };
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

test('working-tree-encoding is read with the other attributes', async () => {
  const f = await makeRepoFixture('attrs-wte');
  const { repo } = hermeticRepo(f);
  try {
    const base = await commitFiles(f, { '.gitattributes': '*.utf16 working-tree-encoding=UTF-16LE\n', 'a.txt': 'x\n' });
    const calls: string[][] = [];
    const snap = await new AttrCache(spyRepo(repo, calls), realFs).snapshot(base, ['a.utf16', 'a.txt']);
    assert.equal(snap.get('a.utf16').workingTreeEncoding, 'UTF-16LE');
    assert.equal(snap.get('a.txt').workingTreeEncoding, null);
    assert.deepEqual(snap.get('a.txt'), NONE, 'every other attribute of a plain path stays unset');
    assert.deepEqual(snap.get('a.utf16'), { ...NONE, workingTreeEncoding: 'UTF-16LE' });

    const checkAttr = calls.filter((a) => a[0] === 'check-attr');
    assert.equal(checkAttr.length, 1, 'one check-attr call for both paths');
    assert.equal(checkAttr[0]!.filter((a) => a === 'working-tree-encoding').length, 1, 'the argv names working-tree-encoding once');
    assert.ok(checkAttr[0]!.includes('filter') && checkAttr[0]!.includes('cowork-sync'), 'the Plan 2 attributes are still read in the same call');
  } finally {
    await f.cleanup();
  }
});

test('working-tree-encoding set without a value is an encoding attribute (path class 3)', async () => {
  const f = await makeRepoFixture('attrs-wte-set');
  const { repo } = hermeticRepo(f);
  try {
    // check-attr answers `set` for a bare attribute and `unset` for `-working-tree-encoding`
    const base = await commitFiles(f, { '.gitattributes': '*.wte working-tree-encoding\n*.off -working-tree-encoding\n', 'a.txt': 'x\n' });
    const snap = await new AttrCache(repo, realFs).snapshot(base, ['a.wte', 'a.off', 'a.txt']);
    assert.equal(snap.get('a.wte').workingTreeEncoding, 'set', 'any value but unspecified/unset is an encoding attribute');
    assert.equal(snap.get('a.off').workingTreeEncoding, null);
    assert.equal(snap.get('a.txt').workingTreeEncoding, null);
    const text = Buffer.from('hello\n', 'utf8');
    assert.equal(pathClassOf('a.wte', text, { mode: '100644', attrs: snap.get('a.wte') }, () => true).cls, 3);
    assert.equal(pathClassOf('a.off', text, { mode: '100644', attrs: snap.get('a.off') }, () => true).cls, 5);
  } finally {
    await f.cleanup();
  }
});
