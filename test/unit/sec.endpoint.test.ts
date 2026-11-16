// Plan 5 Task 3: the endpoint name and the POSIX socket directory (SEC-21, R2-K2; 09 test 20; TC-CCI-16 endpoint half).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { endpointRoot, type RootProbe } from '../../src/data/canonRoot.js';
import type { Fs, FsLstat, FsStat } from '../../src/ports/fs.js';
import { endpointName, socketDir, SOCKET_PATH_MAX_BYTES } from '../../src/sec/endpoint.js';

const KEY = Buffer.alloc(32, 5);
const KEY2 = Buffer.alloc(32, 6);

function hmacHex(key: Buffer, root: string): string {
  return createHmac('sha256', key).update(Buffer.from(`endpoint:${root}`, 'utf8')).digest('hex');
}

/** A win32 probe over a fixed table: every path exists, and realpathNative maps the 8.3 and NFD spellings to the on-disk one. */
function probe(table: Readonly<Record<string, string>>): RootProbe {
  return {
    realpathNative: (p) => table[p] ?? p,
    exists: () => true,
    readText: () => null,
    isDir: () => true,
  };
}

test('two spellings of one repo (drive-letter case, 8.3, NFD) derive one endpoint', () => {
  const p = probe({
    'C:\\Users\\MEFIRS~1\\repo\\.git': 'C:\\Users\\Me\\repo\\.git',
    'C:\\Users\\Me\\cafe\u0301\\.git': 'C:\\Users\\Me\\cafe\u0301\\.git',   // the probe keeps the NFD spelling; canonRoot normalizes NFC
  });
  const at = (spelling: string): string => endpointName(KEY, endpointRoot(spelling, p, 'win32'), 'win32', null);
  const base = at('C:\\Users\\Me\\repo\\.git');
  assert.equal(at('c:/users/me/repo/.git'), base, 'drive-letter and path case, / for \\');
  assert.equal(at('C:\\Users\\MEFIRS~1\\repo\\.git'), base, 'the 8.3 short name');
  const root = endpointRoot('C:\\Users\\Me\\repo\\.git', p, 'win32');
  assert.equal(root, 'c:/users/me/repo/.git');
  assert.equal(base, `\\\\.\\pipe\\cowork-${hmacHex(KEY, root).slice(0, 32)}`);
  assert.match(base, /^\\\\\.\\pipe\\cowork-[0-9a-f]{32}$/);

  const nfc = at('C:\\Users\\Me\\caf\u00e9\\.git');
  assert.equal(at('C:\\Users\\Me\\cafe\u0301\\.git'), nfc, 'NFD and NFC spellings');
  assert.notEqual(nfc, base);

  assert.notEqual(endpointName(KEY2, root, 'win32', null), base, 'another key, another name');

  // POSIX: <dir>/ + the first 24 hex chars (12 bytes) + .sock; the socket directory is a parameter.
  const posixRoot = '/home/me/repo/.git';
  const sock = endpointName(KEY, posixRoot, 'linux', '/run/user/1000/cowork-sync');
  assert.equal(sock, `/run/user/1000/cowork-sync/${hmacHex(KEY, posixRoot).slice(0, 24)}.sock`);
  assert.notEqual(endpointName(KEY2, posixRoot, 'linux', '/run/user/1000/cowork-sync'), sock);
  assert.equal(endpointName(KEY, posixRoot, 'darwin', '/tmp/cws-501'), `/tmp/cws-501/${hmacHex(KEY, posixRoot).slice(0, 24)}.sock`);
  assert.throws(() => endpointName(KEY, posixRoot, 'linux', null), TypeError, 'POSIX needs its socket directory');
});

// ---- POSIX socket directory over a fake Fs ------------------------------------------------------------------------------------------

interface Entry { kind: 'dir' | 'symlink' | 'file'; uid: number; mode: number; }

function fakeFs(entries: Map<string, Entry>, calls: string[]): Fs {
  const lst = (p: string, e: Entry): FsLstat => ({
    size: 0, mtimeNs: 1n, ino: BigInt(p.length), dev: 1n, mode: e.mode, uid: e.uid, ctimeNs: 1n,
    isFile: e.kind === 'file', isDirectory: e.kind === 'dir', isSymbolicLink: e.kind === 'symlink',
  });
  const notUsed = (op: string) => (): never => { throw new Error(`fake Fs: ${op} is not used by socketDir`); };
  return {
    lstat: async (p: string): Promise<FsLstat | null> => {
      calls.push(`lstat ${p}`);
      const e = entries.get(p);
      return e === undefined ? null : lst(p, e);
    },
    stat: async (p: string): Promise<FsStat | null> => {
      calls.push(`stat ${p}`);
      const e = entries.get(p);
      return e === undefined ? null : { size: 0, mtimeMs: 0, isFile: e.kind === 'file', isDirectory: e.kind !== 'file' };
    },
    mkdirp: async (p: string, mode?: number): Promise<void> => {
      calls.push(`mkdirp ${p} ${mode === undefined ? '-' : mode.toString(8)}`);
      if (!entries.has(p)) entries.set(p, { kind: 'dir', uid: 1000, mode: 0o40000 | (mode ?? 0o777) });
    },
    readFile: notUsed('readFile'), writeFile: notUsed('writeFile'), rename: notUsed('rename'), link: notUsed('link'), unlink: notUsed('unlink'),
    readdir: notUsed('readdir'), rmrf: notUsed('rmrf'), writeFileExclusive: notUsed('writeFileExclusive'), rmdir: notUsed('rmdir'),
    appendFile: notUsed('appendFile'), realpath: notUsed('realpath'), freeBytes: notUsed('freeBytes'), chmod: notUsed('chmod'),
  };
}

