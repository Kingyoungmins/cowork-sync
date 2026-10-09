// The viewer's own log (12-visualizer §3.10.10; VIZ-38; R-V40): <dir>/viz-<instance>-<n>.jsonl, append-only, rotated 10 MB × 5 by the
// process that owns <instance> only (a rename touches only this instance's files, so concurrent viewers never rename each other's,
// glossary §26.1 W3); while another process blocks a rotation, -1 grows to at most 2 × 10 MB and later lines are dropped and counted
// (R-V67). A line holds only a local monotonic time, a registry code and values that cannot carry a path or a message:
// numbers, booleans, null, registry codes, opaque room ids, errno codes and {fn, line, col} stack frames with basenames. Anything
// else throws, so a URL, header value, token, name, path or err.message cannot reach a line by construction. Every line passes
// sanitize(…, 'log'); scanSecrets(kind: 'log') is Plan 8b's.
import path from 'node:path';
import type { Clock } from '../../ports/clock.js';
import type { Fs } from '../../ports/fs.js';
import { sanitize } from '../../text/sanitize.js';
import { ALL_VIZ_CODES, REASON_CODES } from '../i18n/codes.js';
import { clockTimer, type ClockTimer } from './clockTimer.js';

/** Strings only: registry codes, room ids, errno codes (^E[A-Z0-9]{2,15}$); anything else throws. */
export type VizLogParam = number | boolean | null | string;
export type SecVizCode = 'SEC_VIZ_BAD_HOST' | 'SEC_VIZ_BAD_ORIGIN' | 'SEC_VIZ_BAD_TOKEN' | 'SEC_VIZ_LAUNCH_REUSED' | 'SEC_VIZ_LAUNCH_EXPIRED' | 'SEC_VIZ_METHOD' | 'SEC_VIZ_LIMIT';

export interface VizLog {
  write(code: string, params?: Readonly<Record<string, VizLogParam>>): void;
  /** One line per code per 60 s with a count; SEC_VIZ_LAUNCH_REUSED at once. */
  security(code: SecVizCode): void;
  /** err.code and stack frames only, never err.message or err.stack text. */
  error(code: string, err: unknown): void;
  /** Closes every open security window (writing its line) and waits for every queued line (the exit path). */
  flush(): Promise<void>;
}

export const LOG_ROTATE_BYTES = 10_000_000, LOG_FILES = 5, LOG_KEEP_MS = 1_209_600_000, SEC_WINDOW_MS = 60_000;

const INSTANCE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const ROOM_ID_RE = /^r[0-9A-HJKMNP-TV-Z]{8}$/;
const ERRNO_RE = /^E[A-Z0-9]{2,15}$/;
/** The `code` of an error logged by error(): an errno, a Node internal error code (ERR_HTTP_HEADERS_SENT, ERR_OUT_OF_RANGE) or an
 *  llhttp parse error (HPE_INVALID_METHOD) — fixed identifiers, never text. */
const ERROR_CODE_RE = /^(E[A-Z0-9]{2,15}|ERR_[A-Z0-9_]{1,60}|HPE_[A-Z0-9_]{1,40})$/;
const KEY_RE = /^[a-z][A-Za-z0-9_]{0,31}$/;
const RESERVED_KEYS: ReadonlySet<string> = new Set(['t', 'code']);
const LOG_FILE_RE = /^viz-.*\.jsonl$/;
const MAX_FRAMES = 20;
const FN_MAX = 128;
/** The marker the log itself writes as the first line once a blocked rotation resumes: {t, code: VIZ_LOG_DROPPED, n} with the number of
 *  dropped lines (R-V67; in the registry ahead of the spec text, spec-edit list 12 §3.10.10 and §3.11). Only the log writes it: a
 *  caller's write() of it throws, so no caller can forge a drop count. */
const DROPPED_CODE = 'VIZ_LOG_DROPPED';

/** The viewer's message registry: every 12 §3.11 code and the closed reason codes (R-V43), i.e. the keys of EN_VIZ. */
function isRegistryCode(s: string): boolean {
  return ALL_VIZ_CODES.has(s) || REASON_CODES.has(s);
}

