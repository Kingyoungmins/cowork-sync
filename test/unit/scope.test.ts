import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AttrSnapshot, PathAttrs } from '../../src/data/attrs.js';
import { DEFAULT_TEAM_CONFIG, type TeamConfig } from '../../src/data/config.js';
import {
  HUGE_BYTES, NEW_FILE_CAP, QUARANTINE_PATTERNS, SECRET_LIKE_PATTERNS, TEMP_PATTERNS,
  admitNew, isDotGitAlias, isQuarantined, portable, scopeOfTracked, validGlob, wildmatch, type ScopeInputs,
} from '../../src/data/scope.js';
import { parseOid } from '../../src/git/oid.js';

const EPOCH = parseOid('1'.repeat(40));
const NO_ATTRS: PathAttrs = { filter: null, merge: null, text: null, binary: false, eol: null, generated: false, coworkOff: false };

function attrsOf(table: Record<string, Partial<PathAttrs>> = {}): AttrSnapshot {
  return { epochBase: EPOCH, get: (p: string): PathAttrs => ({ ...NO_ATTRS, ...(table[p] ?? {}) }) };
}

function cfg(sync: Partial<TeamConfig['sync']> = {}): TeamConfig {
  return { ...DEFAULT_TEAM_CONFIG, sync: { ...DEFAULT_TEAM_CONFIG.sync, ...sync } };
}

function inputs(table: Record<string, Partial<PathAttrs>> = {}, sync: Partial<TeamConfig['sync']> = {}, extra: Partial<ScopeInputs> = {}): ScopeInputs {
  return { attrs: attrsOf(table), config: cfg(sync), mergeDrivers: new Set(), localOnlyPaths: new Set(), hooksPathDir: null, ...extra };
}

