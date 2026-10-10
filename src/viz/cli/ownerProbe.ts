// The owner probe (R-V11; SEC-20): what the Fs port cannot tell, the owner uid and mode bits of a path on POSIX, and on Windows the
// SDDL of a directory (Windows PowerShell) and the current user's SID (whoami.exe), each started by its absolute path under
// <SystemRoot>\System32, without a shell, with cwd <SystemRoot>\System32 and an environment of SystemRoot (plus the directory).
// The PowerShell text is Constrained-Language safe, so the probe works on locked-down PCs (AppLocker / WDAC). The CLI also sets
// a protected user-only DACL on a data directory it has just created or repairs (icacls.exe /L, the same way; ruling 2026-10-08).
// One of the two viz files allowed node:fs (with source/boundedRead.ts) and one of the three allowed child_process (R-V34).
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { isUncOrDevice } from './paths.js';

export interface OwnerProbe {
  /** lstat of a directory or a file (a symlink is not followed); null when it cannot be read. */
  posix(path: string): Promise<{ uid: number; mode: number; isDir: boolean; isSymlink: boolean } | null>;
  euid(): number | null;
  /** <SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -Command <fixed text reading $env:COWORK_ACL_PATH>;
   *  env = { SystemRoot, COWORK_ACL_PATH: dir }; cwd <SystemRoot>\System32; 10 s timeout; returns the SDDL and the current user SID
   *  (<SystemRoot>\System32\whoami.exe /user /fo csv /nh, the same way). */
  windows(dir: string): Promise<{ sddl: string; userSid: string } | null>;
  /**
   * Windows, for a data directory the CLI has just created or repairs (dataDir.ts verifyDataDir): its inherited DACL replaced by a
   * protected user-only one, <SystemRoot>\System32\icacls.exe <dir> /inheritance:r /grant:r *<user SID>:(OI)(CI)F *S-1-5-18:(OI)(CI)F
   * *S-1-5-32-544:(OI)(CI)F /L, by absolute path without a shell; /L works on the path itself, never through a symlink or junction swapped
   * in for it (verifyDataDir also lstats the path right before and after). True when icacls exited 0. Optional: without it a created
   * directory keeps its inherited DACL and the check decides (fail closed).
   */
  protectDir?(dir: string): Promise<boolean>;
}

const RUN_TIMEOUT_MS = 10_000;
const RUN_MAX_BYTES = 64 * 1024;
const SID = 'S-1-[0-9]+(?:-[0-9]+)+';
/** whoami /user /fo csv /nh: one line `"<domain>\<name>","<SID>"` (an account name holds no '"'); the SID column. */
const WHOAMI_LINE_RE = new RegExp(`^"[^"]*","(${SID})"\\r?\\n?$`);
/**
 * The fixed PowerShell text. Constrained-Language safe: a cmdlet, a property read and Write-Output, no .NET method call. The directory is
 * read from the environment, so no path, quote or name ever reaches the PowerShell parser. The SDDL holds SIDs, never account names, so a
 * localized Windows reads the same. Each cmdlet is named with its module (Microsoft.PowerShell.Security\Get-Acl,
 * Microsoft.PowerShell.Utility\Write-Output): PowerShell then imports that module at once instead of searching the modules on its
 * PSModulePath for the command (the plain names took 6-10 s on a hosted Windows runner; on a cold cache here the qualified text takes
 * 0.4-0.5 s against 1.0-1.7 s), and a command of the same name from another module can no longer answer.
 */
export const WINDOWS_ACL_COMMAND = "$ErrorActionPreference = 'Stop'; $a = Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $env:COWORK_ACL_PATH; Microsoft.PowerShell.Utility\\Write-Output $a.Sddl";

/** SystemRoot from this process's environment (any spelling), when it is an absolute drive path. */
function systemRoot(): string | null {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'SYSTEMROOT');
  const v = key === undefined ? undefined : process.env[key];
  return v !== undefined && /^[A-Za-z]:[\\/]/.test(v) && !isUncOrDevice(v) ? v : null;
}

/** `<root>\System32\<exe>` run by that absolute path: no shell, hidden, cwd System32, env { SystemRoot, …extra }, ≤ 10 s, ≤ 64 KiB of
 *  stdout. The exit code and stdout, or null (spawn error, timeout, oversized output). */
function runSystem32(root: string, exe: readonly string[], args: readonly string[], extra: Record<string, string> = {}): Promise<{ code: number | null; out: string } | null> {
  const system32 = win32.join(root, 'System32');
  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (r: { code: number | null; out: string } | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(win32.join(system32, ...exe), [...args], {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], cwd: system32, env: { SystemRoot: root, ...extra },
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, RUN_TIMEOUT_MS);
    child.on('error', () => done(null));
    child.stdout?.on('data', (d: Buffer) => {
      size += d.length;
      if (size > RUN_MAX_BYTES) {
        child.kill();
        done(null);
        return;
      }
      chunks.push(d);
    });
    child.on('close', (code) => done({ code, out: Buffer.concat(chunks).toString('utf8') }));
  });
}

/** The current user's SID: the SID column of whoami.exe /user /fo csv /nh. */
async function userSid(root: string): Promise<string | null> {
  const r = await runSystem32(root, ['whoami.exe'], ['/user', '/fo', 'csv', '/nh']);
  if (r === null || r.code !== 0) return null;
  return WHOAMI_LINE_RE.exec(r.out)?.[1] ?? null;
}

async function windowsAcl(dir: string): Promise<{ sddl: string; userSid: string } | null> {
  const root = systemRoot();
  if (root === null) return null;
  const [sid, acl] = await Promise.all([
    userSid(root),
    runSystem32(root, ['WindowsPowerShell', 'v1.0', 'powershell.exe'], ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_ACL_COMMAND], { COWORK_ACL_PATH: dir }),
  ]);
  if (sid === null || acl === null || acl.code !== 0) return null;
  const lines = acl.out.split(/\r?\n/).filter((l) => l !== '');
  return lines.length === 1 && (lines[0] as string).trim() === lines[0] ? { sddl: lines[0] as string, userSid: sid } : null;
}

async function windowsProtect(dir: string): Promise<boolean> {
  const root = systemRoot();
  if (root === null || !/^[A-Za-z]:[\\/]/.test(dir) || isUncOrDevice(dir)) return false;
  const sid = await userSid(root);
  if (sid === null) return false;
  // /L: the operation applies to the path itself, never to the target of a symlink or junction put there since the caller's lstat.
  const r = await runSystem32(root, ['icacls.exe'], [
    dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/L',
  ]);
  return r !== null && r.code === 0;
}

export const realOwnerProbe: OwnerProbe = {
  async posix(path: string) {
    try {
      const s = await lstat(path);
      return { uid: s.uid, mode: s.mode, isDir: s.isDirectory(), isSymlink: s.isSymbolicLink() };
    } catch {
      return null;
    }
  },
  euid: () => (typeof process.geteuid === 'function' ? process.geteuid() : null),
  windows: windowsAcl,
  protectDir: windowsProtect,
};