const SOCK = `${'a'.repeat(24)}.sock`;   // 29 bytes, the real POSIX socket name length
const parents = (...ps: string[]): Map<string, Entry> => new Map(ps.map((p) => [p, { kind: 'dir', uid: 0, mode: 0o41777 } as Entry]));

test('POSIX socket dir: 0700 owner-only accepted; a symlink swap, a wrong owner and a 101-byte path refuse SEC_REFUSE_SOCKET_PATH', async () => {
  assert.equal(SOCKET_PATH_MAX_BYTES, 100);
  const XDG = '/run/user/1000';
  const DIR = '/run/user/1000/cowork-sync';

  // Created with mode 0o700 and accepted when lstat shows a directory, uid 1000, mode 0o40700.
  {
    const calls: string[] = [];
    const r = await socketDir({ XDG_RUNTIME_DIR: XDG }, 1000, fakeFs(parents(XDG, '/tmp'), calls), SOCK);
    assert.deepEqual(r, { ok: true, dir: DIR });
    assert.ok(calls.includes(`mkdirp ${DIR} 700`), calls.join('\n'));
    assert.equal(calls.filter((c) => c.startsWith('mkdirp')).length, 1, 'only the final directory component is created');
  }
  // An existing directory is verified, never changed: a symlink, uid 0 and mode 0o40755 each refuse (no fallback to /tmp).
  for (const bad of [{ kind: 'symlink', uid: 1000, mode: 0o120777 }, { kind: 'dir', uid: 0, mode: 0o40700 }, { kind: 'dir', uid: 1000, mode: 0o40755 },
    { kind: 'file', uid: 1000, mode: 0o100700 }] as Entry[]) {
    const calls: string[] = [];
    const entries = parents(XDG, '/tmp');
    entries.set(DIR, bad);
    const r = await socketDir({ XDG_RUNTIME_DIR: XDG }, 1000, fakeFs(entries, calls), SOCK);
    assert.deepEqual(r, { ok: false, code: 'SEC_REFUSE_SOCKET_PATH' }, JSON.stringify(bad));
    assert.ok(!calls.some((c) => c.includes('/tmp/cws-')), 'a refused candidate is not replaced by the next one');
    assert.deepEqual(entries.get(DIR), bad, 'the existing entry is left as it was');
  }
  // The 100-byte limit counts UTF-8 bytes of the full socket path: exactly 100 accepted, 101 skipped for /tmp/cws-1000.
  {
    const xdg100 = `/${'\u00e9'.repeat(28)}x`;    // 58 bytes: + '/cowork-sync/' (13) + 29 = 100
    const xdg101 = `/${'\u00e9'.repeat(28)}xy`;   // 59 bytes → 101
    assert.equal(Buffer.byteLength(`${xdg100}/cowork-sync/${SOCK}`), 100);
    const r100 = await socketDir({ XDG_RUNTIME_DIR: xdg100 }, 1000, fakeFs(parents(xdg100, '/tmp'), []), SOCK);
    assert.deepEqual(r100, { ok: true, dir: `${xdg100}/cowork-sync` });
    const calls: string[] = [];
    const r101 = await socketDir({ XDG_RUNTIME_DIR: xdg101 }, 1000, fakeFs(parents(xdg101, '/tmp'), calls), SOCK);
    assert.deepEqual(r101, { ok: true, dir: '/tmp/cws-1000' });
    assert.ok(!calls.some((c) => c.includes('cowork-sync')), 'the over-long candidate is never touched');
  }
  // A 95-byte socket name: both candidates exceed 100 bytes.
  {
    const calls: string[] = [];
    const r = await socketDir({ XDG_RUNTIME_DIR: XDG }, 1000, fakeFs(parents(XDG, '/tmp'), calls), 'b'.repeat(95));
    assert.deepEqual(r, { ok: false, code: 'SEC_REFUSE_SOCKET_PATH' });
    assert.deepEqual(calls, [], 'nothing is created or read');
  }
  // No XDG (unset or empty) → /tmp/cws-<uid>.
  for (const env of [{}, { XDG_RUNTIME_DIR: '' }]) {
    const calls: string[] = [];
    const r = await socketDir(env, 1000, fakeFs(parents('/tmp'), calls), SOCK);
    assert.deepEqual(r, { ok: true, dir: '/tmp/cws-1000' });
    assert.ok(calls.includes('mkdirp /tmp/cws-1000 700'));
  }
  // Readings (report): a relative XDG value and an XDG directory that does not exist are skipped (only the final component is created).
  for (const env of [{ XDG_RUNTIME_DIR: 'run/user/1000' }, { XDG_RUNTIME_DIR: '/run/user/missing' }]) {
    const calls: string[] = [];
    const r = await socketDir(env, 1000, fakeFs(parents('/tmp'), calls), SOCK);
    assert.deepEqual(r, { ok: true, dir: '/tmp/cws-1000' }, JSON.stringify(env));
    assert.ok(!calls.some((c) => c.startsWith('mkdirp') && c.includes('cowork-sync')));
  }
});
