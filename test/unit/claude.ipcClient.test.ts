// Plan 5 Task 4: the IPC client (R1-222 client half, R1-311, CCI-10, CCI-17 client half; A4-5, P5-EC-3; 06 §3.4.2 step 2, 09 test 30 hook half). The
// Deadline on a VirtualClock; openSession over the real Ipc and the real handshake on the real clock (Ruling P5-T3-1: never the stock VirtualClock for
// a handshake), against test/helpers/fakeDaemon.ts.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Deadline, openSession, wireCodec } from '../../src/claude/client/ipcClient.js';
import { encodeFrame, LineReader } from '../../src/claude/wire/ndjson.js';
import { endpointRoot, type LiveRepo } from '../../src/data/canonRoot.js';
import { realClock } from '../../src/ports/clock.js';
import { realFs, realRootProbe, type Fs, type FsLstat } from '../../src/ports/fs.js';
import { realIpc, type Ipc } from '../../src/ports/ipc.js';
import { realRandom } from '../../src/ports/random.js';
import { clientHandshake, HandshakeFailed } from '../../src/sec/handshake.js';
import { createIpcKey, type KeyDeps } from '../../src/sec/ipcKey.js';
import { realWinAcl, WinAclError, type WinAcl } from '../../src/sec/winAcl.js';
import { FaultFs } from '../sim/faultfs.js';
import { VirtualClock } from '../sim/vclock.js';
import { fakeDaemon, type FakeDaemon } from '../helpers/fakeDaemon.js';
import { endpointOf } from '../helpers/loaderRun.js';
import { makeTempRoot } from '../helpers/tmp.js';

const PLATFORM = process.platform;
let tmp: { root: string; cleanup: () => Promise<void> };
let repo: LiveRepo;
let key: Buffer;
let endpoint = '';
const keyDeps: KeyDeps = { fs: realFs, random: realRandom, platform: PLATFORM, uid: process.getuid?.() ?? null, acl: realWinAcl };
const deps = (o: { fs?: KeyDeps['fs']; ipc?: Ipc } = {}): Parameters<typeof openSession>[1] =>
  ({ fs: o.fs ?? realFs, ipc: o.ipc ?? realIpc, random: realRandom, platform: PLATFORM, uid: keyDeps.uid, acl: realWinAcl, env: process.env });

before(async () => {
  tmp = await makeTempRoot('ipc-client');
  const gitdir = join(tmp.root, 'repo', '.git');
  mkdirSync(join(gitdir, 'cowork'), { recursive: true });
  const dataDir = join(tmp.root, 'data');
  key = await createIpcKey(dataDir, keyDeps);   // win32: it also writes the stamp a hook's {stamp: 'use'} read accepts (A3-6, P5SEC #35)
  const epRoot = endpointRoot(gitdir, realRootProbe, PLATFORM);
  repo = { root: join(tmp.root, 'repo'), gitdir, coworkDir: join(gitdir, 'cowork'), dataDir, endpointRoot: epRoot };
  endpoint = await endpointOf(key, gitdir);
});
after(() => tmp?.cleanup());

test('Deadline: remainingMs counts from loader start and extendTo works once up to 7,000', () => {
  const clock = new VirtualClock({ startMono: 1_000 });
  const d = new Deadline(clock, 0, 1_500);
  assert.equal(d.clock, clock, 'P5-EC-3: the constructor clock is public');
  assert.equal(d.remainingMs(), 500);
  assert.equal(d.expired(), false);
  clock.advance(500);
  assert.equal(d.expired(), true);
  assert.equal(d.remainingMs(), 0);
  assert.equal(d.extendTo(7_000), true);
  assert.equal(d.remainingMs(), 5_500);
  assert.equal(d.expired(), false);
  assert.equal(d.extendTo(7_000), false, 'a second extend is ignored');
  assert.equal(d.remainingMs(), 5_500);
  const fresh = new Deadline(new VirtualClock(), 0, 1_500);
  assert.equal(fresh.extendTo(7_001), false, 'above SUSPECT_DEADLINE_MAX_MS');
  assert.equal(fresh.remainingMs(), 1_500);
});

