import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realFs, sameStat, type FsLstat } from '../../src/ports/fs.js';

// Temp dir with a space and non-ASCII characters (Review Focus 1 flavour);
// makeTempRoot() arrives only in Task 9, so this test builds its own.
let base = '';
let dir = '';

before(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowork-fs-'));
  dir = path.join(base, '공 백 dir');
  await fsp.mkdir(dir);
});

after(async () => {
  await fsp.rm(base, { recursive: true, force: true, maxRetries: 3 });
});

// UTF-8 BOM, "a", CRLF, NUL, invalid UTF-8 (0xFF 0xFE), "b", LF.
const BYTES = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x00, 0xff, 0xfe, 0x62, 0x0a]);

async function caught(p: Promise<unknown>): Promise<NodeJS.ErrnoException> {
  try {
    await p;
  } catch (e) {
    return e as NodeJS.ErrnoException;
  }
  throw new Error('expected the promise to reject');
}

test('writeFile then readFile round-trips bytes exactly', async () => {
  const p = path.join(dir, 'bytes.bin');
  await realFs.writeFile(p, BYTES);
  const back = await realFs.readFile(p);
  assert.ok(Buffer.isBuffer(back));
  assert.deepEqual(back, BYTES);
});

test('writeFile refuses a string at run time', async () => {
  const p = path.join(dir, 'string.txt');
  const err = await caught(realFs.writeFile(p, 'text' as unknown as Buffer));
  assert.ok(err instanceof TypeError);
  assert.equal(await realFs.stat(p), null);
});

test('stat returns null for a missing path and fields for files and directories', async () => {
  assert.equal(await realFs.stat(path.join(dir, 'missing.txt')), null);

  const f = path.join(dir, 'stat.bin');
  await realFs.writeFile(f, BYTES);
  const fs1 = await realFs.stat(f);
  assert.ok(fs1 !== null);
  assert.equal(fs1.size, BYTES.length);
  assert.equal(fs1.isFile, true);
  assert.equal(fs1.isDirectory, false);
  assert.equal(typeof fs1.mtimeMs, 'number');
  assert.ok(fs1.mtimeMs > 0);

  const d = await realFs.stat(dir);
  assert.ok(d !== null);
  assert.equal(d.isFile, false);
  assert.equal(d.isDirectory, true);
});

test('rename replaces an existing target', async () => {
  const a = path.join(dir, 'rename-a.txt');
  const b = path.join(dir, 'rename-b.txt');
  await realFs.writeFile(a, Buffer.from('new\n'));
  await realFs.writeFile(b, Buffer.from('old\n'));
  await realFs.rename(a, b);
  assert.equal(await realFs.stat(a), null);
  assert.deepEqual(await realFs.readFile(b), Buffer.from('new\n'));
});

test('link creates a second name that outlives the first', async () => {
  const a = path.join(dir, 'link-a.txt');
  const b = path.join(dir, 'link-b.txt');
  await realFs.writeFile(a, BYTES);
  await realFs.link(a, b);
  await realFs.unlink(a);
  assert.equal(await realFs.stat(a), null);
  assert.deepEqual(await realFs.readFile(b), BYTES);
});

test('unlink of a missing file rejects with a real ENOENT', async () => {
  const p = path.join(dir, 'never-existed.txt');
  const err = await caught(realFs.unlink(p));
  assert.equal(err.code, 'ENOENT');
  assert.equal(err.syscall, 'unlink');
  assert.equal(err.path, p);
});

test('mkdirp creates nested directories and is idempotent', async () => {
  const deep = path.join(dir, 'x', 'y y', 'z');
  await realFs.mkdirp(deep);
  await realFs.mkdirp(deep);
  const s = await realFs.stat(deep);
  assert.ok(s !== null && s.isDirectory);
});

test('readdir returns names in UTF-16 code-unit order', async () => {
  const sub = path.join(dir, 'sorted');
  await realFs.mkdirp(sub);
  // Created in a scrambled order. No case pairs (NTFS/APFS are case-insensitive)
  // and no Hangul (HFS+ would return NFD). '😀' (U+1F600, code units D83D DE00)
  // sorts BEFORE 'ｚ' (U+FF5A) by code unit but AFTER it by code point.
  const names = ['ｚ.txt', 'b.txt', '😀.txt', '9', '_x', 'A.txt', '10'];
  for (const n of names) await realFs.writeFile(path.join(sub, n), Buffer.from(n));
  assert.deepEqual(await realFs.readdir(sub), ['10', '9', 'A.txt', '_x', 'b.txt', '😀.txt', 'ｚ.txt']);
});

test('rmrf removes a tree and ignores a missing path', async () => {
  const t = path.join(dir, 'tree');
  await realFs.mkdirp(path.join(t, 'a', 'b'));
  await realFs.writeFile(path.join(t, 'a', 'b', 'f.bin'), BYTES);
  await realFs.rmrf(t);
  assert.equal(await realFs.stat(t), null);
  await realFs.rmrf(t);
});

