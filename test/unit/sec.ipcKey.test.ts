// Plan 5 Task 3: the IPC key (SEC-20, R2-K1; 09 tests 21 and 30 key half; A3-6's Windows hook stamp). P5SEC (audit #34, #35): the start makes
// the data directory user-only, the stamp is restricted like the key, every refusal deletes it, a runner error never does, and the full check
// runs within the caller's remaining time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { canonicalJsonLine } from '../../src/claude/wire/ndjson.js';
import { resolveDataDir } from '../../src/data/pluginDataDir.js';
import { realFs, type Fs, type FsLstat, type FsStat } from '../../src/ports/fs.js';
import { seededRandom } from '../../src/ports/random.js';
import { createIpcKey, IpcKeyRefused, KEY_BYTES, keyHash, protectDataDir, readIpcKey, type KeyDeps } from '../../src/sec/ipcKey.js';
import { createWinAcl, type WinAcl } from '../../src/sec/winAcl.js';
import { FaultFs } from '../sim/faultfs.js';
import { makeTempRoot } from '../helpers/tmp.js';

const FIX = path.join(process.cwd(), 'test', 'fixtures', 'sec');
const SDDL = JSON.parse(readFileSync(path.join(FIX, 'sddl.json'), 'utf8')) as Record<string, string>;
const USER = SDDL['userSid'] as string;

// ---- An in-memory Fs (exact path strings, POSIX or win32 shaped) ---------------------------------------------------------------------

interface MemEntry { kind: 'file' | 'dir' | 'symlink'; data: Buffer; mode: number; uid: number; ino: bigint; dev: bigint; mtimeNs: bigint; ctimeNs: bigint; }

