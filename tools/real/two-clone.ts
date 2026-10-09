// The real-remote two-clone sync test (Plan 2 Task 20; TST-16; ruling R-34; glossary §4 test ref prefix
// `refs/cowork-ci/<run_id>/…` and branch `ci/<run_id>/<b>`; 11-testing §2 REAL-HOST mode, §3.12 shape; INV-CONVERGE,
// INV-FF). Usage:
//
//   COWORK_REAL_REMOTE=<https url> npm run real:two-clone [-- --timeout-min 15 --keep]
//
// In order: without COWORK_REAL_REMOTE it prints the usage and exits 0 (no git call at all); a URL git would read as an
// option (a leading '-') or one holding a line break is refused (TEST_TARGET_REFUSED{invalid_url}, before any git call),
// and so is a URL whose userinfo holds a password (`user:secret@`; TEST_TARGET_REFUSED{password_in_url}, before any git
// call, push or write), so a password never reaches git, a clone or an engine; every git call gets the URL as given (a
// login user such as an ssh `git@` or a credential-helper username is part of it), and only its form without userinfo
// (sanitizeUrl) is printed, logged, reported or kept in a clone's config; credentials come only from
// the user's git credential helper through DAEMON_ENV — GCM_*, HOME, APPDATA… — with prompts disabled, so a missing
// credential is a refusal, never a hang; `ls-remote --symref HEAD` names the default branch, `ls-remote` reads its head
// and a fetch into a scratch repository reads its tree, and without a `.cowork-test-repo` blob there it refuses
// TEST_TARGET_REFUSED before any push (exit 1); run_id = ulid; the default branch head is pushed, create-only, to
// refs/heads/ci/<run_id>/main; that branch is cloned twice (peer A core.autocrlf=false, peer B core.autocrlf=true);
// both engines run on the real ports under testNamespace(run_id), each holding its daemon.lock; A starts (genesis with
// the host probe), then B (join); runLoop drives both in this process; three scenarios each wait for convergence and
// INV-CONVERGE's quiet period, failing at once when a loop ends or a peer reaches a state no scenario can leave; every
// board tip either peer fetched is checked to lie on one first-parent chain (fpOk); the report and the cleanup command
// are printed; both loops stop (drain); the local temp root is removed unless --keep. Ctrl+C stops the scenarios, drains
// both loops, removes the temp root unless --keep, prints the cleanup command and exits 130. After the target check
// every failure is the environment's: exit 1 with a next step. It never deletes a remote ref: cleanup is
// tools/real/cleanup.ts, a separate and explicit command.
//
// Every printed line passes through sanitizeUrl (any `scheme://userinfo@` loses the userinfo). tools/ is outside src/,
// so the src lints (L-CLOCK, L-FS-PORT, L-PUSH-ARGV) do not apply here; engine code still runs only on its ports.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemoteContentError } from '../../src/board/boardCommit.js';
import { sanitizeUrl } from '../../src/daemon/run.js';
import { liveCodeOf } from '../../src/engine/core.js';
import { humanOnlyAttribution, PLAN2_REGION_SPEC, type EngineDeps } from '../../src/engine/deps.js';
import { fpOk } from '../../src/engine/incident.js';
import { DaemonLock, Engine, runLoop, type EngineInspection, type LoopHandle } from '../../src/engine/loop.js';
import { testNamespace } from '../../src/engine/refs.js';
import { StartRefused } from '../../src/engine/restart.js';
import type { StatusJson } from '../../src/engine/status.js';
import { buildDaemonEnv } from '../../src/git/env.js';
import { fetchRefs, lsRemote, lsRemotePrefix } from '../../src/git/fetch.js';
import { checkUrl, runNetwork } from '../../src/git/netcall.js';
import { ABSENT, oid12, parseOid, type Oid } from '../../src/git/oid.js';
import { pushSpec, runPush } from '../../src/git/push.js';
import { GitCommandError, GitRepo, type RepoContext } from '../../src/git/repo.js';
import { createGitRunner, type GitRunner } from '../../src/git/runner.js';
import { machineMonoMs, realClock } from '../../src/ports/clock.js';
import { realFs } from '../../src/ports/fs.js';
import { alwaysLeased } from '../../src/ports/lease.js';
import { fileLog } from '../../src/ports/log.js';
import { randomHex, realRandom, ulid } from '../../src/ports/random.js';
import { realScheduler } from '../../src/ports/scheduler.js';
import type { Trace, TraceEvent } from '../../src/ports/trace.js';
import { userinfoKind } from '../../src/sec/redact.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { makeTempRoot } from '../../test/helpers/tmp.js';

export interface TwoCloneReport { runId: string; branch: string; scenarios: Array<{ name: string; ok: boolean; detail: string }>; converged: boolean; ffHistory: boolean; pushes: number; k4Records: number; elapsedS: number; }
export interface TwoCloneOptions {
  url: string; root: string; timeoutMs: number; log: (line: string) => void; runId?: string;
  /** The environment every git runner builds DAEMON_ENV from (default process.env); the CLI passes its own. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Ctrl+C: the scenarios stop, both loops drain and the run rejects with TwoCloneInterrupted. */
  signal?: AbortSignal;
}
export interface CliIo { out(line: string): void; err(line: string): void; }
/** Where the CLI hears Ctrl+C (process, in the real CLI). */
export interface SignalSource { on(event: 'SIGINT', listener: () => void): unknown; off(event: 'SIGINT', listener: () => void): unknown; }

/** TST-16: the file the sandbox repository's default branch must hold. */
export const TEST_MARKER = '.cowork-test-repo';
/** Where the scenarios write, in every clone. */
export const SCENARIO_DIR = 'cowork-two-clone';
const SHARED = `${SCENARIO_DIR}/shared.txt`;
const SHARED_ROWS = 30;
const POLL_MS = 1_000;
/** INV-CONVERGE's quiet period: after convergence, this many more polls see the same board tip and no push attempt. */
const QUIET_POLLS = 2;
const DEFAULT_TIMEOUT_MIN = 15;
const HARNESS_IDENTITY = { name: 'cowork two-clone', email: 'two-clone@cowork.invalid' };

