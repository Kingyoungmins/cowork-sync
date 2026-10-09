// Room discovery for --repo (Plan 8a Task 7; 12 §3.3.1, §3.3.2; rulings R-V09, R-V24, R-V54; X-63 canonRoot; Review Focus 5):
// real repositories made with git in temp roots whose path holds a space and Hangul; room admission through VizGit; the
// canonical root form of src/data/canonRoot.ts with the real probe and with a fake one (Plan 5's declared examples).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import fc from 'fast-check';
import { canonRoot, type RootProbe } from '../../../src/data/canonRoot.js';
import { enc } from '../../../src/git/enc.js';
import type { GitCallOptions } from '../../../src/git/flags.js';
import { realFs, realRootProbe } from '../../../src/ports/fs.js';
import { fsBoundedReader, realBoundedReader } from '../../../src/viz/source/boundedRead.js';
import { decodeEnc, discoverRooms, roomId, ROOMS_MAX, type Discovery } from '../../../src/viz/source/rooms.js';
import { makeTempRoot, testRunner } from '../../helpers/tmp.js';
import { spiedVizGit, vizRunner, type VizCall } from '../../helpers/vizSource.js';
import { statusBytes } from '../../helpers/vizStatus.js';

const SALT = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const ROOM_ID = /^r[0-9A-HJKMNP-TV-Z]{8}$/;
const WIN = process.platform === 'win32';
const ID = { identity: { name: 'Fixture', email: 'fixture@cowork.invalid' }, wallMsForDates: 1_700_000_000_000 } as const;

