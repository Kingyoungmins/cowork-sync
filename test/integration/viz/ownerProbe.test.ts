// The owner probe (Task 11, R-V11): lstat uid/mode on POSIX; on Windows the SDDL and the user SID from PowerShell, run by absolute path
// with the directory in the environment and never in command text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join, win32 } from 'node:path';
import { realFs } from '../../../src/ports/fs.js';
import { parseSddl, sddlOwnerOk, sddlUserOnly, verifyDataDir } from '../../../src/viz/cli/dataDir.js';
import { realOwnerProbe, WINDOWS_ACL_COMMAND, type OwnerProbe } from '../../../src/viz/cli/ownerProbe.js';
import { makeTempRoot } from '../../helpers/tmp.js';
import { programsStartedBy } from '../../helpers/vizCli.js';

/** The key this process's PATH lives under (Windows spells it `Path`), and a restore function for a temporary value. */
function setProcessPath(first: string): () => void {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const saved = process.env[key];
  process.env[key] = saved === undefined ? first : `${first}${delimiter}${saved}`;
  return () => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  };
}

/** The shape of a SID the probe may report: any authority, as the product parses whoami (S-1-5-21-… local and AD, S-1-12-1-… Entra ID). */
const SID_SHAPE = /^S-1-[0-9]+(?:-[0-9]+)+$/;

test('the probe test accepts what the product accepts: every SID authority (Entra ID S-1-12-1-… included) and the product\'s owner rule (user, BA, or LA for the built-in Administrator)', () => {
  const LOCAL = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
  const ADMIN = 'S-1-5-21-1111111111-2222222222-3333333333-500';
  const ENTRA = 'S-1-12-1-1234567890-1234567890-1234567890-1234567890';
  for (const sid of [LOCAL, ADMIN, ENTRA]) assert.match(sid, SID_SHAPE);
  for (const sid of ['S-1-x', 'S-1', 'S-1-5', 'x S-1-5-18']) assert.doesNotMatch(sid, SID_SHAPE);
  for (const [owner, user, ok] of [
    [LOCAL, LOCAL, true], [ENTRA, ENTRA, true], ['S-1-5-32-544', LOCAL, true], ['S-1-5-32-544', ENTRA, true], ['LA', ADMIN, true],
    ['LA', LOCAL, false], [ADMIN, LOCAL, false], ['S-1-5-18', LOCAL, false], [null, LOCAL, false],
  ] as const) {
    assert.equal(sddlOwnerOk(owner, user), ok, `${String(owner)} for ${user}`);
  }
});

