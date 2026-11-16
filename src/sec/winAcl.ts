// src/sec/winAcl.ts — SEC-20, R5-48, A3-4: the one SEC process runner (L-PORTS allow-listed, A1-9). Four fixed argv (P5SEC #34 added the data
// directory's protectDir), shell: false, windowsHide, no user input in any argv element except the key, stamp or data directory path given to
// icacls; PowerShell gets the path only through its environment (COWORK_ACL_PATH), never inside a command string. SIDs are compared, never
// localized account names. X-62: no SDDL parser here — the SDDL reading and the user-only verdict are src/sec/sddl.ts's (readIpcKey applies
// them). Spawns no git (L-GIT-SPAWN). Every call takes an optional time bound (P5SEC #35: a hook's full check runs within its deadline).
import { execFile } from 'node:child_process';
import { join } from 'node:path';

/** A caller's time bound for one runner call: the program is killed after min(timeoutMs, 10 s); none starts when timeoutMs ≤ 0. */
export interface RunBound { timeoutMs?: number; }

export interface WinAcl {
  /** The process token's user SID, from `whoami /user /fo csv /nh`. */
  currentUserSid(o?: RunBound): Promise<string>;
  /** `icacls <file> /inheritance:r /grant:r *<SID>:F`: the file's DACL becomes exactly one full-control ACE for sid, nothing inherited. */
  restrictToUser(file: string, sid: string, o?: RunBound): Promise<void>;
  /** P5SEC #34, 8a's ownerProbe form: `icacls <dir> /inheritance:r /grant:r *<SID>:(OI)(CI)F *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F /L` —
   *  the directory's DACL becomes protected and user-only (the user, SYSTEM, Administrators, inherited by what is created inside); /L acts on
   *  the path itself, never through a link or junction put there. */
  protectDir(dir: string, sid: string, o?: RunBound): Promise<void>;
  /** `(Get-Acl -LiteralPath $env:COWORK_ACL_PATH).Sddl` with COWORK_ACL_PATH=<file>, trimmed. */
  readSddl(file: string, o?: RunBound): Promise<string>;
}

/** A program of the three exited with a non-zero code (or could not run: -1). Carries the code only: never the output, a path or a name. */
export class WinAclError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`winAcl: exit code ${code}`);
    this.name = 'WinAclError';
    this.code = code;
  }
}

export type WinAclRun = (file: string, args: readonly string[], env: Readonly<Record<string, string>>, o?: RunBound) => Promise<{ code: number; stdout: Buffer }>;

const SID_RE = /^S-1-[0-9]+(?:-[0-9]+)+$/;
/** The SID field at the end of `"<domain>\<name>","<SID>"`: the name is never decoded (a ko-KR console writes it in cp949). */
const WHOAMI_SID_RE = /"(S-1-[0-9]+(?:-[0-9]+)+)"\s*$/;
const WHOAMI_ARGV: readonly string[] = ['/user', '/fo', 'csv', '/nh'];
const GET_ACL_ARGV: readonly string[] = ['-NoProfile', '-NonInteractive', '-Command', '(Get-Acl -LiteralPath $env:COWORK_ACL_PATH).Sddl'];

export function createWinAcl(run: WinAclRun): WinAcl {
  const ok = async (file: string, args: readonly string[], env: Readonly<Record<string, string>>, o?: RunBound): Promise<Buffer> => {
    const r = await (o?.timeoutMs === undefined ? run(file, args, env) : run(file, args, env, { timeoutMs: o.timeoutMs }));
    if (r.code !== 0) throw new WinAclError(r.code);
    return r.stdout;
  };
  return {
    async currentUserSid(o?: RunBound): Promise<string> {
      const out = await ok('whoami', WHOAMI_ARGV, {}, o);
      const m = WHOAMI_SID_RE.exec(out.toString('latin1'));
      if (m === null) throw new Error('winAcl: whoami printed no SID');
      return m[1] as string;
    },
    async restrictToUser(file: string, sid: string, o?: RunBound): Promise<void> {
      if (!SID_RE.test(sid)) throw new TypeError('winAcl: restrictToUser needs a SID');
      await ok('icacls', [file, '/inheritance:r', '/grant:r', `*${sid}:F`], {}, o);
    },
    async protectDir(dir: string, sid: string, o?: RunBound): Promise<void> {
      if (!SID_RE.test(sid)) throw new TypeError('winAcl: protectDir needs a SID');
      await ok('icacls', [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/L'], {}, o);
    },
    async readSddl(file: string, o?: RunBound): Promise<string> {
      const out = await ok('powershell.exe', GET_ACL_ARGV, { COWORK_ACL_PATH: file }, o);
      return out.toString('utf8').trim();
    },
  };
}

/** The three programs by their System32 paths, so a `whoami` earlier on PATH (Git for Windows ships GNU coreutils' whoami) is never run. */
const SYSTEM32: Readonly<Record<string, readonly string[]>> = {
  whoami: ['System32', 'whoami.exe'],
  icacls: ['System32', 'icacls.exe'],
  'powershell.exe': ['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'],
};
const RUN_TIMEOUT_MS = 10_000;

/** The execFile timeout for a call bounded by o: min(o.timeoutMs, 10 s) rounded up; null when the bound is already spent (nothing starts). */
function runTimeout(o?: RunBound): number | null {
  const ms = o?.timeoutMs;
  if (ms === undefined) return RUN_TIMEOUT_MS;
  if (!(ms > 0)) return null;
  return Math.min(RUN_TIMEOUT_MS, Math.ceil(ms));
}

/** A3-4: the file's one child_process.execFile call — shell: false, windowsHide: true, a 10 s timeout (or the caller's shorter bound, P5SEC #35),
 *  an environment of only SystemRoot, PATH and the caller's COWORK_ACL_PATH. Exit code → code; a program that could not start, was killed by the
 *  timeout or was never started because the bound was spent → -1. */
const execFileRunner: WinAclRun = (file, args, env, o) => {
  const systemRoot = process.env['SystemRoot'] ?? process.env['windir'];
  const rel = SYSTEM32[file];
  const timeout = runTimeout(o);
  if (systemRoot === undefined || rel === undefined || timeout === null) return Promise.resolve({ code: -1, stdout: Buffer.alloc(0) });
  const childEnv: Record<string, string> = { SystemRoot: systemRoot, PATH: process.env['PATH'] ?? '' };
  if (env['COWORK_ACL_PATH'] !== undefined) childEnv['COWORK_ACL_PATH'] = env['COWORK_ACL_PATH'];
  return new Promise((resolve) => {
    execFile(join(systemRoot, ...rel), [...args], { shell: false, windowsHide: true, timeout, env: childEnv, encoding: 'buffer' },
      (err, stdout) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0);
        if (err === null) resolve({ code: 0, stdout: out });
        else resolve({ code: typeof err.code === 'number' ? err.code : -1, stdout: out });
      });
  });
};

export const realWinAcl: WinAcl = createWinAcl(execFileRunner);
