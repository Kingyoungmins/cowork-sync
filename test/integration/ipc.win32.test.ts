// Plan 5 Task 3 (windows-latest only): named pipes and the real key ACLs (09 tests 20 Windows half and 21 real half, TC-SEC-03, INV-IPC).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { encodeFrame, LineReader } from '../../src/claude/wire/ndjson.js';
import { validateFrame } from '../../src/claude/wire/schema.js';
import { endpointRoot } from '../../src/data/canonRoot.js';
import { realClock } from '../../src/ports/clock.js';
import { realFs, realRootProbe } from '../../src/ports/fs.js';
import { realIpc, type IpcConn } from '../../src/ports/ipc.js';
import { realRandom } from '../../src/ports/random.js';
import { endpointName } from '../../src/sec/endpoint.js';
import { clientHandshake, serverHandshake, type FrameCodec } from '../../src/sec/handshake.js';
import { createIpcKey, IpcKeyRefused, readIpcKey, type KeyDeps } from '../../src/sec/ipcKey.js';
import { parseSddl, sddlUserOnly } from '../../src/sec/sddl.js';
import { realWinAcl } from '../../src/sec/winAcl.js';
import { ipcCapture } from '../helpers/ipcCapture.js';
import { makeTempRoot } from '../helpers/tmp.js';

const WIN = process.platform === 'win32';
const SKIP = WIN ? false : 'named pipes and Windows ACLs (this runner is not win32)';
const codec: FrameCodec = { reader: () => new LineReader(), encode: encodeFrame, validate: (d, v) => validateFrame('session', d, v) };
const system32 = (exe: string): string => path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', exe);

test('named pipes: one bind per endpoint; a read-only client and a \\\\127.0.0.1\\pipe\\ client receive 0 session bytes', { skip: SKIP }, async (t) => {
  const tmp = await makeTempRoot('ipc-win32');
  t.after(tmp.cleanup);
  const gitdir = path.join(tmp.root, 'repo', '.git');
  await mkdir(gitdir, { recursive: true });
  const key = Buffer.from(realRandom.bytes(32));
  const ep = endpointName(key, endpointRoot(gitdir, realRootProbe, 'win32'), 'win32', null);
  assert.match(ep, /^\\\\\.\\pipe\\cowork-[0-9a-f]{32}$/);

  const cap = ipcCapture(realIpc);
  const fails: string[] = [];
  let authed = 0;
  const server = await cap.listen(ep, (c: IpcConn) => {
    serverHandshake(c, key, ep, realRandom, (why) => fails.push(why), codec, { clock: realClock, timeoutMs: 1_500 })
      .then((sc) => { authed += 1; sc.onFrame(() => sc.send({ t: 'refused', code: 'TEST' })); }, () => {});
  });
  t.after(() => server.close());

  // A second listen on the same pipe → EADDRINUSE.
  await assert.rejects(realIpc.listen(ep, () => {}), (e: unknown) => (e as NodeJS.ErrnoException).code === 'EADDRINUSE');

  // A client that opens the pipe read-only can never send hello: it receives 0 bytes and the server times it out.
  const ro = await open(ep, 'r');
  let roBytes = 0;
  try {
    const r = await ro.read(Buffer.alloc(256), 0, 256, null).catch(() => ({ bytesRead: 0 }));
    roBytes = r.bytesRead;
  } finally {
    await ro.close().catch(() => {});
  }
  assert.equal(roBytes, 0, 'the read-only client received 0 bytes');
  assert.equal(cap.accepted.length, 1);
  assert.equal(cap.accepted[0]?.out().length, 0, 'the server wrote 0 bytes to it');
  assert.deepEqual(fails, ['timeout']);

  // A client through \\127.0.0.1\pipe\… without the key: 0 bytes before its own hello, at most the srv line after it, 0 session bytes.
  const unc = ep.replace(/^\\\\\.\\/, '\\\\127.0.0.1\\');
  let uncConn: IpcConn | null = null;
  try {
    uncConn = await cap.connect(unc, 1_000);
  } catch (e) {
    t.diagnostic(`\\\\127.0.0.1\\pipe\\ connect refused by the OS (${(e as NodeJS.ErrnoException).code ?? String(e)}): 0 bytes received`);
  }
  if (uncConn !== null) {
    t.diagnostic('\\\\127.0.0.1\\pipe\\ connected (SMB loopback available): asserting the srv-line-only branch');
    const reader = new LineReader();
    const received: string[] = [];
    const done = new Promise<void>((r) => uncConn!.onClose(r));
    uncConn.onData((b) => {
      for (const l of reader.push(b)) {
        received.push(l);
        // No key: any proof is wrong.
        uncConn!.write(Buffer.from(`${JSON.stringify({ t: 'cli', p: Buffer.alloc(32, 5).toString('base64') })}\n`));
      }
    });
    await new Promise((r) => setTimeout(r, 200));
    const serverSide = cap.accepted[1];
    assert.ok(serverSide !== undefined);
    assert.equal(serverSide.out().length, 0, '0 bytes before the client sends hello');
    uncConn.write(Buffer.from(`${JSON.stringify({ t: 'hello', v: 1, n1: Buffer.alloc(16, 4).toString('base64') })}\n`));
    await done;
    assert.equal(serverSide.outBeforeReceived('hello'), 0);
    assert.equal(received.length, 1);
    assert.equal((JSON.parse(received[0] as string) as { t: string }).t, 'srv');
    assert.equal(serverSide.sessionBytes(), 0, '0 session bytes ever');
    assert.deepEqual(fails, ['timeout', 'mac']);
  }

  assert.equal(await realIpc.removeStale(ep), false, 'a pipe is never removed');

  // The first listener keeps serving: a client with the key authenticates.
  const conn = await realIpc.connect(ep, 1_000);
  const client = await clientHandshake(conn, key, ep, realRandom, 3_000, codec);
  const reply = new Promise<object>((r) => client.onFrame(r));
  client.send({ t: 'heartbeat' });
  assert.deepEqual(await reply, { t: 'refused', code: 'TEST' });
  assert.equal(authed, 1);
  client.close();
});

