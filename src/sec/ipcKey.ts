// src/sec/ipcKey.ts — SEC-20 (09 §3.11 "Key"): <dataDir>/ipc.key, 32 random bytes, user-only, verified before every read; never another
// location (a caller without CLAUDE_PLUGIN_DATA passes the derived directory, src/data/pluginDataDir.ts resolveDataDir). POSIX: mode with no
// group/other bits, owner = uid, the parent directory not group- or world-writable — an lstat. win32: the SDDL ACEs ⊆ {user SID, S-1-5-18,
// S-1-5-32-544} by src/sec/sddl.ts's verdict (X-62), SIDs never names, read through the WinAcl runner (≈ 1 s for Get-Acl), so a verifier
// that passed may leave the A3-6 stamp <dataDir>/ipc.key.acl that lets a hook skip the spawn while the key file is unchanged.
// P5SEC (audit #34, #35): the stamp is a cached identity, not a proof — a hook cannot tell a forged one — so it is trusted only in a data
// directory that only the user can write: the start (createIpcKey, protectDataDir) makes the directory user-only and fails closed; a stamp is
// written only by a 'write' verifier, under a temp name restricted like the key, then renamed; every refusal of a key deletes it, a runner error
// in a key check never does; a start refused at the directory step deletes it too (fix r1, never through a link); a hook's full check runs
// within its caller's remaining time.
// No process.env read here, no child_process (the runner is src/sec/winAcl.ts); src/sec may not import src/claude: KEY_BYTES is a local
// copy of C.IPC_KEY_BYTES and the stamp is encoded locally (a test pins it byte-equal to canonicalJsonLine, X5-45).
import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { errnoCode, type Fs, type FsLstat } from '../ports/fs.js';
import type { Random } from '../ports/random.js';
import { parseSddl, sddlUserOnly } from './sddl.js';
import type { RunBound, WinAcl } from './winAcl.js';

/** 09 §3.11: the key is 32 random bytes (= C.IPC_KEY_BYTES). */
export const KEY_BYTES = 32;
const KEY_FILE = 'ipc.key';
const STAMP_FILE = 'ipc.key.acl';

export interface KeyDeps { fs: Fs; random: Random; platform: NodeJS.Platform; uid: number | null; acl: WinAcl; }
/** code null: no key file (or not a 32-byte key): the caller never connects (MCP → NO_MCP, hooks → G4). */
export type KeyCheck = { ok: true; key: Buffer } | { ok: false; code: 'SEC_REFUSE_IPC_ACL' | null };

/** createIpcKey: an existing key (or the one just created) fails its owner/ACL verification. */
export class IpcKeyRefused extends Error {
  readonly code = 'SEC_REFUSE_IPC_ACL' as const;
  constructor() {
    super('SEC_REFUSE_IPC_ACL');
    this.name = 'IpcKeyRefused';
  }
}

const REFUSE: KeyCheck = Object.freeze({ ok: false, code: 'SEC_REFUSE_IPC_ACL' }) as KeyCheck;
const NO_KEY: KeyCheck = Object.freeze({ ok: false, code: null }) as KeyCheck;

const pathOf = (platform: NodeJS.Platform): typeof posix => (platform === 'win32' ? win32 : posix);
const missing = (e: unknown): boolean => errnoCode(e) === 'ENOENT' || errnoCode(e) === 'ENOTDIR';

/** A3-6: the one-line stamp of a key file's identity — {"ctimeNs","dev","ino","mtimeNs","size"} as decimal strings in that (sorted) key
 *  order, so JSON.stringify writes canonicalJsonLine's bytes; null without a ctimeNs (an ACL change would then go unseen: no stamp). */
function stampOf(st: FsLstat): Buffer | null {
  if (st.ctimeNs === undefined) return null;
  return Buffer.from(JSON.stringify({ ctimeNs: String(st.ctimeNs), dev: String(st.dev), ino: String(st.ino), mtimeNs: String(st.mtimeNs), size: String(st.size) }), 'utf8');
}

