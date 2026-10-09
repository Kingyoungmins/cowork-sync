// FaultFs: the SIM binding of the Fs port (11-testing §3.2). Wraps another Fs
// (normally realFs) and fails selected calls with errors built exactly like
// Node's own fs errors, so production code cannot tell them apart.
// hits: key `${op}:${code}:${pathIncludes}`, one counter per rule (header Interfaces).
// Also emulates Windows lock holders (holdLock), a volume without hard links (setNoHardLinks),
// race hooks (interpose) and records every call (calls). 11-testing §3.2 Fs row.
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

  /** Runs fn(path) before the inner op on a matching path, at most `times` times (default 1). */
  interpose(op: FaultOp, pathIncludes: string, fn: (p: string) => Promise<void>, times = 1): void {
    if (!(times > 0)) throw new RangeError(`FaultFs: times must be > 0 (got ${times})`);
    this.interposers.push({ op, pathIncludes, fn, left: times });
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

    for (const lock of this.locks) {
      if (!this.matches(lock.pathIncludes, p, dest)) continue;
      if (lock.mode === 'share-none' && (op === 'readFile' || op === 'rename' || op === 'unlink' || op === 'link')) {
        this.fail('EBUSY', op, p, dest);
      }
      if (lock.mode === 'share-read' && (op === 'rename' || op === 'unlink')) {
        this.fail('EPERM', op, p, dest);
      }
    }

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
    return this.inner.readFile(p);
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
    return this.inner.lstat(p);
  }

  async writeFileExclusive(p: string, data: Buffer): Promise<void> {
    await this.pre('writeFileExclusive', p);
    return this.inner.writeFileExclusive(p, data);
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
    return this.inner.stat(p);
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