test('D5 row by row, first match wins', () => {
  const live = (path: string, inp = inputs(), mode: '100644' | '100755' | '120000' | '160000' = '100644', size = 10) => scopeOfTracked(path, mode, size, inp);

  // row 1: quarantine beats everything below, including an invalid name, a symlink mode and a huge size
  assert.deepEqual(live('.github/workflows/ci.yml'), { cls: 'QUARANTINED', reason: 'quarantine' });
  assert.deepEqual(live('.claude/settings.json', inputs({ '.claude/settings.json': { filter: 'lfs' } }), '120000', HUGE_BYTES), { cls: 'QUARANTINED', reason: 'quarantine' });
  assert.deepEqual(live('hooks/pre-commit', inputs({}, {}, { hooksPathDir: 'hooks' })), { cls: 'QUARANTINED', reason: 'quarantine' });

  // row 1a: an invalid path string is UNMANAGED (portability) before mode, lfs, ... rows
  assert.deepEqual(live('docs/12:30-notes.md'), { cls: 'UNMANAGED', reason: 'portability' });
  assert.deepEqual(live('a\\b', inputs({ 'a\\b': { filter: 'lfs' } }), '160000'), { cls: 'UNMANAGED', reason: 'portability' });
  // the stricter D7 rules are NOT applied to tracked paths (a Linux-only team keeps syncing aux.c)
  assert.deepEqual(live('src/aux.c'), { cls: 'LIVE', reason: null });
  assert.deepEqual(live('Readme.md'), { cls: 'LIVE', reason: null });

  // row 2: modes
  assert.deepEqual(live('vendor/lib', inputs({ 'vendor/lib': { filter: 'lfs' } }), '160000'), { cls: 'UNMANAGED', reason: 'submodule' });
  assert.deepEqual(live('link', inputs({ link: { filter: 'lfs' } }), '120000'), { cls: 'UNMANAGED', reason: 'symlink' });

  // row 3: lfs
  assert.deepEqual(live('big.bin', inputs({ 'big.bin': { filter: 'lfs', generated: true } })), { cls: 'UNMANAGED', reason: 'lfs' });
  // a non-lfs filter is an ordinary LIVE path (filtered paths are hashed by route (b))
  assert.deepEqual(live('s.k', inputs({ 's.k': { filter: 'secret' } })), { cls: 'LIVE', reason: null });

  // row 4: generated / cowork-sync=off
  assert.deepEqual(live('gen.js', inputs({ 'gen.js': { generated: true } }, { exclude: ['gen.js'] })), { cls: 'UNMANAGED', reason: 'generated' });
  assert.deepEqual(live('off.txt', inputs({ 'off.txt': { coworkOff: true } })), { cls: 'UNMANAGED', reason: 'generated' });

  // row 5: sync.exclude
  assert.deepEqual(live('dist/out.js', inputs({}, { exclude: ['dist/**'] })), { cls: 'UNMANAGED', reason: 'excluded-by-config' });
  assert.deepEqual(live('a/b/out.log', inputs({}, { exclude: ['*.log'] })), { cls: 'UNMANAGED', reason: 'excluded-by-config' });
  // row 5 beats rows 6-8
  assert.deepEqual(live('sub/.gitignore', inputs({}, { exclude: ['.gitignore'] })), { cls: 'UNMANAGED', reason: 'excluded-by-config' });

  // row 6: .gitignore at any level
  assert.deepEqual(live('.gitignore'), { cls: 'SAVE_ONLY', reason: 'save-only' });
  assert.deepEqual(live('a/b/.gitignore', inputs({ 'a/b/.gitignore': { merge: 'ours' } }, {}, { mergeDrivers: new Set(['ours']) })), { cls: 'SAVE_ONLY', reason: 'save-only' });

  // row 7: configured custom merge driver; builtin names are not drivers
  assert.deepEqual(live('m.dat', inputs({ 'm.dat': { merge: 'ours' } }, {}, { mergeDrivers: new Set(['ours']) })), { cls: 'SAVE_ONLY', reason: 'merge-driver' });
  assert.deepEqual(live('m.dat', inputs({ 'm.dat': { merge: 'union' } }, {}, { mergeDrivers: new Set(['ours']) })), { cls: 'LIVE', reason: null });
  assert.deepEqual(live('m.dat', inputs({ 'm.dat': { merge: 'ours' } })), { cls: 'LIVE', reason: null });
  // row 7 beats row 8
  assert.deepEqual(live('m.dat', inputs({ 'm.dat': { merge: 'ours' } }, {}, { mergeDrivers: new Set(['ours']) }), '100644', HUGE_BYTES), { cls: 'SAVE_ONLY', reason: 'merge-driver' });

  // row 8: >= 50 MiB
  assert.equal(HUGE_BYTES, 52_428_800);
  assert.deepEqual(live('h.bin', inputs(), '100644', HUGE_BYTES - 1), { cls: 'LIVE', reason: null });
  assert.deepEqual(live('h.bin', inputs(), '100644', HUGE_BYTES), { cls: 'SAVE_ONLY', reason: 'huge' });

  // row 9 (no Plan 2 source, implemented from ScopeInputs): a local_only record
  assert.equal(live('lo.txt', inputs({}, {}, { localOnlyPaths: new Set(['lo.txt']) })).cls, 'LOCAL_ONLY');

  // row 8 beats row 9
  assert.deepEqual(live('lo.bin', inputs({}, {}, { localOnlyPaths: new Set(['lo.bin']) }), '100644', HUGE_BYTES), { cls: 'SAVE_ONLY', reason: 'huge' });

  // row 10
  assert.deepEqual(live('src/a.txt'), { cls: 'LIVE', reason: null });
  assert.deepEqual(live('run.sh', inputs(), '100755'), { cls: 'LIVE', reason: null });
});

