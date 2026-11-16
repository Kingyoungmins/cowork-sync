// FaultFs: the SIM binding of the Fs port (11-testing §3.2). Wraps another Fs
// (normally realFs) and fails selected calls with errors built exactly like
// Node's own fs errors, so production code cannot tell them apart.
// hits: key `${op}:${code}:${pathIncludes}`, one counter per rule (header Interfaces).
// Also emulates Windows lock holders (holdLock; lockRefuses answers an oracle without a call), a volume without hard
// links (setNoHardLinks), race hooks (interpose) and records every call (calls). 11-testing §3.2 Fs row.
import { join, sep } from 'node:path';
import { getSystemErrorMap } from 'node:util';
import type { Fs, FsLstat, FsStat } from '../../src/ports/fs.js';

export type FaultOp =
  | 'readFile'
  | 'writeFile'
  | 'rename'
  | 'link'
  | 'unlink'
  | 'lstat'
  | 'writeFileExclusive'
  | 'rmdir'
  | 'appendFile'
  | 'chmod';
export type LockMode = 'share-none' | 'share-read';

export interface FaultRule {
  op: FaultOp;
  pathIncludes: string;
  /** EXDEV: a hard link across volumes (a gitdir on another volume than the work tree; the writer's probe). */
  code: 'EACCES' | 'EPERM' | 'EBUSY' | 'ENOSPC' | 'EXDEV';
  times: number;
}

interface ActiveRule {
  rule: FaultRule;
  key: string;
  left: number;
}

type FsError = NodeJS.ErrnoException & { dest?: string };

function ruleKey(r: FaultRule): string {
  return `${r.op}:${r.code}:${r.pathIncludes}`;
}

function syscallFor(op: FaultOp, code: string): string {
  switch (op) {
    case 'readFile':
      return 'open';
    case 'writeFile':
      return code === 'ENOSPC' ? 'write' : 'open';
    case 'rename':
      return 'rename';
    case 'link':
      return 'link';
    case 'unlink':
      return 'unlink';
    case 'lstat':
      return 'lstat';
    case 'writeFileExclusive':
    case 'appendFile':
      return 'open';
    case 'rmdir':
      return 'rmdir';
    case 'chmod':
      return 'chmod';
  }
}

// Same construction as Node's uvException: plain Error, platform libuv errno
// (negative), libuv description, then errno/code/syscall/path/dest.
function errnoError(code: string, syscall: string, p: string, dest?: string): FsError {
  let errno: number | undefined;
  let desc = '';
  for (const [n, [name, message]] of getSystemErrorMap()) {
    if (name === code) {
      errno = n;
      desc = message;
      break;
    }
  }
  if (errno === undefined) throw new Error(`FaultFs: no system error named ${code}`);
  const message =
    dest === undefined ? `${code}: ${desc}, ${syscall} '${p}'` : `${code}: ${desc}, ${syscall} '${p}' -> '${dest}'`;
  const err: FsError = new Error(message);
  err.errno = errno;
  err.code = code;
  err.syscall = syscall;
  err.path = p;
  if (dest !== undefined) err.dest = dest;
  return err;
}

interface Lock {
  pathIncludes: string;
  mode: LockMode;
}

interface Interposer {
  op: FaultOp;
  pathIncludes: string;
  fn: (p: string) => Promise<void>;
  left: number;
}

export class FaultFs implements Fs {
  readonly hits = new Map<string, number>();
  readonly calls: string[] = [];
  private readonly inner: Fs;
  private readonly rules: ActiveRule[] = [];
  private readonly locks = new Set<Lock>();
  private readonly interposers: Interposer[] = [];
  private noHardLinks = false;
  private caseRoot: string | null = null;

  constructor(inner: Fs) {
    this.inner = inner;
  }

  addRule(r: FaultRule): void {
    if (!(r.times > 0)) throw new RangeError(`FaultFs: times must be > 0 (got ${r.times})`);
    this.rules.push({ rule: { ...r }, key: ruleKey(r), left: r.times });
  }

  /** A Windows holder on every path containing pathIncludes. Returns release(). */
  holdLock(pathIncludes: string, mode: LockMode): () => void {
    const lock: Lock = { pathIncludes, mode };
    this.locks.add(lock);
    return () => {
      this.locks.delete(lock);
    };
  }

  /** F-FS-8: while on, every link() fails EPERM and creates nothing. */
  setNoHardLinks(on: boolean): void {
    this.noHardLinks = on;
  }

  /**
   * Emulates a case-folding volume (NTFS, APFS by default) on a case-sensitive one, for reads under `root` only (null: off):
   * lstat, stat and readFile of a path whose exact spelling is missing act on the entry another spelling of it names (each
   * component matched case-insensitively against the inner readdir), as the case-folding volume would; readdir keeps the stored
   * spellings. Writes are not emulated. Plan 3 Task 6 (the R3-33 case-variant guard's POSIX twin).
   */
  foldCase(root: string | null): void {
    this.caseRoot = root;
  }

  /** The path a case-folding volume would open for p: p itself, or the stored spelling of its case variant (foldCase on). */
  private async folded(p: string): Promise<string> {
    const root = this.caseRoot;
    if (root === null || !p.startsWith(root + sep)) return p;
    if ((await this.inner.lstat(p)) !== null) return p;
    let dir = root;
    for (const c of p.slice(root.length + 1).split(sep)) {
      let names: string[];
      try {
        names = await this.inner.readdir(dir);
      } catch {
        return p;
      }
      const hit = names.includes(c) ? c : names.find((n) => n.toLowerCase() === c.toLowerCase());
      if (hit === undefined) return p;
      dir = join(dir, hit);
    }
    return dir;
  }