function errno(code: string, p: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${p}`), { code });
}

/** An in-memory Fs shaped like realFs where it matters here: writeFileExclusive is open('wx') → write → fsync, so the new name exists, empty,
 *  for a tick before its bytes (the window a crash or a concurrent reader sees); link shares the entry (one inode, two names) and fails
 *  EEXIST on an existing name; rename replaces its target. crashAfterCreate: the next exclusive create of a path containing it stops right
 *  after the open (the file exists, empty) and throws, as a crash or power loss there would leave it. */
class MemFs implements Fs {
  readonly entries = new Map<string, MemEntry>();
  readonly exclusiveModes: Array<number | undefined> = [];
  /** Every link that created its name: `existing -> newPath`. */
  readonly links: string[] = [];
  crashAfterCreate: string | null = null;
  private nextIno = 100n;
  private tick = 1_000n;
  constructor(private readonly ownUid: number) {}

  put(p: string, e: Partial<MemEntry> & { kind: MemEntry['kind'] }): void {
    this.tick += 1n;
    this.entries.set(p, { data: Buffer.alloc(0), mode: e.kind === 'dir' ? 0o40700 : 0o100600, uid: this.ownUid, ino: this.nextIno++, dev: 1n,
      mtimeNs: this.tick, ctimeNs: this.tick, ...e });
  }
  async lstat(p: string): Promise<FsLstat | null> {
    const e = this.entries.get(p);
    if (e === undefined) return null;
    return { size: e.data.length, mtimeNs: e.mtimeNs, ctimeNs: e.ctimeNs, ino: e.ino, dev: e.dev, mode: e.mode, uid: e.uid,
      isFile: e.kind === 'file', isDirectory: e.kind === 'dir', isSymbolicLink: e.kind === 'symlink' };
  }
  async stat(p: string): Promise<FsStat | null> {
    const e = this.entries.get(p);
    return e === undefined ? null : { size: e.data.length, mtimeMs: 0, isFile: e.kind === 'file', isDirectory: e.kind === 'dir' };
  }
  async readFile(p: string): Promise<Buffer> {
    const e = this.entries.get(p);
    if (e === undefined || e.kind !== 'file') throw errno('ENOENT', p);
    return Buffer.from(e.data);
  }
  async writeFile(p: string, data: Buffer): Promise<void> {
    const e = this.entries.get(p);
    if (e === undefined) this.put(p, { kind: 'file', data: Buffer.from(data), mode: 0o100644 });
    else { this.tick += 1n; e.data = Buffer.from(data); e.mtimeNs = this.tick; e.ctimeNs = this.tick; }
  }
  async writeFileExclusive(p: string, data: Buffer, mode?: number): Promise<void> {
    if (this.entries.has(p)) throw errno('EEXIST', p);
    this.exclusiveModes.push(mode);
    this.put(p, { kind: 'file', mode: 0o100000 | ((mode ?? 0o666) & ~0o022) });   // the open: visible, empty
    const e = this.entries.get(p) as MemEntry;
    if (this.crashAfterCreate !== null && p.includes(this.crashAfterCreate)) {
      this.crashAfterCreate = null;
      throw new Error('crash right after the exclusive open');
    }
    await new Promise((r) => setImmediate(r));
    this.tick += 1n;
    e.data = Buffer.from(data);   // the write and the fsync
    e.mtimeNs = this.tick;
  }
  async unlink(p: string): Promise<void> {
    if (!this.entries.delete(p)) throw errno('ENOENT', p);
  }
  async mkdirp(p: string, mode?: number): Promise<void> {
    if (!this.entries.has(p)) this.put(p, { kind: 'dir', mode: 0o40000 | ((mode ?? 0o777) & ~0o022) });
  }
  async rename(from: string, to: string): Promise<void> {
    const e = this.entries.get(from);
    if (e === undefined) throw errno('ENOENT', from);
    this.entries.delete(from);
    this.entries.set(to, e);
  }
  async link(existing: string, newPath: string): Promise<void> {
    const e = this.entries.get(existing);
    if (e === undefined) throw errno('ENOENT', existing);
    if (this.entries.has(newPath)) throw errno('EEXIST', newPath);
    this.entries.set(newPath, e);
    this.links.push(`${existing} -> ${newPath}`);
  }
  async readdir(): Promise<string[]> { throw new Error('not used'); }
  async rmrf(): Promise<void> { throw new Error('not used'); }
  async rmdir(): Promise<void> { throw new Error('not used'); }
  async appendFile(): Promise<void> { throw new Error('not used'); }
  async realpath(): Promise<string> { throw new Error('not used'); }
  async freeBytes(): Promise<number | null> { throw new Error('not used'); }
  async chmod(p: string, mode: number): Promise<void> {
    const e = this.entries.get(p);
    if (e === undefined) throw errno('ENOENT', p);
    this.tick += 1n;
    e.mode = (e.mode & ~0o7777) | mode;
    e.ctimeNs = this.tick;
  }
}

/** A WinAcl whose SDDLs the test sets (the key's: `sddl`; any other path, the data directory: `dir`, default user-only); counts every call and
 *  records the time bound each runner call was given. */
function countingAcl(sddl: { value: string }, sid = USER, o: { dir?: { value: string } } = {}): WinAcl & { calls: string[]; bounds: Array<number | undefined> } {
  const calls: string[] = [];
  const bounds: Array<number | undefined> = [];
  const dir = o.dir ?? { value: SDDL['userOnly'] as string };
  return {
    calls,
    bounds,
    currentUserSid: async (b) => { calls.push('currentUserSid'); bounds.push(b?.timeoutMs); return sid; },
    restrictToUser: async (file, s) => { calls.push(`restrictToUser ${file} ${s}`); },
    protectDir: async (d, s) => { calls.push(`protectDir ${d} ${s}`); },
    readSddl: async (file, b) => { calls.push(`readSddl ${file}`); bounds.push(b?.timeoutMs); return /[\\/]ipc\.key$/.test(file) ? sddl.value : dir.value; },
  };
}
const noAcl: WinAcl = {
  currentUserSid: async () => { throw new Error('POSIX never runs the ACL runner'); },
  restrictToUser: async () => { throw new Error('POSIX never runs the ACL runner'); },
  protectDir: async () => { throw new Error('POSIX never runs the ACL runner'); },
  readSddl: async () => { throw new Error('POSIX never runs the ACL runner'); },
};
/** The temp name a stamp is written under before its rename (P5SEC #34): `<dir>/ipc.key.acl.<16 hex>.tmp`. */
const STAMP_TMP_RE = /[\\/]ipc\.key\.acl\.[0-9a-f]{16}\.tmp$/;

const posixDeps = (fs: Fs, uid = 1000): KeyDeps => ({ fs, random: seededRandom('k'), platform: 'linux', uid, acl: noAcl });

test("ipc.key with mode 0644 or an Everyone ACE refuses SEC_REFUSE_IPC_ACL; a ko-KR Windows account passes the SID check", async () => {
  assert.equal(KEY_BYTES, 32);
  const K = Buffer.alloc(32, 3);
  const posixCase = async (key: Partial<MemEntry> & { kind: MemEntry['kind'] } | null, parentMode = 0o40700) => {
    const fs = new MemFs(1000);
    fs.put('/d', { kind: 'dir', mode: parentMode });
    if (key !== null) fs.put('/d/ipc.key', key);
    return readIpcKey('/d', posixDeps(fs));
  };
  const REFUSE = { ok: false, code: 'SEC_REFUSE_IPC_ACL' };
  assert.deepEqual(await posixCase({ kind: 'file', data: K, mode: 0o100644 }), REFUSE, 'mode 0644');
  assert.deepEqual(await posixCase({ kind: 'file', data: K, mode: 0o100600, uid: 1001 }), REFUSE, 'another owner');
  assert.deepEqual(await posixCase({ kind: 'file', data: K, mode: 0o100600 }, 0o40777), REFUSE, 'a world-writable parent');
  assert.deepEqual(await posixCase({ kind: 'file', data: K, mode: 0o100600 }, 0o40770), REFUSE, 'a group-writable parent');
  assert.deepEqual(await posixCase({ kind: 'file', data: K, mode: 0o100600 }), { ok: true, key: K });
  assert.deepEqual(await posixCase({ kind: 'symlink', data: K, mode: 0o120777 }), REFUSE, 'a symlink at the key path');
  assert.deepEqual(await posixCase({ kind: 'file', data: Buffer.alloc(31, 3), mode: 0o100600 }), { ok: false, code: null }, 'a 31-byte file');
  assert.deepEqual(await posixCase(null), { ok: false, code: null }, 'no file');

  // win32: the SDDL of the ko-KR fixture's account (SID from its localized whoami line), SY and BA → ok; plus (A;;FR;;;WD) → refuse.
  const whoami = readFileSync(path.join(FIX, 'whoami-ko-KR.utf8.csv'));
  for (const [sddl, want] of [[SDDL['userOnly'], { ok: true, key: K }], [`${SDDL['userOnly']}(A;;FR;;;WD)`, REFUSE]] as const) {
    const fs = new MemFs(0);
    const dir = 'C:\\Users\\\u{D64D}\u{AE38}\u{B3D9}\\.claude\\plugins\\data\\cowork-sync-test-market';
    fs.put(dir, { kind: 'dir' });
    fs.put(`${dir}\\ipc.key`, { kind: 'file', data: K, mode: 0o100666 });
    const acl = createWinAcl(async (file) => ({ code: 0, stdout: file === 'whoami' ? whoami : Buffer.from(`${sddl}\r\n`) }));
    assert.deepEqual(await readIpcKey(dir, { fs, random: seededRandom('k'), platform: 'win32', uid: null, acl }), want);
  }
  // A runner failure is a refusal too (fail closed).
  {
    const fs = new MemFs(0);
    fs.put('C:\\d\\ipc.key', { kind: 'file', data: K });
    const acl = createWinAcl(async () => ({ code: 1, stdout: Buffer.alloc(0) }));
    assert.deepEqual(await readIpcKey('C:\\d', { fs, random: seededRandom('k'), platform: 'win32', uid: null, acl }), REFUSE);
  }
});

/** The temp name createIpcKey writes the key bytes under before it publishes them (fix r1, finding 3): `<dir>/ipc.key.<16 hex>.tmp`. */
const TMP_RE = /[\\/]ipc\.key\.[0-9a-f]{16}\.tmp$/;
const WRITES = /^(writeFileExclusive|writeFile|mkdirp|link|rename|unlink|chmod) /;

test('createIpcKey writes 32 random bytes user-only and verifies them; an existing key is read, never replaced', async () => {
  const expected = Buffer.from(seededRandom('k').bytes(32));
  // POSIX: mkdirp(<dir>, 0o700), then the 32 bytes from seededRandom('k') by an exclusive create with mode 0o600 — under a temp name, then
  // published as <dir>/ipc.key by link (fix r1 finding 3, the controller's ruling: the brief's writeFileExclusive(<dir>/ipc.key, …) made
  // the name visible before its bytes) — then readIpcKey → ok.
  {
    const mem = new MemFs(1000);
    const ffs = new FaultFs(mem);
    const key = await createIpcKey('/d', posixDeps(ffs));
    assert.deepEqual(key, expected);
    assert.deepEqual(mem.exclusiveModes, [0o600]);
    const mk = ffs.calls.indexOf('mkdirp /d');
    const wr = ffs.calls.findIndex((c) => c.startsWith('writeFileExclusive ') && TMP_RE.test(c));
    const tmpPath = (ffs.calls[wr] ?? '').slice('writeFileExclusive '.length);
    const ln = ffs.calls.indexOf(`link ${tmpPath} -> /d/ipc.key`);
    const rm = ffs.calls.indexOf(`unlink ${tmpPath}`);
    assert.ok(mk >= 0 && wr > mk && ln > wr && rm > ln, ffs.calls.join('\n'));
    assert.ok(!ffs.calls.includes('writeFileExclusive /d/ipc.key'), 'the key name is never created empty');
    assert.deepEqual(mem.links, [`${tmpPath} -> /d/ipc.key`]);
    assert.deepEqual([...mem.entries.keys()].sort(), ['/d', '/d/ipc.key'], 'no temp file is left');
    assert.equal(((await mem.lstat('/d'))?.mode ?? 0) & 0o777, 0o700);
    assert.equal(((await mem.lstat('/d/ipc.key'))?.mode ?? 0) & 0o777, 0o600);
    assert.deepEqual(await readIpcKey('/d', posixDeps(mem)), { ok: true, key: expected });
    // A second createIpcKey on the same directory returns the existing key and writes nothing.
    ffs.calls.length = 0;
    assert.deepEqual(await createIpcKey('/d', { ...posixDeps(ffs), random: seededRandom('other') }), expected);
    assert.ok(!ffs.calls.some((c) => WRITES.test(c)), ffs.calls.join('\n'));
    // An existing key whose check refuses throws IpcKeyRefused (and is left as it is).
    await mem.chmod('/d/ipc.key', 0o644);
    await assert.rejects(createIpcKey('/d', posixDeps(ffs)), (e: unknown) => e instanceof IpcKeyRefused && e.code === 'SEC_REFUSE_IPC_ACL');
    assert.deepEqual(await mem.readFile('/d/ipc.key'), expected);
    // A symlink at the key path is refused too, never replaced.
    const sym = new MemFs(1000);
    sym.put('/s', { kind: 'dir' });
    sym.put('/s/ipc.key', { kind: 'symlink', mode: 0o120777 });
    await assert.rejects(createIpcKey('/s', posixDeps(sym)), IpcKeyRefused);
    assert.equal(sym.entries.get('/s/ipc.key')?.kind, 'symlink');
  }
  // win32 (P5SEC #34, #35): the start first makes the data directory user-only (protectDir, then its SDDL verified), then restrictToUser on the
  // temp file before it is published, readSddl on ipc.key, and the stamp written as the key's (a temp file restricted to the user, then renamed).
  // The SID is read once.
  {
    const mem = new MemFs(0);
    const ffs = new FaultFs(mem);
    const acl = countingAcl({ value: SDDL['userOnly'] as string });
    const d: KeyDeps = { fs: ffs, random: seededRandom('k'), platform: 'win32', uid: null, acl };
    const key = await createIpcKey('C:\\d', d);
    assert.deepEqual(key, expected);
    assert.equal(acl.calls.length, 6, acl.calls.join('\n'));
    assert.deepEqual(acl.calls.slice(0, 3), ['currentUserSid', `protectDir C:\\d ${USER}`, 'readSddl C:\\d']);
    assert.match(acl.calls[3] as string, /^restrictToUser C:\\d\\ipc\.key\.[0-9a-f]{16}\.tmp S-1-5-21-1111-2222-3333-1001$/);
    assert.equal(acl.calls[4], 'readSddl C:\\d\\ipc.key');
    assert.match(acl.calls[5] as string, /^restrictToUser C:\\d\\ipc\.key\.acl\.[0-9a-f]{16}\.tmp S-1-5-21-1111-2222-3333-1001$/);
    const tmpPath = (acl.calls[3] as string).split(' ')[1] as string;
    assert.deepEqual(mem.links, [`${tmpPath} -> C:\\d\\ipc.key`], 'published only after the restriction');
    const stampTmp = (acl.calls[5] as string).split(' ')[1] as string;
    assert.ok(ffs.calls.indexOf(`rename ${stampTmp} -> C:\\d\\ipc.key.acl`) > ffs.calls.indexOf(`writeFileExclusive ${stampTmp}`), ffs.calls.join('\n'));
    assert.equal((await mem.readFile('C:\\d\\ipc.key.acl')).toString('utf8'), (() => {
      const e = mem.entries.get('C:\\d\\ipc.key')!;
      return canonicalJsonLine({ ctimeNs: String(e.ctimeNs), dev: String(e.dev), ino: String(e.ino), mtimeNs: String(e.mtimeNs), size: '32' });
    })(), 'the start writes the stamp a hook accepts');
    assert.deepEqual([...mem.entries.keys()].sort(), ['C:\\d', 'C:\\d\\ipc.key', 'C:\\d\\ipc.key.acl'], 'no temp file is left');
    ffs.calls.length = 0;
    assert.deepEqual(await createIpcKey('C:\\d', d), expected);
    assert.ok(!ffs.calls.some((c) => WRITES.test(c) && !c.includes('ipc.key.acl') && c !== 'mkdirp C:\\d'), ffs.calls.join('\n'));
    assert.equal(acl.calls.filter((c) => /^restrictToUser C:\\d\\ipc\.key\.[0-9a-f]{16}\.tmp /.test(c)).length, 1, 'the key is never restricted twice');
    // The created key's ACL turns broad → the next createIpcKey refuses, and the stamp is gone with it.
    const broad = countingAcl({ value: SDDL['everyoneRead'] as string });
    await assert.rejects(createIpcKey('C:\\d', { ...d, acl: broad }), (e: unknown) => e instanceof IpcKeyRefused && e.code === 'SEC_REFUSE_IPC_ACL');
    assert.equal(await mem.lstat('C:\\d\\ipc.key.acl'), null);
  }
});

test('createIpcKey never shows an unwritten key: a crash leaves creation working, concurrent creators read one key, a short key is repaired', async (t) => {
  const keyOf = async (fs: MemFs, p: string): Promise<Buffer> => fs.readFile(p);
  const tmpLeft = (fs: MemFs): string[] => [...fs.entries.keys()].filter((p) => TMP_RE.test(p));

  // (1) A crash right after the exclusive create, before the bytes (fe797f1 created <dir>/ipc.key itself there): no key name is left
  //     behind, and the next call creates the key (its seeded temp name is taken by the leftover: it draws another).
  await t.test('a crash right after the exclusive create leaves no ipc.key, and the next call creates it', async () => {
    const mem = new MemFs(1000);
    mem.crashAfterCreate = 'ipc.key';
    await assert.rejects(createIpcKey('/d', posixDeps(new FaultFs(mem))), /crash right after the exclusive open/);
    assert.equal(await mem.lstat('/d/ipc.key'), null, 'a crash before the bytes leaves no ipc.key');
    const key = await createIpcKey('/d', posixDeps(new FaultFs(mem)));
    assert.equal(key.length, 32);
    assert.deepEqual(await readIpcKey('/d', posixDeps(mem)), { ok: true, key });
  });
  // (2) A crash at the publish (before the link): no ipc.key, and the next call creates it.
  await t.test('a crash before the publish leaves no ipc.key, and the next call creates it', async () => {
    const mem = new MemFs(1000);
    const ffs = new FaultFs(mem);
    ffs.interpose('link', 'ipc.key', async () => { throw new Error('crash before the link'); });
    await assert.rejects(createIpcKey('/d', posixDeps(ffs)), /crash before the link/);
    assert.equal(await mem.lstat('/d/ipc.key'), null);
    const key = await createIpcKey('/d', posixDeps(new FaultFs(mem)));
    assert.deepEqual(await readIpcKey('/d', posixDeps(mem)), { ok: true, key });
  });
  // (3) A short or empty ipc.key, as an older crash or a truncation leaves it, is no key: it is replaced by a new one, never trusted —
  //     whatever its mode (its bytes are never read as a key; the new key file is created 0600).
  await t.test('a short or empty ipc.key is replaced by a new key, never trusted', async () => {
    for (const [size, mode] of [[0, 0o100600], [1, 0o100600], [31, 0o100600], [33, 0o100600], [0, 0o100644]] as const) {
      const mem = new MemFs(1000);
      mem.put('/d', { kind: 'dir' });
      mem.put('/d/ipc.key', { kind: 'file', data: Buffer.alloc(size, 6), mode });
      const ffs = new FaultFs(mem);
      const key = await createIpcKey('/d', posixDeps(ffs));
      assert.equal(key.length, 32, `size ${size}`);
      assert.ok(!key.equals(Buffer.alloc(32, 6)));
      assert.deepEqual(await readIpcKey('/d', posixDeps(mem)), { ok: true, key }, `size ${size} mode ${mode.toString(8)}`);
      assert.deepEqual(tmpLeft(mem), []);
      assert.equal([...mem.entries.keys()].filter((p) => p.startsWith('/d/ipc.key.')).length, 0, 'nothing set aside is left');
    }
  });
  // (4) Concurrent creators on one directory (each its own Random): every one returns the same key, the one that ipc.key holds; one link won.
  await t.test('concurrent creators return the one key ipc.key holds', async () => {
    const mem = new MemFs(1000);
    const keys = await Promise.all(['a', 'b', 'c', 'd'].map((s) => createIpcKey('/d', { ...posixDeps(new FaultFs(mem)), random: seededRandom(s) })));
    const onDisk = await keyOf(mem, '/d/ipc.key');
    for (const k of keys) assert.deepEqual(k, onDisk);
    assert.equal(mem.links.filter((l) => l.endsWith('-> /d/ipc.key')).length, 1);
    assert.deepEqual(tmpLeft(mem), []);
  });
  // (5) Two concurrent repairs of an empty ipc.key: both return the one key ipc.key holds.
  await t.test('two concurrent repairs of an empty ipc.key return one key', async () => {
    const mem = new MemFs(1000);
    mem.put('/d', { kind: 'dir' });
    mem.put('/d/ipc.key', { kind: 'file' });
    const keys = await Promise.all(['a', 'b'].map((s) => createIpcKey('/d', { ...posixDeps(new FaultFs(mem)), random: seededRandom(s) })));
    assert.deepEqual(keys[0], keys[1]);
    assert.deepEqual(keys[0], await keyOf(mem, '/d/ipc.key'));
  });
  // (6) The adversarial order: B saw the empty file, but its move-aside runs only after A has published and returned its key — B moves A's
  //     key aside, sees a 32-byte key, puts it back and returns it too.
  await t.test('a move-aside that finds a published key puts it back', async () => {
    const mem = new MemFs(1000);
    mem.put('/d', { kind: 'dir' });
    mem.put('/d/ipc.key', { kind: 'file' });
    const aFs = new FaultFs(mem);
    const bFs = new FaultFs(mem);
    const a = createIpcKey('/d', { ...posixDeps(aFs), random: seededRandom('a') });
    bFs.interpose('rename', '/d/ipc.key', async () => { await a.catch(() => {}); });
    const b = createIpcKey('/d', { ...posixDeps(bFs), random: seededRandom('b') });
    const [ka, kb] = await Promise.all([a, b]);
    assert.deepEqual(kb, ka);
    assert.deepEqual(await keyOf(mem, '/d/ipc.key'), ka);
    assert.ok(bFs.calls.some((c) => c.startsWith('rename /d/ipc.key -> ')), bFs.calls.join('\n'));
    assert.ok(mem.links.some((l) => /ipc\.key\.[0-9a-f]{16}\.short -> \/d\/ipc\.key$/.test(l)), mem.links.join('\n'));
  });
  // (7) win32: concurrent creators; each temp file is restricted to the user before the link that would publish it.
  await t.test('win32: each temp file is restricted before its link', async () => {
    const mem = new MemFs(0);
    const keys = await Promise.all(['a', 'b', 'c'].map(async (s) => {
      const acl = countingAcl({ value: SDDL['userOnly'] as string });
      const ffs = new FaultFs(mem);
      ffs.interpose('link', '.tmp', async (p) => {
        assert.ok(acl.calls.includes(`restrictToUser ${p} ${USER}`), `${p} restricted before its link`);
      }, 10);
      return createIpcKey('C:\\d', { fs: ffs, random: seededRandom(s), platform: 'win32', uid: null, acl });
    }));
    for (const k of keys) assert.deepEqual(k, await keyOf(mem, 'C:\\d\\ipc.key'));
    assert.deepEqual(tmpLeft(mem), []);
    assert.deepEqual([...mem.entries.keys()].filter((p) => STAMP_TMP_RE.test(p)), [], 'no stamp temp file is left');
  });
  // (9) A volume without hard links cannot publish a key: createIpcKey rejects with the link error and leaves neither ipc.key nor a temp file.
  await t.test('without hard links the create fails closed and leaves nothing', async () => {
    const mem = new MemFs(1000);
    const ffs = new FaultFs(mem);
    ffs.setNoHardLinks(true);
    await assert.rejects(createIpcKey('/d', posixDeps(ffs)), (e: unknown) => (e as NodeJS.ErrnoException).code === 'EPERM');
    assert.deepEqual([...mem.entries.keys()], ['/d']);
  });
  // (8) Real files: four concurrent creators under a temp root read one key, and no temp file is left.
  await t.test('real files: concurrent creators read one key, no temp file left', async (st) => {
    const tmp = await makeTempRoot('ipckey-race');
    st.after(tmp.cleanup);
    const dataDir = path.join(tmp.root, 'data');
    const platform = process.platform;
    const keys = await Promise.all(['a', 'b', 'c', 'd'].map((s) => createIpcKey(dataDir, { fs: realFs, random: seededRandom(s), platform,
      uid: platform === 'win32' ? null : (process.getuid?.() ?? null), acl: platform === 'win32' ? countingAcl({ value: SDDL['userOnly'] as string }) : noAcl })));
    const onDisk = await realFs.readFile(path.join(dataDir, 'ipc.key'));
    for (const k of keys) assert.deepEqual(k, onDisk);
    // win32: the stamp beside it (each creator's start writes it; P5SEC #35); no key or stamp temp file is left.
    assert.deepEqual((await realFs.readdir(dataDir)).sort(), platform === 'win32' ? ['ipc.key', 'ipc.key.acl'] : ['ipc.key']);
  });
});

test('a process without CLAUDE_PLUGIN_DATA reads the key only from the derived directory', async (t) => {
  const tmp = await makeTempRoot('ipckey-derived');
  t.after(tmp.cleanup);
  const home = path.join(tmp.root, 'home');
  const pluginRoot = path.join(home, '.claude', 'plugins', 'cache', 'test-market', 'cowork-sync', '0.6.0');
  const platform = process.platform;
  const env = { CLAUDE_PLUGIN_ROOT: pluginRoot };   // no CLAUDE_PLUGIN_DATA
  const dataDir = resolveDataDir(env, home, platform)!;
  assert.equal(dataDir, path.join(home, '.claude', 'plugins', 'data', 'cowork-sync-test-market'));
  const keyPath = path.join(dataDir, 'ipc.key');
  const sddl = { value: SDDL['userOnly'] as string };
  const d = (fs: Fs): KeyDeps => ({ fs, random: seededRandom('k'), platform, uid: platform === 'win32' ? null : (process.getuid?.() ?? null),
    acl: platform === 'win32' ? countingAcl(sddl) : noAcl });
  const created = await createIpcKey(dataDir, d(realFs));

  const allowed = new Set([`lstat ${keyPath}`, `readFile ${keyPath}`, `lstat ${dataDir}`]);
  const ffs = new FaultFs(realFs);
  assert.deepEqual(await readIpcKey(dataDir, d(ffs)), { ok: true, key: created });
  assert.ok(ffs.calls.length > 0 && ffs.calls.every((c) => allowed.has(c)), ffs.calls.join('\n'));

  // A broad ACL there: the refusal, and still no other path read (no fallback location, SEC-20 "MUST NOT fall back").
  if (platform === 'win32') sddl.value = SDDL['everyoneRead'] as string;
  else await realFs.chmod(keyPath, 0o644);
  const ffs2 = new FaultFs(realFs);
  assert.deepEqual(await readIpcKey(dataDir, d(ffs2)), { ok: false, code: 'SEC_REFUSE_IPC_ACL' });
  assert.ok(ffs2.calls.every((c) => allowed.has(c)), ffs2.calls.join('\n'));
});

test('the Windows hook stamp: a matching stamp skips the spawn, a changed key or a failed check deletes it', async () => {
  const dir = 'C:\\d';
  const keyPath = 'C:\\d\\ipc.key';
  const stampPath = 'C:\\d\\ipc.key.acl';
  const K = Buffer.alloc(32, 4);
  const mem = new MemFs(0);
  mem.put(dir, { kind: 'dir' });
  mem.put(keyPath, { kind: 'file', data: K, ctimeNs: 11n, dev: 1n, ino: 2n, mtimeNs: 3n });
  const sddl = { value: SDDL['userOnly'] as string };
  const acl = countingAcl(sddl);
  const d: KeyDeps = { fs: mem, random: seededRandom('k'), platform: 'win32', uid: null, acl };
  const stampOf = (e: MemEntry): string => canonicalJsonLine({ ctimeNs: String(e.ctimeNs), dev: String(e.dev), ino: String(e.ino), mtimeNs: String(e.mtimeNs),
    size: String(e.data.length) });

  // A full check with stamp 'write' writes ipc.key.acl: the five-field identity of the key it verified, as canonicalJsonLine's bytes, under a
  // temp name restricted to the user like the key (restrictToUser), then renamed onto ipc.key.acl (P5SEC #34).
  const watchedW = new FaultFs(mem);
  assert.deepEqual(await readIpcKey(dir, { ...d, fs: watchedW }, { stamp: 'write' }), { ok: true, key: K });
  assert.deepEqual(acl.calls.slice(0, 2), ['currentUserSid', 'readSddl C:\\d\\ipc.key'], 'a full check is currentUserSid + readSddl');
  assert.equal(acl.calls.length, 3, acl.calls.join('\n'));
  assert.match(acl.calls[2] as string, /^restrictToUser C:\\d\\ipc\.key\.acl\.[0-9a-f]{16}\.tmp S-1-5-21-1111-2222-3333-1001$/);
  const stampTmp = (acl.calls[2] as string).split(' ')[1] as string;
  const order = [`writeFileExclusive ${stampTmp}`, `rename ${stampTmp} -> ${stampPath}`].map((c) => watchedW.calls.indexOf(c));
  assert.ok(order[0]! >= 0 && order[1]! > order[0]!, watchedW.calls.join('\n'));
  assert.ok(!watchedW.calls.includes(`writeFile ${stampPath}`), 'the stamp name never holds an unrestricted file');
  assert.equal((await mem.readFile(stampPath)).toString('utf8'), '{"ctimeNs":"11","dev":"1","ino":"2","mtimeNs":"3","size":"32"}');
  assert.equal([...mem.entries.keys()].filter((p) => STAMP_TMP_RE.test(p)).length, 0, 'no stamp temp file is left');
  // 'use' with a matching stamp: ok with 0 WinAcl calls.
  assert.deepEqual(await readIpcKey(dir, d, { stamp: 'use' }), { ok: true, key: K });
  assert.equal(acl.calls.length, 3);
  // The key file rewritten (new ino and mtimeNs) → the next 'use' runs the full check (2 calls) and passes, but a hook only reads the stamp:
  // it is rewritten by the next 'write' (the daemon's start or its 30 s check), never by a hook (Ruling P5SEC-4).
  const K2 = Buffer.alloc(32, 5);
  const oldStamp = await mem.readFile(stampPath);
  mem.put(keyPath, { kind: 'file', data: K2 });
  assert.deepEqual(await readIpcKey(dir, d, { stamp: 'use' }), { ok: true, key: K2 });
  assert.equal(acl.calls.length, 5);
  assert.deepEqual(await mem.readFile(stampPath), oldStamp, "'use' never writes the stamp");
  assert.deepEqual(await readIpcKey(dir, d, { stamp: 'write' }), { ok: true, key: K2 });
  assert.equal(acl.calls.length, 8);
  assert.equal((await mem.readFile(stampPath)).toString('utf8'), stampOf(mem.entries.get(keyPath)!));
  assert.deepEqual(await readIpcKey(dir, d, { stamp: 'use' }), { ok: true, key: K2 });
  assert.equal(acl.calls.length, 8);
  // An ACL change moves ctimeNs: the stamp no longer matches; the full check refuses and deletes the stamp; the next 'use' checks again.
  sddl.value = SDDL['everyoneRead'] as string;
  mem.entries.get(keyPath)!.ctimeNs += 1n;
  assert.deepEqual(await readIpcKey(dir, d, { stamp: 'use' }), { ok: false, code: 'SEC_REFUSE_IPC_ACL' });
  assert.equal(acl.calls.length, 10);
  assert.equal(await mem.lstat(stampPath), null, 'a failed check deletes the stamp');
  assert.deepEqual(await readIpcKey(dir, d, { stamp: 'use' }), { ok: false, code: 'SEC_REFUSE_IPC_ACL' });
  assert.equal(acl.calls.length, 12, 'no stamp → the full check again');
  // 'write' that refuses deletes a stamp too, even a matching one.
  sddl.value = SDDL['userOnly'] as string;
  assert.deepEqual(await readIpcKey(dir, d, { stamp: 'write' }), { ok: true, key: K2 });
  assert.notEqual(await mem.lstat(stampPath), null);
  sddl.value = SDDL['everyoneRead'] as string;
  assert.deepEqual(await readIpcKey(dir, d, { stamp: 'write' }), { ok: false, code: 'SEC_REFUSE_IPC_ACL' });
  assert.equal(await mem.lstat(stampPath), null);
  // A symlink at the key path is a refusal too: it deletes the stamp.
  sddl.value = SDDL['userOnly'] as string;
  assert.deepEqual(await readIpcKey(dir, d, { stamp: 'write' }), { ok: true, key: K2 });
  const keyEntry = mem.entries.get(keyPath)!;
  mem.put(keyPath, { kind: 'symlink', mode: 0o120777 });
  assert.deepEqual(await readIpcKey(dir, d, { stamp: 'use' }), { ok: false, code: 'SEC_REFUSE_IPC_ACL' });
  assert.equal(await mem.lstat(stampPath), null, 'a symlink at the key path deletes the stamp');
  mem.entries.set(keyPath, keyEntry);
  // 'ignore' (the default) neither reads nor writes nor deletes the stamp.
  sddl.value = SDDL['userOnly'] as string;
  const watched = new FaultFs(mem);
  assert.deepEqual(await readIpcKey(dir, { ...d, fs: watched }), { ok: true, key: K2 });
  assert.deepEqual(await readIpcKey(dir, { ...d, fs: watched }, { stamp: 'ignore' }), { ok: true, key: K2 });
  assert.ok(!watched.calls.some((c) => c.includes('ipc.key.acl')), watched.calls.join('\n'));
  assert.equal(await mem.lstat(stampPath), null);

  // POSIX: no stamp file is ever written (verification is an lstat).
  {
    const pm = new MemFs(1000);
    pm.put('/d', { kind: 'dir' });
    pm.put('/d/ipc.key', { kind: 'file', data: K });
    const pf = new FaultFs(pm);
    for (const stamp of ['use', 'write', 'ignore'] as const) assert.deepEqual(await readIpcKey('/d', posixDeps(pf), { stamp }), { ok: true, key: K });
    assert.ok(!pf.calls.some((c) => c.includes('ipc.key.acl')), pf.calls.join('\n'));
    assert.equal(pm.entries.has('/d/ipc.key.acl'), false);
  }

  // Parity (X5-45): src/sec encodes the stamp locally; its bytes equal canonicalJsonLine of the same object over 200 random stat tuples.
  const u64 = fc.bigUintN(64);
  await fc.assert(fc.asyncProperty(u64, u64, u64, u64, async (ctimeNs, dev, ino, mtimeNs) => {
    const m = new MemFs(0);
    m.put(dir, { kind: 'dir' });
    m.put(keyPath, { kind: 'file', data: K, ctimeNs, dev, ino, mtimeNs });
    const r = await readIpcKey(dir, { ...d, fs: m, acl: countingAcl({ value: SDDL['userOnly'] as string }) }, { stamp: 'write' });
    assert.equal(r.ok, true);
    const want = canonicalJsonLine({ ctimeNs: String(ctimeNs), dev: String(dev), ino: String(ino), mtimeNs: String(mtimeNs), size: '32' });
    assert.deepEqual(await m.readFile(stampPath), Buffer.from(want, 'utf8'));
  }), { numRuns: 200 });
});

/** A win32 MemFs data directory C:\d holding a 32-byte key, and the stamp a verifier would write for it (`forge()` writes it as a planter would). */
function plantedKey(): { mem: MemFs; K: Buffer; forge(): Promise<void> } {
  const mem = new MemFs(0);
  const K = Buffer.alloc(32, 6);
  mem.put('C:\\d', { kind: 'dir' });
  mem.put('C:\\d\\ipc.key', { kind: 'file', data: K, ctimeNs: 21n, dev: 1n, ino: 9n, mtimeNs: 8n });
  const forge = async (): Promise<void> => {
    const e = mem.entries.get('C:\\d\\ipc.key')!;
    await mem.writeFile('C:\\d\\ipc.key.acl', Buffer.from(canonicalJsonLine({ ctimeNs: String(e.ctimeNs), dev: String(e.dev), ino: String(e.ino), mtimeNs: String(e.mtimeNs),
      size: String(e.data.length) }), 'utf8'));
  };
  return { mem, K, forge };
}

test('a forged stamp on a broad-ACL key refuses', async () => {
  // The stamp is a cached identity, not a proof: a hook's 'use' cannot tell a stamp a verifier wrote from one a planter wrote next to a key the
  // full check refuses (SE5-17's precondition: only the user can write the data directory). So the daemon's start (createIpcKey, X5-28) makes the
  // data directory user-only first and fails closed, and every refusal deletes the stamp — createIpcKey's included (P5SEC #34).
  const { mem, forge } = plantedKey();
  await forge();
  const acl = countingAcl({ value: SDDL['everyoneRead'] as string });
  const d: KeyDeps = { fs: mem, random: seededRandom('k'), platform: 'win32', uid: null, acl };
  // The start refuses the planted key and removes the forged stamp; the key itself is left for the user (never replaced).
  await assert.rejects(createIpcKey('C:\\d', d), (e: unknown) => e instanceof IpcKeyRefused && e.code === 'SEC_REFUSE_IPC_ACL');
  assert.equal(await mem.lstat('C:\\d\\ipc.key.acl'), null, "createIpcKey's refusal deletes the stamp");
  assert.deepEqual(await mem.readFile('C:\\d\\ipc.key'), Buffer.alloc(32, 6));
  assert.ok(acl.calls.includes(`protectDir C:\\d ${USER}`), 'the data directory was made user-only first');
  // A hook after it: no stamp → the full check → refused.
  const before = acl.calls.length;
  assert.deepEqual(await readIpcKey('C:\\d', d, { stamp: 'use' }), { ok: false, code: 'SEC_REFUSE_IPC_ACL' });
  assert.deepEqual(acl.calls.slice(before), ['currentUserSid', 'readSddl C:\\d\\ipc.key'], 'the hook ran the full check');
  // The same forged stamp met by a 'write' verifier (the daemon's 30 s check, the MCP server's start): refused and deleted as well.
  await forge();
  assert.deepEqual(await readIpcKey('C:\\d', d, { stamp: 'write' }), { ok: false, code: 'SEC_REFUSE_IPC_ACL' });
  assert.equal(await mem.lstat('C:\\d\\ipc.key.acl'), null);
});

test('a refusal whose stamp delete fails (EPERM, EACCES) still refuses, keeps the stamp, runs no icacls on it, and hooks keep trusting it — the residual the trusted-copy carry closes (P5SEC #34 journal; F2 #156 #80)', async () => {
  // A stamp the user cannot delete (a planter-owned file whose DACL denies the user DELETE) is one the user cannot change the DACL of either: the
  // user has no WRITE_DAC on it, so 81c84c1's retry through icacls (grant the user control of the stamp, then delete again) bought nothing, and it
  // rewrote a DACL on a path inside a directory the planter controls. The refused start deletes the stamp with one best-effort unlink and nothing
  // else; a stamp that survives it stays trusted by hooks while it matches — the honest residual, pinned here on purpose: only the trusted copy
  // under <gitdir>/cowork/ (SE5-17's carry, HANDOFF §11) closes it.
  const STAMP = 'C:\\d\\ipc.key.acl';
  const refused = (e: unknown): boolean => e instanceof IpcKeyRefused && e.code === 'SEC_REFUSE_IPC_ACL';
  const startStep = (step: 'createIpcKey' | 'protectDataDir', d: KeyDeps): Promise<unknown> =>
    step === 'createIpcKey' ? createIpcKey('C:\\d', d) : protectDataDir('C:\\d', d);
  for (const code of ['EPERM', 'EACCES'] as const) {
    for (const step of ['createIpcKey', 'protectDataDir'] as const) {
      const what = `${step}, ${code}`;
      const { mem, forge } = plantedKey();
      await forge();
      const stamp = await mem.readFile(STAMP);
      const ffs = new FaultFs(mem);
      ffs.addRule({ op: 'unlink', pathIncludes: 'ipc.key.acl', code, times: 1 });   // protectDirFor's delete
      const acl = countingAcl({ value: SDDL['everyoneRead'] as string }, USER, { dir: { value: SDDL['everyoneRead'] as string } });
      await assert.rejects(startStep(step, { fs: ffs, random: seededRandom('k'), platform: 'win32', uid: null, acl }), refused, what);
      assert.deepEqual(await mem.readFile(STAMP), stamp, `${what}: the stamp survives a denied delete`);
      assert.deepEqual(acl.calls.filter((c) => c.startsWith('restrictToUser')), [], `${what}: no icacls runs on the stamp`);
      assert.deepEqual(ffs.calls.filter((c) => c === `unlink ${STAMP}`), [`unlink ${STAMP}`], `${what}: one delete, no retry`);
      assert.deepEqual(await mem.readFile('C:\\d\\ipc.key'), Buffer.alloc(32, 6), `${what}: the key is left for the user, never replaced`);
      const hook = await readIpcKey('C:\\d', { fs: mem, random: seededRandom('k'), platform: 'win32', uid: null, acl }, { stamp: 'use' });
      assert.deepEqual(hook, { ok: true, key: Buffer.alloc(32, 6) }, `${what}: the hook still trusts the surviving stamp (the residual)`);
    }
  }
});

test('the start makes the data directory user-only and fails closed when it cannot (P5SEC #34)', async () => {
  const fresh = (): { mem: MemFs; ffs: FaultFs } => {
    const mem = new MemFs(0);
    return { mem, ffs: new FaultFs(mem) };
  };
  const refused = (e: unknown): boolean => e instanceof IpcKeyRefused && e.code === 'SEC_REFUSE_IPC_ACL';
  const keyWrites = (ffs: FaultFs): string[] => ffs.calls.filter((c) => /^(writeFileExclusive|link|rename) /.test(c));
  // A data directory whose DACL is still not user-only after protectDir (an explicit foreign ACE survives /inheritance:r): refused before any key
  // byte is written.
  {
    const { mem, ffs } = fresh();
    const acl = countingAcl({ value: SDDL['userOnly'] as string }, USER, { dir: { value: SDDL['everyoneRead'] as string } });
    await assert.rejects(createIpcKey('C:\\d', { fs: ffs, random: seededRandom('k'), platform: 'win32', uid: null, acl }), refused);
    assert.deepEqual(acl.calls, ['currentUserSid', `protectDir C:\\d ${USER}`, 'readSddl C:\\d']);
    assert.deepEqual(keyWrites(ffs), []);
    assert.deepEqual([...mem.entries.keys()], ['C:\\d']);
  }
  // protectDir failing (icacls exit ≠ 0) or an unreadable directory SDDL: refused (fail closed), nothing written.
  for (const broken of ['protectDir', 'readSddl'] as const) {
    const { ffs } = fresh();
    const acl = countingAcl({ value: SDDL['userOnly'] as string });
    acl[broken] = async () => { throw new Error(`${broken} failed`); };
    await assert.rejects(createIpcKey('C:\\d', { fs: ffs, random: seededRandom('k'), platform: 'win32', uid: null, acl }), refused, broken);
    assert.deepEqual(keyWrites(ffs), [], broken);
  }
  // A symlink or junction at the data directory path: refused before icacls runs on it.
  {
    const { mem, ffs } = fresh();
    mem.put('C:\\d', { kind: 'symlink', mode: 0o120777 });
    const acl = countingAcl({ value: SDDL['userOnly'] as string });
    await assert.rejects(createIpcKey('C:\\d', { fs: ffs, random: seededRandom('k'), platform: 'win32', uid: null, acl }), refused);
    assert.ok(!acl.calls.some((c) => c.startsWith('protectDir')), acl.calls.join('\n'));
  }
  // The path swapped for another directory while icacls ran (dev/ino changed): refused.
  {
    const { mem, ffs } = fresh();
    const acl = countingAcl({ value: SDDL['userOnly'] as string });
    acl.protectDir = async () => { mem.put('C:\\d', { kind: 'dir' }); };   // a new inode under the same name
    await assert.rejects(createIpcKey('C:\\d', { fs: ffs, random: seededRandom('k'), platform: 'win32', uid: null, acl }), refused);
    assert.deepEqual(keyWrites(ffs), []);
  }
  // protectDataDir is the start's step on its own too (Task 5's run.ts may call it before it reads a key with 'write').
  {
    const { mem } = fresh();
    mem.put('C:\\d', { kind: 'dir' });
    const acl = countingAcl({ value: SDDL['userOnly'] as string });
    await protectDataDir('C:\\d', { fs: mem, random: seededRandom('k'), platform: 'win32', uid: null, acl });
    assert.deepEqual(acl.calls, ['currentUserSid', `protectDir C:\\d ${USER}`, 'readSddl C:\\d']);
    // POSIX: nothing to protect (the key's parent mode is checked on every read; no stamp exists there).
    await protectDataDir('/d', posixDeps(new MemFs(1000)));
  }
});

test('a start refused at the data-directory step deletes a forged stamp, never through a link; a whoami failure keeps it (P5SEC #34 r1)', async () => {
  // The refusal that shows SE5-17's precondition is false (the directory is not user-only, or is not the directory it was) is exactly the one a
  // planted key with a forged stamp meets. It must leave no stamp, so the next hook runs the full check instead of trusting the planted key.
  const STAMP = 'C:\\d\\ipc.key.acl';
  const REFUSE = { ok: false, code: 'SEC_REFUSE_IPC_ACL' };
  const refused = (e: unknown): boolean => e instanceof IpcKeyRefused && e.code === 'SEC_REFUSE_IPC_ACL';
  const foreignOwnerDir = `O:S-1-5-21-9-9-9-2002G:S-1-5-21-1111-2222-3333-513D:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;
  const causes = ['a broad DACL', 'a foreign owner', 'an unparseable SDDL', 'protectDir failing', 'Get-Acl failing', 'another directory swapped in'] as const;
  const startStep = (step: 'createIpcKey' | 'protectDataDir', d: KeyDeps): Promise<unknown> =>
    step === 'createIpcKey' ? createIpcKey('C:\\d', d) : protectDataDir('C:\\d', d);
  for (const cause of causes) {
    for (const step of ['createIpcKey', 'protectDataDir'] as const) {
      const what = `${step}, ${cause}`;
      // A planted 32-byte key whose own ACL is broad, and the stamp a planter forged for it.
      const { mem, forge } = plantedKey();
      await forge();
      const dirSddl = cause === 'a broad DACL' ? SDDL['everyoneRead'] : cause === 'a foreign owner' ? foreignOwnerDir
        : cause === 'an unparseable SDDL' ? SDDL['unparseable'] : SDDL['userOnly'];
      const acl = countingAcl({ value: SDDL['everyoneRead'] as string }, USER, { dir: { value: dirSddl as string } });
      const { protectDir, readSddl } = acl;
      acl.protectDir = async (p, s, b) => {
        await protectDir(p, s, b);
        if (cause === 'protectDir failing') throw new Error('icacls: exit code 5');
        if (cause === 'another directory swapped in') mem.put('C:\\d', { kind: 'dir' });   // a new inode under the same name (its stamp entry kept)
      };
      acl.readSddl = async (p, b) => {
        const v = await readSddl(p, b);
        if (cause === 'Get-Acl failing' && p === 'C:\\d') throw new Error('powershell.exe: exit code 1');
        return v;
      };
      const d: KeyDeps = { fs: mem, random: seededRandom('k'), platform: 'win32', uid: null, acl };
      await assert.rejects(startStep(step, d), refused, what);
      assert.equal(await mem.lstat(STAMP), null, `${what}: the refusal deletes the forged stamp`);
      assert.deepEqual(await mem.readFile('C:\\d\\ipc.key'), Buffer.alloc(32, 6), `${what}: the planted key is left for the user`);
      // The next hook finds no stamp: it runs the full check (whoami + Get-Acl on the key), which refuses the planted key.
      const before = acl.calls.length;
      assert.deepEqual(await readIpcKey('C:\\d', d, { stamp: 'use' }), REFUSE, what);
      assert.deepEqual(acl.calls.slice(before), ['currentUserSid', 'readSddl C:\\d\\ipc.key'], `${what}: the next hook runs the full check`);
    }
  }
  // A link or junction at the data directory path — there before the start, or put there while icacls ran (which may then fail): refused, and
  // nothing is deleted through it (the file its target holds under the stamp's name is left as it is).
  for (const when of ['before the start', 'while icacls ran', 'while icacls ran, which then failed'] as const) {
    const { mem, forge } = plantedKey();
    await forge();
    const target = await mem.readFile(STAMP);
    const acl = countingAcl({ value: SDDL['userOnly'] as string });
    if (when === 'before the start') mem.put('C:\\d', { kind: 'symlink', mode: 0o120777 });
    else {
      acl.protectDir = async () => {
        mem.put('C:\\d', { kind: 'symlink', mode: 0o120777 });
        if (when !== 'while icacls ran') throw new Error('icacls: exit code 5');
      };
    }
    const ffs = new FaultFs(mem);
    await assert.rejects(createIpcKey('C:\\d', { fs: ffs, random: seededRandom('k'), platform: 'win32', uid: null, acl }), refused, when);
    assert.ok(!ffs.calls.some((c) => c.startsWith('unlink ')), `${when}:\n${ffs.calls.join('\n')}`);
    assert.deepEqual(await mem.readFile(STAMP), target, when);
  }
  // whoami failing before the step (no SID, nothing learnt about the directory): refused, the stamp kept — a runner error is no verdict (#35).
  for (const step of ['createIpcKey', 'protectDataDir'] as const) {
    const { mem, forge } = plantedKey();
    await forge();
    const stamp = await mem.readFile(STAMP);
    const acl = countingAcl({ value: SDDL['userOnly'] as string });
    acl.currentUserSid = async () => { throw new Error('whoami: exit code -1'); };
    await assert.rejects(startStep(step, { fs: mem, random: seededRandom('k'), platform: 'win32', uid: null, acl }), refused, step);
    assert.deepEqual(await mem.readFile(STAMP), stamp, `${step}: a whoami failure deletes nothing`);
  }
});