function refuse(what: string): never {
  // Never echo the refused value: it may be a path or a message.
  throw new TypeError(`vizLog: ${what} is not allowed in a log line`);
}

function checkCode(code: string): void {
  if (typeof code !== 'string' || !isRegistryCode(code) || code === DROPPED_CODE) refuse('the code');
}

function checkParam(key: string, v: unknown): VizLogParam {
  if (!KEY_RE.test(key) || RESERVED_KEYS.has(key)) refuse('a parameter name');
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) refuse('a non-finite number');
    return v;
  }
  if (typeof v === 'string' && (isRegistryCode(v) || ROOM_ID_RE.test(v) || ERRNO_RE.test(v))) return v;
  return refuse('a parameter value');
}

/** A checked line object: {t, code, …params}; throws on anything outside the allowlist. */
function lineOf(t: number, code: string, params: Readonly<Record<string, VizLogParam>> | undefined): Record<string, unknown> {
  checkCode(code);
  const line: Record<string, unknown> = { t, code };
  if (params !== undefined) for (const [k, v] of Object.entries(params)) line[k] = checkParam(k, v);
  return line;
}

function errorCodeOf(err: unknown): string | null {
  const c = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof c === 'string' && ERROR_CODE_RE.test(c) ? c : null;
}

const FRAME_RE = /^\s*at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?$/;
const FN_UNSAFE = /[^\p{L}\p{N}_$.<>[\] ]/gu;
const BASENAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function basename(file: string): string {
  const b = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
  return BASENAME_RE.test(b) ? b : '?';
}

/** At most 20 frames, file reduced to its basename (`fn` is "<function> (<basename>)"). Only the part of err.stack after the
 *  `name: message` header is parsed, so a message that imitates frames is never read; a stack whose header is not the error's
 *  own (a message changed after capture, a non-Error) gives no frames. */
export function stackFrames(err: unknown): Array<{ fn: string; line: number; col: number }> {
  if (!(err instanceof Error) || typeof err.stack !== 'string') return [];
  const header = Error.prototype.toString.call(err);
  if (!err.stack.startsWith(header) || (err.stack.length > header.length && err.stack[header.length] !== '\n')) return [];
  const out: Array<{ fn: string; line: number; col: number }> = [];
  for (const text of err.stack.slice(header.length).split('\n')) {
    if (out.length === MAX_FRAMES) break;
    const m = FRAME_RE.exec(text);
    if (m === null) continue;
    const name = (m[1] ?? '').replace(FN_UNSAFE, '?').slice(0, FN_MAX);
    const fn = name === '' ? `(${basename(m[2] ?? '')})` : `${name} (${basename(m[2] ?? '')})`;
    out.push({ fn, line: Number(m[3]), col: Number(m[4]) });
  }
  return out;
}

/** One log line as written: JSON through sanitize(…, 'log'), LF. */
function lineBytes(line: Record<string, unknown>): Buffer {
  return Buffer.from(`${sanitize(JSON.stringify(line), 'log')}\n`, 'utf8');
}

function fileName(instance: string, n: number): string {
  return `viz-${instance}-${n}.jsonl`;
}

function hasCode(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === code;
}

/** Security aggregation (12 §3.10.10): the first occurrence of a code opens a 60 s window (its monotonic start); the window's one
 *  line {t: start, code, count} is written when it closes — by its timer on the injected Clock (60 s of Δmono, clockTimer.ts), by the
 *  first occurrence after SEC_WINDOW_MS (which opens the next window), or by flush() on exit. SEC_VIZ_LAUNCH_REUSED is written at
 *  once: the viewer exits right after it. */
interface SecWindow { start: number; count: number; timer: ClockTimer; }

/** The name a rotation moves -1 to before it touches any archive: n = 0, inside this instance's viz-<instance>-<n>.jsonl names, so
 *  the 14-day cleanup also covers one that a crash left behind. */