async function must(args: string[], cwd: string, opts: Partial<GitCallOptions> = {}): Promise<string> {
  const r = await testRunner().run(args, { class: 'local', cwd, ...opts });
  assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr.toString('utf8')}`);
  return r.stdout.toString('utf8').trim();
}

/** A repository at `dir` with one commit and a board ref per branch in `boards` (refs/cowork-remote/<enc(b)>/board). */
async function repoAt(dir: string, boards: readonly string[]): Promise<void> {
  await must(['init', '-q', '-b', 'main', dir], dir);
  const tree = await must(['hash-object', '-w', '-t', 'tree', '--stdin'], dir, { stdin: Buffer.alloc(0) });
  const c = await must(['commit-tree', tree], dir, { ...ID, stdin: Buffer.from('one\n') });
  for (const b of boards) await must(['update-ref', `refs/cowork-remote/${enc(b)}/board`, c], dir);
  await must(['update-ref', 'refs/cowork-remote/main/code', c], dir);
  await must(['update-ref', 'refs/cowork-local/stale/board', c], dir);
}

function deps(dataDir: string, calls: VizCall[] = []) {
  const runner = vizRunner(dataDir);
  return {
    fs: realFs, reader: realBoundedReader, probe: realRootProbe, salt: SALT, platform: process.platform,
    git: (gitDir: string) => {
      const s = spiedVizGit(runner, gitDir, dataDir);
      s.calls = calls;
      return s.git;
    },
  };
}

function rooms(d: Discovery): Extract<Discovery, { rooms: unknown }> {
  assert.ok('rooms' in d, `refused: ${JSON.stringify(d)}`);
  return d;
}

test('rooms: --repo of a main worktree → its gitdir realpath, the basename label and the decoded branch; a .git file, no board ref, or two board refs without a matching status.json branch → RF_VIZ_REPO_NOT_LIVE', async () => {
  const { root, cleanup } = await makeTempRoot('viz-rooms');
  try {
    const dataDir = join(root, 'data dir');
    const branch = 'feat/\u{D55C}\u{AE00} x';
    const repo = join(root, 'shop app');
    mkdirSync(repo);
    await repoAt(repo, [branch]);
    const calls: VizCall[] = [];
    const d = rooms(await discoverRooms([repo], deps(dataDir, calls)));
    assert.equal(d.more, 0);
    assert.equal(d.rooms.length, 1);
    const r = d.rooms[0]!;
    assert.match(r.id, ROOM_ID);
    assert.deepEqual(
      { kind: r.kind, label: r.label, branch: r.branch, gitDir: r.gitDir, boardRef: r.boardRef, canonicalRoot: r.canonicalRoot },
      { kind: 'git', label: 'shop app', branch, gitDir: realpathSync.native(join(repo, '.git')), boardRef: `refs/cowork-remote/${enc(branch)}/board`, canonicalRoot: canonRoot(repo, realRootProbe, process.platform) },
    );
    assert.equal(r.id, roomId(SALT, r.canonicalRoot!));
    // Room admission is one for-each-ref under refs/cowork-remote/ (R-V09), run with --git-dir from the data directory.
    assert.deepEqual(calls.map((c) => c.args), [['for-each-ref', '--format=%(objectname) %(refname)', 'refs/cowork-remote/']]);

    // A linked worktree or submodule: <path>/.git is a file.
    const linked = join(root, 'linked wt');
    mkdirSync(linked);
    writeFileSync(join(linked, '.git'), `gitdir: ${join(repo, '.git')}\n`);
    assert.deepEqual(await discoverRooms([linked], deps(dataDir)), { refuse: 'RF_VIZ_REPO_NOT_LIVE' }, 'a .git file');
    // Nothing at <path>/.git.
    const plain = join(root, 'plain dir');
    mkdirSync(plain);
    assert.deepEqual(await discoverRooms([plain], deps(dataDir)), { refuse: 'RF_VIZ_REPO_NOT_LIVE' }, 'no .git');
    // No board ref (only a code ref and a cowork-local board).
    const bare = join(root, 'no board');
    mkdirSync(bare);
    await repoAt(bare, []);
    assert.deepEqual(await discoverRooms([bare], deps(dataDir)), { refuse: 'RF_VIZ_REPO_NOT_LIVE' }, 'no board ref');
    // Two board refs: status.json's branch picks one; without a match the room is refused.
    const two = join(root, 'two boards');
    mkdirSync(two);
    await repoAt(two, ['main', 'old-branch']);
    assert.deepEqual(await discoverRooms([two], deps(dataDir)), { refuse: 'RF_VIZ_REPO_NOT_LIVE' }, 'two board refs, no status.json');
    mkdirSync(join(two, '.git', 'cowork'));
    writeFileSync(join(two, '.git', 'cowork', 'status.json'), statusBytes({ branch: 'gone-branch' }));
    assert.deepEqual(await discoverRooms([two], deps(dataDir)), { refuse: 'RF_VIZ_REPO_NOT_LIVE' }, 'two board refs, status.json names neither');
    writeFileSync(join(two, '.git', 'cowork', 'status.json'), statusBytes({ branch: 'old-branch' }));
    const picked = rooms(await discoverRooms([two], deps(dataDir)));
    assert.deepEqual([picked.rooms[0]!.branch, picked.rooms[0]!.boardRef], ['old-branch', 'refs/cowork-remote/old-branch/board']);
    // One refused --repo refuses the run; no --repo at all is no rooms.
    assert.deepEqual(await discoverRooms([repo, plain], deps(dataDir)), { refuse: 'RF_VIZ_REPO_NOT_LIVE' });
    assert.deepEqual(await discoverRooms([], deps(dataDir)), { refuse: 'RF_VIZ_NO_ROOMS' });
    // The fsBoundedReader path reads status.json the same way.
    const viaFs = rooms(await discoverRooms([two], { ...deps(dataDir), reader: fsBoundedReader(realFs) }));
    assert.equal(viaFs.rooms[0]!.branch, 'old-branch');
  } finally {
    await cleanup();
  }
});

/**
 * A spelling of an existing path (Windows) with one 8.3 short-name component: the nearest ancestor with a long ASCII name
 * (the temp directory; cmd prints non-ASCII names in the console code page) replaced by its short form. null when the
 * volume has no short names for it.
 */
function shortName(p: string): string | null {
  for (let a = p; a !== dirname(a); a = dirname(a)) {
    const name = basename(a);
    if (!/^[\x21-\x7e]{9,}$/.test(name)) continue;
    const r = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${a}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true });
    const s = (r.stdout ?? '').trim();
    if (r.status !== 0 || s.length === 0 || s.includes('"') || basename(s).toLowerCase() === name.toLowerCase()) return null;
    return s + p.slice(a.length);
  }
  return null;
}

test('room ids match ^r[0-9A-HJKMNP-TV-Z]{8}$, differ by salt and never contain a path; two spellings of one clone (drive-letter case, a symlinked alias, an 8.3 short name on Windows) are one room; more than 32 rooms → the first 32 and more', async (t) => {
  const { root, cleanup } = await makeTempRoot('viz-room-ids');
  try {
    const dataDir = join(root, 'data dir');
    const repo = join(root, 'clone \u{AE40} one');
    mkdirSync(repo);
    await repoAt(repo, ['main']);
    const one = rooms(await discoverRooms([repo], deps(dataDir))).rooms[0]!;
    assert.match(one.id, ROOM_ID);
    const other = roomId(Buffer.from('ffeeddccbbaa99887766554433221100', 'hex'), one.canonicalRoot!);
    assert.match(other, ROOM_ID);
    assert.notEqual(other, one.id, 'another salt, another id');
    for (const piece of [repo, basename(repo), 'clone', one.canonicalRoot!]) assert.ok(!one.id.includes(piece), `the id holds ${piece}`);

    // Spellings of the same clone: each discovered alone gives the same room; together they are one room.
    const spellings: Array<[string, string]> = [['as given', repo], ['trailing separator', `${repo}${WIN ? '\\' : '/'}`]];
    if (WIN) {
      const drive = repo[0]!;
      spellings.push(['drive-letter case', `${drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()}${repo.slice(1)}`]);
      const short = shortName(repo);
      if (short !== null) spellings.push(['8.3 short name', short]);
      else t.diagnostic('8.3 leg skipped: no short name on this volume (8.3 generation off)');
    }
    const alias = join(root, 'alias of clone');
    try {
      symlinkSync(repo, alias, WIN ? 'junction' : 'dir');
      spellings.push([WIN ? 'junction alias' : 'symlinked alias', alias]);
    } catch {
      t.diagnostic('alias leg skipped: no symlink or junction could be made');
    }
    for (const [label, p] of spellings) {
      const r = rooms(await discoverRooms([p], deps(dataDir))).rooms[0]!;
      assert.deepEqual([r.id, r.canonicalRoot, r.gitDir], [one.id, one.canonicalRoot, one.gitDir], label);
    }
    const all = rooms(await discoverRooms(spellings.map(([, p]) => p), deps(dataDir)));
    assert.deepEqual([all.rooms.length, all.more, all.rooms[0]!.id], [1, 0, one.id], 'every spelling is one room');

    // More than 32 rooms: sorted by (label, canonical root), the first 32 and the count of the rest.
    const repos: string[] = [];
    for (let i = ROOMS_MAX; i >= 0; i--) {
      const p = join(root, `r${String(i).padStart(2, '0')}`);
      cpSync(repo, p, { recursive: true });
      repos.push(p);
    }
    const many = rooms(await discoverRooms(repos, deps(dataDir)));
    assert.equal(many.rooms.length, ROOMS_MAX);
    assert.equal(many.more, 1);
    assert.deepEqual(many.rooms.map((r) => r.label), Array.from({ length: ROOMS_MAX }, (_, i) => `r${String(i).padStart(2, '0')}`));
    assert.equal(new Set(many.rooms.map((r) => r.id)).size, ROOMS_MAX, 'one id per clone');
  } finally {
    await cleanup();
  }
});

test('decodeEnc inverts enc and refuses anything enc would not produce', () => {
  const branch = fc.oneof(fc.string({ unit: 'binary', minLength: 1, maxLength: 40 }), fc.string({ unit: 'binary-ascii', minLength: 1, maxLength: 40 }));
  fc.assert(fc.property(branch, (b) => {
    let e: string;
    try {
      e = enc(b);
    } catch {
      return true;   // enc refuses it (too long or a lone surrogate): nothing to invert
    }
    return decodeEnc(e) === b;
  }), { numRuns: 500 });
  for (const b of ['main', 'feat/x', 'a b', 'v1.2', '\u{D55C}\u{AE00}', '\u{FEFF}bom', '%', 'a/b/c', '\u{1F600}']) assert.equal(decodeEnc(enc(b)), b, b);
  // Never produced by enc: lower-case hex, a short or bad escape, an escaped unreserved byte, a raw reserved character,
  // bytes that are not UTF-8 (overlong, a lone surrogate, a stray continuation), the empty name and an over-long one.
  for (const e of ['', '%e4%b8%80', '%G1', '%2', 'a%2', '%41', '%5F', 'a/b', 'a b', 'v1.2', 'a%', '%FF', '%C0%AF', '%ED%A0%80', '%80', `${'a'.repeat(151)}`, 'é']) {
    assert.equal(decodeEnc(e), null, JSON.stringify(e));
  }
});

/** A fake probe over a table of existing paths and their realpath (Plan 5's unit form). */
function fakeProbe(real: ReadonlyMap<string, string>, exists: (p: string) => boolean): RootProbe {
  return {
    realpathNative: (p) => {
      const r = real.get(p);
      if (r === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return r;
    },
    exists,
    readText: () => null,
    isDir: (p) => exists(p),
  };
}

test('canonRoot gives one string for two spellings of a clone (8.3 short name, trailing separator, drive-letter case) and equals Plan 5\'s declared examples', async (t) => {
  // Plan 5's examples, fake probe on win32: case and 8.3 spellings reach the on-disk spelling with a lower-case drive letter.
  const onDisk = 'C:\\Users\\Me\\repo\\src\\a.ts';
  const winReal = new Map([
    ['c:\\users\\me\\repo\\src\\a.ts', onDisk], ['C:\\USERS\\ME~1\\repo\\src\\a.ts', onDisk], ['C:\\Users\\Me\\repo\\src', 'C:\\Users\\Me\\repo\\src'],
    ['C:\\Users\\Me\\repo', 'C:\\Users\\Me\\repo'], ['C:\\USERS\\ME~1\\repo', 'C:\\Users\\Me\\repo'], ['c:\\users\\me\\repo', 'C:\\Users\\Me\\repo'],
  ]);
  const win = fakeProbe(winReal, (p) => winReal.has(p));
  assert.equal(canonRoot('c:\\users\\me\\repo\\src\\a.ts', win, 'win32'), 'c:/Users/Me/repo/src/a.ts');
  assert.equal(canonRoot('C:\\USERS\\ME~1\\repo\\src\\a.ts', win, 'win32'), 'c:/Users/Me/repo/src/a.ts');
  assert.equal(canonRoot('C:\\Users\\Me\\repo\\src\\new\\b.ts', win, 'win32'), 'c:/Users/Me/repo/src/new/b.ts', 'a missing tail resolves through its nearest ancestor');
  // The 8a spellings of one clone: 8.3 short name, trailing separator, drive-letter case.
  const clone = canonRoot('C:\\Users\\Me\\repo', win, 'win32');
  assert.equal(clone, 'c:/Users/Me/repo');
  for (const p of ['C:\\USERS\\ME~1\\repo', 'C:\\Users\\Me\\repo\\', 'c:\\users\\me\\repo', 'C:/Users/Me/repo/']) assert.equal(canonRoot(p, win, 'win32'), clone, p);
  // darwin: an NFD spelling gives the NFC string.
  const mac = fakeProbe(new Map([['/Users/me/re\u0301po', '/Users/me/re\u0301po']]), (p) => p === '/Users/me/re\u0301po' || p === '/Users/me' || p === '/Users' || p === '/');
  assert.equal(canonRoot('/Users/me/re\u0301po', mac, 'darwin'), '/Users/me/r\u00e9po');
  // linux: exact; a trailing separator is the same root.
  const lin = fakeProbe(new Map([['/home/Me/repo', '/home/Me/repo']]), (p) => p === '/home/Me/repo');
  assert.equal(canonRoot('/home/Me/repo/', lin, 'linux'), '/home/Me/repo');

  // The real probe on a temp clone: the same spellings give one string, which never ends in a separator.
  const { root, cleanup } = await makeTempRoot('viz-canonroot');
  try {
    const dir = join(root, 'clone');
    mkdirSync(join(dir, 'src'), { recursive: true });
    const want = canonRoot(dir, realRootProbe, process.platform);
    assert.ok(!want.endsWith('/') && !want.includes('\\'), want);
    if (WIN) assert.match(want, /^[a-z]:\//);
    const forms = [`${dir}${WIN ? '\\' : '/'}`, join(dir, 'src', '..')];
    if (WIN) {
      forms.push(`${dir[0] === dir[0]!.toUpperCase() ? dir[0]!.toLowerCase() : dir[0]!.toUpperCase()}${dir.slice(1)}`);
      const short = shortName(dir);
      if (short !== null) forms.push(short);
      else t.diagnostic('8.3 leg skipped: no short name on this volume');
    }
    for (const f of forms) assert.equal(canonRoot(f, realRootProbe, process.platform), want, f);
    assert.equal(canonRoot(join(dir, 'not yet', 'x.ts'), realRootProbe, process.platform), `${want}/not yet/x.ts`);
  } finally {
    await cleanup();
  }
});
