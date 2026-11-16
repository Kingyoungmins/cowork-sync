// Plan 5 Task 1: the canonical root form over a fake RootProbe (R1-203, R1-204 parse half, R1-205; glossary §24 default 12; SEC-21).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonRoot, endpointRoot, findRepo, liveState, sameRoot, type RootProbe } from '../../src/data/canonRoot.js';

/** A fake probe over a table: realpath maps listed spellings, `files` holds text files, `dirs` existing directories; `throws` lists entries lstat
 *  finds whose realpath throws an error with that code (a dangling or looping link, or another failure; '' = an error without a code). */
function fakeProbe(o: { real?: Record<string, string>; dirs?: string[]; files?: Record<string, string>; throws?: Record<string, string> }): RootProbe & { reads: string[] } {
  const dirs = new Set(o.dirs ?? []);
  const files = new Map(Object.entries(o.files ?? {}));
  const real = new Map(Object.entries(o.real ?? {}));
  const throws = new Map(Object.entries(o.throws ?? {}));
  const reads: string[] = [];
  return {
    reads,
    realpathNative: (p) => {
      const code = throws.get(p);
      if (code !== undefined) throw Object.assign(new Error(`${code || 'no code'}: realpath '${p}'`), code === '' ? {} : { code });
      return real.get(p) ?? p;
    },
    exists: (p) => real.has(p) || dirs.has(p) || files.has(p) || throws.has(p),
    readText: (p) => { reads.push(p); return files.get(p) ?? null; },
    isDir: (p) => dirs.has(p),
  };
}

test('canonRoot: c:\\users\\…\\repo\\src\\a.ts, an 8.3 short name and an NFD spelling equal C:/Users/…/repo; a not-yet-existing file resolves through its nearest ancestor', () => {
  const ON_DISK = 'C:\\Users\\Me\\repo\\src\\a.ts';
  const probe = fakeProbe({
    real: { 'c:\\users\\me\\repo\\src\\a.ts': ON_DISK, 'C:\\USERS\\ME~1\\repo\\src\\a.ts': ON_DISK, 'C:\\Users\\Me\\repo\\src': 'C:\\Users\\Me\\repo\\src' },
  });
  assert.equal(canonRoot('c:\\users\\me\\repo\\src\\a.ts', probe, 'win32'), 'c:/Users/Me/repo/src/a.ts');
  assert.equal(canonRoot('C:\\USERS\\ME~1\\repo\\src\\a.ts', probe, 'win32'), 'c:/Users/Me/repo/src/a.ts');
  assert.equal(canonRoot('c:/users/me/repo/src/a.ts', probe, 'win32'), 'c:/Users/Me/repo/src/a.ts', 'forward slashes on win32');
  assert.equal(canonRoot('C:\\Users\\Me\\repo\\src\\new\\b.ts', probe, 'win32'), 'c:/Users/Me/repo/src/new/b.ts');
  const nfd = '/Users/me/re\u{301}po';
  assert.equal(canonRoot(nfd, fakeProbe({ real: { [nfd]: nfd } }), 'darwin'), '/Users/me/r\u{E9}po');

  assert.equal(sameRoot('c:/Users/Me/repo', 'C:/users/me/REPO', 'win32'), true);
  assert.equal(sameRoot('c:/Users/Me/repo', 'C:/users/me/REPO', 'darwin'), true);
  assert.equal(sameRoot('c:/Users/Me/repo', 'C:/users/me/REPO', 'linux'), false);
  assert.equal(sameRoot('/home/me/repo', '/home/me/repo', 'linux'), true);
  assert.equal(sameRoot('/home/me/repo', '/home/me/repo2', 'win32'), false);
});

