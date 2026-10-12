// The data directory (Task 11): derivation, creation and the SEC-20 owner/ACL verification (R-V11; 12 §3.2 item 2, VIZ-02; S9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realFs, type Fs, type FsLstat } from '../../../src/ports/fs.js';
import * as dataDirModule from '../../../src/viz/cli/dataDir.js';
import { parseSddl, pluginDataDir, resolveDataDir, sddlOwnerOk, sddlUserOnly, verifyDataDir, type DataDirVerdict } from '../../../src/viz/cli/dataDir.js';
import * as pluginDataModule from '../../../src/data/pluginDataDir.js';
import * as sddlModule from '../../../src/sec/sddl.js';
import { isUncOrDevice } from '../../../src/viz/cli/paths.js';
import { realOwnerProbe, type OwnerProbe } from '../../../src/viz/cli/ownerProbe.js';
import { VIEWER_STDERR_FILE } from '../../../src/viz/cli/spawn.js';
import * as stderrLeaf from '../../../src/viz/cli/stderrFile.js';
import { makeTempRoot } from '../../helpers/tmp.js';
import { passingProbe, USER_ONLY_SDDL, USER_SID } from '../../helpers/vizCli.js';

const U = USER_SID;
const OTHER = 'S-1-5-21-1111111111-2222222222-3333333333-1002';
const CAPABILITY = 'S-1-15-3-65536-599108337-2355189375-1353122160-3480128286-3345335107-485756383-4087318168-230526575';
const HANGUL = '\u{D64D}\u{AE38}\u{B3D9}';

test('parseSddl and sddlUserOnly', () => {
  // The user SID, SY and BA (aliases mapped to SIDs; flags P/AI and inherited ACEs read).
  const plain = parseSddl(USER_ONLY_SDDL);
  assert.deepEqual(plain, { owner: U, allow: ['S-1-5-18', 'S-1-5-32-544', U], deny: [] });
  assert.equal(sddlUserOnly(plain!, U), true);
  assert.equal(sddlUserOnly(plain!, U.toLowerCase()), true);
  const baOwned = parseSddl(`O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1f01ff;;;${U})`);
  assert.deepEqual(baOwned, { owner: 'S-1-5-32-544', allow: ['S-1-5-18', 'S-1-5-32-544', U], deny: [] });
  assert.equal(sddlUserOnly(baOwned!, U), true);
  // A SACL is read past; the explicit SID spelling of SY and BA is the alias.
  const withSacl = parseSddl(`O:${U}G:${U}D:AR(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)(A;;FA;;;${U})S:AI(AU;SAFA;FA;;;WD)`);
  assert.equal(sddlUserOnly(withSacl!, U), true);

  // Inherit-only CREATOR OWNER and OWNER RIGHTS pass; the same ACEs on the directory itself do not.
  const io = parseSddl(`O:${U}D:(A;OICIIO;GA;;;CO)(A;OICIIO;FA;;;OW)(A;OICIIO;GA;;;S-1-3-0)(A;OICI;FA;;;${U})`);
  assert.deepEqual(io, { owner: U, allow: ['CO', 'OW', 'CO', U], deny: [] });
  assert.equal(sddlUserOnly(io!, U), true);
  for (const ace of ['(A;;FA;;;CO)', '(A;OICI;FA;;;OW)', '(A;;FA;;;S-1-3-4)']) {
    const s = parseSddl(`O:${U}D:${ace}(A;;FA;;;${U})`);
    assert.ok(s !== null, ace);
    assert.equal(sddlUserOnly(s, U), false, ace);
  }

  // WD, AU, BU, another user's SID, a capability SID and an inherit-only foreign allow are refused (SEC-20).
  for (const ace of [
    '(A;;FR;;;WD)', '(A;OICI;FA;;;AU)', '(A;;FA;;;BU)', `(A;;FA;;;${OTHER})`, `(A;;0x100020;;;${CAPABILITY})`, '(A;OICIIO;FA;;;WD)',
    '(A;;FA;;;S-1-1-0)', '(A;;FA;;;IU)', '(A;;FA;;;DA)',
  ]) {
    const s = parseSddl(`O:${U}G:${U}D:(A;;FA;;;SY)${ace}(A;;FA;;;${U})`);
    assert.ok(s !== null, ace);
    assert.equal(sddlUserOnly(s, U), false, ace);
  }
  // The deny-only quirk: a deny ACE grants nothing, so a deny for anyone is tolerated; deny ACEs alone grant the user nothing.
  const denyEveryone = parseSddl(`O:${U}D:(D;OICI;FW;;;WD)(D;;FA;;;${OTHER})(A;OICI;FA;;;${U})`);
  assert.deepEqual(denyEveryone, { owner: U, allow: [U], deny: ['S-1-1-0', OTHER] });
  assert.equal(sddlUserOnly(denyEveryone!, U), true);
  const denyOnly = parseSddl(`O:${U}D:(D;;FA;;;WD)(D;;FW;;;${U})`);
  assert.ok(denyOnly !== null);
  assert.equal(sddlUserOnly(denyOnly, U), false);

  // A DACL without an allow ACE for the user, an empty DACL, a foreign or SY owner and a missing owner are refused (S9).
  for (const s of [
    `O:${U}D:(A;;FA;;;SY)(A;;FA;;;BA)`, `O:${U}D:`, `O:${U}D:P`, `O:${OTHER}D:(A;;FA;;;${U})`, `O:SYD:(A;;FA;;;${U})`, `D:(A;;FA;;;${U})`,
  ]) {
    const parsed = parseSddl(s);
    assert.ok(parsed !== null, s);
    assert.equal(sddlUserOnly(parsed, U), false, s);
  }

  // Refused by the parser: NO_ACCESS_CONTROL, no D: part, object and callback ACEs (S9), malformed SDDL.
  for (const s of [
    'D:NO_ACCESS_CONTROL', `O:${U}G:${U}D:NO_ACCESS_CONTROL`, `O:${U}D:PNO_ACCESS_CONTROL`, `O:${U}G:${U}`, `O:${U}G:${U}S:(AU;SA;FA;;;WD)`,
    `O:${U}D:(OA;;GA;;;WD)`, `O:${U}D:(A;;FA;;;${U})(OA;;GA;;;WD)`, `O:${U}D:(XA;;FA;;;BU)`, `O:${U}D:(XA;;FA;;;BU;(WIN://SYSAPPID Contains "x"))`,
    `O:${U}D:(ZA;;FA;;;BU)`, `O:${U}D:(OD;;GA;;;WD)(A;;FA;;;${U})`, `O:${U}D:(AU;;FA;;;${U})`,
    '', 'garbage', 'D:x', `O:${U}D:(A;;FA;;;`, `O:${U}D:(A;;FA;;;S-1-x)`, `O:${U}D:(A;;FA;;)`, `O:${U}D:(A;QQ;FA;;;SY)`, `O:${U}D:(A;;;;;SY)`,
    `O:${U}D:(A;;FA;00000000-0000-0000-0000-000000000000;;SY)`, `O:${U}O:${U}D:(A;;FA;;;${U})`, `O:${U}D:(A;;FA;;;${U})D:(A;;FA;;;${U})`,
    `O:${U}D:(A;;FA;;;${U})x`, `O:${U}D:(A;;FA;;;${U}))`, `O:S-1-xD:(A;;FA;;;${U})`, `O:sYD:(A;;FA;;;${U})`, `Q:${U}D:(A;;FA;;;${U})`,
    `O:${U}D:(A;;FA;;;${U};extra)`,
  ]) {
    assert.equal(parseSddl(s), null, s);
  }
});