/** The key bytes when the file holds exactly 32; NO_KEY otherwise or when it vanished; a read error other than that refuses. */
async function readKeyBytes(fs: Fs, keyPath: string, st: FsLstat): Promise<KeyCheck> {
  if (st.size !== KEY_BYTES) return NO_KEY;
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(keyPath);
  } catch (e) {
    return missing(e) ? NO_KEY : REFUSE;
  }
  return bytes.length === KEY_BYTES ? { ok: true, key: bytes } : NO_KEY;
}

async function posixVerified(keyPath: string, st: FsLstat, d: KeyDeps): Promise<boolean> {
  if (d.uid === null || st.uid !== d.uid || (st.mode & 0o077) !== 0) return false;
  const parent = await d.fs.lstat(posix.dirname(keyPath));
  return parent !== null && parent.isDirectory && (parent.mode & 0o022) === 0;
}

type StampMode = 'use' | 'write' | 'ignore';
/** The full win32 check's outcome: a pass (with the SID it compared), a broad ACL (a verdict), or no verdict (a runner error, a spent bound, an
 *  answer that is not an SDDL) — the last two both refuse; only a verdict deletes the stamp (P5SEC #35). */
type Win32Verdict = { kind: 'pass'; sid: string } | { kind: 'broad' } | { kind: 'error' };
const BROAD: Win32Verdict = Object.freeze({ kind: 'broad' });
const NO_VERDICT: Win32Verdict = Object.freeze({ kind: 'error' });

/** The bound of the next runner call: {} without a caller bound; null once the caller's time is spent (no runner starts). */
function boundOf(remainingMs: (() => number) | undefined): RunBound | null {
  if (remainingMs === undefined) return {};
  const ms = remainingMs();
  return ms > 0 ? { timeoutMs: ms } : null;
}

/** The full win32 check: whoami (skipped when the caller already holds the SID) and Get-Acl, started together and each bounded by the caller's
 *  remaining time, so the check costs the slower of the two. */
async function win32Verdict(keyPath: string, acl: WinAcl, sid: string | null, remainingMs: (() => number) | undefined): Promise<Win32Verdict> {
  const b = boundOf(remainingMs);
  if (b === null) return NO_VERDICT;
  try {
    const [user, sddl] = await Promise.all([sid ?? acl.currentUserSid(b), acl.readSddl(keyPath, b)]);
    const parsed = parseSddl(sddl);
    if (parsed === null) return NO_VERDICT;
    return sddlUserOnly(parsed, user) ? { kind: 'pass', sid: user } : BROAD;
  } catch {
    return NO_VERDICT;
  }
}

/** A3-6, P5SEC #34: the stamp gets the key's ACL — its bytes under <dataDir>/ipc.key.acl.<16 hex>.tmp (exclusive create, mode 0o600), that file
 *  restricted to the user (`icacls /inheritance:r /grant:r *<SID>:F`), then renamed onto ipc.key.acl, so the stamp name never holds a file
 *  with another DACL. Best-effort: a failure leaves no temp file and costs a later full check. */
async function writeStamp(dataDir: string, identity: Buffer, sid: string, d: KeyDeps): Promise<void> {
  const P = pathOf(d.platform);
  const tmp = P.join(dataDir, `${STAMP_FILE}.${hex(d, 8)}.tmp`);
  try {
    await d.fs.writeFileExclusive(tmp, identity, 0o600);
  } catch {
    return;
  }
  try {
    await d.acl.restrictToUser(tmp, sid);
    await d.fs.rename(tmp, P.join(dataDir, STAMP_FILE));
  } catch {
    await d.fs.unlink(tmp).catch(() => {});
  }
}

/** readIpcKey's options: the stamp mode (A3-6) and the caller's remaining time for the full check (P5SEC #35; a hook passes its Deadline's). */
export interface KeyReadOptions { stamp: StampMode; remainingMs?: () => number; }