test('D6 order, first match wins', () => {
  const no = (entry: string, size = 5, symlink = false, inp = inputs(), others: ReadonlySet<string> = new Set()) => admitNew(entry, size, symlink, others, inp);
  const reason = (s: { cls: string; reason: string | null }): string | null => (s.cls === 'NOT_ADMITTED' ? s.reason : `ADMITTED:${s.cls}`);

  // 1. directory (nested repo) or .claude/worktrees/
  assert.equal(reason(no('sub/repo/')), 'nested-repo');
  assert.equal(reason(no('.claude/worktrees/wt1/a.txt')), 'nested-repo');
  assert.equal(reason(no('x/.env/', 5, false, inputs({}, { allowSecretLike: ['x/.env/'] }))), 'nested-repo');
  // 2. temp (case-insensitive basename), before secret-like and quarantine
  for (const t of ['a.swp', 'dir/.a.swo', 'dir/4913', '#x#', '.#lock', 'a~', 'a.ORIG', 'x___jb_tmp___', 'x___jb_old___', '~$doc.docx', '~wrd0001.tmp', '.DS_Store', 'sub/THUMBS.DB', 'Desktop.ini', '.vs/x/y.suo', 'proj/.vs/slnx.sqlite']) {
    assert.equal(reason(no(t)), 'temp', t);
  }
  assert.equal(reason(no('.claude/a.swp')), 'temp');
  assert.equal(reason(no('id_rsa~')), 'temp');
  // 3. secret-like (case-insensitive), exact allowSecretLike exempt
  for (const t of ['.env', 'cfg/.ENV.local', 'k.pem', 'a/KEY.KEY', 'x.p12', 'x.pfx', 'id_rsa', 'id_rsa.pub', 'id_ed25519', 'x.keystore', 'my-credentials.json', 'secrets.yml', 'db.kdbx', '.npmrc', '.pypirc', '.netrc', 'a.tfstate', 'x.tfstate.backup', 'appsettings.Prod.json', 'local.settings.json']) {
    assert.equal(reason(no(t)), 'secret-like', t);
  }
  assert.equal(reason(no('.env', 5, false, inputs({}, { allowSecretLike: ['.env'] }))), 'ADMITTED:LIVE');
  assert.equal(reason(no('sub/.env', 5, false, inputs({}, { allowSecretLike: ['.env'] }))), 'secret-like', 'exact paths only');
  const bracket = 'app/api/[r-i]/credentials.ts';
  assert.equal(reason(no(bracket, 5, false, inputs({}, { allowSecretLike: [bracket] }))), 'ADMITTED:LIVE', 'brackets in an allowed path are literal');
  assert.equal(reason(no('app/api/r/credentials.ts', 5, false, inputs({}, { allowSecretLike: [bracket] }))), 'secret-like', 'an allowed path is not a glob');
  // secret-like beats quarantine
  assert.equal(reason(no('.claude/.env')), 'secret-like');
  // 4. quarantine / symlink
  assert.equal(reason(no('.claude/settings.json')), 'quarantine');
  assert.equal(reason(no('CLAUDE.md')), 'quarantine');
  assert.equal(reason(no('link.txt', 5, true)), 'quarantine');
  assert.equal(reason(no('hooks/pre-push', 5, false, inputs({}, {}, { hooksPathDir: 'hooks' }))), 'quarantine');
  // quarantine beats lfs/generated/exclude
  assert.equal(reason(no('.github/workflows/a.yml', 5, false, inputs({ '.github/workflows/a.yml': { filter: 'lfs' } }))), 'quarantine');
  // 5. attribute and config rows, in order
  assert.equal(reason(no('a.bin', 5, false, inputs({ 'a.bin': { filter: 'lfs', generated: true } }, { exclude: ['a.bin'] }))), 'lfs');
  assert.equal(reason(no('g.js', 5, false, inputs({ 'g.js': { generated: true } }, { exclude: ['g.js'] }))), 'generated');
  assert.equal(reason(no('o.js', 5, false, inputs({ 'o.js': { coworkOff: true } }))), 'generated');
  assert.equal(reason(no('x/out.log', 5, false, inputs({}, { exclude: ['*.log'], include: ['*.txt'] }))), 'excluded-by-config');
  assert.equal(reason(no('a.md', 5, false, inputs({}, { include: ['*.txt'] }))), 'not-included');
  assert.equal(reason(no('a.txt', 5, false, inputs({}, { include: ['*.txt'] }))), 'ADMITTED:LIVE');
  assert.equal(reason(no('sub/.gitignore')), 'save-only');
  assert.equal(reason(no('m.dat', 5, false, inputs({ 'm.dat': { merge: 'ours' } }, {}, { mergeDrivers: new Set(['ours']) }))), 'merge-driver');
  // 6. portability (D7), with rule 4 against others
  assert.equal(reason(no('bad:name.txt')), 'portability');
  assert.equal(reason(no('docs/aux.txt')), 'portability');
  assert.equal(reason(no('Readme.md', 5, false, inputs(), new Set(['README.md']))), 'portability');
  // 7. size
  assert.equal(NEW_FILE_CAP, 1_048_576);
  assert.equal(reason(no('big.txt', NEW_FILE_CAP)), 'ADMITTED:LIVE');
  assert.equal(reason(no('big.txt', NEW_FILE_CAP + 1)), 'too-large');
  assert.equal(reason(no('mid.txt', 11, false, inputs({}, { maxNewFileBytes: 10 }))), 'too-large');
  // portability beats size
  assert.equal(reason(no('a:b', NEW_FILE_CAP + 1)), 'portability');
  // admitted
  assert.deepEqual(no('src/new.ts'), { cls: 'LIVE', reason: null });
  assert.deepEqual(no('한글/새 파일.md'), { cls: 'LIVE', reason: null });
});