test('the machine-relative aliases LA and LG name the user exactly when the user is that account (RID 500, RID 501)', async () => {
  // Windows prints the built-in Administrator's own SID as LA (and Guest's as LG), so its data directory reads O:LA … (A;…;LA).
  const ADMIN = 'S-1-5-21-1111111111-2222222222-3333333333-500';
  const GUEST = 'S-1-5-21-1111111111-2222222222-3333333333-501';
  const la = parseSddl('O:LAG:LAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)');
  assert.deepEqual(la, { owner: 'LA', allow: ['S-1-5-18', 'S-1-5-32-544', 'LA'], deny: [] });
  assert.equal(sddlUserOnly(la!, ADMIN), true);
  assert.equal(sddlUserOnly(la!, U), false, 'for any other user LA is another account');
  assert.equal(sddlUserOnly(la!, GUEST), false);
  const lg = parseSddl('O:LGD:(A;OICI;FA;;;SY)(A;OICI;FA;;;LG)');
  assert.equal(sddlUserOnly(lg!, GUEST), true);
  assert.equal(sddlUserOnly(lg!, ADMIN), false);
  // Beside the user's own SID, an LA or LG allow is a second account and refused.
  assert.equal(sddlUserOnly(parseSddl(`O:${U}D:(A;;FA;;;${U})(A;;FA;;;LA)`)!, U), false);
  assert.equal(sddlUserOnly(parseSddl(`O:${U}D:(A;;FA;;;${U})(A;;FA;;;LG)`)!, U), false);
  // verifyDataDir applies the same reading to the owner.
  const fs = tableFs(new Map([['C:\\d', { isDirectory: true }]]));
  const probe = (userSid: string): OwnerProbe => ({ posix: async () => null, euid: () => null, windows: async () => ({ sddl: 'O:LAD:(A;OICI;FA;;;LA)', userSid }) });
  assert.deepEqual(await verifyDataDir('C:\\d', { fs, probe: probe(ADMIN), platform: 'win32', create: false }), { ok: true });
  assert.deepEqual(await verifyDataDir('C:\\d', { fs, probe: probe(U), platform: 'win32', create: false }), { ok: false, why: 'owner' });
});