export const TWO_CLONE_USAGE = [
  'usage: COWORK_REAL_REMOTE=<https url> npm run real:two-clone [-- --timeout-min 15 --keep]',
  '  Runs two clones of the sandbox repository against each other through the remote, under refs/cowork-ci/<run_id>/',
  '  and the branch ci/<run_id>/main. The default branch must hold .cowork-test-repo (else TEST_TARGET_REFUSED).',
  '  Credentials come only from your git credential helper (prompts are disabled): authenticate once with a plain git push.',
  '  A URL holding a password is refused (TEST_TARGET_REFUSED); a login user name may stay in it.',
  '  --timeout-min N  the whole run\'s deadline (default 15)   --keep  keep the local temp root',
  '  Remote refs are never deleted here; afterwards: npm run real:cleanup -- --remote <url> --run <run_id> --yes',
].join('\n');

/** A refusal with a message code (exit 1): TEST_TARGET_REFUSED{reason}, or an engine start refusal (its code and params). */
export class TwoCloneRefused extends Error {
  readonly code: string;
  readonly params: Record<string, unknown>;
  readonly next: string;
  constructor(code: string, params: Record<string, unknown>, next: string) {
    super(`${code} ${JSON.stringify(params)}`);
    this.name = 'TwoCloneRefused';
    this.code = code;
    this.params = params;
    this.next = next;
  }
}

/** A failure of the run's environment after the target check (a git or file-system error, a busy namespace): exit 1. */
export class TwoCloneFailed extends Error {
  readonly next: string;
  constructor(message: string, next: string) {
    super(message);
    this.name = 'TwoCloneFailed';
    this.next = next;
  }
}

/** The run was stopped by Ctrl+C (its signal); both loops have drained when this reaches the caller. */
export class TwoCloneInterrupted extends Error {
  constructor() {
    super('interrupted');
    this.name = 'TwoCloneInterrupted';
  }
}

/** A convergence wait that can never succeed: a loop ended, or a peer is in a state no scenario leaves on its own. */
export class ConvergeFatal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConvergeFatal';
  }
}

/** Every `scheme://…` token of a line through sanitizeUrl (userinfo dropped). */
export function sanitizeLine(line: string): string {
  return line.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>`]+/g, (u) => sanitizeUrl(u));
}

/** A git runner for the harness and the engines: DAEMON_ENV (the credential helper's variables, prompts disabled). */
export function harnessRunner(hooksPath: string, env: Readonly<Record<string, string | undefined>> = process.env): GitRunner {
  return createGitRunner({ clock: realClock, hooksPath, daemonEnv: buildDaemonEnv({ ...env }, []), testBuild: true });
}

/** `git init` of an empty scratch repository (the target check, the branch push, the cleanup's listing and deletion). */
export async function scratchRepo(dir: string, runner: GitRunner): Promise<GitRepo> {
  await mkdir(dir, { recursive: true });
  const init = await runner.run(['init', '-q', '--', dir], { class: 'local', cwd: dir });
  if (init.code !== 0) throw new Error(`git init ${dir} failed (exit ${init.code})`);
  return repoAt(dir, runner);
}

function repoAt(dir: string, runner: GitRunner): GitRepo {
  const workTree = realpathSync.native(dir);
  const ctx = (): RepoContext => ({ attrTree: null, filterDrivers: [], identity: HARNESS_IDENTITY, wallMs: () => realClock.wallMs() });
  return new GitRepo(runner, { workTree, gitDir: join(workTree, '.git'), coworkDir: join(workTree, '.git', 'cowork') }, ctx);
}

const UNREACHABLE_NEXT = 'check the URL, then authenticate once with a plain `git fetch` or `git push` to it (credentials come only from your git credential helper; prompts are disabled), and run again';
const MARKER_NEXT = `point COWORK_REAL_REMOTE at the sandbox repository: its default branch must hold ${TEST_MARKER}`;
const INVALID_URL_NEXT = 'give the sandbox repository\'s URL (https, ssh or file): a URL starting with "-" or holding a line break never reaches git';
const PASSWORD_NEXT = 'remove the password from the URL (a login user name may stay) and let your git credential helper supply it: authenticate once with a plain `git fetch` or `git push` to the URL (prompts are disabled), then run again';

/** A scheme URL's userinfo (`scheme://<userinfo>@host…`). */
const SCHEME_USERINFO = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)@/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** The userinfo of a URL, '' without one: `scheme://<userinfo>@…`, else what precedes an '@' ahead of the first '/'. */
function userinfoOf(url: string): string {
  const m = SCHEME_USERINFO.exec(url);
  if (m !== null) return m[1]!;
  if (SCHEME.test(url)) return '';
  const head = url.split('/')[0]!;
  const at = head.lastIndexOf('@');
  return at < 0 ? '' : head.slice(0, at);
}

/**
 * Whether the URL's userinfo has a password component (`user:secret@`, also `user:@` and `:secret@`). Task 17's
 * userinfoKind classifies first: 'none' and 'scp_user' (`git@host:path`) hold none; it calls every other userinfo
 * 'secret' — a login user (`https://user@host/`) as much as a password — so of those only a ':' in the userinfo is
 * a password. A login user alone is no password and reaches git (the credential helper may need it to pick an account).
 */
export function hasPassword(url: string): boolean {
  return userinfoKind(url) === 'secret' && userinfoOf(url).includes(':');
}

/** A refused URL as printed: sanitizeUrl, and no userinfo it leaves (`user:secret@host:path` is no scp form to it). */
function refusedShown(url: string): string {
  const s = sanitizeUrl(url);
  if (SCHEME.test(s)) return s;
  const head = s.split('/')[0]!;
  const at = head.lastIndexOf('@');
  return at < 0 ? s : s.slice(at + 1);
}