test('tracked-in-live paths are exempt from the 1 MiB new-file cap', () => {
  const inp = inputs();
  const size = NEW_FILE_CAP * 2 + 123; // the team's 1.3 MB hot file and bigger
  assert.deepEqual(scopeOfTracked('docs/hot.md', '100644', size, inp), { cls: 'LIVE', reason: null });
  assert.deepEqual(scopeOfTracked('docs/hot.md', '100644', HUGE_BYTES - 1, inp), { cls: 'LIVE', reason: null });
  assert.equal(admitNew('docs/hot.md', size, false, new Set(), inp).reason, 'too-large');
});

test('D7 rules 1–4, including case-fold and NFC collisions with others and an allowed case-only rename', () => {
  const none = new Set<string>();
  assert.deepEqual(portable('src/a.txt', none), { ok: true });
  assert.deepEqual(portable('한글/파일.md', none), { ok: true });
  assert.deepEqual(portable('a/b c/d.e', none), { ok: true });

  // rule 1: NFD
  assert.deepEqual(portable('café.txt', none), { ok: false, rule: 1 });
  assert.deepEqual(portable('café.txt', none), { ok: true });

  // rule 2: components
  const rule2 = ['', 'a//b', 'a/', '/a', 'a/./b', 'a/../b', '.git/config', 'x/.GIT/y', 'a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b', 'a\\b', 'a\u0001b', 'a\u001fb',
    'x.', 'x ', 'dir./f', 'dir /f', 'CON', 'con.txt', 'Prn', 'aux.c', 'NUL.tar.gz', 'COM1', 'com0.txt', 'LPT9', 'lpt3.log', 'COM¹', 'LPT².x', 'a/aux /b', 'x/CON.d/y'];
  for (const p of rule2) assert.deepEqual(portable(p, none), { ok: false, rule: 2 }, JSON.stringify(p));
  for (const p of ['a/console.txt', 'COM10', 'auxx', 'a.git/x', '.gitignore', 'x/.github/y', 'LPT', 'nul_x']) assert.deepEqual(portable(p, none), { ok: true }, p);
  assert.deepEqual(portable(`${'a'.repeat(256)}`, none), { ok: false, rule: 2 });
  assert.deepEqual(portable('한'.repeat(85), none), { ok: true }); // 255 bytes
  assert.deepEqual(portable('한'.repeat(86), none), { ok: false, rule: 2 }); // 258 bytes

  // rule 3: 200 UTF-16 code units
  const seg = 'd'.repeat(49);
  const p200 = `${seg}/${seg}/${seg}/${seg}`; // 4*49 + 3 = 199
  assert.deepEqual(portable(`${p200}x`, none), { ok: true }); // 200
  assert.deepEqual(portable(`${p200}xy`, none), { ok: false, rule: 3 }); // 201
  const emoji = '😀'.repeat(24); // 48 code units, 96 bytes per component
  const base = [emoji, emoji, emoji, emoji].join('/'); // 195 code units
  assert.deepEqual(portable(`${base}abcde`, none), { ok: true }); // 200
  assert.deepEqual(portable(`${base}abcdef`, none), { ok: false, rule: 3 }); // 201

  // rule 4: case-fold and NFC collisions against others
  assert.deepEqual(portable('Readme.md', new Set(['README.md'])), { ok: false, rule: 4 });
  assert.deepEqual(portable('readme.md', new Set(['README.md'])), { ok: false, rule: 4 });
  assert.deepEqual(portable('README.md', new Set(['README.md'])), { ok: true }, 'same path is not a collision');
  assert.deepEqual(portable('src/Foo.ts', new Set(['src/foo.ts', 'other'])), { ok: false, rule: 4 });
  assert.deepEqual(portable('Src/new.ts', new Set(['src/old.ts'])), { ok: false, rule: 4 }, 'directory prefix collision');
  assert.deepEqual(portable('src/new.ts', new Set(['Src/old.ts'])), { ok: false, rule: 4 });
  assert.deepEqual(portable('src/new.ts', new Set(['src/old.ts'])), { ok: true });
  assert.deepEqual(portable('a/B', new Set(['a/b/c'])), { ok: false, rule: 4 }, 'file against a directory prefix');
  // NFC collision: an NFD sibling already exists (e.g. from a mac peer); p itself is NFC
  assert.deepEqual(portable('café.txt', new Set(['café.txt'])), { ok: false, rule: 4 });
  // an allowed case-only rename: the old spelling is deleted in the same snapshot, so it is not in others
  assert.deepEqual(portable('Readme.md', new Set(['src/a.txt'])), { ok: true });
  // the key folds through upper then lower case ('ß' -> 'SS' -> 'ss')
  assert.deepEqual(portable('straße.txt', new Set(['STRASSE.txt'])), { ok: false, rule: 4 });
  // rule order: 1 before 2 before 3 before 4
  assert.deepEqual(portable('café:x', none), { ok: false, rule: 1 });
  assert.deepEqual(portable(`${'a'.repeat(201)}:`, none), { ok: false, rule: 2 });
});