test('resolveDataDir: CLAUDE_PLUGIN_DATA when absolute, else pluginDataDir; created 0700 when absent', async () => {
  // Derivation (both platforms' path forms, whatever this host is).
  assert.equal(pluginDataDir({}, `C:\\Users\\${HANGUL}`, 'win32'), `C:\\Users\\${HANGUL}\\.claude\\plugins\\data\\cowork-sync`);
  assert.equal(pluginDataDir({}, `/home/${HANGUL}`, 'linux'), `/home/${HANGUL}/.claude/plugins/data/cowork-sync`);
  assert.equal(pluginDataDir({ CLAUDE_CONFIG_DIR: '/etc/claude conf' }, '/home/me', 'darwin'), '/etc/claude conf/plugins/data/cowork-sync');
  assert.equal(pluginDataDir({ Claude_Config_Dir: 'D:\\conf' }, 'C:\\Users\\me', 'win32'), 'D:\\conf\\plugins\\data\\cowork-sync');
  assert.equal(pluginDataDir({ CLAUDE_CONFIG_DIR: 'relative/conf' }, '/home/me', 'linux'), '/home/me/.claude/plugins/data/cowork-sync');

  assert.equal(resolveDataDir({ CLAUDE_PLUGIN_DATA: '/var/data/cowork' }, '/home/me', 'linux'), '/var/data/cowork');
  assert.equal(resolveDataDir({ claude_plugin_data: 'D:\\pd' }, 'C:\\Users\\me', 'win32'), 'D:\\pd');
  // Normalized without a trailing separator: lstat of `<link>/` follows a symlink, so `<link>/` would pass for a directory.
  for (const [v, want] of [['/var/data/cowork/', '/var/data/cowork'], ['/var/data//cowork//', '/var/data/cowork'], ['/var/x/../data/', '/var/data'], ['/', '/']]) {
    assert.equal(resolveDataDir({ CLAUDE_PLUGIN_DATA: v }, '/home/me', 'linux'), want, v);
  }
  for (const [v, want] of [['D:\\plugin data\\x\\', 'D:\\plugin data\\x'], ['D:/pd//x/', 'D:\\pd\\x'], ['D:\\', 'D:\\']]) {
    assert.equal(resolveDataDir({ CLAUDE_PLUGIN_DATA: v }, 'C:\\Users\\me', 'win32'), want, v);
  }
  // Unset or empty: the derived directory. Relative: refused like a UNC path (fail closed, never replaced by another location).
  for (const v of [undefined, '']) {
    assert.equal(resolveDataDir({ CLAUDE_PLUGIN_DATA: v }, '/home/me', 'linux'), '/home/me/.claude/plugins/data/cowork-sync', String(v));
    assert.equal(resolveDataDir({ CLAUDE_PLUGIN_DATA: v }, 'C:\\Users\\me', 'win32'), 'C:\\Users\\me\\.claude\\plugins\\data\\cowork-sync', String(v));
  }
  for (const v of ['relative/data', './data', 'data', '~/data']) assert.equal(resolveDataDir({ CLAUDE_PLUGIN_DATA: v }, '/home/me', 'linux'), null, v);
  for (const v of ['C:data', 'relative\\data', '\\rooted\\data']) assert.equal(resolveDataDir({ CLAUDE_PLUGIN_DATA: v }, 'C:\\Users\\me', 'win32'), null, v);
  assert.equal(resolveDataDir({ CLAUDE_PLUGIN_DATA: '\\\\server\\share\\data' }, 'C:\\Users\\me', 'win32'), null);
  assert.equal(resolveDataDir({}, '\\\\server\\share\\home', 'win32'), null);
  assert.equal(resolveDataDir({}, 'relative home', 'linux'), null);

  // Creation: absent → created (POSIX mode 0700) and verified; the viewer's create: false never creates.
  const t = await makeTempRoot('viz-datadir');
  try {
    const probe = process.platform === 'win32' ? passingProbe : realOwnerProbe;
    const dir = resolveDataDir({}, join(t.root, `home ${HANGUL}`), process.platform);
    assert.ok(dir !== null);
    assert.deepEqual(await verifyDataDir(dir, { fs: realFs, probe, platform: process.platform, create: false }), { ok: false, why: 'not_dir' });
    assert.equal(existsSync(dir), false);
    // POSIX: created with mode 0700 itself, not by the umask's grace (umask 0 here).
    const mask = process.platform === 'win32' ? null : process.umask(0);
    try {
      assert.deepEqual(await verifyDataDir(dir, { fs: realFs, probe, platform: process.platform, create: true }), { ok: true });
    } finally {
      if (mask !== null) process.umask(mask);
    }
    assert.ok(statSync(dir).isDirectory());
    if (process.platform !== 'win32') assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(await verifyDataDir(dir, { fs: realFs, probe, platform: process.platform, create: false }), { ok: true });
  } finally {
    await t.cleanup();
  }
});

/** An Fs whose lstat answers from a table (null = absent) and whose mkdirp records; everything else throws. */
function tableFs(table: Map<string, Partial<FsLstat> | 'throw'>, made: string[] = []): Fs {
  const no = (): never => { throw new Error('unexpected Fs call'); };
  return {
    readFile: no, writeFile: no, rename: no, link: no, unlink: no, stat: no, readdir: no, rmrf: no, writeFileExclusive: no, rmdir: no,
    appendFile: no, realpath: no, freeBytes: no, chmod: no,
    mkdirp: async (p: string) => { made.push(p); table.set(p, { isDirectory: true, isFile: false, isSymbolicLink: false }); },
    lstat: async (p: string) => {
      const e = table.get(p);
      if (e === 'throw') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return e === undefined ? null : { size: 0, mtimeNs: 0n, ino: 0n, dev: 0n, mode: 0, isFile: false, isDirectory: false, isSymbolicLink: false, ...e };
    },
  };
}