/**
 * <dataDir>/ipc.key verified, then read. A symlink or a non-file at the key path, a failed verification or an I/O error other than "absent"
 * refuses SEC_REFUSE_IPC_ACL; no file, or a file that is not 32 bytes, is {ok: false, code: null}. A3-6 (win32 only; POSIX needs no stamp),
 * as amended by P5SEC: stamp 'use' (hooks) accepts the key without the runner when <dataDir>/ipc.key.acl equals the key's current lstat identity,
 * else runs the full check and never writes the stamp; 'write' (the start, the daemon's 30 s check, the MCP server's start) always runs the full
 * check and writes the stamp on a pass (writeStamp: restricted like the key); under both, every refusal verdict — a broad ACL, a symlink or a
 * non-file at the key path — deletes the stamp, while a refusal without a verdict (a runner error, the caller's time spent, an answer that is
 * not an SDDL, an I/O error) keeps it; 'ignore' (the default) runs the full check and neither reads, writes nor deletes the stamp. A matching
 * stamp is trusted only because the data directory is user-only (protectDataDir, the start's step); stamp writes and deletes are best-effort.
 * o.remainingMs bounds the full check: each runner call gets the time left, none starts once it is ≤ 0.
 */
export async function readIpcKey(dataDir: string, d: KeyDeps, o?: KeyReadOptions): Promise<KeyCheck> {
  return readKey(dataDir, d, o?.stamp ?? 'ignore', null, o?.remainingMs);
}

/** readIpcKey with the user's SID when the caller already read it (createIpcKey: whoami runs once per start). */
async function readKey(dataDir: string, d: KeyDeps, mode: StampMode, sid: string | null, remainingMs: (() => number) | undefined): Promise<KeyCheck> {
  const P = pathOf(d.platform);
  const keyPath = P.join(dataDir, KEY_FILE);
  const stampPath = P.join(dataDir, STAMP_FILE);
  /** A refusal verdict: on win32 under 'use' and 'write' it deletes the stamp (P5SEC #34). */
  const refused = async (): Promise<KeyCheck> => {
    if (d.platform === 'win32' && mode !== 'ignore') await d.fs.unlink(stampPath).catch(() => {});
    return REFUSE;
  };
  try {
    const st = await d.fs.lstat(keyPath);
    if (st === null) return NO_KEY;
    if (st.isSymbolicLink || !st.isFile) return await refused();
    if (d.platform !== 'win32') return (await posixVerified(keyPath, st, d)) ? await readKeyBytes(d.fs, keyPath, st) : REFUSE;

    const identity = stampOf(st);
    if (mode === 'use' && identity !== null) {
      const saved = await d.fs.readFile(stampPath).catch(() => null);
      if (saved !== null && saved.equals(identity)) return await readKeyBytes(d.fs, keyPath, st);
    }
    const v = await win32Verdict(keyPath, d.acl, sid, remainingMs);
    if (v.kind === 'broad') return await refused();
    if (v.kind === 'error') return REFUSE;
    const r = await readKeyBytes(d.fs, keyPath, st);
    if (r.ok && mode === 'write' && identity !== null) await writeStamp(dataDir, identity, v.sid, d);
    return r;
  } catch (e) {
    return missing(e) ? NO_KEY : REFUSE;
  }
}

/** P5SEC #34, protectDataDir's body for a known SID: the path lstats as a directory (not a link or junction), protectDir runs on it, its SDDL is
 *  then user-only by sddlUserOnly, and a second lstat finds the same directory (dev/ino) — else IpcKeyRefused. Fix r1 (Ruling P5SEC-R1-1): any
 *  refusal after the first lstat found a real directory — a DACL still not user-only or a foreign owner, a failed protectDir or Get-Acl, an
 *  unparseable SDDL, another directory swapped in — deletes <dataDir>\ipc.key.acl (one best-effort unlink), because a stamp is trusted only in a
 *  user-only directory and this refusal is the one a planted key with a forged stamp meets; only when the second lstat finds a real directory
 *  there, never through a link or junction put at the path. An lstat that throws refuses as a missing directory does, deleting nothing; a stamp
 *  the user cannot delete (a planter-owned file) survives the refusal and only the trusted-copy carry (HANDOFF §11) closes that (F2 #156). A
 *  start that refuses here runs no daemon, so the stamp it drops has no use. */