test('canonRoot: a link lstat finds but realpath cannot resolve (dangling, looping: ENOENT, ENOTDIR, ELOOP) counts as missing; other realpath errors throw (P5-T4-1)', () => {
  // A dangling link at the leaf: the walk goes on to the repo, which realpath resolves (here through a symlinked spelling), and the link's name is kept.
  const leaf = fakeProbe({ real: { '/home/me/r': '/data/repo' }, throws: { '/home/me/r/link': 'ENOENT' } });
  assert.equal(canonRoot('/home/me/r/link', leaf, 'linux'), '/data/repo/link');
  // A dangling link at an ancestor, with components below it that do not exist either.
  assert.equal(canonRoot('/home/me/r/link/sub/x.ts', leaf, 'linux'), '/data/repo/link/sub/x.ts');
  // A link whose target runs through a file (ENOTDIR) and a link loop (ELOOP), at the leaf and at an ancestor.
  const odd = fakeProbe({ real: { '/home/me/r': '/data/repo' }, throws: { '/home/me/r/through-file': 'ENOTDIR', '/home/me/r/loop-a': 'ELOOP' } });
  assert.equal(canonRoot('/home/me/r/through-file/x.ts', odd, 'linux'), '/data/repo/through-file/x.ts');
  assert.equal(canonRoot('/home/me/r/loop-a', odd, 'linux'), '/data/repo/loop-a');
  assert.equal(canonRoot('/home/me/r/loop-a/deeper/x.ts', odd, 'linux'), '/data/repo/loop-a/deeper/x.ts');
  // Two dangling components in a row: the nearest ancestor realpath resolves decides.
  const two = fakeProbe({ real: { '/home/me/r': '/data/repo' }, throws: { '/home/me/r/l1': 'ENOENT', '/home/me/r/l1/l2': 'ELOOP' } });
  assert.equal(canonRoot('/home/me/r/l1/l2/x.ts', two, 'linux'), '/data/repo/l1/l2/x.ts');
  // win32: a dangling junction under C:\Users\Me\repo, either separator, keeps the on-disk spelling of the resolved ancestor.
  const win = fakeProbe({ real: { 'c:\\users\\me\\repo': 'C:\\Users\\Me\\repo' }, throws: { 'c:\\users\\me\\repo\\junction': 'ENOENT' } });
  assert.equal(canonRoot('c:/users/me/repo/junction/x.ts', win, 'win32'), 'c:/Users/Me/repo/junction/x.ts');
  // The repo walk then decides as usual: the .git of the resolved ancestor.
  const repo = fakeProbe({ dirs: ['/r', '/r/.git'], throws: { '/r/link': 'ENOENT' } });
  assert.deepEqual(findRepo(canonRoot('/r/link/x.ts', repo, 'linux'), repo, 'linux'), { kind: 'dir', root: '/r', gitdir: '/r/.git' });
  // Any other realpath failure still throws (fail closed), and so does an error without a code.
  for (const code of ['EACCES', 'EPERM', 'EIO', '']) {
    const p = fakeProbe({ real: { '/home/me/r': '/data/repo' }, throws: { '/home/me/r/locked': code } });
    assert.throws(() => canonRoot('/home/me/r/locked/x.ts', p, 'linux'), (e: unknown) => (e as { code?: string }).code === (code === '' ? undefined : code), code || 'no code');
  }
});

test('endpointRoot lower-cases on win32 and darwin only', () => {
  const gitdir = 'C:\\Users\\Me\\repo\\.git';
  assert.equal(endpointRoot(gitdir, fakeProbe({ dirs: [gitdir] }), 'win32'), 'c:/users/me/repo/.git');
  assert.equal(endpointRoot('/Users/Me/repo/.git', fakeProbe({ dirs: ['/Users/Me/repo/.git'] }), 'darwin'), '/users/me/repo/.git');
  assert.equal(endpointRoot('/home/Me/repo/.git', fakeProbe({ dirs: ['/home/Me/repo/.git'] }), 'linux'), '/home/Me/repo/.git');
  // Locale-independent: dotless i, dotted capital I and a Turkish-style name lower with toLowerCase() of the root locale.
  const turkish = '/Users/\u{130}stanbul/\u{131}I/.git';
  assert.equal(endpointRoot(turkish, fakeProbe({ dirs: [turkish] }), 'darwin'), turkish.toLowerCase());
  assert.equal(turkish.toLowerCase(), '/users/i\u{307}stanbul/\u{131}i/.git');
});