test('verifyDataDir (win32): a data directory owned by the user that fails only on inherited ACEs gets one more protectDir and a re-check before it is refused; nothing is created inside a new one before protectDir returns', async () => {
  const dir = 'C:\\Users\\me\\.claude\\plugins\\data\\cowork-sync';
  const WD_READ = '(A;OICIID;0x1200a9;;;WD)';
  const inheritedWide = (owner: string): string => `O:${owner}G:${U}D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${U})${WD_READ}`;
  const PROTECTED = `O:${U}G:${U}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${U})`;
  /** The DACL reads `sddl` until a protectDir succeeds (protectDir answers `results` in order; false = icacls failed and changed nothing). */
  const run = async (o: { exists: boolean; results: boolean[]; sddl?: string; create?: boolean }): Promise<{ v: DataDirVerdict; events: string[] }> => {
    const events: string[] = [];
    let present = o.exists;
    let sddl = o.sddl ?? inheritedWide(U);
    const results = [...o.results];
    const no = (): never => { throw new Error('unexpected Fs call'); };
    const write = (what: string) => async (p: string): Promise<void> => { events.push(`${what} ${p}`); };
    const fs: Fs = {
      readFile: no, stat: no, realpath: no, freeBytes: no, chmod: no, rmrf: write('rmrf'), unlink: write('unlink'), rmdir: write('rmdir'),
      readdir: async (p: string) => (p === dir ? [] : no()),
      writeFile: write('writeFile'), writeFileExclusive: write('writeFileExclusive'), appendFile: write('appendFile'),
      rename: async (a: string) => { events.push(`rename ${a}`); }, link: async (a: string, b: string) => { events.push(`link ${b}`); },
      mkdirp: async (p: string) => { events.push(p === dir ? 'mkdirp' : `mkdirp ${p}`); if (p === dir) present = true; },
      lstat: async (p: string) => (p === dir && present ? { size: 0, mtimeNs: 0n, ino: 0n, dev: 0n, mode: 0, isFile: false, isDirectory: true, isSymbolicLink: false } : null),
    };
    const probe: OwnerProbe = {
      posix: async () => null, euid: () => null,
      windows: async (p) => { assert.equal(p, dir); events.push('acl'); return { sddl, userSid: U }; },
      protectDir: async (p) => {
        assert.equal(p, dir);
        const ok = results.shift() ?? false;
        events.push(`protect:${ok}`);
        if (ok) sddl = PROTECTED;
        return ok;
      },
    };
    return { v: await verifyDataDir(dir, { fs, probe, platform: 'win32', create: o.create ?? true }), events };
  };

  // Created: the first protectDir fails, the check fails on the inherited Everyone ACE, one more protectDir succeeds → ok. Nothing but
  // the directory itself is created, and no protectDir or check comes before it exists.
  assert.deepEqual(await run({ exists: false, results: [false, true] }), { v: { ok: true }, events: ['mkdirp', 'protect:false', 'acl', 'protect:true', 'acl'] });
  // Both fail: refused after exactly two protectDir calls (once more, never a loop).
  assert.deepEqual(await run({ exists: false, results: [false, false] }), { v: { ok: false, why: 'acl' }, events: ['mkdirp', 'protect:false', 'acl', 'protect:false', 'acl'] });
  // The first succeeds: one call.
  assert.deepEqual(await run({ exists: false, results: [true] }), { v: { ok: true }, events: ['mkdirp', 'protect:true', 'acl'] });
  // Existing (left by an earlier run whose protectDir failed): repaired once, or refused when that fails too.
  assert.deepEqual(await run({ exists: true, results: [true] }), { v: { ok: true }, events: ['acl', 'protect:true', 'acl'] });
  assert.deepEqual(await run({ exists: true, results: [false] }), { v: { ok: false, why: 'acl' }, events: ['acl', 'protect:false', 'acl'] });
  // Everything inherited but no allow for the user: still only what it inherits, so repaired.
  assert.deepEqual(await run({ exists: true, results: [true], sddl: `O:${U}D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)` }), { v: { ok: true }, events: ['acl', 'protect:true', 'acl'] });
  // Owned by BUILTIN\Administrators (an elevated user's objects; the SEC-20 owner rule): repaired the same way.
  assert.deepEqual(await run({ exists: true, results: [true], sddl: inheritedWide('BA') }), { v: { ok: true }, events: ['acl', 'protect:true', 'acl'] });

  // Never re-permissioned: the viewer (create: false), a foreign owner, an explicit (not inherited) foreign ACE, an explicit foreign ACE
  // beside inherited ones, an unreadable SDDL, and a directory that already passes.
  for (const [name, o, why] of [
    ['viewer', { create: false }, 'acl'],
    ['foreign owner', { sddl: inheritedWide(OTHER) }, 'owner'],
    ['explicit Everyone', { sddl: `O:${U}D:AI(A;OICIID;FA;;;SY)(A;OICI;FA;;;${U})(A;OICI;0x1200a9;;;WD)` }, 'acl'],
    ['explicit Users beside inherited Everyone', { sddl: `O:${U}D:AI(A;OICI;FA;;;${U})(A;OICI;FA;;;BU)${WD_READ}` }, 'acl'],
    ['explicit, nothing inherited, no user allow', { sddl: `O:${U}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)` }, 'acl'],
    ['malformed', { sddl: 'O:garbage' }, 'acl'],
  ] as const) {
    const r = await run({ exists: true, results: [true], ...o });
    assert.deepEqual(r, { v: { ok: false, why }, events: ['acl'] }, name);
  }
  assert.deepEqual(await run({ exists: true, results: [true], sddl: PROTECTED }), { v: { ok: true }, events: ['acl'] });
});

const WIN_DIR = 'C:\\Users\\me\\.claude\\plugins\\data\\cowork-sync';
const DIR_STAT: FsLstat = { size: 0, mtimeNs: 0n, ino: 7n, dev: 3n, mode: 0o40000, isFile: false, isDirectory: true, isSymbolicLink: false };
/** Owned by the user, failing only on an inherited Everyone read ACE: repairable. */
const INHERITED_WIDE = `O:${U}G:${U}D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${U})(A;OICIID;0x1200a9;;;WD)`;
/** What a protectDir leaves: inheritance removed, the user, SY and BA. */
const PROTECTED_DACL = `O:${U}G:${U}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${U})`;