/**
 * Refuses, before any git call, push or write: a URL git would read as an option (a leading '-'), an empty one or one
 * holding NUL/CR/LF (TEST_TARGET_REFUSED{invalid_url}); a URL whose userinfo holds a password
 * (TEST_TARGET_REFUSED{password_in_url}: credentials come only from the git credential helper, so a password never
 * reaches git, a clone's config or an engine's state).
 */
export function refuseBadUrl(url: string): void {
  try {
    checkUrl('remote', url);
  } catch {
    throw new TwoCloneRefused('TEST_TARGET_REFUSED', { reason: 'invalid_url', remote: refusedShown(String(url)) }, INVALID_URL_NEXT);
  }
  if (hasPassword(url)) throw new TwoCloneRefused('TEST_TARGET_REFUSED', { reason: 'password_in_url', remote: refusedShown(url) }, PASSWORD_NEXT);
}

/**
 * TST-16: the remote's default branch (`ls-remote --symref HEAD`) must hold a `.cowork-test-repo` blob in its tree
 * (read from a fetch into the scratch repository); else TEST_TARGET_REFUSED{reason: invalid_url | password_in_url |
 * unreachable | no_default_branch | no_marker}. Fetches only: no push happens before this returns. `url` reaches git as given.
 */
export async function checkTestTarget(repo: GitRepo, url: string, abort?: AbortSignal): Promise<{ defaultRef: string; head: Oid }> {
  refuseBadUrl(url);
  const remote = sanitizeUrl(url);
  const refuse = (reason: string, next: string, extra: Record<string, unknown> = {}): TwoCloneRefused =>
    new TwoCloneRefused('TEST_TARGET_REFUSED', { reason, remote, ...extra }, next);
  const interrupted = (): void => {
    if (abort?.aborted === true) throw new TwoCloneInterrupted();
  };
  const sym = await runNetwork(repo, ['ls-remote', '--symref', '--', url, 'HEAD'], abort);
  interrupted();
  if (sym.code !== 0 || sym.killedByWatchdog || sym.aborted) throw refuse('unreachable', UNREACHABLE_NEXT, { exit: sym.code });
  let defaultRef: string | null = null;
  for (const raw of sym.stdout.toString('utf8').split('\n')) {
    const m = /^ref: (refs\/heads\/[^\t]+)\tHEAD\r?$/.exec(raw);
    if (m !== null) defaultRef = m[1]!;
  }
  if (defaultRef === null) throw refuse('no_default_branch', MARKER_NEXT);
  const ls = await lsRemote(repo, url, [defaultRef]);
  if (!ls.ok) throw refuse('unreachable', UNREACHABLE_NEXT);
  if (!ls.values.has(defaultRef)) throw refuse('no_default_branch', MARKER_NEXT);
  const f = await fetchRefs(repo, url, [{ remote: defaultRef, local: 'refs/cowork-remote/two-clone/default' }], abort);
  interrupted();
  const head = f.values.get(defaultRef);
  if (!f.ok || head === undefined || head === ABSENT) throw refuse('unreachable', UNREACHABLE_NEXT);
  const t = await repo.run(['ls-tree', '-z', head, '--', TEST_MARKER]);
  const entry = t.stdout.toString('utf8').split('\0').find((e) => e.endsWith(`\t${TEST_MARKER}`));
  if (entry === undefined || !/^100(644|755) blob /.test(entry)) {
    throw refuse('no_marker', MARKER_NEXT, { default_branch: defaultRef.slice('refs/heads/'.length) });
  }
  return { defaultRef, head };
}

// ---- convergence ----------------------------------------------------------------------------------------------------

/** The status fields that tell whether a peer can still converge. */
export type StopStatus = Pick<StatusJson, 'state' | 'publish_pause' | 'message_code' | 'message_params'>;

const STOPPED_STATES: ReadonlySet<string> = new Set(['down', 'refused', 'incident', 'frozen', 'paused']);
const STOPPED_PAUSES: ReadonlySet<string> = new Set(['NONRETRYABLE', 'VERSION', 'AUTH']);

/**
 * Why a peer can never converge in this run, or null while it still can: its loop ended (`loop`), or its status is
 * down, refused, incident, frozen or paused, or its publishing is paused NONRETRYABLE, VERSION or AUTH — each needs a
 * human (or a later plan's verb) to leave. OFFLINE and the degraded states recover on their own and are "not yet".
 */
export function stopReason(name: string, status: StopStatus | null, loop: { error: unknown } | null): string | null {
  if (loop !== null) return `${name}: the loop ended${loop.error === undefined ? '' : ` with ${errText(loop.error)}`}`;
  if (status === null) return null;
  const what = `${status.message_code ?? '-'} ${JSON.stringify(status.message_params)}`;
  if (STOPPED_STATES.has(status.state)) return `${name}: status ${status.state}: ${what}`;
  if (status.publish_pause !== null && STOPPED_PAUSES.has(status.publish_pause)) return `${name}: publishing paused ${status.publish_pause}: ${what}`;
  return null;
}

export interface WaitOptions { deadline: number; pollMs: number; quietPolls: number; signal?: AbortSignal }

/**
 * Polls `probe` until it reports convergence and `quietPolls` more polls then see the same board tip and push count
 * (INV-CONVERGE's quiet period: no new board tip and no push attempt; either restarts it). A string is "not yet" (its
 * reason). A thrown error is transient and retried at the next poll, except ConvergeFatal, which fails at once, and an
 * interrupt. Returns the converged value, or `timeout: <last reason>` at the deadline.
 */