test('isDotGitAlias: .git spellings, NTFS 8.3 names and NTFS streams, on every platform (ruling P2-DOTGIT)', () => {
  const yes = ['.git', '.GIT', '.Git', '.git.', '.git  ', '.git. .', 'git~1', 'GIT~1', 'GIT~12', 'git~1.', 'Git~3 ', 'a:b', '.git::$INDEX_ALLOCATION',
    '.g\u{200c}it', '\u{feff}.GIT']; // the last two: HFS+ ignores these code points when it compares names
  for (const c of yes) assert.equal(isDotGitAlias(c), true, JSON.stringify(c));
  const no = ['.github', 'git~', 'gitx~1', '.gitignore', 'a.git', 'git', '.git~1', 'git~1a', '..git', '.git_', 'x.git.', 'git~-1', ''];
  for (const c of no) assert.equal(isDotGitAlias(c), false, JSON.stringify(c));
  // D6 never admits a new path through such a component: D7 rule 2 (componentOk).
  for (const p of ['GIT~1/x', 'sub/git~1/hooks/post-checkout', '.Git/config', 'src/.git./x', 'GIT~12']) {
    assert.deepEqual(portable(p, new Set()), { ok: false, rule: 2 }, p);
    assert.deepEqual(admitNew(p, 5, false, new Set(), inputs()), { cls: 'NOT_ADMITTED', reason: 'portability' }, p);
  }
  assert.deepEqual(admitNew('.github/ISSUE_TEMPLATE/a.md', 5, false, new Set(), inputs()), { cls: 'LIVE', reason: null }, 'negative control');
});