test('verifyDataDir (win32): every protectDir runs between an lstat right before and one right after it, and the last probe is followed by one more lstat; a path that became a symlink or junction, vanished, or is another directory (dev/ino) is refused and never re-permissioned', async () => {
  const JUNCTION: FsLstat = { ...DIR_STAT, ino: 8n, mode: 0o120000, isDirectory: false, isSymbolicLink: true };
  type When = 'acl#1' | 'acl#2' | 'protect#1' | 'protect#2';
  /**
   * The path lstats as DIR_STAT until the swap: then as `to` (null: gone). A protectDir changes the DACL the probe reads next whatever the
   * path is by then (icacls /L on a junction protects the junction itself, and Get-Acl reads the junction's own DACL), so only the lstats
   * can tell the swap. `firstProtect` false: the first protectDir fails (icacls did not run).
   */
  const run = async (o: { exists: boolean; firstProtect?: boolean; swap?: { when: When; to: FsLstat | null }; sddl?: string }): Promise<{ v: DataDirVerdict; events: string[] }> => {
    const events: string[] = [];
    let current: FsLstat | null = o.exists ? DIR_STAT : null;
    let sddl = o.sddl ?? INHERITED_WIDE;
    let acls = 0;
    let protects = 0;
    const swapAt = (e: When): void => {
      if (o.swap?.when === e) current = o.swap.to;
    };
    const no = (): never => { throw new Error('unexpected Fs call'); };
    const fs: Fs = {
      readFile: no, writeFile: no, rename: no, link: no, unlink: no, stat: no, rmrf: no, writeFileExclusive: no, rmdir: no, appendFile: no,
      realpath: no, freeBytes: no, chmod: no,
      readdir: async (p: string) => { assert.equal(p, WIN_DIR); events.push('list'); return []; },
      mkdirp: async (p: string) => { assert.equal(p, WIN_DIR); events.push('mkdirp'); current = DIR_STAT; },
      lstat: async (p: string) => { assert.equal(p, WIN_DIR); events.push('lstat'); return current; },
    };
    const probe: OwnerProbe = {
      posix: async () => null, euid: () => null,
      windows: async () => {
        acls += 1;
        events.push('acl');
        const r = { sddl, userSid: U };
        swapAt(`acl#${acls}` as When);
        return r;
      },
      protectDir: async () => {
        protects += 1;
        events.push('protect');
        swapAt(`protect#${protects}` as When);
        const ok = protects > 1 || (o.firstProtect ?? true);
        if (ok) sddl = PROTECTED_DACL;
        return ok;
      },
    };
    return { v: await verifyDataDir(WIN_DIR, { fs, probe, platform: 'win32', create: true }), events };
  };
  const OTHER_INO: FsLstat = { ...DIR_STAT, ino: 9n };
  const OTHER_DEV: FsLstat = { ...DIR_STAT, dev: 4n };

  // No swap: an existing directory is repaired between two lstats, re-listed, probed again, and lstat'ed once more; a created one too.
  assert.deepEqual(await run({ exists: true }), { v: { ok: true }, events: ['lstat', 'acl', 'list', 'lstat', 'protect', 'lstat', 'list', 'acl', 'lstat'] });
  assert.deepEqual(await run({ exists: false }), { v: { ok: true }, events: ['lstat', 'mkdirp', 'lstat', 'lstat', 'protect', 'lstat', 'acl', 'lstat'] });
  assert.deepEqual(await run({ exists: true, sddl: PROTECTED_DACL }), { v: { ok: true }, events: ['lstat', 'acl', 'lstat'] });

  // Swapped between the check and the repair: refused by the lstat right before protectDir, which never runs.
  for (const [to, why] of [[JUNCTION, 'symlink'], [OTHER_INO, 'probe_failed'], [OTHER_DEV, 'probe_failed'], [null, 'not_dir']] as const) {
    assert.deepEqual(await run({ exists: true, swap: { when: 'acl#1', to } }), { v: { ok: false, why }, events: ['lstat', 'acl', 'list', 'lstat'] }, `acl#1 → ${why}`);
  }
  // Swapped while protectDir runs (after its first lstat): refused by the lstat right after it, before any re-probe.
  for (const [to, why] of [[JUNCTION, 'symlink'], [OTHER_INO, 'probe_failed'], [null, 'not_dir']] as const) {
    assert.deepEqual(await run({ exists: true, swap: { when: 'protect#1', to } }), { v: { ok: false, why }, events: ['lstat', 'acl', 'list', 'lstat', 'protect', 'lstat'] }, `protect#1 → ${why}`);
    assert.deepEqual(await run({ exists: false, swap: { when: 'protect#1', to } }), { v: { ok: false, why }, events: ['lstat', 'mkdirp', 'lstat', 'lstat', 'protect', 'lstat'] }, `created, protect#1 → ${why}`);
  }
  // A created directory whose first protectDir failed: the repair is guarded the same way.
  assert.deepEqual(await run({ exists: false, firstProtect: false, swap: { when: 'protect#2', to: JUNCTION } }),
    { v: { ok: false, why: 'symlink' }, events: ['lstat', 'mkdirp', 'lstat', 'lstat', 'protect', 'lstat', 'acl', 'list', 'lstat', 'protect', 'lstat'] });
  // Swapped after the last probe: the lstat after it refuses, with or without a repair before.
  assert.deepEqual(await run({ exists: true, swap: { when: 'acl#2', to: JUNCTION } }),
    { v: { ok: false, why: 'symlink' }, events: ['lstat', 'acl', 'list', 'lstat', 'protect', 'lstat', 'list', 'acl', 'lstat'] });
  assert.deepEqual(await run({ exists: true, sddl: PROTECTED_DACL, swap: { when: 'acl#1', to: OTHER_INO } }), { v: { ok: false, why: 'probe_failed' }, events: ['lstat', 'acl', 'lstat'] });
});