test('lstat returns bigint mtimeNs, ino, dev and mode, null on ENOENT and ENOTDIR, and never follows a symlink', async (t) => {
  const f = path.join(dir, 'lstat.bin');
  await realFs.writeFile(f, BYTES);
  const s = await realFs.lstat(f);
  assert.ok(s !== null);
  assert.equal(s.size, BYTES.length);
  assert.equal(typeof s.mtimeNs, 'bigint');
  assert.equal(typeof s.ino, 'bigint');
  assert.equal(typeof s.dev, 'bigint');
  assert.equal(typeof s.mode, 'number');
  assert.equal(s.isFile, true);
  assert.equal(s.isDirectory, false);
  assert.equal(s.isSymbolicLink, false);
  assert.ok(s.mtimeNs > 0n);

  assert.equal(await realFs.lstat(path.join(dir, 'lstat-missing')), null);
  // a path below a regular file is ENOTDIR (POSIX); on Windows it may be ENOENT: both give null
  assert.equal(await realFs.lstat(path.join(f, 'below')), null);

  const link = path.join(dir, 'lstat-link');
  try {
    await fsp.symlink(f, link);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'UNKNOWN') {
      t.skip('symlinks need privileges here');
      return;
    }
    throw e;
  }
  const l = await realFs.lstat(link);
  assert.ok(l !== null);
  assert.equal(l.isSymbolicLink, true);
  assert.equal(l.isFile, false);
});

test('writeFileExclusive creates a new file and fails EEXIST without touching an existing one', async () => {
  const p = path.join(dir, 'excl.bin');
  await realFs.writeFileExclusive(p, BYTES);
  assert.deepEqual(await realFs.readFile(p), BYTES);
  const err = await caught(realFs.writeFileExclusive(p, Buffer.from('other')));
  assert.equal(err.code, 'EEXIST');
  assert.deepEqual(await realFs.readFile(p), BYTES);
  const terr = await caught(realFs.writeFileExclusive(path.join(dir, 'excl2.bin'), 'x' as unknown as Buffer));
  assert.ok(terr instanceof TypeError);
});

test('rmdir removes an empty directory and fails ENOTEMPTY on a non-empty one', async () => {
  const d = path.join(dir, 'rmdir-d');
  await realFs.mkdirp(d);
  await realFs.writeFile(path.join(d, 'f'), BYTES);
  const err = await caught(realFs.rmdir(d));
  assert.equal(err.code, 'ENOTEMPTY');
  await realFs.unlink(path.join(d, 'f'));
  await realFs.rmdir(d);
  assert.equal(await realFs.stat(d), null);
});

test('appendFile appends Buffers in order and throws TypeError for a string', async () => {
  const p = path.join(dir, 'append.bin');
  await realFs.appendFile(p, Buffer.from('a'));
  await realFs.appendFile(p, Buffer.from('b\n'));
  await realFs.appendFile(p, Buffer.from([0xff]));
  assert.deepEqual(await realFs.readFile(p), Buffer.from([0x61, 0x62, 0x0a, 0xff]));
  const err = await caught(realFs.appendFile(p, 'x' as unknown as Buffer));
  assert.ok(err instanceof TypeError);
  assert.equal((await realFs.readFile(p)).length, 4);
});

test('freeBytes returns a positive number for the temp volume', async () => {
  const n = await realFs.freeBytes(os.tmpdir());
  assert.ok(n !== null);
  assert.ok(n > 0);
});

test('realpath resolves a path to its canonical form', async () => {
  const p = path.join(dir, 'real.bin');
  await realFs.writeFile(p, BYTES);
  const r = await realFs.realpath(p);
  assert.equal(path.basename(r), 'real.bin');
  assert.equal(await realFs.realpath(r), r);
});

test('mkdirp applies its mode to the directories it creates (POSIX)', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX modes');
    return;
  }
  const top = path.join(dir, 'mode-a');
  const leaf = path.join(top, 'b');
  await realFs.mkdirp(leaf, 0o700);
  for (const d of [top, leaf]) {
    const s = await realFs.lstat(d);
    assert.ok(s !== null);
    assert.equal(s.mode & 0o777, 0o700);
  }
});

test('sameStat compares size, mtimeNs, ino, dev and mode', () => {
  const a: FsLstat = {
    size: 3,
    mtimeNs: 10n,
    ino: 5n,
    dev: 7n,
    mode: 0o100644,
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
  };
  assert.equal(sameStat(a, { ...a }), true);
  assert.equal(sameStat(a, { ...a, size: 4 }), false);
  assert.equal(sameStat(a, { ...a, mtimeNs: 11n }), false);
  assert.equal(sameStat(a, { ...a, ino: 6n }), false);
  assert.equal(sameStat(a, { ...a, dev: 8n }), false);
  assert.equal(sameStat(a, { ...a, mode: 0o100755 }), false);
});

test('chmod sets and clears the owner-exec bit (POSIX) and keeps a file writable everywhere', async () => {
  const p = path.join(dir, 'chmod.sh');
  await realFs.writeFile(p, BYTES);
  await realFs.chmod(p, 0o755);
  const x = await realFs.lstat(p);
  assert.ok(x !== null);
  if (process.platform !== 'win32') assert.equal(x.mode & 0o777, 0o755);
  await realFs.chmod(p, 0o644);
  const y = await realFs.lstat(p);
  assert.ok(y !== null);
  if (process.platform !== 'win32') assert.equal(y.mode & 0o777, 0o644);
  await realFs.writeFile(p, BYTES); // still writable
  const err = await caught(realFs.chmod(path.join(dir, 'chmod-missing'), 0o644));
  assert.equal(err.code, 'ENOENT');
});