test('wildmatch: basename and path patterns, **, case-insensitive built-in lists', () => {
  // no slash: basename at any depth
  assert.equal(wildmatch('*.md', 'README.md'), true);
  assert.equal(wildmatch('*.md', 'docs/deep/README.md'), true);
  assert.equal(wildmatch('*.md', 'README.mdx'), false);
  assert.equal(wildmatch('CHANGELOG*', 'pkg/CHANGELOG-1.0.md'), true);
  assert.equal(wildmatch('a?c', 'abc'), true);
  assert.equal(wildmatch('a?c', 'a/c'), false);
  assert.equal(wildmatch('[abc].txt', 'b.txt'), true);
  assert.equal(wildmatch('[!abc].txt', 'b.txt'), false);
  assert.equal(wildmatch('[!abc].txt', 'd.txt'), true);
  assert.equal(wildmatch('a.b', 'aXb'), false, 'dot is literal');
  assert.equal(wildmatch('a+b', 'a+b'), true, 'regex metacharacters are literal');
  assert.equal(wildmatch('a(b)', 'a(b)'), true);
  // slash: anchored at the root, * does not cross directories
  assert.equal(wildmatch('src/*.ts', 'src/a.ts'), true);
  assert.equal(wildmatch('src/*.ts', 'src/sub/a.ts'), false);
  assert.equal(wildmatch('src/*.ts', 'x/src/a.ts'), false);
  assert.equal(wildmatch('/src/*.ts', 'src/a.ts'), true, 'leading slash anchors');
  assert.equal(wildmatch('/top.txt', 'top.txt'), true);
  assert.equal(wildmatch('/top.txt', 'a/top.txt'), false);
  // **
  assert.equal(wildmatch('dist/**', 'dist/a/b/c.js'), true);
  assert.equal(wildmatch('dist/**', 'dist/c.js'), true);
  assert.equal(wildmatch('dist/**', 'dist'), false);
  assert.equal(wildmatch('dist/**', 'x/dist/c.js'), false);
  assert.equal(wildmatch('**/logs/*.log', 'logs/a.log'), true);
  assert.equal(wildmatch('**/logs/*.log', 'a/b/logs/a.log'), true);
  assert.equal(wildmatch('**/logs/*.log', 'a/b/logs/c/a.log'), false);
  assert.equal(wildmatch('a/**/z', 'a/z'), true);
  assert.equal(wildmatch('a/**/z', 'a/b/c/z'), true);
  assert.equal(wildmatch('a/**/z', 'ab/z'), false);
  assert.equal(wildmatch('.github/workflows/**', '.github/workflows/ci.yml'), true);
  // `**` only as a whole segment; elsewhere it is a plain `*` that stays inside one component.
  // Every negative uses a pattern WITH a slash (anchored to the whole path) so it only turns true if a wildcard crossed '/'.
  assert.equal(wildmatch('q/a**b', 'q/axxb'), true, 'positive control');
  assert.equal(wildmatch('q/a**b', 'q/ax/yb'), false);
  assert.equal(wildmatch('foo/**bar', 'foo/xbar'), true, 'positive control');
  assert.equal(wildmatch('foo/**bar', 'foo/x/ybar'), false);
  assert.equal(wildmatch('foo/bar**', 'foo/barx'), true, 'positive control');
  assert.equal(wildmatch('foo/bar**', 'foo/barx/y'), false);
  assert.equal(wildmatch('**', 'a/b/c'), true);
  assert.equal(wildmatch('**/b', 'a/b'), true);
  assert.equal(wildmatch('**/b', 'b'), true);
  // '*', '?' and bracket classes never match '/'; each pair is (crossing path -> false, same shape without '/' -> true)
  assert.equal(wildmatch('a*b/z', 'axxb/z'), true, 'positive control');
  assert.equal(wildmatch('a*b/z', 'a/b/z'), false);
  assert.equal(wildmatch('a*b/z', 'a/x/b/z'), false);
  assert.equal(wildmatch('a?b/z', 'axb/z'), true, 'positive control');
  assert.equal(wildmatch('a?b/z', 'a/b/z'), false);
  assert.equal(wildmatch('a[!x]b/z', 'ayb/z'), true, 'positive control');
  assert.equal(wildmatch('a[!x]b/z', 'a/b/z'), false);
  assert.equal(wildmatch('a[^x]b/z', 'ayb/z'), true, 'positive control');
  assert.equal(wildmatch('a[^x]b/z', 'a/b/z'), false);
  assert.equal(wildmatch('a[/x]b/z', 'axb/z'), true, 'positive control');
  assert.equal(wildmatch('a[/x]b/z', 'a/b/z'), false);
  assert.equal(wildmatch('a[a-z/]b/z', 'aqb/z'), true, 'positive control');
  assert.equal(wildmatch('a[a-z/]b/z', 'a/b/z'), false);
  assert.equal(wildmatch('a[]x]b', 'a]b'), true);
  assert.equal(wildmatch('a[!]x]b', 'a]b'), false);
  assert.equal(wildmatch('a[!]x]b', 'ayb'), true);
  assert.equal(wildmatch('src/*/x', 'src/a/x'), true, 'positive control');
  assert.equal(wildmatch('src/*/x', 'src/a/b/x'), false);
  // trailing slash: a directory pattern matches everything below such a directory
  assert.equal(wildmatch('build/', 'build/x.o'), true);
  assert.equal(wildmatch('build/', 'a/build/x.o'), true);
  assert.equal(wildmatch('build/', 'build'), false);
  assert.equal(wildmatch('build/', 'rebuild/x.o'), false);
  // case-sensitive by default (config globs), insensitive on request (built-in lists)
  assert.equal(wildmatch('*.MD', 'a.md'), false);
  assert.equal(wildmatch('*.MD', 'a.md', true), true);
  assert.equal(wildmatch('SRC/*.ts', 'src/a.ts', true), true);
  assert.equal(wildmatch('SRC/*.ts', 'src/a.ts'), false);

  // built-in lists: case-insensitive basenames
  const matchesAny = (list: readonly string[], p: string): boolean => list.some((pat) => wildmatch(pat, p, true));
  assert.equal(matchesAny(TEMP_PATTERNS, 'X/THUMBS.DB'), true);
  assert.equal(matchesAny(TEMP_PATTERNS, 'a.SWP'), true);
  assert.equal(matchesAny(TEMP_PATTERNS, 'a.txt'), false);
  assert.equal(matchesAny(SECRET_LIKE_PATTERNS, 'a/ID_RSA.pub'), true);
  assert.equal(matchesAny(SECRET_LIKE_PATTERNS, 'a/readme'), false);
  assert.equal(matchesAny(QUARANTINE_PATTERNS, '.CLAUDE/x'), true);
  assert.equal(matchesAny(QUARANTINE_PATTERNS, 'src/.claude/x'), false, 'path patterns are anchored at the root');
});