test('verifyDataDir (win32): a directory is repaired only when it is empty or holds nothing but the viewer\'s own files (log\\*.jsonl, log\\viz-stderr.txt, *.jsonl, probe.json), checked before and after the repair; anything else keeps its acl refusal and is never re-permissioned', async () => {
  const FILE: Partial<FsLstat> = { isFile: true, mode: 0o100000 };
  const DIR: Partial<FsLstat> = { isDirectory: true, mode: 0o40000 };
  const LINK: Partial<FsLstat> = { isSymbolicLink: true, mode: 0o120000 };
  /** `entries`: paths relative to the data directory ('log\\x.jsonl') → their lstat; protectDir succeeds and runs `during` first. */
  const run = async (entries: Record<string, Partial<FsLstat>>, during?: (tree: Map<string, Partial<FsLstat>>) => void, listFails = false): Promise<{ v: DataDirVerdict; protects: number; acls: number }> => {
    const tree = new Map<string, Partial<FsLstat>>(Object.entries(entries).map(([k, v]) => [win32.join(WIN_DIR, k), v]));
    let sddl = INHERITED_WIDE;
    let protects = 0;
    let acls = 0;
    const no = (): never => { throw new Error('unexpected Fs call'); };
    const fs: Fs = {
      readFile: no, writeFile: no, rename: no, link: no, unlink: no, stat: no, rmrf: no, writeFileExclusive: no, rmdir: no, appendFile: no,
      realpath: no, freeBytes: no, chmod: no, mkdirp: no,
      readdir: async (p: string) => {
        if (listFails) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        if (p !== WIN_DIR && tree.get(p)?.isDirectory !== true) throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' });
        return [...tree.keys()].filter((k) => win32.dirname(k) === p).map((k) => win32.basename(k)).sort();
      },
      lstat: async (p: string) => {
        const e = p === WIN_DIR ? DIR_STAT : tree.get(p);
        return e === undefined ? null : { ...DIR_STAT, ino: BigInt(p.length), isDirectory: false, ...e };
      },
    };
    const probe: OwnerProbe = {
      posix: async () => null, euid: () => null,
      windows: async () => { acls += 1; return { sddl, userSid: U }; },
      protectDir: async () => { protects += 1; during?.(tree); sddl = PROTECTED_DACL; return true; },
    };
    return { v: await verifyDataDir(WIN_DIR, { fs, probe, platform: 'win32', create: true }), protects, acls };
  };

  // Empty, or only the viewer's own files: repaired once and accepted. The viewer's own files include its stderr file,
  // log\viz-stderr.txt (VIEWER_STDERR_FILE: every CLI start opens it, Task 15 fix round 2), a regular file inside log\ only.
  assert.equal(VIEWER_STDERR_FILE, 'viz-stderr.txt');
  const stderrIn = (dir: string): string => `${dir}\\${VIEWER_STDERR_FILE}`;
  for (const entries of [
    {}, { log: DIR }, { log: DIR, 'log\\viz-ABCDEFGH-1.jsonl': FILE, 'log\\viz-ABCDEFGH-0.jsonl': FILE },
    { 'probe.json': FILE }, { 'viz-ABCDEFGH-1.jsonl': FILE, 'probe.json': FILE, log: DIR, 'log\\viz-ABCDEFGH-2.jsonl': FILE },
    { log: DIR, [stderrIn('log')]: FILE }, { log: DIR, 'log\\viz-ABCDEFGH-1.jsonl': FILE, [stderrIn('log')]: FILE, 'probe.json': FILE },
  ] as Array<Record<string, Partial<FsLstat>>>) {
    assert.deepEqual(await run(entries), { v: { ok: true }, protects: 1, acls: 2 }, JSON.stringify(Object.keys(entries)));
  }
  // Anything else: the acl refusal it had, and its DACL never touched (no protectDir). The stderr file as a link (symlink or
  // junction), a folder, outside log\ (the data directory itself) or under another case of its name is not the viewer's.
  for (const entries of [
    { 'notes.txt': FILE }, { 'repos.json': FILE }, { 'user.json': FILE }, { 'viz-no-hooks': DIR }, { sub: DIR }, { 'Documents.lnk': FILE },
    { log: LINK }, { log: FILE }, { 'log\\x.txt': FILE, log: DIR }, { log: DIR, 'log\\sub': DIR }, { log: DIR, 'log\\a.jsonl': LINK },
    { log: DIR, 'log\\a.jsonl': DIR }, { 'probe.json': DIR }, { 'probe.json': LINK }, { 'a.jsonl': LINK }, { 'a.jsonl': DIR },
    { 'probe.json': FILE, 'notes.txt': FILE }, { 'LOG.TXT': FILE },
    { log: DIR, [stderrIn('log')]: LINK }, { log: DIR, [stderrIn('log')]: DIR }, { [VIEWER_STDERR_FILE]: FILE },
    { log: DIR, 'log\\VIZ-STDERR.TXT': FILE }, { log: DIR, 'log\\viz-stderr.txt.bak': FILE }, { log: DIR, 'log\\viz-stderr.log': FILE },
  ] as Array<Record<string, Partial<FsLstat>>>) {
    assert.deepEqual(await run(entries), { v: { ok: false, why: 'acl' }, protects: 0, acls: 1 }, JSON.stringify(entries));
  }
  // Checked again after the repair: a file that appeared meanwhile refuses before the re-probe.
  assert.deepEqual(await run({}, (tree) => { tree.set(win32.join(WIN_DIR, 'dropped.txt'), FILE); }), { v: { ok: false, why: 'acl' }, protects: 1, acls: 1 });
  assert.deepEqual(await run({ log: DIR }, (tree) => { tree.set(win32.join(WIN_DIR, 'log'), LINK); }), { v: { ok: false, why: 'acl' }, protects: 1, acls: 1 });
  // A directory that cannot be listed: fail closed, never re-permissioned.
  assert.deepEqual(await run({}, undefined, true), { v: { ok: false, why: 'probe_failed' }, protects: 0, acls: 1 });
});

