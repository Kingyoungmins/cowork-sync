// The memory readings of T-VIZ-perf (Plan 8a final review B2; 12 §3.12 row 1, VIZ-41): a real child started with the GC observer
// (test/fixtures/viz/gcObserver.mjs: --expose-gc, --import and an IPC channel; test-only, the shipped viewerArgv is unchanged) answers
// memoryAfterGc with its process.memoryUsage() right after forced major GCs (two plain ones, then a memory-reducing one); osMemoryOf
// reads what the OS says about the same
// process (Linux: /proc/<pid>/status VmRSS, VmHWM, RssAnon, RssFile, RssShmem, and on request smapsFields of /proc/<pid>/smaps;
// Windows: WorkingSet64, PrivateMemorySize64 and PeakWorkingSet64), so a hosted run reports why its RSS is what it is.
import { spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const GC_OBSERVER = fileURLToPath(new URL('../fixtures/viz/gcObserver.mjs', import.meta.url));
/** The node flags that load the observer, put before the viewer's own argv (whose first entry is its --max-old-space-size). */
export const GC_OBSERVER_FLAGS: readonly string[] = Object.freeze(['--expose-gc', '--import', pathToFileURL(GC_OBSERVER).href]);
const MB = 1024 * 1024;

/** The observer's answer to 'gc': process.memoryUsage() after two plain major GCs, then after one memory-reducing major GC. */
export interface GcMemory { major: NodeJS.MemoryUsage; reduced: NodeJS.MemoryUsage; }

/**
 * The child's memory after forced major GCs (the observer's answer to 'gc', see GcMemory); rejects after `ms`. `reduced` is the
 * settled reading: a plain gc() frees the garbage but keeps the heap pages V8 committed for it (Node 24 on Windows, T-VIZ-perf's
 * real viewer: heapUsed 37 MB, heapTotal 170 MB, RSS 250 MB), which only a memory-reducing GC gives back.
 */
export function memoryAfterGc(child: ChildProcess, ms = 60_000): Promise<GcMemory> {
  return new Promise((resolve, reject) => {
    if (typeof child.send !== 'function' || !child.connected) {
      reject(new Error('the child has no IPC channel (start it with the GC observer)'));
      return;
    }
    const onMessage = (m: unknown): void => {
      const a = m as Partial<GcMemory> | null;
      if (a?.major === undefined || a.reduced === undefined) return;
      clearTimeout(timer);
      child.off('message', onMessage);
      resolve({ major: a.major, reduced: a.reduced });
    };
    const timer = setTimeout(() => {
      child.off('message', onMessage);
      reject(new Error(`no answer from the GC observer within ${ms} ms`));
    }, ms);
    child.on('message', onMessage);
    child.send('gc');
  });
}

/** What the OS reports for a running process: `rss` (Linux VmRSS, Windows WorkingSet64) and every field read, in bytes. */
export interface OsMemory { rss: number; fields: Readonly<Record<string, number>>; }

/**
 * What holds a Linux process's anonymous RSS, from the text of /proc/<pid>/smaps (viz-hosted-perf; report-only, beside 12 §3.12's
 * own OS fields), in bytes: `HeapRss`, the Rss of the `[heap]` mapping (glibc's main arena: native memory freed but kept by the
 * allocator stays here); `AnonMapRss`, the Rss of the anonymous mappings without a name (V8's heap pages, other threads' malloc
 * arenas, mmapped blocks); `LazyFree`, pages freed with MADV_FREE that RSS counts until the kernel needs them; `AnonHugePages`.
 */
export function smapsFields(smaps: string): Record<'HeapRss' | 'AnonMapRss' | 'LazyFree' | 'AnonHugePages', number> {
  const out = { HeapRss: 0, AnonMapRss: 0, LazyFree: 0, AnonHugePages: 0 };
  let name: string | null = null;
  for (const line of smaps.split('\n')) {
    const head = /^[0-9a-f]+-[0-9a-f]+\s+\S+\s+\S+\s+\S+\s+\d+\s*(.*)$/.exec(line);
    if (head !== null) {
      name = head[1]!.trim();
      continue;
    }
    const f = /^(\w+):\s+(\d+) kB$/.exec(line);
    if (f === null || name === null) continue;
    const kb = Number(f[2]) * 1024;
    if (f[1] === 'Rss' && name === '[heap]') out.HeapRss += kb;
    else if (f[1] === 'Rss' && name === '') out.AnonMapRss += kb;
    else if (f[1] === 'LazyFree') out.LazyFree += kb;
    else if (f[1] === 'AnonHugePages') out.AnonHugePages += kb;
  }
  return out;
}

/**
 * smapsFields of /proc/<pid>/smaps, or no field when it cannot be read (ptrace or hidepid limits, a process that just exited):
 * report-only, so an unreadable smaps never costs T-VIZ-perf its settled reading (read before and after the GCs) or its gate.
 */
export function smapsOf(pid: number, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): Partial<ReturnType<typeof smapsFields>> {
  let text: string;
  try {
    text = read(`/proc/${pid}/smaps`);
  } catch {
    return {};
  }
  return smapsFields(text);
}

/**
 * The OS view of `pid`'s memory (see the file header); throws when /proc/<pid>/status or Get-Process cannot be read. With `maps`
 * on linux, smapsOf its /proc/<pid>/smaps too (a larger read: for the settled readings, not for the folding samples; none when
 * unreadable).
 */
export function osMemoryOf(pid: number, o: { maps?: boolean } = {}): OsMemory {
  if (process.platform === 'linux') {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const fields: Record<string, number> = {};
    for (const k of ['VmRSS', 'VmHWM', 'RssAnon', 'RssFile', 'RssShmem']) {
      const m = new RegExp(`^${k}:\\s+(\\d+) kB$`, 'm').exec(status);
      if (m !== null) fields[k] = Number(m[1]) * 1024;
    }
    if (fields['VmRSS'] === undefined) throw new Error(`no VmRSS in /proc/${pid}/status`);
    if (o.maps === true) Object.assign(fields, smapsOf(pid));
    return { rss: fields['VmRSS'], fields };
  }
  if (process.platform === 'win32') {
    const root = process.env['SystemRoot'] ?? 'C:\\Windows';
    const ps = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const command = `$p = Get-Process -Id ${pid}; "$($p.WorkingSet64) $($p.PrivateMemorySize64) $($p.PeakWorkingSet64)"`;
    const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    const n = (r.stdout ?? '').trim().split(/\s+/).map(Number);
    if (n.length !== 3 || !n.every((x) => Number.isSafeInteger(x) && x > 0)) throw new Error(`Get-Process ${pid}: ${r.stdout} ${r.stderr}`);
    const [WorkingSet64, PrivateMemorySize64, PeakWorkingSet64] = n as [number, number, number];
    return { rss: WorkingSet64, fields: { WorkingSet64, PrivateMemorySize64, PeakWorkingSet64 } };
  }
  throw new Error(`no OS memory reading on ${process.platform}`);
}

/** "name 12.3 MB, …" for a diagnostic line. */
export function mbList(o: Readonly<Record<string, number>>): string {
  return Object.entries(o).map(([k, v]) => `${k} ${(v / MB).toFixed(1)} MB`).join(', ');
}