test('real key ACLs on Windows', { skip: SKIP }, async (t) => {
  const tmp = await makeTempRoot('ipckey-acl');
  t.after(tmp.cleanup);
  const dataDir = path.join(tmp.root, 'data');
  const d: KeyDeps = { fs: realFs, random: realRandom, platform: 'win32', uid: null, acl: realWinAcl };
  const key = await createIpcKey(dataDir, d);
  assert.deepEqual(await readIpcKey(dataDir, d), { ok: true, key });
  // P5SEC #34: the start left the data directory with a protected (inheritance removed) user-only DACL, and the stamp beside the key with the
  // key's own ACL — one ACE for the user, nothing inherited.
  const sid = await realWinAcl.currentUserSid();
  const stampPath = path.join(dataDir, 'ipc.key.acl');
  for (const [what, p] of [['data directory', dataDir], ['stamp', stampPath]] as const) {
    const sddl = await realWinAcl.readSddl(p);
    const parsed = parseSddl(sddl);
    assert.ok(parsed !== null && sddlUserOnly(parsed, sid), `${what}: user-only (${sddl.replace(/S-1-[0-9]+-[0-9]+(?:-[0-9]+){3,}/g, '<account SID>')})`);
    assert.match(sddl, /D:P/, `${what}: protected (no inherited ACE)`);
  }
  assert.deepEqual(parseSddl(await realWinAcl.readSddl(stampPath))?.allow, [sid], 'the stamp: exactly the key\'s one ACE');
  // The key's DACL is the user alone; then an Everyone read ACE (test code) → SEC_REFUSE_IPC_ACL.
  const keyPath = path.join(dataDir, 'ipc.key');
  execFileSync(system32('icacls.exe'), [keyPath, '/grant', '*S-1-1-0:R'], { windowsHide: true, stdio: 'ignore' });
  assert.deepEqual(await readIpcKey(dataDir, d), { ok: false, code: 'SEC_REFUSE_IPC_ACL' });
  // 'a forged stamp on a broad-ACL key refuses', on real files: a stamp written for the broadened key's identity, as a planter would, is
  // removed by the start's refusal, and the next hook read runs the full check and refuses.
  const st = await realFs.lstat(keyPath);
  assert.ok(st !== null && st.ctimeNs !== undefined);
  await realFs.writeFile(stampPath, Buffer.from(JSON.stringify({ ctimeNs: String(st.ctimeNs), dev: String(st.dev), ino: String(st.ino),
    mtimeNs: String(st.mtimeNs), size: String(st.size) }), 'utf8'));
  await assert.rejects(createIpcKey(dataDir, d), (e: unknown) => e instanceof IpcKeyRefused);
  assert.equal(await realFs.lstat(stampPath), null, "the start's refusal deleted the forged stamp");
  assert.deepEqual(await readIpcKey(dataDir, d, { stamp: 'use' }), { ok: false, code: 'SEC_REFUSE_IPC_ACL' });
  // P5SEC #34 r1, on real files: an explicit Everyone ACE on the data directory survives protectDir's /inheritance:r, so the start refuses at
  // the directory step, before it reads the key — and that refusal deletes a forged stamp as well.
  await realFs.writeFile(stampPath, Buffer.from(JSON.stringify({ ctimeNs: String(st.ctimeNs), dev: String(st.dev), ino: String(st.ino),
    mtimeNs: String(st.mtimeNs), size: String(st.size) }), 'utf8'));
  execFileSync(system32('icacls.exe'), [dataDir, '/grant', '*S-1-1-0:(OI)(CI)R'], { windowsHide: true, stdio: 'ignore' });
  await assert.rejects(createIpcKey(dataDir, d), (e: unknown) => e instanceof IpcKeyRefused);
  assert.match(await realWinAcl.readSddl(dataDir), /\(A;[^)]*;;;WD\)/, 'the explicit foreign ACE survived protectDir');
  assert.equal(await realFs.lstat(stampPath), null, "the directory step's refusal deleted the forged stamp");

  // The SID comparison on a non-ASCII account name: this runner's own account, when its name is non-ASCII.
  const who = execFileSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const nameBytes = who.subarray(0, who.lastIndexOf(Buffer.from('","')));
  const nonAscii = nameBytes.some((b) => b >= 0x80);
  await t.test('a non-ASCII account name passes the SID check', { skip: nonAscii ? false : 'this runner\'s account name is ASCII (none configured)' }, async () => {
    const dir2 = path.join(tmp.root, 'data2');
    const k2 = await createIpcKey(dir2, d);
    assert.deepEqual(await readIpcKey(dir2, d), { ok: true, key: k2 });
  });
});