test('verifyDataDir: POSIX owner and mode, Windows junctions and SDDL, and every probe failure fail closed', async () => {
  const dir = '/home/me/.claude/plugins/data/cowork-sync';
  const isDir = { isDirectory: true };
  const posixProbe = (st: Awaited<ReturnType<OwnerProbe['posix']>>, euid: number | null = 501): OwnerProbe => ({
    posix: async () => st, euid: () => euid, windows: async () => null,
  });
  const v = (fs: Fs, probe: OwnerProbe, platform: NodeJS.Platform = 'linux', create = false) => verifyDataDir(dir, { fs, probe, platform, create });
  const fs = tableFs(new Map([[dir, isDir]]));
  assert.deepEqual(await v(fs, posixProbe({ uid: 501, mode: 0o40700, isDir: true, isSymlink: false })), { ok: true });
  assert.deepEqual(await v(fs, posixProbe({ uid: 501, mode: 0o40755, isDir: true, isSymlink: false })), { ok: false, why: 'mode' });
  assert.deepEqual(await v(fs, posixProbe({ uid: 501, mode: 0o40701, isDir: true, isSymlink: false })), { ok: false, why: 'mode' });
  assert.deepEqual(await v(fs, posixProbe({ uid: 0, mode: 0o40700, isDir: true, isSymlink: false })), { ok: false, why: 'owner' });
  assert.deepEqual(await v(fs, posixProbe({ uid: 502, mode: 0o40700, isDir: true, isSymlink: false })), { ok: false, why: 'owner' });
  assert.deepEqual(await v(fs, posixProbe({ uid: 501, mode: 0o40700, isDir: true, isSymlink: false }, null)), { ok: false, why: 'probe_failed' });
  assert.deepEqual(await v(fs, posixProbe(null)), { ok: false, why: 'probe_failed' });
  assert.deepEqual(await v(tableFs(new Map([[dir, { isSymbolicLink: true }]])), posixProbe({ uid: 501, mode: 0o120777, isDir: false, isSymlink: true })),
    { ok: false, why: 'symlink' });
  // The same symlink named with a trailing separator: lstat("<link>/") follows the link (the table answers as the OS would), so the
  // directory is checked by its name without the separator.
  const linkFs = tableFs(new Map<string, Partial<FsLstat>>([[dir, { isSymbolicLink: true }], [`${dir}/`, isDir], [`${dir}//`, isDir]]));
  for (const named of [`${dir}/`, `${dir}//`]) {
    assert.deepEqual(await verifyDataDir(named, { fs: linkFs, probe: posixProbe({ uid: 501, mode: 0o40700, isDir: true, isSymlink: false }), platform: 'linux', create: false }),
      { ok: false, why: 'symlink' }, named);
  }
  assert.deepEqual(await v(tableFs(new Map([[dir, { isFile: true }]])), posixProbe({ uid: 501, mode: 0o100600, isDir: false, isSymlink: false })),
    { ok: false, why: 'not_dir' });
  assert.deepEqual(await v(tableFs(new Map([[dir, 'throw']])), posixProbe({ uid: 501, mode: 0o40700, isDir: true, isSymlink: false })),
    { ok: false, why: 'probe_failed' });
  // Creation goes through the Fs port with mode 0700; a probe that throws fails closed.
  const made: string[] = [];
  assert.deepEqual(await v(tableFs(new Map(), made), posixProbe({ uid: 501, mode: 0o40700, isDir: true, isSymlink: false }), 'linux', true), { ok: true });
  assert.deepEqual(made, [dir]);
  const throwing: OwnerProbe = { posix: () => Promise.reject(new Error('x')), euid: () => 501, windows: () => Promise.reject(new Error('x')) };
  assert.deepEqual(await v(fs, throwing), { ok: false, why: 'probe_failed' });
  assert.deepEqual(await v(fs, throwing, 'win32'), { ok: false, why: 'probe_failed' });

  // Windows: a junction (lstat reports it as a symbolic link) is refused before any probe; the SDDL decides the rest, by SID.
  const winProbe = (r: Awaited<ReturnType<OwnerProbe['windows']>>): OwnerProbe => ({ posix: async () => null, euid: () => null, windows: async () => r });
  assert.deepEqual(await v(tableFs(new Map([[dir, { isSymbolicLink: true, isDirectory: false }]])), winProbe({ sddl: USER_ONLY_SDDL, userSid: U }), 'win32'),
    { ok: false, why: 'symlink' });
  assert.deepEqual(await v(fs, winProbe({ sddl: USER_ONLY_SDDL, userSid: U }), 'win32'), { ok: true });
  assert.deepEqual(await v(fs, winProbe({ sddl: `${USER_ONLY_SDDL}(A;OICI;FR;;;WD)`, userSid: U }), 'win32'), { ok: false, why: 'acl' });
  assert.deepEqual(await v(fs, winProbe({ sddl: `O:${OTHER}D:(A;;FA;;;${U})`, userSid: U }), 'win32'), { ok: false, why: 'owner' });
  assert.deepEqual(await v(fs, winProbe({ sddl: 'D:NO_ACCESS_CONTROL', userSid: U }), 'win32'), { ok: false, why: 'acl' });
  assert.deepEqual(await v(fs, winProbe({ sddl: USER_ONLY_SDDL, userSid: OTHER }), 'win32'), { ok: false, why: 'owner' });
  assert.deepEqual(await v(fs, winProbe(null), 'win32'), { ok: false, why: 'probe_failed' });
});

