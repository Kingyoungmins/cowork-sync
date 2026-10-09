// VizGit: the viewer's read-only git facade (12 VIZ-07; Plan 8a rulings R-V06, R-V09, R-V10, R-V13).
// The viewer reaches git only through this module: its own runner (createGitRunner, so the glossary §18 flags,
// --no-replace-objects, P2-UTF8 and P2-GRAFTS come from buildGitInvocation unchanged) with the 120 s watchdog, every
// call in the `local` class with an absolute --git-dir, cwd = the data directory, every transport disabled by
// command-line config and GIT_NO_LAZY_FETCH=1, and every argv checked against the allowlist (vizGitArgvOk, shared with
// the lint L-VIZ-GIT) before anything is spawned. No GitRepo, no lock-taking, filter, hook or network command.
import { isAbsolute, join } from 'node:path';
import type { BatchGit } from '../../board/batchRead.js';
import { parseOid, type Oid } from '../../git/oid.js';
import { GitCommandError } from '../../git/repo.js';
import { createGitRunner, type GitResult, type GitRunner } from '../../git/runner.js';
import { parseGitVersion, type GitVersion } from '../../git/version.js';
import type { Clock } from '../../ports/clock.js';
import { vizGitArgvOk } from './vizGitArgv.js';

/**
 * protocol.allow=never and protocol.<name>.allow=never for file, git, http, https and ssh: command-line values override
 * repository config at the git floor, so a missing object in a partial clone is a read error, never a fetch. The
 * runner already forces protocol.ext.allow=never (buildGitInvocation refuses it here).
 */
export const VIZ_GIT_CONFIG: Readonly<Record<string, string>> = Object.freeze({
  'protocol.allow': 'never',
  'protocol.file.allow': 'never',
  'protocol.git.allow': 'never',
  'protocol.http.allow': 'never',
  'protocol.https.allow': 'never',
  'protocol.ssh.allow': 'never',
});
export const VIZ_GIT_ENV: Readonly<Record<string, string>> = Object.freeze({ GIT_NO_LAZY_FETCH: '1' });
/** The runner's read/hash watchdog value: a hung cat-file must not stall every room's poll (R-V06). */
export const VIZ_GIT_WATCHDOG_MS = 120_000;

/** An argv outside the viewer allowlist: refused before anything is spawned. */
export class VizGitRefused extends Error {
  constructor(args: readonly string[]) {
    super(`VizGit: git argv outside the viewer allowlist ${JSON.stringify(args).slice(0, 200)}`);
    this.name = 'VizGitRefused';
  }
}

export interface VizGit extends BatchGit {
  readonly gitDir: string;
  /** git version */
  version(): Promise<GitVersion>;
  /** rev-parse --verify -q <ref>; null when the ref does not resolve. */
  revParse(ref: string): Promise<Oid | null>;
  /** for-each-ref --format=%(objectname) %(refname) refs/cowork-remote/ (R-V09: there is no -z), in git's ref order. */
  remoteRefs(): Promise<Array<{ ref: string; oid: Oid }>>;
  /** rev-list --first-parent --count <tip> */
  chainCount(tip: Oid): Promise<number>;
  /** rev-list --first-parent --skip=<n> --max-count=<n> <tip>, newest first. */
  chain(tip: Oid, skip: number, max: number): Promise<Oid[]>;
}

const REMOTE_NAMESPACE = 'refs/cowork-remote/';

/**
 * An absolute path that does not depend on a current drive or directory: on Windows a drive-absolute (`C:\…`) or UNC
 * (`\\server\share\…`) path — node's isAbsolute also admits a root-relative `\Program Files\…` and refuses only a
 * drive-relative `C:x` — elsewhere isAbsolute.
 */
function absolutePath(p: unknown): p is string {
  if (typeof p !== 'string') return false;
  if (process.platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]/.test(p);
  return isAbsolute(p);
}