async function protectDirFor(dataDir: string, d: KeyDeps, sid: string): Promise<void> {
  await d.fs.mkdirp(dataDir, 0o700);
  const first = await d.fs.lstat(dataDir).catch(() => null);
  if (first === null || first.isSymbolicLink || !first.isDirectory) throw new IpcKeyRefused();
  let userOnly: boolean;
  try {
    await d.acl.protectDir(dataDir, sid);
    const parsed = parseSddl(await d.acl.readSddl(dataDir));
    userOnly = parsed !== null && sddlUserOnly(parsed, sid);
  } catch {
    userOnly = false;
  }
  const now = await d.fs.lstat(dataDir).catch(() => null);
  const realDir = now !== null && !now.isSymbolicLink && now.isDirectory;
  if (userOnly && realDir && now.dev === first.dev && now.ino === first.ino) return;
  if (realDir) await d.fs.unlink(pathOf(d.platform).join(dataDir, STAMP_FILE)).catch(() => {});
  throw new IpcKeyRefused();
}

/**
 * P5SEC #34 (the precondition SE5-17's stamp rests on): on win32 the start makes <dataDir> user-only — created 0o700 when absent, then
 * WinAcl.protectDir (inheritance removed; the user, SYSTEM and Administrators granted, inherited by what is created inside; /L on the path
 * itself) — and verifies it; a link or junction at the path, a failed protectDir, a DACL that is still not user-only (an explicit foreign ACE
 * survives /inheritance:r) or a path swapped meanwhile throws IpcKeyRefused (start refused, SEC_REFUSE_IPC_ACL); each of these refusals except
 * a link's first deletes <dataDir>\ipc.key.acl (protectDirFor; a whoami failure before the step deletes nothing). createIpcKey runs it first;
 * the daemon's own start (Task 5) calls createIpcKey or this before it reads the key with 'write'. POSIX: nothing (the key's parent mode is
 * checked on every read, and no stamp exists there).
 */
export async function protectDataDir(dataDir: string, d: KeyDeps): Promise<void> {
  if (d.platform !== 'win32') return;
  let sid: string;
  try {
    sid = await d.acl.currentUserSid();
  } catch {
    throw new IpcKeyRefused();
  }
  await protectDirFor(dataDir, d, sid);
}

/** A regular file at the key path that is not 32 bytes: no key (an older crash, a truncation) — never read as one, replaced. */
const notAKey = (st: FsLstat): boolean => st.isFile && !st.isSymbolicLink && st.size !== KEY_BYTES;
const hex = (d: KeyDeps, n: number): string => Buffer.from(d.random.bytes(n)).toString('hex');
/** Each step of the publish loop either returns, publishes, or moves one non-key aside; a few steps settle any two-creator race. */
const PUBLISH_STEPS = 8;
const TEMP_TRIES = 8;

/** 32 fresh bytes under <dataDir>/ipc.key.<16 hex>.tmp: mkdirp(dataDir, 0o700), an exclusive create with mode 0o600 (open 'wx', one write,
 *  fsync — POSIX: the mode is set by the open itself, before any byte, and the umask can only narrow it), and on win32 `icacls
 *  /inheritance:r /grant:r *<SID>:F` on the temp file (sid: the start's one whoami), so the key name is born user-only when the link publishes
 *  it. A temp name that exists (a crash leftover) draws another. A failure after the create removes the temp file. */
async function writeTempKey(dataDir: string, d: KeyDeps, sid: string | null): Promise<string> {
  await d.fs.mkdirp(dataDir, 0o700);
  const bytes = Buffer.from(d.random.bytes(KEY_BYTES));
  const P = pathOf(d.platform);
  for (let i = 0; ; i++) {
    const tmp = P.join(dataDir, `${KEY_FILE}.${hex(d, 8)}.tmp`);
    try {
      await d.fs.writeFileExclusive(tmp, bytes, 0o600);
    } catch (e) {
      if (errnoCode(e) === 'EEXIST' && i + 1 < TEMP_TRIES) continue;
      throw e;
    }
    try {
      if (d.platform === 'win32') await d.acl.restrictToUser(tmp, sid ?? await d.acl.currentUserSid());
    } catch (e) {
      await d.fs.unlink(tmp).catch(() => {});
      throw e;
    }
    return tmp;
  }
}