  /** Runs fn(path) before the inner op on a matching path, at most `times` times (default 1). */
  interpose(op: FaultOp, pathIncludes: string, fn: (p: string) => Promise<void>, times = 1): void {
    if (!(times > 0)) throw new RangeError(`FaultFs: times must be > 0 (got ${times})`);
    this.interposers.push({ op, pathIncludes, fn, left: times });
  }

  /**
   * Whether a lock held now refuses `op` on `p` (pre()'s lock rule, read-only, no call recorded): the harness's own fault state, so an
   * oracle may ask it without trusting the engine under test (INV-NOLOSS's share-none window, ruling R3-EF4-9, asks it for 'readFile').
   */
  lockRefuses(op: FaultOp, p: string): boolean {
    return this.lockCode(op, p) !== null;
  }

  /** The error a held lock gives `op` on `p` (share-none: reads, renames, unlinks and links; share-read: renames and unlinks), or null. */
  private lockCode(op: FaultOp, p: string, dest?: string): 'EBUSY' | 'EPERM' | null {
    for (const lock of this.locks) {
      if (!this.matches(lock.pathIncludes, p, dest)) continue;
      if (lock.mode === 'share-none' && (op === 'readFile' || op === 'rename' || op === 'unlink' || op === 'link')) return 'EBUSY';
      if (lock.mode === 'share-read' && (op === 'rename' || op === 'unlink')) return 'EPERM';
    }
    return null;
  }

  private matches(needle: string, p: string, dest?: string): boolean {
    return p.includes(needle) || (dest !== undefined && dest.includes(needle));
  }

  // Throws before the inner call, so a faulted call has no side effect.
  private fail(code: string, op: FaultOp, p: string, dest?: string): never {
    throw errnoError(code, syscallFor(op, code), p, dest);
  }

  private async pre(op: FaultOp, p: string, dest?: string): Promise<void> {
    this.calls.push(dest === undefined ? `${op} ${p}` : `${op} ${p} -> ${dest}`);

    for (const ip of [...this.interposers]) {
      if (ip.op !== op || ip.left <= 0 || !this.matches(ip.pathIncludes, p, dest)) continue;
      ip.left -= 1;
      if (ip.left <= 0) this.interposers.splice(this.interposers.indexOf(ip), 1);
      await ip.fn(p);
    }

    if (op === 'link' && this.noHardLinks) this.fail('EPERM', op, p, dest);

    const locked = this.lockCode(op, p, dest);
    if (locked !== null) this.fail(locked, op, p, dest);

    const i = this.rules.findIndex((a) => a.rule.op === op && this.matches(a.rule.pathIncludes, p, dest));
    if (i < 0) return;
    const a = this.rules[i];
    if (a === undefined) return;
    a.left -= 1;
    if (a.left <= 0) this.rules.splice(i, 1);
    this.hits.set(a.key, (this.hits.get(a.key) ?? 0) + 1);
    this.fail(a.rule.code, op, p, dest);
  }

  async readFile(p: string): Promise<Buffer> {
    await this.pre('readFile', p);
    return this.inner.readFile(await this.folded(p));
  }

  async writeFile(p: string, data: Buffer): Promise<void> {
    await this.pre('writeFile', p);
    return this.inner.writeFile(p, data);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.pre('rename', from, to);
    return this.inner.rename(from, to);
  }

  async link(existing: string, newPath: string): Promise<void> {
    await this.pre('link', existing, newPath);
    return this.inner.link(existing, newPath);
  }

  async unlink(p: string): Promise<void> {
    await this.pre('unlink', p);
    return this.inner.unlink(p);
  }

  async lstat(p: string): Promise<FsLstat | null> {
    await this.pre('lstat', p);
    return this.inner.lstat(await this.folded(p));
  }

  async writeFileExclusive(p: string, data: Buffer, mode?: number): Promise<void> {
    await this.pre('writeFileExclusive', p);
    return this.inner.writeFileExclusive(p, data, mode);
  }

  async rmdir(p: string): Promise<void> {
    await this.pre('rmdir', p);
    return this.inner.rmdir(p);
  }

  async appendFile(p: string, data: Buffer): Promise<void> {
    await this.pre('appendFile', p);
    return this.inner.appendFile(p, data);
  }

  async chmod(p: string, mode: number): Promise<void> {
    await this.pre('chmod', p);
    return this.inner.chmod(p, mode);
  }

  async stat(p: string): Promise<FsStat | null> {
    this.calls.push(`stat ${p}`);
    return this.inner.stat(await this.folded(p));
  }

  async mkdirp(p: string, mode?: number): Promise<void> {
    this.calls.push(`mkdirp ${p}`);
    return this.inner.mkdirp(p, mode);
  }

  async readdir(p: string): Promise<string[]> {
    this.calls.push(`readdir ${p}`);
    return this.inner.readdir(p);
  }

  async rmrf(p: string): Promise<void> {
    this.calls.push(`rmrf ${p}`);
    return this.inner.rmrf(p);
  }

  async realpath(p: string): Promise<string> {
    this.calls.push(`realpath ${p}`);
    return this.inner.realpath(p);
  }

  async freeBytes(dir: string): Promise<number | null> {
    this.calls.push(`freeBytes ${dir}`);
    return this.inner.freeBytes(dir);
  }
}