const STAGED = 0;
/** The renames that complete a rotation once -1 is staged, in order: -4→-5 (replacing the old -5, the one file a rotation drops),
 *  -3→-4, -2→-3, then the staged file → -2. Each step's target was emptied by the step before, so a shift that stopped at a failed step
 *  and resumes there later deletes nothing more. */
const SHIFT: ReadonlyArray<readonly [number, number]> = [
  ...Array.from({ length: LOG_FILES - 2 }, (_, i): [number, number] => [LOG_FILES - 1 - i, LOG_FILES - i]),
  [STAGED, 2],
];
/** R-V67 (spec-edit list 12 §3.10.10): while a rotation or a shift is blocked, -1 grows to at most this; past it, lines are dropped and
 *  counted until a rotation empties -1 again. With the staged file that keeps an instance at six files and 2 × 10 MB in -1. */
const LOG_HOLD_BYTES = 2 * LOG_ROTATE_BYTES;

class FileVizLog implements VizLog {
  private readonly sec = new Map<SecVizCode, SecWindow>();
  private queue: Promise<void> = Promise.resolve();
  /** The next SHIFT step of a rotation that stopped at a failed rename; null when no rotation is pending. */
  private shiftAt: number | null = null;
  /** Lines dropped since -1 reached LOG_HOLD_BYTES (R-V67); written as one VIZ_LOG_DROPPED marker once the rotation resumes. */
  private dropped = 0;

  constructor(private readonly fs: Fs, private readonly clock: Clock, private readonly dir: string, private readonly instance: string,
              private size: number) {}

  write(code: string, params?: Readonly<Record<string, VizLogParam>>): void {
    this.enqueue(lineOf(this.now(), code, params));
  }

  security(code: SecVizCode): void {
    const now = this.now();
    if (code === 'SEC_VIZ_LAUNCH_REUSED') {
      this.enqueue({ ...lineOf(now, code, undefined), count: 1 });
      return;
    }
    const open = this.sec.get(code);
    if (open !== undefined && now - open.start < SEC_WINDOW_MS) {
      open.count += 1;
      return;
    }
    if (open !== undefined) this.closeWindow(code, open);
    const w: SecWindow = { start: now, count: 1, timer: clockTimer(this.clock, SEC_WINDOW_MS, () => this.closeWindow(code, w)) };
    this.sec.set(code, w);
  }

  error(code: string, err: unknown): void {
    this.enqueue({ ...lineOf(this.now(), code, undefined), err: errorCodeOf(err), frames: stackFrames(err) });
  }

  async flush(): Promise<void> {
    for (const [code, w] of [...this.sec]) this.closeWindow(code, w);
    await this.queue;
  }

  /** Writes a window's one line and forgets it; a window already closed (a stale timer) writes nothing. */
  private closeWindow(code: SecVizCode, w: SecWindow): void {
    if (this.sec.get(code) !== w) return;
    w.timer.cancel();
    this.sec.delete(code);
    this.enqueue({ ...lineOf(w.start, code, undefined), count: w.count });
  }

  private now(): number {
    return Math.round(this.clock.monoMs());
  }

  private enqueue(line: Record<string, unknown>): void {
    const bytes = lineBytes(line);
    // A failed append must not stop the viewer, and the log cannot log its own failure: that line is dropped. A blocked rotation
    // drops a line only once -1 holds LOG_HOLD_BYTES (append below).
    this.queue = this.queue.then(() => this.append(bytes)).catch(() => undefined);
  }

  private file(n: number): string {
    return path.join(this.dir, fileName(this.instance, n));
  }