test('an lstat of the data directory that throws (EPERM, EACCES) refuses IpcKeyRefused and deletes nothing (F2 #156; PC 2 rereview1 P5SEC)', async () => {
  // protectDirFor lstats the data directory before icacls and again after it; an lstat that throws (not "absent") is no verdict on what is at the
  // path, so the step refuses as a missing directory does (start refused, SEC_REFUSE_IPC_ACL — run.ts maps only IpcKeyRefused) and deletes
  // nothing through a path it could not verify. The first lstat's fault refuses before icacls runs.
  const STAMP = 'C:\\d\\ipc.key.acl';
  const refused = (e: unknown): boolean => e instanceof IpcKeyRefused && e.code === 'SEC_REFUSE_IPC_ACL';
  const startStep = (step: 'createIpcKey' | 'protectDataDir', d: KeyDeps): Promise<unknown> =>
    step === 'createIpcKey' ? createIpcKey('C:\\d', d) : protectDataDir('C:\\d', d);
  for (const code of ['EPERM', 'EACCES'] as const) {
    for (const step of ['createIpcKey', 'protectDataDir'] as const) {
      for (const cause of ['protectDir failing', 'the directory passes', 'the first lstat'] as const) {
        const what = `${step}, ${code}, ${cause}`;
        const { mem, forge } = plantedKey();
        await forge();
        const stamp = await mem.readFile(STAMP);
        const ffs = new FaultFs(mem);
        const acl = countingAcl({ value: SDDL['userOnly'] as string });
        // FaultFs.mkdirp passes straight through and whoami is an ACL call, so the start's first ffs.lstat is protectDirFor's first one.
        if (cause === 'the first lstat') ffs.addRule({ op: 'lstat', pathIncludes: 'C:\\d', code, times: 1 });
        else {
          acl.protectDir = async (p, s) => {
            acl.calls.push(`protectDir ${p} ${s}`);
            ffs.addRule({ op: 'lstat', pathIncludes: 'C:\\d', code, times: 1 });   // added after the first lstat: it fails exactly the second
            if (cause === 'protectDir failing') throw new Error('icacls: exit code 5');
          };
        }
        await assert.rejects(startStep(step, { fs: ffs, random: seededRandom('k'), platform: 'win32', uid: null, acl }), refused, what);
        assert.ok(!ffs.calls.some((c) => c.startsWith('unlink ')), `${what}: nothing deleted\n${ffs.calls.join('\n')}`);
        assert.deepEqual(await mem.readFile(STAMP), stamp, `${what}: the stamp is untouched`);
        assert.deepEqual(await mem.readFile('C:\\d\\ipc.key'), Buffer.alloc(32, 6), `${what}: the key is untouched`);
        if (cause === 'the first lstat') assert.ok(!acl.calls.some((c) => c.startsWith('protectDir')), `${what}: refused before icacls runs`);
      }
    }
  }
});