export async function waitConverged<C extends { T: string; pushes: number }>(probe: () => Promise<C | string>, o: WaitOptions): Promise<C | string> {
  let last = 'not probed';
  let quiet: { c: C; n: number } | null = null;
  for (;;) {
    if (o.signal?.aborted === true) throw new TwoCloneInterrupted();
    let c: C | string;
    try {
      c = await probe();
    } catch (e) {
      if (e instanceof ConvergeFatal || e instanceof TwoCloneInterrupted) throw e;
      c = `a probe failed (retried): ${errText(e)}`;
    }
    if (typeof c === 'string') {
      quiet = null;
      last = c;
    } else if (quiet !== null && quiet.c.T === c.T && quiet.c.pushes === c.pushes) {
      quiet.n += 1;
      if (quiet.n >= o.quietPolls) return c;
      last = `converged at board ${c.T.slice(0, 12)}; quiet poll ${quiet.n} of ${o.quietPolls}`;
    } else {
      last = `${quiet === null ? 'converged' : 'the board tip or the push count moved; converged again'} at board ${c.T.slice(0, 12)}; quiet poll 0 of ${o.quietPolls}`;
      quiet = { c, n: 0 };
    }
    if (Date.now() >= o.deadline) return `timeout: ${last}`;
    await sleep(o.pollMs, o.signal);
  }
}

/**
 * The disk check, in the stored form: on a core.autocrlf=false clone the bytes on disk are the stored bytes (CRLF
 * stays CRLF, LF stays LF); on a core.autocrlf=true clone they are the stored bytes or their checkout form (every LF
 * not already after a CR written as CRLF). Absent on disk and in the tree match.
 */
export function storedFormMatches(autocrlf: boolean, disk: Buffer | null, stored: Buffer | null): boolean {
  if (disk === null || stored === null) return disk === stored;
  if (disk.equals(stored)) return true;
  return autocrlf && disk.equals(Buffer.from(stored.toString('latin1').replace(/(?<!\r)\n/g, '\r\n'), 'latin1'));
}

// ---- the run ------------------------------------------------------------------------------------------------------

