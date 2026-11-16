// The data directory (12-visualizer section 3.2 item 2, VIZ-02; SEC-20; R-V11): where it is, its creation (user-only), and the
// owner/ACL verification the CLI runs before anything is read or spawned (the viewer repeats it with create: false).
// SEC-20 fixes the check, not the derivation: the derivation lives in src/data/pluginDataDir.ts and the SDDL reading in src/sec/sddl.ts (F-8a-2).
import type { Fs, FsLstat } from '../../ports/fs.js';
import { pathOf, withoutTrailingSeparator } from '../../data/pluginDataDir.js';
import { asUser, admittedSids, ownerOk, parseSddlAces, sddlUserOnly } from '../../sec/sddl.js';
import type { OwnerProbe } from './ownerProbe.js';
import { VIEWER_STDERR_FILE } from './stderrFile.js';

// The moved names stay importable from here (F-8a-2): pluginDataDir and resolveDataDir live in src/data, the SDDL reading in src/sec.
export { pluginDataDir, resolveDataDir } from '../../data/pluginDataDir.js';
export { parseSddl, sddlOwnerOk, sddlUserOnly, type Sddl } from '../../sec/sddl.js';

export type DataDirVerdict = { ok: true } | { ok: false; why: 'not_dir' | 'symlink' | 'owner' | 'mode' | 'acl' | 'probe_failed' };

const refuse = (why: Exclude<DataDirVerdict, { ok: true }>['why']): DataDirVerdict => ({ ok: false, why });
/**
 * create: mkdirp 0700 when absent (the CLI), and on win32 a protected user-only DACL right away (OwnerProbe.protectDir: a new directory
 * would otherwise inherit its parent's DACL and fail its own check for good), before anything else touches it; the viewer passes
 * create: false. The directory is checked by its name without a trailing separator. POSIX: lstat directory, not a symlink, uid = euid,
 * mode & 0o077 === 0. win32: lstat not a symlink or junction (isSymbolicLink), then parseSddl + sddlUserOnly (the owner first, as
 * 'owner'); with create, a directory whose owner passes and whose DACL fails only on what it inherits (windowsVerdict's `repairable`: a
 * protectDir that failed at creation, or a directory left by such a run) gets one more protectDir and one re-check before it is refused
 * (ruling 2026-10-08), only when it is empty or holds nothing but the viewer's own files (onlyViewerFiles, listed before and after the
 * repair; anything else keeps its 'acl' refusal and its DACL). Every protectDir runs between two lstats of the path, and the last probe
 * is followed by one more; each must find the directory first checked (changedSince: a path that became a symlink or junction, vanished,
 * or is another directory by dev/ino is refused), because icacls and Get-Acl act on a path, which a writer of the parent folder can swap
 * between the checks. Any probe failure → probe_failed (fail closed).
 */
export async function verifyDataDir(dirName: string, o: { fs: Fs; probe: OwnerProbe; platform: NodeJS.Platform; create: boolean }): Promise<DataDirVerdict> {
  try {
    const dir = withoutTrailingSeparator(dirName, o.platform);
    let st = await o.fs.lstat(dir);
    let created = false;
    if (st === null) {
      if (!o.create) return refuse('not_dir');
      await o.fs.mkdirp(dir, 0o700);
      st = await o.fs.lstat(dir);
      if (st === null) return refuse('probe_failed');
      created = true;
    }
    if (st.isSymbolicLink) return refuse('symlink');
    if (!st.isDirectory) return refuse('not_dir');
    if (o.platform === 'win32') {
      // Nothing is created inside a new directory before its protectDir returns: the CLI writes nothing into the data directory before
      // this check passes, and the viewer it starts afterwards writes its log there.
      const first = st;
      const protectDir = o.create ? o.probe.protectDir?.bind(o.probe) : undefined;
      /** protectDir between an lstat right before and one right after it: null when the path stayed the directory first checked. */
      const guarded = async (run: (d: string) => Promise<boolean>): Promise<DataDirVerdict | null> => {
        const before = await changedSince(o.fs, dir, first);
        if (before !== null) return before;
        await run(dir);
        return changedSince(o.fs, dir, first);
      };
      if (created && protectDir !== undefined) {
        const moved = await guarded(protectDir);
        if (moved !== null) return moved;
      }
      let r = await windowsVerdict(dir, o.probe);
      if (r.repairable && protectDir !== undefined) {
        if (!(await onlyViewerFiles(o.fs, dir, o.platform))) return r.verdict;
        const moved = await guarded(protectDir);
        if (moved !== null) return moved;
        if (!(await onlyViewerFiles(o.fs, dir, o.platform))) return r.verdict;
        r = await windowsVerdict(dir, o.probe);
      }
      if (!r.verdict.ok) return r.verdict;
      return (await changedSince(o.fs, dir, first)) ?? r.verdict;
    }
    const p = await o.probe.posix(dir);
    if (p === null) return refuse('probe_failed');
    if (p.isSymlink) return refuse('symlink');
    if (!p.isDir) return refuse('not_dir');
    const euid = o.probe.euid();
    if (euid === null) return refuse('probe_failed');
    if (p.uid !== euid) return refuse('owner');
    return (p.mode & 0o077) === 0 ? { ok: true } : refuse('mode');
  } catch {
    return refuse('probe_failed');
  }
}