test('the full check runs within the caller\'s remaining time; a runner error or an expired bound refuses but keeps the stamp (P5SEC #35)', async () => {
  const { mem, forge } = plantedKey();
  const sddl = { value: SDDL['userOnly'] as string };
  const acl = countingAcl(sddl);
  const d: KeyDeps = { fs: mem, random: seededRandom('k'), platform: 'win32', uid: null, acl };
  await forge();
  mem.entries.get('C:\\d\\ipc.key')!.ctimeNs += 1n;   // the stamp no longer matches: a hook must run the full check
  const stamp = await mem.readFile('C:\\d\\ipc.key.acl');
  // The bound reaches both runner calls (started together, so the check costs the slower of the two, not their sum).
  let left = 1_200;
  assert.deepEqual(await readIpcKey('C:\\d', d, { stamp: 'use', remainingMs: () => left }), { ok: true, key: Buffer.alloc(32, 6) });
  assert.deepEqual(acl.bounds, [1_200, 1_200]);
  // A runner that fails (an EPERM spawn, a timeout at the bound): refused, the stamp kept — no verdict was reached.
  acl.readSddl = async () => { throw new Error('powershell.exe: exit code -1'); };
  assert.deepEqual(await readIpcKey('C:\\d', d, { stamp: 'use', remainingMs: () => left }), { ok: false, code: 'SEC_REFUSE_IPC_ACL' });
  assert.deepEqual(await mem.readFile('C:\\d\\ipc.key.acl'), stamp, 'a runner error deletes nothing');
  assert.deepEqual(await readIpcKey('C:\\d', d, { stamp: 'write' }), { ok: false, code: 'SEC_REFUSE_IPC_ACL' });
  assert.deepEqual(await mem.readFile('C:\\d\\ipc.key.acl'), stamp, "nor under 'write'");
  // An unparseable SDDL is no verdict either (a banner or warning in PowerShell's output): refused, stamp kept.
  acl.readSddl = async () => SDDL['unparseable'] as string;
  assert.deepEqual(await readIpcKey('C:\\d', d, { stamp: 'use' }), { ok: false, code: 'SEC_REFUSE_IPC_ACL' });
  assert.deepEqual(await mem.readFile('C:\\d\\ipc.key.acl'), stamp);
  // No time left: no runner starts at all; refused, stamp kept.
  const calls = acl.calls.length;
  left = 0;
  assert.deepEqual(await readIpcKey('C:\\d', d, { stamp: 'use', remainingMs: () => left }), { ok: false, code: 'SEC_REFUSE_IPC_ACL' });
  assert.equal(acl.calls.length, calls, 'no spawn past the deadline');
  assert.deepEqual(await mem.readFile('C:\\d\\ipc.key.acl'), stamp);
  // A matching stamp still answers with no time left (it needs no runner).
  await forge();
  assert.deepEqual(await readIpcKey('C:\\d', d, { stamp: 'use', remainingMs: () => 0 }), { ok: true, key: Buffer.alloc(32, 6) });
});

test('keyHash is the hex SHA-256 of the key bytes', () => {
  assert.equal(keyHash(Buffer.alloc(32, 7)), createHash('sha256').update(Buffer.alloc(32, 7)).digest('hex'));
  assert.match(keyHash(Buffer.alloc(32, 7)), /^[0-9a-f]{64}$/);
  assert.notEqual(keyHash(Buffer.alloc(32, 8)), keyHash(Buffer.alloc(32, 7)));
});