test('final review minor (ledger Task 4:71): a glob with many stars matches without backtracking (time linear in the path): a committed team-config or insertionMerge glob cannot stall the event loop of every peer', () => {
  const subject = 'a'.repeat(120);
  for (const glob of ['*a*a*a*a*a*a*a*a*a*a*b', 'src/*a*a*a*a*a*a*a*a*a*a*b', '**/*a*a*a*a*a*a*a*a*a*a*b', '*a?a*a[ab]a*a*a*a*a*a*a*c']) {
    const t0 = performance.now();
    for (const ci of [false, true]) {
      assert.equal(wildmatch(glob, subject, ci), false, glob);
      assert.equal(wildmatch(glob, `src/${subject}`, ci), false, glob);
      assert.equal(wildmatch(glob, `x/y/${subject}`, ci), false, glob);
    }
    const ms = performance.now() - t0;
    assert.ok(ms < 250, `${glob}: ${ms.toFixed(0)} ms`);
  }
  // The same globs still match what they should.
  assert.equal(wildmatch('*a*a*a*a*a*a*a*a*a*a*b', `${subject}b`), true);
  assert.equal(wildmatch('src/*a*a*a*a*a*a*a*a*a*a*b', `src/${subject}b`), true);
  assert.equal(wildmatch('**/*a*a*a*a*a*a*a*a*a*a*b', `x/y/${subject}b`), true);
  assert.equal(wildmatch('*A*B', 'xaxb', true), true);
  assert.equal(wildmatch('[A-C]*', 'b.txt', true), true);
  assert.equal(wildmatch('[A-C]*', 'b.txt'), false);
});