test('findRepo walks to the first .git and parses gitdir: and commondir without git', () => {
  // A .git directory.
  const dirProbe = fakeProbe({ dirs: ['/r', '/r/.git', '/r/src'] });
  assert.deepEqual(findRepo('/r/src/a.ts', dirProbe, 'linux'), { kind: 'dir', root: '/r', gitdir: '/r/.git' });
  assert.deepEqual(findRepo('/r', dirProbe, 'linux'), { kind: 'dir', root: '/r', gitdir: '/r/.git' });
  // A linked worktree: .git file with a relative gitdir:, commondir ../.. in the worktree's gitdir.
  const wt = fakeProbe({
    dirs: ['/r', '/r/.git', '/r/.git/worktrees', '/r/.git/worktrees/wt1', '/r/wt'],
    files: { '/r/wt/.git': 'gitdir: ../.git/worktrees/wt1\n', '/r/.git/worktrees/wt1/commondir': '../..\n' },
  });
  assert.deepEqual(findRepo('/r/wt/src/x.ts', wt, 'linux'), { kind: 'file', root: '/r/wt', commonGitdir: '/r/.git', submodule: false });
  // A submodule: gitdir: ../../.git/modules/sub, no commondir.
  const sub = fakeProbe({
    dirs: ['/r', '/r/.git', '/r/.git/modules', '/r/.git/modules/sub', '/r/libs', '/r/libs/sub'],
    files: { '/r/libs/sub/.git': 'gitdir: ../../.git/modules/sub\r\n' },
  });
  assert.deepEqual(findRepo('/r/libs/sub', sub, 'linux'), { kind: 'file', root: '/r/libs/sub', commonGitdir: '/r/.git/modules/sub', submodule: true });
  // An absolute gitdir: on win32, either separator.
  const win = fakeProbe({
    dirs: ['C:\\r', 'C:\\r\\.git', 'C:\\r\\.git\\worktrees\\w', 'C:\\w'],
    files: { 'C:\\w\\.git': 'gitdir: C:/r/.git/worktrees/w\n', 'C:\\r\\.git\\worktrees\\w\\commondir': '../..\n' },
  });
  assert.deepEqual(findRepo('C:\\w\\a.ts', win, 'win32'), { kind: 'file', root: 'c:/w', commonGitdir: 'c:/r/.git', submodule: false });
  // No .git up to the filesystem root.
  assert.equal(findRepo('/nowhere/x', fakeProbe({ dirs: ['/nowhere'] }), 'linux'), null);
  // A .git file whose target is missing, or that names no gitdir.
  const missing = fakeProbe({ dirs: ['/m'], files: { '/m/.git': 'gitdir: ../gone\n' } });
  assert.deepEqual(findRepo('/m/a', missing, 'linux'), { kind: 'file', root: '/m', commonGitdir: null, submodule: false });
  const garbage = fakeProbe({ dirs: ['/g'], files: { '/g/.git': 'not a gitdir line\n' } });
  assert.deepEqual(findRepo('/g/a', garbage, 'linux'), { kind: 'file', root: '/g', commonGitdir: null, submodule: false });
});

test('liveState compares canonical forms with the DAT-34 case rule', () => {
  const loc = { kind: 'dir', root: 'c:/users/me/repo', gitdir: 'c:/users/me/repo/.git' } as const;
  const live = 'c:/users/me/repo/.git/cowork/live';
  const paused = 'c:/users/me/repo/.git/cowork/paused';
  const named = (content: string, withPaused = false): RootProbe =>
    fakeProbe({ files: { [live]: content, ...(withPaused ? { [paused]: '' } : {}) } });
  assert.equal(liveState(loc, named('C:/Users/Me/repo\n'), 'win32'), 'live');
  assert.equal(liveState(loc, named('C:/Users/Me/repo\n'), 'darwin'), 'live');
  assert.equal(liveState(loc, named('C:/Users/Me/repo\n'), 'linux'), 'nonlive');
  assert.equal(liveState(loc, named('c:/users/me/repo\n'), 'linux'), 'live');
  assert.equal(liveState(loc, named('c:/users/me/repo\r\n'), 'linux'), 'live');
  assert.equal(liveState(loc, fakeProbe({}), 'win32'), 'nonlive');
  assert.equal(liveState(loc, named('c:/users/me/other-worktree\n'), 'win32'), 'nonlive');
  assert.equal(liveState(loc, named('C:/Users/Me/repo\n', true), 'win32'), 'paused');
  assert.equal(liveState(loc, fakeProbe({ files: { [paused]: '' } }), 'win32'), 'nonlive', 'paused without live');
});