interface Peer {
  name: 'A' | 'B';
  dir: string;
  autocrlf: boolean;
  repo: GitRepo;            // the harness's own GitRepo on the clone (reads only)
  tips: string[];           // every board tip this peer's fetches returned, in order
  lock: DaemonLock | null;
  engine: Engine | null;
  handle: LoopHandle | null;
  loopEnd: { error: unknown } | null;   // set when the loop's `finished` settles
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      res();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** The 30 numbered rows of shared.txt (LF, its stored form), with some rows replaced. */
function sharedText(over: Readonly<Record<number, string>> = {}): string {
  return Array.from({ length: SHARED_ROWS }, (_, i) => `${over[i + 1] ?? `row ${i + 1}`}\n`).join('');
}

function workFile(p: Peer, path: string): string {
  return join(p.dir, ...path.split('/'));
}

async function diskBytes(p: Peer, path: string): Promise<Buffer | null> {
  try {
    return await readFile(workFile(p, path));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** A human save: the file written in place, in the ending given. */
async function save(p: Peer, path: string, text: string): Promise<void> {
  await mkdir(dirname(workFile(p, path)), { recursive: true });
  await writeFile(workFile(p, path), Buffer.from(text, 'utf8'));
}

/** Rewrites one row of a working file, keeping that file's line endings (CRLF on the autocrlf=true clone). */
async function editRow(p: Peer, path: string, row: number, expect: string, next: string): Promise<void> {
  const raw = (await readFile(workFile(p, path))).toString('utf8');
  const parts = raw.split('\n');
  const cur = parts[row - 1];
  const cr = cur?.endsWith('\r') === true ? '\r' : '';
  if (cur === undefined || cur.slice(0, cur.length - cr.length) !== expect) {
    throw new Error(`${p.name}: ${path} row ${row} is ${JSON.stringify(cur)} on disk, expected ${JSON.stringify(expect)}`);
  }
  parts[row - 1] = `${next}${cr}`;
  await save(p, path, parts.join('\n'));
}

async function blobsAt(repo: GitRepo, tree: Oid, paths: readonly string[]): Promise<Map<string, Buffer | null>> {
  const map = await repo.readTreeMap(tree);
  const out = new Map<string, Buffer | null>();
  for (const p of paths) {
    const e = map.get(p);
    out.set(p, e === undefined ? null : await repo.readBlob(e.oid));
  }
  return out;
}

function k4Of(p: Peer): Array<{ path: string; s2: string | null }> {
  const out: Array<{ path: string; s2: string | null }> = [];
  for (const r of p.engine?.core.holds.all() ?? []) {
    if (!r.guards.some((g) => g.name === 'conflict')) continue;
    for (const path of r.paths) out.push({ path, s2: 's2' in r.blobs ? (r.blobs.s2[path] ?? null) : null });
  }
  return out;
}

/** The K4 record keeps the loser's bytes (R-02; INV-NOLOSS's local registry location): its LOCAL stage holds the loser's row 25. Null when it does. */
export async function k4LocalStageCheck(repo: GitRepo, loser: string, s2: string | null): Promise<string | null> {
  if (s2 === null || s2 === ABSENT) return `the K4 record on ${loser} has no LOCAL stage`;
  let kept: string;
  try {
    kept = (await repo.readBlob(parseOid(s2))).toString('utf8');
  } catch (e) {
    return `the LOCAL stage ${s2.slice(0, 12)} of the K4 record on ${loser} cannot be read: ${errText(e)}`;
  }
  return kept.includes(`row 25 edited on ${loser}`) ? null : `the LOCAL stage of the K4 record on ${loser} does not hold ${loser}'s row 25`;
}

async function fpSafe(repo: GitRepo, old: string, next: string): Promise<boolean> {
  try {
    return await fpOk(repo, parseOid(old), parseOid(next));
  } catch {
    return false;   // a missing object or a malformed oid: not shown to be on the chain
  }
}

/**
 * INV-FF as the peers saw it: per peer, every fetched board tip has the one fetched before it on its first-parent chain,
 * and the peers' last tips are on one chain too — so every tip either peer fetched lies on one first-parent chain.
 */
export async function ffHistoryOf(peers: ReadonlyArray<{ name: string; repo: GitRepo; tips: readonly string[] }>): Promise<{ ok: boolean; detail: string }> {
  const short = (t: string): string => t.slice(0, 12);
  const lasts: Array<{ name: string; repo: GitRepo; tip: string }> = [];
  let distinct = new Set<string>();
  for (const p of peers) {
    const seq = p.tips.filter((t, i) => i === 0 || p.tips[i - 1] !== t);
    if (seq.length === 0) return { ok: false, detail: `${p.name} fetched no board` };
    for (let i = 1; i < seq.length; i++) {
      if (!(await fpSafe(p.repo, seq[i - 1]!, seq[i]!))) return { ok: false, detail: `${p.name}: board ${short(seq[i]!)} does not have ${short(seq[i - 1]!)} on its first-parent chain` };
    }
    distinct = new Set([...distinct, ...seq]);
    lasts.push({ name: p.name, repo: p.repo, tip: seq[seq.length - 1]! });
  }
  for (let i = 1; i < lasts.length; i++) {
    const a = lasts[i - 1]!;
    const b = lasts[i]!;
    if (!(await fpSafe(b.repo, a.tip, b.tip)) && !(await fpSafe(a.repo, b.tip, a.tip))) {
      return { ok: false, detail: `the last boards of ${a.name} and ${b.name} are on different first-parent chains` };
    }
  }
  return { ok: true, detail: `${distinct.size} distinct board tips on one first-parent chain` };
}

interface Converged { T: Oid; pushes: number; files: Map<string, Buffer | null>; }

/**
 * One convergence probe: no loop ended and no peer is stopped (else ConvergeFatal), both LA_B equal (T),
 * A == tree(live_code(T)) on both (liveCodeOf), no open or ready change-set, no outbox, intent or pending path,
 * not_converged empty apart from `allow`, every scenario path on both disks in the stored form of tree(live_code(T))
 * (storedFormMatches), and T is the remote board tip. A reason string while not converged.
 */
async function probeConverged(peers: readonly Peer[], scratch: GitRepo, url: string, boardRef: string, paths: readonly string[], allow: ReadonlySet<string>): Promise<Converged | string> {
  for (const p of peers) {
    const why = stopReason(p.name, null, p.loopEnd);
    if (why !== null) throw new ConvergeFatal(why);
  }
  const ins: EngineInspection[] = [];
  for (const p of peers) ins.push(await p.engine!.inspect());
  for (const [k, i] of ins.entries()) {
    const why = stopReason(peers[k]!.name, i.status, null);
    if (why !== null) throw new ConvergeFatal(why);
  }
  const T = ins[0]!.laB;
  if (ins.some((i) => i.laB !== T)) return `LA_B differs (${ins.map((i, k) => `${peers[k]!.name} ${oid12(i.laB)}`).join(', ')})`;
  let tree: Oid;
  try {
    tree = (await liveCodeOf(peers[0]!.engine!.core, T)).tree;
  } catch (e) {
    if (e instanceof RemoteContentError) throw new ConvergeFatal(`LA_B ${oid12(T)} has no live code: ${errText(e)}`);
    throw e;
  }
  for (const [k, i] of ins.entries()) {
    const p = peers[k]!;
    const core = p.engine!.core;
    if (i.aTree !== tree) return `${p.name}: A is not tree(live_code(LA_B)) yet`;
    if (i.ready.length > 0 || i.status.pending.cs_open > 0) return `${p.name}: a change-set is open or ready`;
    if (core.outbox.size > 0 || core.view?.intent.kind !== 'none') return `${p.name}: a publish is pending`;
    if (Object.keys(i.pending).length > 0) return `${p.name}: pending ${Object.keys(i.pending).join(', ')}`;
    const nc = i.notConverged.filter((x) => !allow.has(x));
    if (nc.length > 0) return `${p.name}: not_converged ${nc.join(', ')}`;
  }
  const files = await blobsAt(peers[0]!.repo, tree, paths);
  for (const p of peers) {
    for (const [path, want] of files) {
      if (!storedFormMatches(p.autocrlf, await diskBytes(p, path), want)) return `${p.name}: ${path} on disk is not the stored form of tree(live_code(LA_B))`;
    }
  }
  const remote = await lsRemote(scratch, url, [boardRef]);
  if (!remote.ok) return 'the remote board tip could not be read';
  if (remote.values.get(boardRef) !== T) return 'the remote board tip moved past LA_B';
  return { T, pushes: ins.reduce((n, i) => n + i.pushAttempts, 0), files };
}

function isErrno(e: unknown): boolean {
  return e instanceof Error && typeof (e as NodeJS.ErrnoException).code === 'string' && typeof (e as NodeJS.ErrnoException).syscall === 'string';
}

export async function twoCloneRun(opts: TwoCloneOptions): Promise<TwoCloneReport> {
  const started = Date.now();
  const deadline = started + opts.timeoutMs;
  const say = (line: string): void => opts.log(sanitizeLine(line));
  // The URL as given talks to the remote; `shown` (no userinfo) is the only form printed, logged, reported or stored.
  const url = opts.url;
  refuseBadUrl(url);
  const shown = sanitizeUrl(url);
  const signal = opts.signal;
  const checkInterrupt = (): void => {
    if (signal?.aborted === true) throw new TwoCloneInterrupted();
  };
  const runId = opts.runId ?? ulid(realRandom, realClock);
  const ns = testNamespace(runId);
  const branch = `ci/${runId}/main`;
  const cleanupCmd = `npm run real:cleanup -- --remote ${shown} --run ${runId} --yes`;
  const root = resolve(opts.root);
  await mkdir(root, { recursive: true });
  const env = opts.env ?? process.env;
  const runner = harnessRunner(join(root, 'empty-hooks'), env);
  say(`two-clone: run ${runId} on ${shown}`);

  // TST-16 before any push.
  const scratch = await scratchRepo(join(root, 'probe'), runner);
  const target = await checkTestTarget(scratch, url, signal);
  say(`two-clone: ${target.defaultRef} at ${oid12(target.head)} holds ${TEST_MARKER}`);

  // From here on a failure is the environment's: TwoCloneFailed (exit 1) with a next step.
  const peers: Peer[] = [];
  try {
    checkInterrupt();
    const leftovers = await lsRemotePrefix(scratch, url, ns.remotePrefix);
    if (!leftovers.ok) throw new TwoCloneFailed(`the namespace ${ns.remotePrefix} could not be listed on the remote`, UNREACHABLE_NEXT);
    if (leftovers.values.size > 0) {
      throw new TwoCloneFailed(`the namespace ${ns.remotePrefix} is not empty on the remote`, `run again with a new run id, or first remove that run's refs: ${cleanupCmd}`);
    }

    // The run branch, create-only (an ABSENT lease): the only push the harness makes.
    const branchRef = `refs/heads/${branch}`;
    const pushed = await runPush(scratch, url, [pushSpec(target.head, branchRef, ABSENT)], []);
    if (pushed.statuses.get(branchRef) !== 'ok') {
      throw new TwoCloneFailed(`creating ${branch} failed (exit ${pushed.code})`, 'check that your credential helper grants write access to refs/heads/ci/* of the sandbox repository, then run again');
    }
    say(`two-clone: created ${branch} at ${oid12(target.head)}; remove this run's refs later with: ${cleanupCmd}`);
    const harnessPushes = 1;
    const afterPush = `see the error above, then run again; remove this run's refs with: ${cleanupCmd}`;

    for (const [name, autocrlf] of [['A', false], ['B', true]] as const) {
      checkInterrupt();
      const dir = join(root, name);
      const c = await runner.run(['clone', '-q', '--single-branch', '--no-tags', '-b', branch, '-c', `core.autocrlf=${autocrlf}`, '--', url, dir], { class: 'network', cwd: root, ...(signal !== undefined ? { abort: signal } : {}) });
      checkInterrupt();
      if (c.code !== 0) throw new TwoCloneFailed(`git clone of ${branch} into ${name} failed (exit ${c.code})`, `${UNREACHABLE_NEXT}; remove this run's refs with: ${cleanupCmd}`);
      if (shown !== url) {
        // Never store a credential: the clone's config keeps the URL without userinfo (the engines get the URL in memory).
        const s = await runner.run(['config', '--', 'remote.origin.url', shown], { class: 'local', cwd: dir });
        if (s.code !== 0) throw new TwoCloneFailed(`git config remote.origin.url in ${name} failed (exit ${s.code})`, afterPush);
      }
      peers.push({ name, dir: realpathSync.native(dir), autocrlf, repo: repoAt(dir, runner), tips: [], lock: null, engine: null, handle: null, loopEnd: null });
    }
    for (const p of peers) {
      const coworkDir = join(p.dir, '.git', 'cowork');
      const lock = await DaemonLock.acquire(realFs, coworkDir, { pluginVersion: PLUGIN_VERSION, instance: randomHex(realRandom, 16) });
      if (!(lock instanceof DaemonLock)) throw new TwoCloneFailed(`${p.name}: daemon.lock is held by pid ${lock.held?.pid ?? 'unknown'}`, afterPush);
      p.lock = lock;
      await realFs.mkdirp(join(coworkDir, 'log'));
      const trace: Trace = {
        emit(ev: TraceEvent): void {
          if (ev.kind === 'fetch' && ev.ok && ev.board !== null) p.tips.push(ev.board);
        },
      };
      const deps: EngineDeps = {
        ports: { clock: realClock, random: realRandom, scheduler: realScheduler(realClock), fs: realFs, git: harnessRunner(join(coworkDir, 'empty-hooks'), env) },
        trace, log: fileLog(realFs, realClock, join(coworkDir, 'log', 'daemon-0.jsonl')), lease: alwaysLeased, attribution: humanOnlyAttribution,
        heartbeatMs: machineMonoMs,
        paths: { workTree: p.dir, gitDir: join(p.dir, '.git'), coworkDir },
        branch, namespace: ns, url, display: `two-clone ${p.name}`,
        pluginVersion: PLUGIN_VERSION, pluginSha: createHash('sha256').update(`cowork-sync two-clone ${PLUGIN_VERSION}`, 'utf8').digest('hex'),
        regionSpec: PLAN2_REGION_SPEC, platform: process.platform, testBuild: true, testMutants: new Set(),
      };
      p.engine = await Engine.create(deps);
    }

    // A: genesis (with the host probe); then B: join.
    for (const [p, want] of [[peers[0]!, 'genesis'], [peers[1]!, 'join']] as const) {
      checkInterrupt();
      const r = await p.engine!.start({ publishLocal: null });
      if (!r.ok) throw new TwoCloneRefused(r.code, { peer: p.name, ...r.params }, `peer ${p.name} could not start (see the code above); remove this run's refs with: ${cleanupCmd}`);
      if (r.mode !== want) throw new TwoCloneFailed(`peer ${p.name} started in mode ${r.mode}, expected ${want}`, afterPush);
      say(`two-clone: ${p.name} (core.autocrlf=${p.autocrlf}) started ${r.mode} as peer ${p.engine!.peerId}`);
    }
    for (const p of peers) {
      const h = runLoop(p.engine!, { scheduler: p.engine!.core.deps.ports.scheduler, clock: realClock, lease: alwaysLeased });
      void h.finished.then(
        () => { p.loopEnd ??= { error: undefined }; },
        (e: unknown) => { p.loopEnd ??= { error: e }; },
      );
      p.handle = h;
    }

    const [A, B] = peers as [Peer, Peer];
    const boardRef = A.engine!.core.refs.remoteBoard;
    const scenarios: TwoCloneReport['scenarios'] = [];
    const paths = [`${SCENARIO_DIR}/a.txt`, `${SCENARIO_DIR}/b.txt`, SHARED];
    const none: ReadonlySet<string> = new Set();
    const k4Total = (): number => peers.reduce((n, p) => n + k4Of(p).length, 0);
    const scenario = async (name: string, act: () => Promise<void>, allow: ReadonlySet<string>, check: (c: Converged) => string | null, describe: (c: Converged) => string): Promise<boolean> => {
      if (scenarios.some((s) => !s.ok)) {
        scenarios.push({ name, ok: false, detail: 'not run: an earlier scenario failed' });
        return false;
      }
      checkInterrupt();
      const t0 = Date.now();
      say(`two-clone: scenario ${name}`);
      try {
        await act();
        const probe = async (): Promise<Converged | string> => {
          const c = await probeConverged(peers, scratch, url, boardRef, paths, allow);
          return typeof c === 'string' ? c : (check(c) ?? c);
        };
        const c = await waitConverged(probe, { deadline, pollMs: POLL_MS, quietPolls: QUIET_POLLS, ...(signal !== undefined ? { signal } : {}) });
        const s = typeof c === 'string'
          ? { name, ok: false, detail: c }
          : { name, ok: true, detail: `${describe(c)}; converged at board ${oid12(c.T)} in ${((Date.now() - t0) / 1_000).toFixed(1)} s` };
        scenarios.push(s);
        say(`two-clone: scenario ${name} ${s.ok ? 'ok' : 'FAILED'}: ${s.detail}`);
        return s.ok;
      } catch (e) {
        if (e instanceof TwoCloneInterrupted) throw e;
        const detail = e instanceof ConvergeFatal ? `cannot converge: ${e.message}` : errText(e);
        scenarios.push({ name, ok: false, detail });
        say(`two-clone: scenario ${name} FAILED: ${detail}`);
        return false;
      }
    };
    const expectFiles = (want: Readonly<Record<string, string>>) => (c: Converged): string | null => {
      for (const [path, text] of Object.entries(want)) if (c.files.get(path)?.toString('utf8') !== text) return `${path} is not the expected text yet`;
      return null;
    };

    // (1) different files: A adds a.txt and shared.txt (LF), B adds b.txt (CRLF, stored LF by canon).
    const s1 = { [`${SCENARIO_DIR}/a.txt`]: 'a.txt written on A\n', [`${SCENARIO_DIR}/b.txt`]: 'b.txt written on B\n', [SHARED]: sharedText() };
    await scenario('different-files', async () => {
      await save(A, `${SCENARIO_DIR}/a.txt`, s1[`${SCENARIO_DIR}/a.txt`]!);
      await save(A, SHARED, s1[SHARED]!);
      await save(B, `${SCENARIO_DIR}/b.txt`, 'b.txt written on B\r\n');
    }, none, (c) => expectFiles(s1)(c) ?? (k4Total() > 0 ? 'a K4 record appeared' : null), () => 'a.txt from A and b.txt from B on both disks');

    // (2) one file, rows 10 apart: both edits merge.
    const s2 = sharedText({ 5: 'row 5 edited on A', 15: 'row 15 edited on B' });
    await scenario('same-file-10-rows-apart', async () => {
      await editRow(A, SHARED, 5, 'row 5', 'row 5 edited on A');
      await editRow(B, SHARED, 15, 'row 15', 'row 15 edited on B');
    }, none, (c) => (c.files.get(SHARED)?.toString('utf8') !== s2 ? 'shared.txt does not hold both edits yet' : k4Total() > 0 ? 'a K4 record appeared' : null), () => 'rows 5 (A) and 15 (B) merged on both disks');

    // (3) the same line: TIP's version on both disks, the later publisher's version one K4 record (R-02, R-39).
    const s3 = { A: sharedText({ 5: 'row 5 edited on A', 15: 'row 15 edited on B', 25: 'row 25 edited on A' }), B: sharedText({ 5: 'row 5 edited on A', 15: 'row 15 edited on B', 25: 'row 25 edited on B' }) };
    let s3Detail = '';
    await scenario('same-line', async () => {
      await editRow(A, SHARED, 25, 'row 25', 'row 25 edited on A');
      await editRow(B, SHARED, 25, 'row 25', 'row 25 edited on B');
    }, new Set([SHARED]), (c) => {
      const text = c.files.get(SHARED)?.toString('utf8');
      const winner = text === s3.A ? A : text === s3.B ? B : null;
      if (winner === null) return 'shared.txt holds neither version of row 25 alone';
      const loser = winner === A ? B : A;
      const total = k4Total();
      const mine = k4Of(loser).filter((r) => r.path === SHARED);
      if (total !== 1 || mine.length !== 1) return `K4 records: ${total} in all, ${mine.length} on ${loser.name}`;
      s3Detail = `TIP kept ${winner.name}'s row 25 on both disks; ${loser.name}'s version is one K4 record (the later publisher)`;
      return null;
    }, () => s3Detail);

    // The K4 record keeps the loser's bytes (INV-NOLOSS's local registry location).
    const last = scenarios[scenarios.length - 1]!;
    if (last.ok) {
      const loser = peers.find((p) => k4Of(p).length === 1)!;
      const why = await k4LocalStageCheck(loser.repo, loser.name, k4Of(loser)[0]!.s2);
      if (why !== null) {
        last.ok = false;
        last.detail = `${last.detail}; but ${why}`;
      }
    }

    // Stop both loops (drain), then the history check on what each peer fetched.
    await stopAll(peers, say);
    const ff = await ffHistoryOf(peers);
    say(`two-clone: ffHistory ${ff.ok}: ${ff.detail}`);
    const pushes = harnessPushes + peers.reduce((n, p) => n + (p.engine?.core.pushAttempts ?? 0), 0);
    return {
      runId, branch,
      scenarios: scenarios.map((s) => ({ ...s, detail: sanitizeLine(s.detail) })),
      converged: scenarios.length === 3 && scenarios.every((s) => s.ok),
      ffHistory: ff.ok,
      pushes,
      k4Records: k4Total(),
      elapsedS: Math.round((Date.now() - started) / 100) / 10,
    };
  } catch (e) {
    if (e instanceof StartRefused) throw new TwoCloneRefused(e.code, { ...e.params }, `a peer could not start (see the code above); remove this run's refs with: ${cleanupCmd}`);
    if (e instanceof GitCommandError || e instanceof RemoteContentError || isErrno(e)) {
      throw new TwoCloneFailed(errText(e), `check the git, remote or file-system error above, then run again; remove this run's refs with: ${cleanupCmd}`);
    }
    throw e;
  } finally {
    await stopAll(peers, say);
    for (const p of peers) await p.lock?.release().catch(() => undefined);
  }
}

/** Stops every loop that still runs (each drains its engine); a loop that died is reported once. */
async function stopAll(peers: readonly Peer[], say: (l: string) => void): Promise<void> {
  for (const p of peers) {
    const h = p.handle;
    if (h === null) continue;
    p.handle = null;
    try {
      await h.stop();
    } catch (e) {
      say(`two-clone: the loop of ${p.name} ended with ${errText(e)}`);
    }
  }
}

// ---- the CLI ------------------------------------------------------------------------------------------------------

export function formatReport(r: TwoCloneReport): string[] {
  return [
    `two-clone report: run ${r.runId} branch ${r.branch} converged=${r.converged} ffHistory=${r.ffHistory} pushes=${r.pushes} k4Records=${r.k4Records} elapsed=${r.elapsedS}s`,
    ...r.scenarios.map((s) => `  ${s.ok ? 'ok  ' : 'FAIL'} ${s.name}: ${s.detail}`),
    `report: ${JSON.stringify(r)}`,
  ].map(sanitizeLine);
}

class UsageError extends Error {}

/**
 * Exit 0: usage (no COWORK_REAL_REMOTE) or a passing run; 1: a refusal, an environmental failure or a failing run;
 * 2: a usage or internal error; 130: Ctrl+C (heard on `signals`). The run gets `env` (its git runners' DAEMON_ENV
 * source), a run id chosen here (so the cleanup command can always be printed) and the URL as given.
 */
export async function twoCloneMain(
  argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: CliIo,
  run: (o: TwoCloneOptions) => Promise<TwoCloneReport> = twoCloneRun, signals: SignalSource | null = null,
): Promise<number> {
  const p: CliIo = { out: (l) => io.out(sanitizeLine(l)), err: (l) => io.err(sanitizeLine(l)) };
  const raw = (env['COWORK_REAL_REMOTE'] ?? '').trim();
  if (raw.length === 0) {
    for (const l of TWO_CLONE_USAGE.split('\n')) p.out(l);
    return 0;
  }
  let timeoutMin = DEFAULT_TIMEOUT_MIN;
  let keep = false;
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === '--keep') keep = true;
      else if (a === '--timeout-min') {
        const v = argv[++i];
        if (v === undefined || !/^[1-9][0-9]{0,3}$/.test(v)) throw new UsageError(`--timeout-min needs a whole number of minutes, got ${v ?? '(nothing)'}`);
        timeoutMin = Number(v);
      } else throw new UsageError(`unknown argument ${a}`);
    }
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    p.err(`two-clone: ${e.message}`);
    for (const l of TWO_CLONE_USAGE.split('\n')) p.err(l);
    return 2;
  }
  const refused = (e: TwoCloneRefused): void => {
    p.out(`${e.code} ${JSON.stringify(e.params)}`);
    p.out(`next: ${e.next}`);
  };
  try {
    refuseBadUrl(raw);
  } catch (e) {
    if (!(e instanceof TwoCloneRefused)) throw e;
    refused(e);
    return 1;
  }
  const shown = sanitizeUrl(raw);
  const runId = ulid(realRandom, realClock);
  const cleanupLine = `cleanup: npm run real:cleanup -- --remote ${shown} --run ${runId} --yes`;
  const ac = new AbortController();
  const onInterrupt = (): void => {
    if (ac.signal.aborted) return;
    p.err('two-clone: interrupted: stopping both loops (drain); a second Ctrl+C exits at once');
    ac.abort();
  };
  signals?.on('SIGINT', onInterrupt);
  const tmp = await makeTempRoot('two-clone');
  try {
    const report = await run({ url: raw, root: tmp.root, timeoutMs: timeoutMin * 60_000, log: (l) => p.out(l), runId, env, signal: ac.signal });
    if (ac.signal.aborted) {
      p.out(cleanupLine);
      return 130;
    }
    for (const l of formatReport(report)) p.out(l);
    p.out(`cleanup: npm run real:cleanup -- --remote ${shown} --run ${report.runId} --yes`);
    return report.converged && report.ffHistory ? 0 : 1;
  } catch (e) {
    if (ac.signal.aborted) {
      p.out('two-clone: interrupted; both loops stopped');
      p.out(cleanupLine);
      return 130;
    }
    if (e instanceof TwoCloneRefused) {
      refused(e);
      if (e.code !== 'TEST_TARGET_REFUSED') p.out(cleanupLine);
      return 1;
    }
    if (e instanceof TwoCloneFailed) {
      p.out(`two-clone: FAILED ${e.message}`);
      p.out(`next: ${e.next}`);
      p.out(cleanupLine);
      return 1;
    }
    p.err(`two-clone: internal error ${errText(e)}`);
    p.out(cleanupLine);
    return 2;
  } finally {
    signals?.off('SIGINT', onInterrupt);
    if (keep) p.out(`two-clone: kept ${tmp.root}`);
    else await tmp.cleanup().catch((e: unknown) => p.err(`two-clone: could not remove ${tmp.root}: ${errText(e)}`));
  }
}

/** This file is the process entry (tsx tools/real/two-clone.ts), not an import (realpath; case-insensitive on Windows). */
export function isEntry(moduleUrl: string): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    const a = realpathSync.native(resolve(argv1));
    const b = realpathSync.native(fileURLToPath(moduleUrl));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isEntry(import.meta.url)) {
  const io: CliIo = { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) };
  // The first Ctrl+C reaches twoCloneMain (drain, cleanup command, exit 130); a second one exits at once.
  let interrupts = 0;
  process.on('SIGINT', () => {
    interrupts += 1;
    if (interrupts > 1) {
      io.err('two-clone: interrupted again: exiting without drain');
      process.exit(130);
    }
  });
  twoCloneMain(process.argv.slice(2), process.env, io, twoCloneRun, process).then(
    (code) => { process.exitCode = code; },
    (e: unknown) => { io.err(sanitizeLine(`two-clone: ${errText(e)}`)); process.exitCode = 2; },
  );
}