/**
 * null while `dir` still lstats as the directory first checked (a directory, not a symlink or junction, the same dev and ino); else the
 * refusal: 'symlink' for a link or junction, 'not_dir' when it is gone or no directory, 'probe_failed' for another directory.
 */
async function changedSince(fs: Fs, dir: string, first: FsLstat): Promise<DataDirVerdict | null> {
  const now = await fs.lstat(dir);
  if (now === null) return refuse('not_dir');
  if (now.isSymbolicLink) return refuse('symlink');
  if (!now.isDirectory) return refuse('not_dir');
  return now.dev === first.dev && now.ino === first.ino ? null : refuse('probe_failed');
}

/** The viewer's log folder (12 §3.10.10: <data dir>/log/viz-<instance>-<n>.jsonl; the CLI's stderr file log/viz-stderr.txt). */
const LOG_DIR = 'log';
/** The test probe's record (test/fixtures/viz/probeViewer.mjs writes <data dir>/probe.json). */
const PROBE_RECORD = 'probe.json';
const isJsonl = (name: string): boolean => name.endsWith('.jsonl');

/**
 * `dir` is empty or holds nothing but the viewer's own files: regular *.jsonl files, the probe record, and a `log` folder (no link or
 * junction) holding only regular *.jsonl files and the viewer's stderr file (VIEWER_STDERR_FILE, which every CLI start opens there,
 * spawn.ts openViewerStderr). A data directory the CLI repairs must be one the viewer made: any other folder's DACL is not the CLI's to
 * rewrite (and a link inside could lead the viewer's log writes elsewhere).
 */
async function onlyViewerFiles(fs: Fs, dir: string, platform: NodeJS.Platform): Promise<boolean> {
  const P = pathOf(platform);
  const regularFile = async (p: string): Promise<boolean> => {
    const s = await fs.lstat(p);
    return s !== null && s.isFile && !s.isSymbolicLink;
  };
  for (const name of await fs.readdir(dir)) {
    const p = P.join(dir, name);
    if (name === LOG_DIR) {
      const s = await fs.lstat(p);
      if (s === null || s.isSymbolicLink || !s.isDirectory) return false;
      for (const inner of await fs.readdir(p)) {
        if (!(isJsonl(inner) || inner === VIEWER_STDERR_FILE) || !(await regularFile(P.join(p, inner)))) return false;
      }
      continue;
    }
    if (!(isJsonl(name) || name === PROBE_RECORD) || !(await regularFile(p))) return false;
  }
  return true;
}

/**
 * The SEC-20 verdict of a directory's DACL, by the owner probe; `repairable` when the owner passes and the DACL fails only on what it
 * inherits: every explicit (non-inherited) allow ACE is one sddlUserOnly admits, and at least one allow ACE is inherited. A protectDir
 * (inheritance removed, the user, SY and BA granted) then gives a passing DACL. An explicit foreign ACE is never repaired: someone set it.
 */
async function windowsVerdict(dir: string, probe: OwnerProbe): Promise<{ verdict: DataDirVerdict; repairable: boolean }> {
  const fail = (why: Exclude<DataDirVerdict, { ok: true }>['why'], repairable = false): { verdict: DataDirVerdict; repairable: boolean } => ({ verdict: refuse(why), repairable });
  const acl = await probe.windows(dir);
  if (acl === null) return fail('probe_failed');
  const s = parseSddlAces(acl.sddl);
  if (s === null) return fail('acl');
  const user = acl.userSid.toUpperCase();
  if (!ownerOk(s.owner, user)) return fail('owner');
  if (sddlUserOnly(s, user)) return { verdict: { ok: true }, repairable: false };
  const admitted = admittedSids(user);
  const explicitAdmitted = s.allow.every((sid, i) => s.allowInherited[i] === true || admitted.has(asUser(sid, user) ?? ''));
  return fail('acl', explicitAdmitted && s.allowInherited.includes(true));
}