test('dataDir.ts re-exports pluginDataDir, resolveDataDir, Sddl, parseSddl, sddlUserOnly and sddlOwnerOk from src/data and src/sec unchanged', () => {
  // The same function objects (Sddl is a type: its use below is checked by tsc).
  assert.equal(dataDirModule.pluginDataDir, pluginDataModule.pluginDataDir);
  assert.equal(dataDirModule.resolveDataDir, pluginDataModule.resolveDataDir);
  assert.equal(dataDirModule.parseSddl, sddlModule.parseSddl);
  assert.equal(dataDirModule.sddlUserOnly, sddlModule.sddlUserOnly);
  assert.equal(dataDirModule.sddlOwnerOk, sddlModule.sddlOwnerOk);
  assert.equal(pluginDataDir, pluginDataModule.pluginDataDir);
  assert.equal(resolveDataDir, pluginDataModule.resolveDataDir);
  assert.equal(sddlOwnerOk, sddlModule.sddlOwnerOk);
  const parsed: sddlModule.Sddl | null = sddlModule.parseSddl(USER_ONLY_SDDL);
  assert.deepEqual(parsed, parseSddl(USER_ONLY_SDDL));
});

test('resolveDataDir refuses UNC and device paths on POSIX too, and agrees with the shared isUncOrDevice (SEC-20 parity)', () => {
  // pluginDataDir.ts keeps a private copy of paths.ts isUncOrDevice (it imports only node:*); on win32 the drive regex hides a broken copy, so the POSIX cases pin it.
  const refused = ['//host/x', '/dev', '/dev/x', '/dev/shm/x', '\\/server/share', '/\\server\\share', '\\\\server\\share', '\\\\.\\x', '\\\\?\\C:\\x'];
  for (const p of refused) {
    assert.equal(isUncOrDevice(p), true, `shared ${p}`);
    assert.equal(resolveDataDir({ CLAUDE_PLUGIN_DATA: p }, '/home/me', 'linux'), null, `linux ${p}`);
    assert.equal(resolveDataDir({ CLAUDE_PLUGIN_DATA: p }, 'C:\Users\me', 'win32'), null, `win32 ${p}`);
  }
  const accepted = ['/devices/x', '/home/me', '/var/data', '/device'];
  for (const p of accepted) {
    assert.equal(isUncOrDevice(p), false, `shared ${p}`);
    assert.equal(resolveDataDir({ CLAUDE_PLUGIN_DATA: p }, '/home/me', 'linux'), p, `linux ${p}`);
  }
  // A UNC or device CLAUDE_CONFIG_DIR is ignored (the derived directory falls back to <home>/.claude).
  for (const p of ['//host/c', '/dev/c']) {
    assert.equal(pluginDataDir({ CLAUDE_CONFIG_DIR: p }, '/home/me', 'linux'), '/home/me/.claude/plugins/data/cowork-sync', p);
  }
});

test('the stderr file\'s name comes from the import-free leaf stderrFile.ts, which dataDir.ts and spawn.ts both import: dataDir.ts (bundled into viz.js too) never imports spawn.ts and its node:child_process', () => {
  const src = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../../src/viz/cli/${rel}`, import.meta.url)), 'utf8');
  const imports = (text: string): string[] => [...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gms)].map((m) => m[1]!);
  assert.deepEqual(imports(src('stderrFile.ts')), [], 'the leaf imports nothing');
  assert.equal(stderrLeaf.VIEWER_STDERR_FILE, 'viz-stderr.txt');
  assert.equal(VIEWER_STDERR_FILE, stderrLeaf.VIEWER_STDERR_FILE, 'spawn.ts re-exports the leaf\'s name');
  assert.ok(imports(src('dataDir.ts')).includes('./stderrFile.js'));
  assert.ok(!imports(src('dataDir.ts')).some((m) => m === './spawn.js' || m.startsWith('node:child_process')), 'dataDir.ts imports neither spawn.ts nor child_process');
  assert.ok(imports(src('spawn.ts')).includes('./stderrFile.js'));
});