test('the Windows owner probe runs powershell.exe by absolute path with the directory in the environment, never in command text',
  { skip: process.platform !== 'win32' ? 'Windows legs only' : false }, async () => {
    const t = await makeTempRoot('viz-probe-win');
    const before = process.cwd();
    const savedRoot = process.env.SystemRoot;
    let restorePath = (): void => {};
    try {
      // A directory name that breaks the command if it ever reaches the PowerShell parser: spliced into single quotes the ' ends
      // the string (a parse error, or a different command); spliced into double quotes $x and the backtick expand, so Get-Acl
      // looks for a path that does not exist. Either way the probe answers null and the assertions below fail.
      const hostile = join(t.root, "x'; $x `y; echo '");
      mkdirSync(hostile);
      // A powershell.exe and a whoami.exe that are not programs, in the process cwd and first on this process's PATH (the PATH a
      // spawn of a bare name falls back to when the child's environment has none): a bare-name spawn runs a planted file and fails.
      for (const name of ['powershell.exe', 'whoami.exe']) writeFileSync(join(t.root, name), Buffer.from('MZ planted, never a program'));
      process.chdir(t.root);
      restorePath = setProcessPath(t.root);
      const r = await realOwnerProbe.windows(hostile);
      restorePath();
      assert.ok(r !== null, 'the probe answered');
      assert.match(r.userSid, SID_SHAPE);
      const s = parseSddl(r.sddl);
      assert.ok(s !== null, r.sddl);
      // The owner check is the product's own rule: the user, BUILTIN\Administrators (an elevated user's objects), or LA when the user is
      // the built-in Administrator; compared by SID.
      assert.ok(sddlOwnerOk(s.owner, r.userSid), `owner ${String(s.owner)}`);
      assert.equal(sddlUserOnly(s, r.userSid), true, r.sddl);
      assert.ok(existsSync(hostile));

      // A missing directory, and no usable SystemRoot: no answer, fail closed.
      assert.equal(await realOwnerProbe.windows(join(t.root, 'missing')), null);
      for (const sr of [undefined, 'relative\\Windows', '\\\\server\\share\\Windows']) {
        if (sr === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = sr;
        assert.equal(await realOwnerProbe.windows(hostile), null, String(sr));
      }
    } finally {
      restorePath();
      if (savedRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = savedRoot;
      process.chdir(before);
      await t.cleanup();
    }
  });

const WIN_ROOT = process.env.SystemRoot ?? 'C:\\Windows';
const SYSTEM32 = win32.join(WIN_ROOT, 'System32');

test('the owner probe works under PowerShell Constrained Language Mode, and takes the user SID from whoami.exe by absolute path',
  { skip: process.platform !== 'win32' ? 'Windows legs only' : false }, async () => {
    const t = await makeTempRoot('viz-probe-clm');
    try {
      // The probe's own text, with the language mode a locked-down corporate PC enforces (AppLocker / WDAC) set first.
      const ps = win32.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const clm = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
        `$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; ${WINDOWS_ACL_COMMAND}`], {
        env: { SystemRoot: WIN_ROOT, COWORK_ACL_PATH: t.root }, cwd: SYSTEM32, encoding: 'utf8', windowsHide: true,
      });
      assert.equal(clm.status, 0, clm.stderr);
      const sddl = clm.stdout.trim();
      assert.ok(parseSddl(sddl) !== null, sddl);

      // The probe answers the same SDDL, and the user SID whoami.exe reports (its SID column).
      const who = spawnSync(win32.join(SYSTEM32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
      const sid = /,"(S-1-[0-9]+(?:-[0-9]+)+)"\s*$/.exec(who.stdout)?.[1];
      assert.ok(sid !== undefined, who.stdout);
      assert.deepEqual(await realOwnerProbe.windows(t.root), { sddl, userSid: sid });
    } finally {
      await t.cleanup();
    }
  });

test('a data directory the CLI creates under a parent that grants Everyone read gets a protected user-only DACL and passes the check; a failed protectDir is retried once',
  { skip: process.platform !== 'win32' ? 'Windows legs only' : false }, async () => {
    const t = await makeTempRoot('viz-probe-icacls');
    try {
      const parent = join(t.root, 'wide parent');
      mkdirSync(parent);
      const icacls = spawnSync(win32.join(SYSTEM32, 'icacls.exe'), [parent, '/grant', '*S-1-1-0:(OI)(CI)(R)'], { encoding: 'utf8', windowsHide: true });
      assert.equal(icacls.status, 0, icacls.stdout);
      // A sibling made the ordinary way inherits the Everyone ACE and fails the check: what the CLI used to create.
      const plain = join(parent, 'plain');
      mkdirSync(plain);
      assert.deepEqual(await verifyDataDir(plain, { fs: realFs, probe: realOwnerProbe, platform: 'win32', create: false }), { ok: false, why: 'acl' });

      const dir = join(parent, "data $x 'q");
      assert.deepEqual(await verifyDataDir(dir, { fs: realFs, probe: realOwnerProbe, platform: 'win32', create: true }), { ok: true });
      const r = await realOwnerProbe.windows(dir);
      assert.ok(r !== null);
      assert.match(r.sddl, /D:PAI?\(/, 'protected: inheritance removed');
      assert.ok(!r.sddl.includes(';WD)'), r.sddl);

      // The first protectDir fails (icacls did not run): the new directory fails on its inherited Everyone ACE, gets one more protectDir
      // (the real one) and passes.
      const calls: string[] = [];
      const flaky: OwnerProbe = {
        ...realOwnerProbe,
        protectDir: async (d) => { calls.push(d); return calls.length === 1 ? false : (realOwnerProbe.protectDir as (d: string) => Promise<boolean>)(d); },
      };
      const second = join(parent, 'second data');
      assert.deepEqual(await verifyDataDir(second, { fs: realFs, probe: flaky, platform: 'win32', create: true }), { ok: true });
      assert.deepEqual(calls, [second, second]);
      assert.match((await realOwnerProbe.windows(second))?.sddl ?? '', /D:PAI?\(/);
      // A directory left behind by such a run (the plain one: owned by the user, failing only on what it inherits) is repaired by the CLI
      // (create: true), never by the viewer (create: false).
      assert.deepEqual(await verifyDataDir(plain, { fs: realFs, probe: realOwnerProbe, platform: 'win32', create: false }), { ok: false, why: 'acl' });
      assert.deepEqual(await verifyDataDir(plain, { fs: realFs, probe: realOwnerProbe, platform: 'win32', create: true }), { ok: true });
      assert.match((await realOwnerProbe.windows(plain))?.sddl ?? '', /D:PAI?\(/);
      // An explicit Everyone ACE (someone set it) is never repaired.
      const explicit = join(t.root, 'explicit data');
      mkdirSync(explicit);
      const grant = spawnSync(win32.join(SYSTEM32, 'icacls.exe'), [explicit, '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8', windowsHide: true });
      assert.equal(grant.status, 0, grant.stdout);
      assert.deepEqual(await verifyDataDir(explicit, { fs: realFs, probe: realOwnerProbe, platform: 'win32', create: true }), { ok: false, why: 'acl' });
    } finally {
      await t.cleanup();
    }
  });

/** A folder under `root` whose children inherit an Everyone read ACE (what a directory made there fails SEC-20 on, repairably). */
function wideParent(root: string): string {
  const parent = join(root, 'wide parent');
  mkdirSync(parent);
  const grant = spawnSync(win32.join(SYSTEM32, 'icacls.exe'), [parent, '/grant', '*S-1-1-0:(OI)(CI)(R)'], { encoding: 'utf8', windowsHide: true });
  assert.equal(grant.status, 0, grant.stdout);
  return parent;
}

const sddlOf = async (p: string): Promise<string | undefined> => (await realOwnerProbe.windows(p))?.sddl;

test('a data directory swapped for a junction (or for another directory) between the SEC-20 check and the repair is refused, the junction target\'s DACL is unchanged, and every icacls call passes /L',
  { skip: process.platform !== 'win32' ? 'Windows legs only' : false }, async () => {
    const t = await makeTempRoot('viz-probe-swap');
    try {
      const parent = wideParent(t.root);
      // The junction target: a folder of the user's that inherits the Everyone ACE; a protectDir that reached it would protect its DACL.
      const victim = join(parent, 'victim');
      mkdirSync(victim);
      const victimSddl = await sddlOf(victim);
      assert.ok(victimSddl !== undefined && !victimSddl.includes('D:P'), String(victimSddl));
      const icaclsArgs: string[][] = [];
      let n = 0;
      for (const [when, to] of [['check', 'junction'], ['repair', 'junction'], ['last probe', 'junction'], ['check', 'directory'], ['repair', 'directory']] as const) {
        n += 1;
        const name = `${to} swapped in at the ${when}`;
        // An existing data directory owned by the user that fails only on the inherited Everyone ACE: the CLI would repair it.
        const dir = join(parent, `data ${n}`);
        mkdirSync(dir);
        const swap = (): void => {
          renameSync(dir, `${dir} moved`);
          if (to === 'junction') symlinkSync(victim, dir, 'junction');
          else mkdirSync(dir);
        };
        let checks = 0;
        const protects: string[] = [];
        const probe: OwnerProbe = {
          ...realOwnerProbe,
          windows: async (d) => {
            const r = await realOwnerProbe.windows(d);
            checks += 1;
            if (when === 'check' && checks === 1) swap();   // after the SEC-20 check, before the repair
            if (when === 'last probe' && checks === 2) swap();   // after the re-check that follows the repair
            return r;
          },
          protectDir: async (d) => {
            protects.push(d);
            if (when === 'repair') swap();   // inside the repair: after the lstat before it, before icacls runs
            return (realOwnerProbe.protectDir as (d: string) => Promise<boolean>)(d);
          },
        };
        const { result, calls } = await programsStartedBy(() => verifyDataDir(dir, { fs: realFs, probe, platform: 'win32', create: true }));
        assert.equal(result.ok, false, `${name}: ${JSON.stringify(result)}`);
        assert.deepEqual(protects, when === 'check' ? [] : [dir], name);
        // Refused by the lstat right before the repair, right after it (before any re-check), or right after the last probe.
        assert.equal(checks, when === 'last probe' ? 2 : 1, name);
        assert.equal(await sddlOf(victim), victimSddl, `${name}: the junction target's DACL changed`);
        for (const c of calls) if (/icacls\.exe$/i.test(c.file)) icaclsArgs.push(c.args);
      }
      // icacls ran in the three swaps that reached the repair, each time on the path itself, never through a reparse point (/L).
      assert.equal(icaclsArgs.length, 3);
      for (const args of icaclsArgs) assert.ok(args.includes('/L'), args.join(' '));
    } finally {
      await t.cleanup();
    }
  });

test('the CLI repairs an existing data directory only when it is empty or holds nothing but the viewer\'s own files; one holding anything else, or a log junction, keeps its DACL and is refused',
  { skip: process.platform !== 'win32' ? 'Windows legs only' : false }, async () => {
    const t = await makeTempRoot('viz-probe-contents');
    try {
      const parent = wideParent(t.root);
      const verify = (dir: string): Promise<unknown> => verifyDataDir(dir, { fs: realFs, probe: realOwnerProbe, platform: 'win32', create: true });
      // The viewer's own files: its log folder of *.jsonl files, and the test probe's record.
      const own = join(parent, 'own data');
      mkdirSync(join(own, 'log'), { recursive: true });
      writeFileSync(join(own, 'log', 'viz-ABCDEFGH-1.jsonl'), '{}\n');
      writeFileSync(join(own, 'probe.json'), '{}\n');
      assert.deepEqual(await verify(own), { ok: true });
      assert.match((await sddlOf(own)) ?? '', /D:PAI?\(/);
      // Anything else: the folder is not the viewer's, so its DACL is never rewritten.
      const other = join(parent, 'other data');
      mkdirSync(other);
      writeFileSync(join(other, 'notes.txt'), 'mine\n');
      const linked = join(parent, 'linked data');
      mkdirSync(linked);
      const elsewhere = join(parent, 'elsewhere');
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, join(linked, 'log'), 'junction');
      for (const dir of [other, linked]) {
        const before = await sddlOf(dir);
        assert.ok(before !== undefined && !before.includes('D:P'), String(before));
        assert.deepEqual(await verify(dir), { ok: false, why: 'acl' }, dir);
        assert.equal(await sddlOf(dir), before, dir);
      }
      // Listed again after the repair: a file that appears while icacls runs refuses before the re-check.
      const busy = join(parent, 'busy data');
      mkdirSync(busy);
      let checks = 0;
      const dropping: OwnerProbe = {
        ...realOwnerProbe,
        windows: async (d) => { checks += 1; return realOwnerProbe.windows(d); },
        protectDir: async (d) => {
          writeFileSync(join(d, 'dropped.txt'), 'x\n');
          return (realOwnerProbe.protectDir as (d: string) => Promise<boolean>)(d);
        },
      };
      assert.deepEqual(await verifyDataDir(busy, { fs: realFs, probe: dropping, platform: 'win32', create: true }), { ok: false, why: 'acl' });
      assert.equal(checks, 1);
    } finally {
      await t.cleanup();
    }
  });

test('the POSIX owner probe reports the lstat uid, mode, directory and symlink bits, and the euid',
  { skip: process.platform === 'win32' ? 'POSIX legs only' : false }, async () => {
    const t = await makeTempRoot('viz-probe-posix');
    try {
      const euid = process.geteuid?.() ?? null;
      assert.equal(realOwnerProbe.euid(), euid);
      const dir = join(t.root, 'dir');
      mkdirSync(dir);
      chmodSync(dir, 0o750);
      const file = join(t.root, 'file');
      writeFileSync(file, 'x');
      chmodSync(file, 0o640);
      const link = join(t.root, 'link');
      symlinkSync(dir, link);
      assert.deepEqual(await realOwnerProbe.posix(dir), { uid: euid, mode: 0o40750, isDir: true, isSymlink: false });
      assert.deepEqual(await realOwnerProbe.posix(file), { uid: euid, mode: 0o100640, isDir: false, isSymlink: false });
      const l = await realOwnerProbe.posix(link);
      assert.deepEqual(l && { isDir: l.isDir, isSymlink: l.isSymlink }, { isDir: false, isSymlink: true });
      assert.equal(await realOwnerProbe.posix(join(t.root, 'missing')), null);
      assert.equal(await realOwnerProbe.windows(dir), null);
    } finally {
      await t.cleanup();
    }
  });