/** Moves the non-key at keyPath aside (one atomic rename to a fresh name) and deletes it. When what was moved turns out to be a key (one a
 *  concurrent creator published after our lstat), it is put back by link — EEXIST then means yet another creator published meanwhile, and the
 *  key ipc.key now holds wins (the daemon's 30 s same-hash check, SEC-23, catches a caller that kept the moved one). */
async function setAside(keyPath: string, d: KeyDeps): Promise<void> {
  const aside = `${keyPath}.${hex(d, 8)}.short`;
  try {
    await d.fs.rename(keyPath, aside);
  } catch (e) {
    if (missing(e)) return;
    throw e;
  }
  const moved = await d.fs.lstat(aside);
  if (moved !== null && moved.isFile && !moved.isSymbolicLink && moved.size === KEY_BYTES) {
    try {
      await d.fs.link(aside, keyPath);
    } catch (e) {
      if (errnoCode(e) !== 'EEXIST') throw e;
    }
  }
  await d.fs.unlink(aside).catch(() => {});
}

/**
 * The key of <dataDir>: an existing one is read (and verified), never replaced — one whose check refuses (a symlink or a non-file at the key
 * path included) throws IpcKeyRefused. Without one, the key is created so that <dataDir>/ipc.key never exists without its 32 bytes: they are
 * written and fsynced under a temp name (writeTempKey; win32: restricted to the user first), then published by fs.link(tmp, ipc.key), which
 * fails EEXIST when a file is there; the temp name is removed after. A creator that loses the race reads and verifies the winner's key. A
 * regular file at ipc.key that is not 32 bytes (an older crash: fe797f1 created ipc.key itself before writing it) is no key and is never
 * trusted: it is moved aside (setAside) and replaced the same way. Every path ends in readIpcKey on ipc.key with stamp 'write': the returned key
 * is the one ipc.key holds and verifies. P5SEC (#34, #35): on win32 the start reads the user's SID once, makes the data directory user-only
 * first (protectDataDir; it throws IpcKeyRefused when it cannot, deleting any stamp there), and its final read writes the stamp a hook accepts —
 * or, refusing, deletes any stamp there (a forged one included). Called by Plan 7's start (X5-28) and by setupLiveRepo.
 */
export async function createIpcKey(dataDir: string, d: KeyDeps): Promise<Buffer> {
  const keyPath = pathOf(d.platform).join(dataDir, KEY_FILE);
  let sid: string | null = null;
  if (d.platform === 'win32') {
    try {
      sid = await d.acl.currentUserSid();
    } catch {
      throw new IpcKeyRefused();
    }
    await protectDirFor(dataDir, d, sid);
  }
  let tmp: string | null = null;
  try {
    for (let step = 0; step < PUBLISH_STEPS; step++) {
      const st = await d.fs.lstat(keyPath);
      if (st !== null && !notAKey(st)) {
        const r = await readKey(dataDir, d, 'write', sid, undefined);
        if (r.ok) return r.key;
        if (r.code !== null) throw new IpcKeyRefused();
        continue;   // it vanished or changed between the two lstats: look again
      }
      tmp ??= await writeTempKey(dataDir, d, sid);
      if (st !== null) {
        await setAside(keyPath, d);
        continue;
      }
      try {
        await d.fs.link(tmp, keyPath);
      } catch (e) {
        if (errnoCode(e) !== 'EEXIST') throw e;
        continue;   // a concurrent creator published first: read its key
      }
      const published = tmp;
      tmp = null;
      await d.fs.unlink(published).catch(() => {});
    }
    throw new Error('createIpcKey: ipc.key kept changing');
  } finally {
    if (tmp !== null) await d.fs.unlink(tmp).catch(() => {});
  }
}

/** SEC-23 "exists with the same hash" (the daemon's 30 s check, Task 9): the hex SHA-256 of the key bytes. */
export function keyHash(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex');
}
