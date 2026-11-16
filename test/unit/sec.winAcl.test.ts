// Plan 5 Task 3: the Windows ACL runner (SEC-20, R5-48, OQ-14 (r2), A3-4) and Plan 5's use of src/sec/sddl.ts's verdict (X-62).
// 8a's own parseSddl/sddlUserOnly tests stay in test/unit/viz/dataDir.test.ts and test/integration/viz/ownerProbe.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseSddl, sddlUserOnly } from '../../src/sec/sddl.js';
import * as vizDataDir from '../../src/viz/cli/dataDir.js';
import * as winAclModule from '../../src/sec/winAcl.js';
import { createWinAcl, WinAclError, type WinAcl } from '../../src/sec/winAcl.js';
import { readIpcKey } from '../../src/sec/ipcKey.js';
import type { Fs, FsLstat } from '../../src/ports/fs.js';
import { seededRandom } from '../../src/ports/random.js';

const FIX = path.join(process.cwd(), 'test', 'fixtures', 'sec');
const SDDL = JSON.parse(readFileSync(path.join(FIX, 'sddl.json'), 'utf8')) as Record<string, string>;
const USER = SDDL['userSid'] as string;

/** A Fs holding one 32-byte key file (win32 paths); everything else absent. */
function oneKeyFs(keyPath: string): Fs {
  const st: FsLstat = { size: 32, mtimeNs: 1n, ctimeNs: 1n, ino: 7n, dev: 1n, mode: 0o100666, uid: 0, isFile: true, isDirectory: false, isSymbolicLink: false };
  const no = (): never => { throw new Error('not used'); };
  return {
    lstat: async (p) => (p === keyPath ? st : null),
    readFile: async (p) => { if (p === keyPath) return Buffer.alloc(32, 1); throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    unlink: async () => {}, writeFile: no, rename: no, link: no, stat: no, mkdirp: no, readdir: no, rmrf: no, writeFileExclusive: no, rmdir: no,
    appendFile: no, realpath: no, freeBytes: no, chmod: no,
  };
}

test("the key's SDDL verdict is src/sec/sddl.ts's user-only rule", async () => {
  const userOnly = SDDL['userOnly'] as string;
  assert.equal(userOnly, 'O:S-1-5-21-1111-2222-3333-1001G:S-1-5-21-1111-2222-3333-513D:PAI(A;;FA;;;S-1-5-21-1111-2222-3333-1001)(A;;FA;;;SY)(A;;FA;;;BA)');
  assert.equal(sddlUserOnly(parseSddl(userOnly)!, USER), true);
  assert.equal(SDDL['everyoneInheritRead'], `${userOnly}(A;OICI;FR;;;WD)`);
  assert.equal(sddlUserOnly(parseSddl(`${userOnly}(A;OICI;FR;;;WD)`)!, USER), false);

  // An unparseable SDDL (parseSddl → null) → readIpcKey refuses SEC_REFUSE_IPC_ACL (fail closed).
  assert.equal(parseSddl(SDDL['unparseable'] as string), null);
  const keyPath = 'C:\\d\\ipc.key';
  const acl: WinAcl = { currentUserSid: async () => USER, restrictToUser: async () => {}, protectDir: async () => {}, readSddl: async () => SDDL['unparseable'] as string };
  const r = await readIpcKey('C:\\d', { fs: oneKeyFs(keyPath), random: seededRandom('x'), platform: 'win32', uid: null, acl });
  assert.deepEqual(r, { ok: false, code: 'SEC_REFUSE_IPC_ACL' });
  // The same key with the user-only SDDL passes (the refusal above is the SDDL's).
  const okAcl: WinAcl = { ...acl, readSddl: async () => userOnly };
  const ok = await readIpcKey('C:\\d', { fs: oneKeyFs(keyPath), random: seededRandom('x'), platform: 'win32', uid: null, acl: okAcl });
  assert.deepEqual(ok, { ok: true, key: Buffer.alloc(32, 1) });

  // X-62: winAcl.ts has no SDDL parser of its own; 8a's dataDir.ts re-exports the very function objects of src/sec/sddl.ts.
  for (const gone of ['sddlAllowSids', 'ALLOWED_SYSTEM_SIDS', 'parseSddl', 'sddlUserOnly']) assert.ok(!(gone in winAclModule), `winAcl.ts exports ${gone}`);
  assert.equal(vizDataDir.parseSddl, parseSddl);
  assert.equal(vizDataDir.sddlUserOnly, sddlUserOnly);
});

interface Call { file: string; args: readonly string[]; env: Readonly<Record<string, string>>; timeoutMs?: number | undefined; }

function recordingRun(calls: Call[], out: Readonly<Record<string, { code: number; stdout: Buffer }>>) {
  return async (file: string, args: readonly string[], env: Readonly<Record<string, string>>, o?: { timeoutMs?: number }): Promise<{ code: number; stdout: Buffer }> => {
    calls.push({ file, args: [...args], env: { ...env }, timeoutMs: o?.timeoutMs });
    const r = out[file];
    if (r === undefined) throw new Error(`unexpected program ${file}`);
    return r;
  };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

test('createWinAcl runs exactly the three fixed argv and parses a localized whoami', async () => {
  const whoamiUtf8 = readFileSync(path.join(FIX, 'whoami-ko-KR.utf8.csv'));
  // The fixture's account name is "desktop-x\홍길동" in UTF-8; check the bytes, not an editor's reading of them.
  assert.ok(whoamiUtf8.includes(Buffer.from([0xed, 0x99, 0x8d, 0xea, 0xb8, 0xb8, 0xeb, 0x8f, 0x99])));
  assert.equal(whoamiUtf8.toString('utf8'), '"desktop-x\\\u{D64D}\u{AE38}\u{B3D9}","S-1-5-21-1111-2222-3333-1001"\n');
  // A ko-KR console writes the name in cp949 (홍길동 = C8AB B1E6 B5BF) with CRLF: the SID is read without decoding the name.
  const whoamiCp949 = Buffer.concat([Buffer.from('"desktop-x\\', 'latin1'), Buffer.from([0xc8, 0xab, 0xb1, 0xe6, 0xb5, 0xbf]),
    Buffer.from('","S-1-5-21-1111-2222-3333-1001"\r\n', 'latin1')]);

  for (const whoami of [whoamiUtf8, whoamiCp949]) {
    const calls: Call[] = [];
    const acl = createWinAcl(recordingRun(calls, {
      whoami: { code: 0, stdout: whoami },
      icacls: { code: 0, stdout: Buffer.from('processed file: C:\\d\\ipc.key\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n') },
      'powershell.exe': { code: 0, stdout: Buffer.from(`${SDDL['userOnly']}\r\n`) },
    }));
    assert.equal(await acl.currentUserSid(), 'S-1-5-21-1111-2222-3333-1001');
    await acl.restrictToUser('C:\\d\\ipc.key', 'S-1-5-21-1111-2222-3333-1001');
    const tricky = "C:\\d\\it's'; Remove-Item x\\ipc.key";
    assert.equal(await acl.readSddl(tricky), SDDL['userOnly']);
    assert.deepEqual(calls.map((c) => [c.file, c.args]), [
      ['whoami', ['/user', '/fo', 'csv', '/nh']],
      ['icacls', ['C:\\d\\ipc.key', '/inheritance:r', '/grant:r', '*S-1-5-21-1111-2222-3333-1001:F']],
      ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Acl -LiteralPath $env:COWORK_ACL_PATH).Sddl']],
    ]);
    const ps = calls[2] as Call;
    assert.equal(ps.env['COWORK_ACL_PATH'], tricky, 'the path reaches PowerShell only through the environment');
    assert.deepEqual(ps.env, { COWORK_ACL_PATH: tricky }, 'and the seam passes no other variable');
    for (const c of calls) assert.ok(!c.args.some((a) => a.includes('it\'s')), `${c.file}: the path is in no argv element`);
    assert.deepEqual(calls[0]?.env, {});
    assert.deepEqual(calls[1]?.env, {});
  }

  // A non-zero exit code rejects with WinAclError carrying the code only (no output, no path).
  const failing = createWinAcl(async () => ({ code: 5, stdout: Buffer.from('Access is denied: C:\\d\\secret-name\r\n') }));
  for (const p of [failing.currentUserSid(), failing.restrictToUser('C:\\d\\secret-name', USER), failing.readSddl('C:\\d\\secret-name')]) {
    const e = await rejection(p);
    assert.ok(e instanceof WinAclError);
    assert.equal(e.code, 5);
    assert.ok(!e.message.includes('secret-name') && !e.message.includes('denied'), e.message);
  }
  // whoami output without a SID rejects; restrictToUser refuses a malformed SID before running anything.
  const calls: Call[] = [];
  const noSid = createWinAcl(recordingRun(calls, { whoami: { code: 0, stdout: Buffer.from('"desktop-x\\me","not-a-sid"\r\n') } }));
  await rejection(noSid.currentUserSid());
  await assert.rejects(noSid.restrictToUser('C:\\d\\ipc.key', 'S-1-5; icacls x /grant *S-1-1-0:F'), TypeError);
  assert.equal(calls.length, 1);
});

test('protectDir gives the data directory a protected user, SYSTEM and Administrators DACL on the path itself; every call passes the caller\'s time bound (P5SEC #34, #35)', async () => {
  const calls: Call[] = [];
  const acl = createWinAcl(recordingRun(calls, {
    whoami: { code: 0, stdout: Buffer.from(`"desktop-x\\me","${USER}"\r\n`) },
    icacls: { code: 0, stdout: Buffer.from('processed file: C:\\d\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n') },
    'powershell.exe': { code: 0, stdout: Buffer.from(`${SDDL['userOnly']}\r\n`) },
  }));
  // The fourth fixed argv (8a's ownerProbe protectDir form): inheritance removed, the three admitted SIDs granted with (OI)(CI) so what is created
  // inside inherits a user-only DACL, and /L so icacls acts on the path itself, never through a link or junction swapped in for it.
  await acl.protectDir('C:\\d', USER);
  assert.deepEqual(calls.map((c) => [c.file, c.args, c.env]), [
    ['icacls', ['C:\\d', '/inheritance:r', '/grant:r', `*${USER}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/L'], {}],
  ]);
  await assert.rejects(acl.protectDir('C:\\d', 'S-1-5; icacls x /grant *S-1-1-0:F'), TypeError);
  assert.equal(calls.length, 1, 'a malformed SID runs nothing');

  // Every method hands its optional bound to the runner (the runner's own 10 s cap applies without one).
  calls.length = 0;
  await acl.currentUserSid({ timeoutMs: 900 });
  await acl.readSddl('C:\\d\\ipc.key', { timeoutMs: 800 });
  await acl.restrictToUser('C:\\d\\ipc.key', USER, { timeoutMs: 700 });
  await acl.protectDir('C:\\d', USER, { timeoutMs: 600 });
  await acl.currentUserSid();
  assert.deepEqual(calls.map((c) => c.timeoutMs), [900, 800, 700, 600, undefined]);

  // A failing icacls rejects WinAclError with its code only.
  const failing = createWinAcl(async () => ({ code: 5, stdout: Buffer.from('Access is denied: C:\\d\\secret-name\r\n') }));
  const e = await rejection(failing.protectDir('C:\\d\\secret-name', USER));
  assert.ok(e instanceof WinAclError && e.code === 5 && !e.message.includes('secret-name'));
});