test('wireCodec is the one FrameCodec binding: LineReader, encodeFrame and the session schema', () => {
  assert.ok(wireCodec.reader() instanceof LineReader);
  assert.equal(wireCodec.encode, encodeFrame);
  assert.deepEqual(wireCodec.validate('s2c', { t: 'extend', deadline_ms: 7_000 }), { t: 'extend', deadline_ms: 7_000 });
  assert.equal(wireCodec.validate('s2c', { t: 'extend', deadline_ms: 9_000 }), null);
  assert.equal(wireCodec.validate('c2s', { t: 'hello', v: 1, n1: 'AAAAAAAAAAAAAAAAAAAAAA==' }), null, 'session phase only');
});

test('openSession retries every 50 ms until the deadline and never connects without a verified key', async () => {
  // (a) The fakeDaemon starts listening 400 ms after the call: at the first attempt at or after 400 ms (every earlier one finds no endpoint).
  const t0 = realClock.monoMs();
  const attempts: Array<{ at: number; ok: boolean }> = [];
  let daemon: FakeDaemon | null = null;
  const late: Ipc = {
    ...realIpc,
    connect: async (ep, ms) => {
      const at = realClock.monoMs() - t0;
      if (at >= 400 && daemon === null) daemon = await fakeDaemon(endpoint, key);
      try {
        const c = await realIpc.connect(ep, ms);
        attempts.push({ at, ok: true });
        return c;
      } catch (e) {
        attempts.push({ at, ok: false });
        throw e;
      }
    },
  };
  const conn = await openSession(repo, deps({ ipc: late }), new Deadline(realClock, t0, 1_500));
  const openedAt = realClock.monoMs() - t0;
  try {
    assert.ok(conn !== null, 'a session');
    assert.ok(openedAt >= 400 && openedAt < 500, `opened at ${openedAt} ms`);
    const refused = attempts.filter((a) => !a.ok);
    assert.equal(refused.length, Math.floor(400 / 50), `refused at ${refused.map((a) => Math.round(a.at)).join(', ')}`);
    refused.forEach((a, i) => assert.ok(a.at >= i * 50 - 1 && a.at < 400, `attempt ${i} at ${a.at}`));
    assert.equal(attempts.length, refused.length + 1, 'the first attempt after 400 ms opens it');
    assert.equal((daemon as FakeDaemon | null)?.connections(), 1);
  } finally {
    conn?.close();
    await (daemon as FakeDaemon | null)?.close();
  }

  // (b) readIpcKey refusing (SEC_REFUSE_IPC_ACL: the key's lstat fails EACCES) → null at once, 0 connect attempts.
  const faulty = new FaultFs(realFs);
  faulty.addRule({ op: 'lstat', pathIncludes: 'ipc.key', code: 'EACCES', times: 1 });
  let connects = 0;
  const counting: Ipc = { ...realIpc, connect: (ep, ms) => { connects += 1; return realIpc.connect(ep, ms); } };
  const t1 = realClock.monoMs();
  assert.equal(await openSession(repo, deps({ fs: faulty, ipc: counting }), new Deadline(realClock, t1, 1_500)), null);
  assert.ok(realClock.monoMs() - t1 < 200, 'at once');
  assert.equal(connects, 0);
  assert.equal(faulty.hits.get('lstat:EACCES:ipc.key'), 1);
  // A missing key: null at once as well.
  assert.equal(await openSession({ ...repo, dataDir: join(tmp.root, 'no-such-data') }, deps({ ipc: counting }), new Deadline(realClock, realClock.monoMs(), 1_500)), null);
  assert.equal(connects, 0);

  // (c) A fakeDaemon with another key: every attempt fails its handshake, null at the deadline; each failed handshake is reported to the caller
  // (P5SEC #36, SEC-22 client side) — the squatter's proof fails as 'mac' — while a refused connect (no endpoint) is no handshake and reports nothing.
  const other = await fakeDaemon(endpoint, Buffer.alloc(32, 0x5a));
  try {
    const t2 = realClock.monoMs();
    const whys: string[] = [];
    assert.equal(await openSession(repo, { ...deps(), onHandshakeFail: (why) => whys.push(why) }, new Deadline(realClock, t2, 1_500)), null);
    const elapsed = realClock.monoMs() - t2;
    assert.ok(elapsed >= 1_450 && elapsed < 2_200, `null at the deadline (${elapsed} ms)`);
    assert.ok(other.connections() >= 10, `retried every 50 ms (${other.connections()} connections)`);
    assert.ok(whys.length >= other.connections() - 1 && whys.length <= other.connections(), `${whys.length} reports for ${other.connections()} connections`);
    assert.ok(whys.slice(0, -1).every((w) => w === 'mac'), whys.join(','));
    assert.equal(other.frames().length, 0, 'no attempt authenticated: no session frame');
    // What each attempt met: the server's proof under another key fails the client's check (HandshakeFailed).
    const c = await realIpc.connect(endpoint, 1_000);
    await assert.rejects(clientHandshake(c, key, endpoint, realRandom, 1_500, wireCodec, { clock: realClock }), HandshakeFailed);
  } finally {
    await other.close();
  }
  {
    const whys: string[] = [];
    const none: Ipc = { ...realIpc, connect: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } };
    assert.equal(await openSession(repo, { ...deps({ ipc: none }), onHandshakeFail: (why) => whys.push(why) }, new Deadline(realClock, realClock.monoMs(), 200)), null);
    assert.deepEqual(whys, [], 'a refused connect is not a failed handshake');
  }
});