test('final review minor (ledger Task 4:72): a POSIX bracket class ([[:alpha:]], anywhere in a bracket expression) is an invalid glob, so a config using one is invalid (defaults) instead of an exclude that silently matches nothing', () => {
  for (const g of ['[[:alpha:]]*', '*.[[:digit:]]', '[![:space:]]x', '[a[:upper:]]', 'src/[^[:alnum:]]/**']) assert.equal(validGlob(g), false, g);
  for (const g of ['[[]x', '[]]x', '[a-z]*', 'a[:]b', '*.md', 'docs/**', '[!:]x']) assert.equal(validGlob(g), true, g);
  assert.equal(validGlob('[z-a]'), false, 'an out-of-order range stays invalid');
  assert.equal(validGlob('[abc'), false, 'an unterminated class stays invalid');
});

test('isQuarantined: the glossary §16 set', () => {
  for (const p of ['.claude/settings.json', '.claude/a/b', '.mcp.json', 'CLAUDE.md', 'AGENTS.md', 'sub/CLAUDE.md', '.husky/pre-commit', '.githooks/x', '.gitattributes', 'sub/.gitattributes',
    '.gitmodules', '.lfsconfig', '.cowork/config.json', '.github/workflows/ci.yml', '.gitlab-ci.yml', 'azure-pipelines.yml', 'azure-pipelines-ci.yml', 'bitbucket-pipelines.yml',
    '.vscode/settings.json', '.vscode/tasks.json', '.vscode/launch.json', '.devcontainer/devcontainer.json', '.devcontainer/x/y', '.envrc', '.Claude/x', 'claude.MD']) {
    assert.equal(isQuarantined(p, null), true, p);
  }
  for (const p of ['src/a.txt', '.vscode/extensions.json', '.github/ISSUE_TEMPLATE/a.md', '.github/CODEOWNERS', 'docs/claude.md.txt', 'x/.claude/a', '.claudeX/a', 'azure-pipelines']) {
    assert.equal(isQuarantined(p, null), false, p);
  }
  assert.equal(isQuarantined('hooks/pre-commit', 'hooks'), true);
  assert.equal(isQuarantined('hooks', 'hooks'), true);
  assert.equal(isQuarantined('hooksX/a', 'hooks'), false);
  assert.equal(isQuarantined('a/hooks/x', 'hooks'), false);
  assert.equal(isQuarantined('a/b/x', 'a/b'), true);
  assert.equal(isQuarantined('hooks/pre-commit', null), false);
});