/** env with every case variant of VIZ_GIT_ENV's names replaced by the forced value (Windows names are case-insensitive). */
function vizEnv(env: Record<string, string>): Record<string, string> {
  const forced = new Set(Object.keys(VIZ_GIT_ENV).map((k) => k.toUpperCase()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (!forced.has(k.toUpperCase())) out[k] = v;
  return { ...out, ...VIZ_GIT_ENV };
}

/**
 * createGitRunner({ clock, hooksPath: join(dataDir, 'viz-no-hooks'), daemonEnv: { ...env, ...VIZ_GIT_ENV }, gitPath,
 * watchdogOverrideMs: VIZ_GIT_WATCHDOG_MS }). gitPath is ServeArgs.git (absolute, resolved by the CLI, R-V13): a relative
 * value throws, as does a relative data directory. The hooks directory is never created.
 */
export function vizGitRunner(o: { clock: Clock; dataDir: string; env: Record<string, string>; gitPath: string }): GitRunner {
  if (!absolutePath(o.gitPath)) throw new Error(`vizGitRunner: the git path must be absolute, got ${JSON.stringify(o.gitPath)}`);
  if (!absolutePath(o.dataDir)) throw new Error('vizGitRunner: the data directory must be absolute');
  return createGitRunner({
    clock: o.clock,
    hooksPath: join(o.dataDir, 'viz-no-hooks'),
    daemonEnv: vizEnv(o.env),
    gitPath: o.gitPath,
    watchdogOverrideMs: VIZ_GIT_WATCHDOG_MS,
  });
}

/**
 * Plan 8a Task 15 (additive; ledger carry "the viewer serve entry kills its git children on SIGTERM"): `runner` with
 * GitCallOptions.abort = `signal` on every call, so a stopping viewer kills its running git children the way the watchdog does
 * (ruling P2-ABORT), and a call after the abort starts nothing. On POSIX those children lead process groups of their own, which
 * no signal to the viewer's group reaches. Written here because this facade is the one module of src/viz/** that may hand a
 * non-literal argv to `.run(` (L-VIZ-GIT).
 */
export function abortingRunner(runner: GitRunner, signal: AbortSignal): GitRunner {
  return { run: (args, opts) => runner.run(args, { ...opts, abort: signal }) };
}

/**
 * Every call: class 'local', cwd dataDir, gitDir (absolute), config VIZ_GIT_CONFIG; vizGitArgvOk false throws VizGitRefused
 * before spawning; an exit code other than 0 throws GitCommandError (rev-parse's 1 is "no such ref").
 */
export function createVizGit(o: { runner: GitRunner; gitDir: string; dataDir: string }): VizGit {
  if (!absolutePath(o.gitDir)) throw new Error('createVizGit: the git dir must be absolute');
  if (!absolutePath(o.dataDir)) throw new Error('createVizGit: the data directory must be absolute');
  const { runner, gitDir, dataDir } = o;

  const call = async (args: string[], stdin: Buffer | null, okCodes: readonly number[] = [0]): Promise<GitResult> => {
    if (!vizGitArgvOk(args)) throw new VizGitRefused(args);
    const r = await runner.run(args, { class: 'local', cwd: dataDir, gitDir, config: VIZ_GIT_CONFIG, ...(stdin === null ? {} : { stdin }) });
    if (!okCodes.includes(r.code)) throw new GitCommandError(args, r.code, r.stderr);
    return r;
  };
  const lines = (r: GitResult): string[] => r.stdout.toString('utf8').split('\n').filter((l) => l.length > 0);

  return {
    gitDir,
    run: (args, opts) => call(args, opts.stdin),
    async version() {
      return parseGitVersion((await call(['version'], null)).stdout.toString('utf8'));
    },
    async revParse(ref) {
      const r = await call(['rev-parse', '--verify', '-q', ref], null, [0, 1]);
      return r.code === 0 ? parseOid(r.stdout.toString('utf8')) : null;
    },
    async remoteRefs() {
      const r = await call(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/cowork-remote/'], null);
      const out: Array<{ ref: string; oid: Oid }> = [];
      for (const line of lines(r)) {
        const sp = line.indexOf(' ');
        const ref = line.slice(sp + 1);
        if (sp > 0 && ref.startsWith(REMOTE_NAMESPACE)) out.push({ ref, oid: parseOid(line.slice(0, sp)) });
      }
      return out;
    },
    async chainCount(tip) {
      const text = (await call(['rev-list', '--first-parent', '--count', tip], null)).stdout.toString('utf8').trim();
      const n = Number(text);
      if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(n)) throw new Error(`rev-list --count: unexpected output ${JSON.stringify(text.slice(0, 40))}`);
      return n;
    },
    async chain(tip, skip, max) {
      return lines(await call(['rev-list', '--first-parent', `--skip=${skip}`, `--max-count=${max}`, tip], null)).map((l) => parseOid(l));
    },
  };
}