  /** A pending shift resumes first; a line that would pass 10 MB rotates first. Whatever the rotation's outcome, the line is appended
   *  to -1 — past 10 MB while the rotation or the shift is blocked, and the next line past the limit retries — up to LOG_HOLD_BYTES
   *  (R-V67). Past that, lines are dropped and counted until a rotation empties -1; the first line written then is preceded, in the
   *  same append, by one VIZ_LOG_DROPPED{n} marker. */
  private async append(bytes: Buffer): Promise<void> {
    if (this.shiftAt !== null) await this.shift();
    if (this.shiftAt === null && this.size > 0 && this.size + bytes.length > LOG_ROTATE_BYTES) await this.rotate();
    const out = this.dropped > 0 ? Buffer.concat([lineBytes({ t: this.now(), code: DROPPED_CODE, n: this.dropped }), bytes]) : bytes;
    if ((this.dropped > 0 && this.size > LOG_ROTATE_BYTES) || this.size + out.length > LOG_HOLD_BYTES) {
      this.dropped += 1;
      return;
    }
    await this.fs.appendFile(this.file(1), out);
    this.size += out.length;
    this.dropped = 0;
  }

  /** -1 is first renamed to the staging name; only then are the archives shifted (SHIFT), so a -1 held by another process (the
   *  rename fails: on Windows a rename of a file another process holds open fails, W3) skips the rotation with no archive renamed or
   *  deleted. Only this instance's files are named. */
  private async rotate(): Promise<void> {
    try {
      await this.fs.rename(this.file(1), this.file(STAGED));
    } catch (e) {
      if (hasCode(e, 'ENOENT')) this.size = 0;   // -1 is gone: the next append starts a new one
      return;
    }
    this.size = 0;
    this.shiftAt = 0;
    await this.shift();
  }

  /** Runs the pending SHIFT from its next step; a rename that fails (other than ENOENT: nothing to move) stops it at that step. */
  private async shift(): Promise<void> {
    while (this.shiftAt !== null && this.shiftAt < SHIFT.length) {
      const [from, to] = SHIFT[this.shiftAt] as readonly [number, number];
      try {
        await this.fs.rename(this.file(from), this.file(to));
      } catch (e) {
        if (!hasCode(e, 'ENOENT')) return;
      }
      this.shiftAt += 1;
    }
    this.shiftAt = null;
  }
}

/** <dir>/viz-<instance>-<n>.jsonl, append-only; rotation renames only this instance's files; every line {"t": monoMs, "code", …}
 *  through sanitize(…, 'log'). Creates <dir> user-only (0700) when absent. */
export async function openVizLog(o: { fs: Fs; clock: Clock; dir: string; instance: string }): Promise<VizLog> {
  if (!INSTANCE_RE.test(o.instance)) refuse('the instance id');
  await o.fs.mkdirp(o.dir, 0o700);
  const current = await o.fs.lstat(path.join(o.dir, fileName(o.instance, 1)));
  return new FileVizLog(o.fs, o.clock, o.dir, o.instance, current?.isFile === true ? current.size : 0);
}

/** Deletes the viz-*.jsonl regular files of <dir> whose mtime is older than 14 days (start of every viewer); returns how many. A
 *  missing directory, an entry whose lstat fails, or a file that cannot be deleted (held by another process) is skipped. */
export async function cleanupVizLogs(fs: Fs, clock: Clock, dir: string): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if (hasCode(e, 'ENOENT') || hasCode(e, 'ENOTDIR')) return 0;
    throw e;
  }
  let deleted = 0;
  for (const name of names) {
    if (!LOG_FILE_RE.test(name)) continue;
    const file = path.join(dir, name);
    let st: Awaited<ReturnType<Fs['lstat']>>;
    try {
      st = await fs.lstat(file);
    } catch {
      continue;   // EACCES/EPERM on this entry: the others are still cleaned
    }
    if (st === null || !st.isFile) continue;
    if (clock.wallMs() - Number(st.mtimeNs / 1_000_000n) <= LOG_KEEP_MS) continue;
    try {
      await fs.unlink(file);
      deleted += 1;
    } catch {
      // EPERM/EBUSY (a file held open elsewhere) or a concurrent delete: kept for the next start.
    }
  }
  return deleted;
}

/** Writes nothing, but refuses exactly what a file log refuses, so a caller tested against it cannot log a path. */
export const nullVizLog: VizLog = Object.freeze({
  write(code: string, params?: Readonly<Record<string, VizLogParam>>): void { lineOf(0, code, params); },
  security(): void {},
  error(code: string): void { checkCode(code); },
  flush: async (): Promise<void> => {},
});