test('openSession bounds the full key check by the deadline, and a runner error keeps the stamp (P5SEC #35)', async () => {
  // win32 semantics on any host: an in-memory data directory C:\d with a 32-byte key and a stamp that does not match it, so the hook must run the
  // full check; both runner calls stall until the bound they are given (as realWinAcl's execFile timeout kills a child) and then fail.
  const keyPath = 'C:\\d\\ipc.key';
  const stampPath = 'C:\\d\\ipc.key.acl';
  const st: FsLstat = { size: 32, mtimeNs: 1n, ctimeNs: 1n, ino: 7n, dev: 1n, mode: 0o100666, uid: 0, isFile: true, isDirectory: false, isSymbolicLink: false };
  const unlinked: string[] = [];
  const no = (): never => { throw new Error('not used'); };
  const fs: Fs = {
    lstat: async (p) => (p === keyPath ? st : null),
    readFile: async (p) => {
      if (p === keyPath) return Buffer.alloc(32, 1);
      if (p === stampPath) return Buffer.from('{"ctimeNs":"0","dev":"1","ino":"7","mtimeNs":"1","size":"32"}');
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    unlink: async (p) => { unlinked.push(p); }, writeFile: no, rename: no, link: no, stat: no, mkdirp: no, readdir: no, rmrf: no, writeFileExclusive: no,
    rmdir: no, appendFile: no, realpath: no, freeBytes: no, chmod: no,
  };
  const bounds: Array<number | undefined> = [];
  const stall = (b?: { timeoutMs?: number }): Promise<never> => new Promise((_, reject) => {
    bounds.push(b?.timeoutMs);
    setTimeout(() => reject(new WinAclError(-1)), Math.min(b?.timeoutMs ?? 3_000, 3_000));
  });
  const acl: WinAcl = { currentUserSid: (b) => stall(b), readSddl: (_f, b) => stall(b), restrictToUser: no, protectDir: no };
  let connects = 0;
  const ipc: Ipc = { ...realIpc, connect: async () => { connects += 1; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } };
  const live: LiveRepo = { root: 'C:\\r', gitdir: 'C:\\r\\.git', coworkDir: 'C:\\r\\.git\\cowork', dataDir: 'C:\\d', endpointRoot: 'c:/r/.git' };
  const t0 = realClock.monoMs();
  const conn = await openSession(live, { fs, ipc, random: realRandom, platform: 'win32', uid: null, acl, env: {} }, new Deadline(realClock, t0, 400));
  const elapsed = realClock.monoMs() - t0;
  assert.equal(conn, null, 'no verified key: no session');
  assert.equal(connects, 0);
  assert.ok(elapsed < 400 + 300, `returned by the deadline (${Math.round(elapsed)} ms), not after the runner's own 10 s cap`);
  assert.equal(bounds.length, 2, 'whoami and Get-Acl, started together');
  assert.ok(bounds.every((b) => b !== undefined && b > 0 && b <= 400), `bounds ${bounds.join(',')}`);
  assert.deepEqual(unlinked, [], 'a runner error is no verdict: the stamp stays');
});
