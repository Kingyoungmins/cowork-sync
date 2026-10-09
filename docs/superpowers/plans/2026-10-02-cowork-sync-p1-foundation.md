# cowork-sync Plan 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the toolchain, the side-effect ports, the single git runner, the push-outcome classifier, the real-git test fixtures, a deterministic multi-peer simulation harness and the lint suite skeleton. Every later cowork-sync plan builds on these.

**Architecture:** TypeScript, bundled by esbuild into single-file JS entry points under `dist/`, with no runtime dependencies. Every side effect (time, randomness, file system, git, crash injection) goes through a *port* interface in `src/ports/` or `src/git/`. Production binds the real implementation; tests bind virtual or fault-injecting ones from `test/sim/`. Tests run real `git` against `file://` bare remotes. Git is never mocked.

**Tech Stack:**
- Runtime: Node ≥ 20, TypeScript 5.x, esbuild.
- Tests: `node:test` via `tsx`, `fast-check` for property tests.
- Git ≥ 2.43.
- CI: GitHub Actions (windows-latest, macos-latest, ubuntu-latest).
- Dev dependencies only: `typescript`, `esbuild`, `tsx`, `fast-check`, `@types/node`.

**Spec:** [`docs/spec/00-glossary.md`](../../spec/00-glossary.md) (rev 2.4) and these sections, which the tasks quote:
- glossary §4 (`enc()`), §6 (`dist/` file list), §18 (git runner, including the watchdogs) and §20 (numbers);
- [`docs/spec/09-security.md`](../../spec/09-security.md) §3.4 (DAEMON_ENV);
- [`docs/spec/11-testing.md`](../../spec/11-testing.md) §3.2 (ports), §3.3 (SIM harness), §3.4 (INV-FF, INV-OID oracles), §3.5 (fault catalogue: the Fs/remote faults Plan 1 can already inject), §3.6 (crashpoints), §3.7 (fixtures), §3.10 (lints) and §3.11 (CI matrix; Plan 1 runs a 10-seed SIM smoke per leg, the 100/200-seed budgets start with Plan 2's real engine);
- glossary §26.2 item 2 (push-outcome classification).

Roadmap: [`2026-10-02-cowork-sync-roadmap.md`](2026-10-02-cowork-sync-roadmap.md).

## Global Constraints

- Node floor **20** for everything under `src/` and `dist/` (no `--experimental-strip-types`, no APIs newer than Node 20). Dev tooling (tests and lint via `node --import tsx`) requires Node ≥ 20.6; `package.json` `engines.node` is `>=20.6` for contributors.
- Git floor **2.43.0** (glossary §18); tests use whatever git is on PATH but `meetsFloor` must reject anything below 2.43.0.
- **No runtime dependencies.** `package.json` has `devDependencies` only; nothing under `src/` may import a package that is not a Node built-in (`node:*`).
- The plugin bundle `dist/` will eventually be exactly: `hook.js`, `core.js`, `daemon.js`, `worker.js`, `mcp.js`, `cli.js`, `grammars/*.wasm`, `i18n/*.json`, `schema/*.json`, `SHA256SUMS` (glossary §6). Plan 1 builds only the six JS entry points as stubs.
- Every git process is started by `createGitRunner(...).run(...)` (`src/git/runner.ts`). No other file may spawn `git` (lint L-GIT-SPAWN).
- No `Date.now()`, `new Date()`, `performance.now()` outside `src/ports/clock.ts`; no `Math.random`, `crypto.randomBytes`, `randomUUID` outside `src/ports/random.ts` (lints L-CLOCK, L-RANDOM).
- No `child_process` outside `src/git/runner.ts` in `src/` (lint L-PORTS; later plans add the notifier adapter and daemon spawner to the allow list).
- Every file write and read of user files under `src/` goes through the `Fs` port, on `Buffer`s (never `utf8` strings that feed a write).
- Forced git environment (glossary §18): `LC_ALL=C`, `LANGUAGE=` (empty), `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `SSH_ASKPASS_REQUIRE=never`, `GIT_OPTIONAL_LOCKS=0`, stdin ignored.
- Watchdogs (glossary §18): fetch 45 s, push 90 s, read/hash commands (`add`, `cat-file --filters`, `hash-object`) 120 s; ref-updating plumbing (`update-ref`, `update-index`, `commit-tree`, `read-tree`) is never killed.
- `enc(b)`: percent-encode every byte of the branch name outside `[A-Za-z0-9_-]` as `%XX` (uppercase hex); result ≤ 150 bytes, else refuse.
- Push classification (glossary §26.2 item 2): after a fresh fetch, op ids present → landed; leased ref moved → lease lost; ref unchanged and ids absent → transient; 3 consecutive transient rejections of the same publish → `NONRETRYABLE`. Message text never decides.
- All files written by tools and fixtures use LF line endings and UTF-8 without BOM, except fixtures that deliberately test BOM/CRLF.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

The five conditions most likely to break in real use that no single unit test exercises unless pinned here (each has a test in the owning task):

1. **Temp and repo paths with spaces and non-ASCII characters on Windows** (e.g. `C:\Users\홍길동\My Repos\demo`). Expected: `runGit`, the bare-remote fixture and peer clones work unchanged. Pinned in Task 9 (runner) and Task 11 (remote fixture) by using a temp root containing `"공 백 dir"`.
2. **A watchdog kill that leaves grandchild processes running** (git spawns helpers such as `git-remote-https` and filters). Expected: the whole process tree dies and `killedByWatchdog` is true. Pinned in Task 9 with an alias that spawns a node grandchild which writes a heartbeat file; after the kill the file stops growing.
3. **Hook scripts written with CRLF on Windows** (`core.autocrlf=true` checkouts or `\r\n` string literals) make `sh` fail with `$'\r': command not found`. Expected: fixture hooks always run. Pinned in Task 11: hook files are written from LF-only buffers and a test asserts a rejected push really was rejected by the hook.
4. **The user's own git configuration leaking into cowork's git calls** (`core.hooksPath`, `core.fsmonitor`, `commit.gpgSign=true`, `core.sshCommand`, a localized `LANG=ko_KR.UTF-8`). Expected: cowork's `-c` flags override the first three, the user's `core.sshCommand` is kept as the effective ssh command with BatchMode options appended, and output stays in English. Pinned in Task 8 (argv snapshot, sshCommand precedence) and Task 9 (a repo with `commit.gpgSign=true` and a hook directory configured as `core.hooksPath` whose hook *does* run under plain `git commit` — proven first by a control commit — but does not run under `runGit`). `url.*.insteadOf` cannot be overridden with `-c`; it is detected by the pinned-URL drift check of a later plan (09-security SEC-12), not here.
5. **Nondeterminism from the OS** (readdir order, timer resolution, commit timestamps) breaking "same seed, same run". Expected: identical op-log and identical remote ref oids across two runs. Pinned in Task 13 (determinism test runs the same seed twice in different temp roots and compares).

---

## File Structure

```
package.json                     private package, scripts, devDependencies only
tsconfig.json                    strict TS, target ES2022, module NodeNext
tools/build/build.mjs            esbuild: src/entry/*.ts → dist/*.js (6 entry points)
src/entry/{hook,core,daemon,worker,mcp,cli}.ts   stub entry points (print version / no-op)
src/version.ts                   PLUGIN_VERSION constant
src/ports/clock.ts               Clock port, realClock, Anchor helpers (INV-CLOCK)
src/ports/random.ts              Random port, realRandom, seededRandom, randomHex, ulid
src/ports/scheduler.ts           Scheduler port, realScheduler
src/ports/fs.ts                  Fs port (Buffer-only), realFs
src/ports/crashpoint.ts          crashpoint(), setCrashHandler(), KilledAt
src/ports/index.ts               Ports bundle type (created in Task 9, when GitRunner exists)
src/git/enc.ts                   enc() branch-name encoding (glossary §4)
src/git/version.ts               parseGitVersion, GIT_FLOOR, meetsFloor
src/git/env.ts                   buildDaemonEnv() allowlist/never-list (09 §3.4)
src/git/flags.ts                 buildGitInvocation() — glossary §18 argv/env per class
src/git/runner.ts                createGitRunner() — spawn, watchdog, tree kill, GitResult
src/git/classify.ts              classifyPush() — glossary §26.2 item 2
test/helpers/tmp.ts              makeTempRoot() with spaces + non-ASCII, cleanup
test/helpers/retryGit.ts         retryGit(): retry a fixture's git network call while nothing landed
test/sim/vclock.ts               VirtualClock (offset, drift, suspend)
test/sim/vscheduler.ts           VirtualScheduler (seeded, single-step, yieldPoint)
test/sim/faultfs.ts              FaultFs (fault rules over realFs)
test/sim/remote.ts               createBareRemote() with pre-receive/post-receive/reference-transaction hooks
test/sim/peers.ts                clonePeer() with autocrlf profile and counting secret filter
test/sim/fixtures/bigBomCrlf.ts  generateBigBomCrlf()
test/sim/harness.ts              runSim() deterministic multi-peer loop, op-log, oracles
test/sim/oracles.ts              oracleFF(), oracleOID()
test/sim/naiveEngine.ts          NaiveEngine (harness self-test engine) + force-push mutant
test/crashpoints.json            crashpoint catalogue (names) — L-CRASHPOINTS source of truth
tools/lint/rules.ts              lint rules on the TypeScript AST
tools/lint/lint.ts               CLI: lint src/ (and dist/ later), exit 1 on findings
tools/sim/smoke.ts               SIM smoke gate: NaiveEngine over fixed seeds
.github/workflows/ci.yml         matrix CI: lint, typecheck, build, test, sim:smoke
.gitattributes                   * text=auto eol=lf (already present)
```

## Interfaces (the contract every task implements exactly)

```ts
// src/ports/clock.ts
export interface Clock { monoMs(): number; wallMs(): number; sleep(ms: number): Promise<void>; }
export const realClock: Clock;
export interface Anchor { readonly mono: number; readonly wall: number; }
export function anchorNow(clock: Clock): Anchor;
export function elapsedMono(clock: Clock, a: Anchor): number;   // observer-side waits (Δmono)
export function ownStaleness(clock: Clock, a: Anchor): number;  // max(Δwall, Δmono)
export function suspendGapMs(clock: Clock, a: Anchor): number;  // Δwall − Δmono
export const SUSPEND_GAP_THRESHOLD_MS = 5000;

// src/ports/random.ts
export interface Random { bytes(n: number): Uint8Array; }
export const realRandom: Random;
export function seededRandom(seed: string): Random;            // sfc32 seeded from sha256(seed)
export function randomHex(r: Random, nBytes: number): string;  // lowercase hex, 2*nBytes chars
export function randomInt(r: Random, maxExclusive: number): number;
export function ulid(r: Random, clock: Clock): string;          // 26 chars Crockford base32

// src/ports/scheduler.ts
export type Task = () => void | Promise<void>;
export interface Scheduler { schedule(task: Task, atMono: number): void; yieldPoint(name: string): Promise<void>; }
export function realScheduler(clock: Clock): Scheduler;

// src/ports/fs.ts
export interface FsStat { size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean; }
export interface Fs {
  readFile(p: string): Promise<Buffer>;
  writeFile(p: string, data: Buffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  link(existing: string, newPath: string): Promise<void>;
  unlink(p: string): Promise<void>;
  stat(p: string): Promise<FsStat | null>;   // null on ENOENT
  mkdirp(p: string): Promise<void>;
  readdir(p: string): Promise<string[]>;     // sorted by code unit
  rmrf(p: string): Promise<void>;
}
export const realFs: Fs;

// src/ports/crashpoint.ts
export class KilledAt extends Error { readonly point: string; constructor(point: string); }
export function crashpoint(name: string): void;                                   // no-op unless a handler is set
export function setCrashHandler(h: ((name: string) => void) | null): void;        // test builds only

// src/ports/index.ts
import type { GitRunner } from '../git/runner.js';
export interface Ports { clock: Clock; random: Random; scheduler: Scheduler; fs: Fs; git: GitRunner; }

// src/git/enc.ts
export const ENC_MAX_BYTES = 150;
export class EncTooLongError extends Error {}
export function enc(branch: string): string;

// src/git/version.ts
export interface GitVersion { major: number; minor: number; patch: number; raw: string; }
export const GIT_FLOOR: GitVersion;                 // 2.43.0
export function parseGitVersion(stdout: string): GitVersion;   // parses "git version 2.55.0.windows.3"
export function meetsFloor(v: GitVersion): boolean;

// src/git/env.ts
export const FORCED_ENV: Readonly<Record<string, string>>;
export function buildDaemonEnv(source: Record<string, string | undefined>, passthrough: string[]): Record<string, string>;

// src/git/flags.ts
export type GitClass = 'local' | 'network' | 'attr' | 'refupdate';
export interface GitIdentity { name: string; email: string; }
export interface GitCallOptions {
  class: GitClass;
  cwd: string;
  filterDrivers?: string[];          // each gets -c filter.<d>.required=true; lfs is always added
  attrTree?: string;                 // -c attr.tree=<oid> (attribute-reading commands)
  fsmonitor?: boolean;               // -c core.fsmonitor=true|false (default false)
  identity?: GitIdentity;            // live/board commits: GIT_AUTHOR_*/GIT_COMMITTER_* with +0000
  wallMsForDates?: number;           // test builds only: GIT_AUTHOR_DATE/GIT_COMMITTER_DATE
  indexFile?: string;                // GIT_INDEX_FILE for private indexes
  stdin?: Buffer;                    // when set, piped to git; otherwise stdin is ignored
  extraEnv?: Record<string, string>; // never overrides FORCED_ENV
}
export interface GitInvocation { argv: string[]; env: Record<string, string>; }
export interface GitBase { hooksPath: string; platform: NodeJS.Platform; daemonEnv: Record<string, string>; testBuild: boolean; sshCommand?: string; }
// sshCommand = the user's `core.sshCommand`, resolved once by the caller (start path) with `git config --get core.sshCommand`.
// Effective ssh command precedence (09-security §2): daemonEnv.GIT_SSH_COMMAND > sshCommand > GIT_SSH (+variant) > 'ssh'; BatchMode options are appended to it.
export function buildGitInvocation(args: string[], opts: GitCallOptions, base: GitBase): GitInvocation;
export const MERGE_FLAGS: readonly string[];          // -c merge.renormalize=false -c merge.renames=true -c merge.directoryRenames=false
export const DIFF_FAMILY: ReadonlySet<string>;        // diff, diff-tree, diff-index, diff-files, log, show, blame

// src/git/runner.ts
export interface GitResult { code: number; stdout: Buffer; stderr: Buffer; killedByWatchdog: boolean; durationMs: number; }
export interface GitRunner { run(args: string[], opts: GitCallOptions): Promise<GitResult>; }
export interface GitRunnerDeps { clock: Clock; hooksPath: string; daemonEnv: Record<string, string>; gitPath?: string; platform?: NodeJS.Platform; testBuild?: boolean; watchdogOverrideMs?: number; sshCommand?: string; }
export function createGitRunner(deps: GitRunnerDeps): GitRunner;
export function watchdogMs(args: string[], cls: GitClass): number | null;   // null = never killed
export const WATCHDOG = { fetch: 45_000, push: 90_000, readHash: 120_000 } as const;

// src/git/classify.ts
export type PushOutcome = 'landed' | 'lease_lost' | 'transient' | 'nonretryable';
export interface PushObservation { refMovedSinceLease: boolean; ourOpIdsPresent: boolean; previousStreak: number; }
export const NONRETRYABLE_STREAK = 3;
export function classifyPush(o: PushObservation): { outcome: PushOutcome; streak: number };
```

```ts
// test/helpers/tmp.ts
export async function makeTempRoot(label: string): Promise<{ root: string; cleanup: () => Promise<void> }>;  // root contains "공 백 dir"
export function testRunner(clock?: Clock): GitRunner;   // createGitRunner bound for tests (testBuild: true)

// test/sim/vclock.ts
export const SIM_WALL_EPOCH_MS = 1_767_225_600_000;   // 2026-01-01T00:00:00Z; VirtualClock wall time = epoch + offset + drift
export class VirtualClock implements Clock {
  constructor(opts?: { wallOffsetMs?: number; startMono?: number; driftPpm?: number });   // wallOffsetMs is an OFFSET from SIM_WALL_EPOCH_MS, never an absolute time
  monoMs(): number; wallMs(): number; sleep(ms: number): Promise<void>;
  advance(ms: number): void;       // both clocks
  suspend(ms: number): void;       // wall only (Δwall − Δmono = ms)
}

// test/sim/vscheduler.ts
export class VirtualScheduler implements Scheduler {
  constructor(clock: VirtualClock, random: Random);
  readonly random: Random;                  // the seeded stream, for onYield handlers and engines
  schedule(task: Task, atMono: number): void;
  yieldPoint(name: string): Promise<void>;
  onYield: ((name: string) => void | Promise<void>) | null;
  step(): Promise<boolean>;                 // runs the earliest task (ties broken by insertion order); false if none
  runUntilIdle(maxSteps: number): Promise<number>;
  pending(): number;
}

// test/sim/faultfs.ts
export type FaultOp = 'readFile' | 'writeFile' | 'rename' | 'link' | 'unlink';
export interface FaultRule { op: FaultOp; pathIncludes: string; code: 'EACCES' | 'EPERM' | 'EBUSY' | 'ENOSPC'; times: number; }
export class FaultFs implements Fs { constructor(inner: Fs); addRule(r: FaultRule): void; readonly hits: Map<string, number>; /* key `${op}:${code}:${pathIncludes}`, one counter per rule; + Fs methods */ }
// Lock probe, fsync and delay/lock emulation (11-testing §3.2 Fs row) are added by Plan 2, whose verifying writer is their first user.

// test/sim/remote.ts
export type RejectKind = 'transient-failed' | 'commit_refs' | 'policy';
export interface RemoteLogEntry { ref: string; old: string; new: string; }
export interface RefTxEntry { state: string; old: string; new: string; ref: string; }
export interface BareRemote {
  dir: string; url: string;
  rejectNext(n: number, kind: RejectKind, refSubstring?: string): Promise<void>;
  clearRejects(): Promise<void>;
  readRemoteLog(): Promise<RemoteLogEntry[]>;
  readRefTxLog(): Promise<RefTxEntry[]>;
  refs(): Promise<Record<string, string>>;   // ref -> oid, sorted keys
}
export async function createBareRemote(root: string, git: GitRunner, defaultBranch?: string): Promise<BareRemote>;

// test/helpers/retryGit.ts (Task 12; used by seedRemote, clonePeer and the NaiveEngine's fetch)
export interface GitAttempt { code: number; stderr: string; }
export class RetryGitError extends Error { readonly attempts: GitAttempt[]; }
export interface RetryGitOptions { attempts: number; label: string; nothingLanded?: () => Promise<boolean>; pauseMs?: number; }
export async function retryGit<R extends { code: number; stderr: Buffer }>(run: () => Promise<R>, opts: RetryGitOptions): Promise<R>;
// runs `run` until it exits 0, at most `attempts` times; a non-zero exit is retried only while nothingLanded() is true
// (omitted: always, for fetch/clone), after pauseMs (default 200); the final RetryGitError lists every attempt's code and stderr

// test/sim/peers.ts
export function canary(runId: string): string;   // `COWORK_CANARY_${runId}` (11-testing §3.7); the secret filter replaces exactly this string
export interface PeerOptions { name: string; autocrlf: boolean; withFilter: boolean; }
export interface PeerClone { name: string; dir: string; filterCountFile: string; opts: PeerOptions; canary: string; }
export async function seedRemote(remote: BareRemote, root: string, git: GitRunner, files: Record<string, Buffer>): Promise<string>; // returns commit oid on main
export async function clonePeer(remote: BareRemote, root: string, opts: PeerOptions, git: GitRunner): Promise<PeerClone>;

// test/sim/fixtures/bigBomCrlf.ts
export function generateBigBomCrlf(lines: number, random: Random): Buffer;  // UTF-8 BOM + CRLF python source

// test/sim/harness.ts
export interface SeedTuple { seed: string; peers: number; ops: number; }
export interface OpLogEntry { step: number; peer: string; kind: string; detail: string; }
export interface SimContext { root: string; remote: BareRemote; peers: PeerClone[]; git: GitRunner; random: Random; clocks: Map<string, VirtualClock>; scheduler: VirtualScheduler; opLog: OpLogEntry[]; }
export interface SimEngine { readonly peer: PeerClone; step(ctx: SimContext): Promise<void>; }
export type EngineFactory = (ctx: SimContext, peer: PeerClone) => SimEngine;
export interface Oracle { name: string; afterEveryOp?(ctx: SimContext): Promise<string | null>; atQuiescence?(ctx: SimContext): Promise<string | null>; }
export interface SimResult { ok: boolean; failure?: { oracle: string; message: string; step: number }; opLog: OpLogEntry[]; remoteRefs: Record<string, string>; artifactsDir?: string; }   // artifactsDir: set only when ok is false (<root>/artifacts; the temp root is kept)
export async function runSim(t: SeedTuple, makeEngine: EngineFactory, oracles: Oracle[]): Promise<SimResult>;

// test/sim/oracles.ts
export function oracleFF(refPrefix: string): Oracle;   // every remote-log update on refPrefix* is a fast-forward
export function oracleOID(allowedDeletePrefixes: string[]): Oracle;  // no remote ref deletion except refs starting with one of the prefixes
// oracleFF(refPrefix) checks only refs whose name is `${refPrefix}<branch>/board` or `${refPrefix}<branch>/code`; deletions of those refs fail it.
// The trace-based clauses of INV-FF (no '+'/--force in daemon push argv) and INV-OID (only the deleting peer's own probe; no push after write-tree exit 128) need the trace port of Plan 2.

// test/sim/naiveEngine.ts
export function naiveEngine(opts?: { forcePush?: boolean }): EngineFactory;   // edits a file, commits, pushes leased FF to refs/cowork/main/code; a rejected push is retried (same commit if nothing landed, rebuilt once if the lease was lost)

// tools/lint/rules.ts
export interface LintFinding { rule: string; file: string; line: number; message: string; }
export function lintSource(file: string, text: string): LintFinding[];
export function lintCrashpoints(callSites: string[], catalogue: string[]): LintFinding[];   // call sites must be ⊆ catalogue; catalogue names without a call site are allowed until later plans place them
```

## Tasks

| # | Task | Produces |
|---|---|---|
| 1 | Project scaffold, build, test runner | `package.json`, `tsconfig.json`, `tools/build/build.mjs`, `src/entry/*.ts`, `src/version.ts` |
| 2 | Clock port and anchor helpers; VirtualClock | `src/ports/clock.ts`, `test/sim/vclock.ts` |
| 3 | Random port (real + seeded), randomHex, randomInt, ulid | `src/ports/random.ts` |
| 4 | Fs port and FaultFs | `src/ports/fs.ts`, `test/sim/faultfs.ts` |
| 5 | Scheduler port and VirtualScheduler | `src/ports/scheduler.ts`, `test/sim/vscheduler.ts` |
| 6 | crashpoint and the catalogue file | `src/ports/crashpoint.ts`, `test/crashpoints.json` |
| 7 | `enc()` and git version floor | `src/git/enc.ts`, `src/git/version.ts` |
| 8 | DAEMON_ENV builder and glossary §18 argv/env builder | `src/git/env.ts`, `src/git/flags.ts` |
| 9 | Git runner: spawn, watchdog, process-tree kill; Ports bundle | `src/git/runner.ts`, `src/ports/index.ts`, `test/helpers/tmp.ts` |
| 10 | Push-outcome classifier | `src/git/classify.ts` |
| 11 | Bare-remote fixture with server-side hooks | `test/sim/remote.ts` |
| 12 | Peer clones, counting secret filter, big BOM+CRLF fixture, retry for fixture git network calls | `test/sim/peers.ts`, `test/sim/fixtures/bigBomCrlf.ts`, `test/helpers/retryGit.ts` |
| 13 | SIM harness skeleton, oracles INV-FF/INV-OID, NaiveEngine, determinism | `test/sim/harness.ts`, `test/sim/oracles.ts`, `test/sim/naiveEngine.ts` |
| 14 | Lint suite skeleton | `tools/lint/rules.ts`, `tools/lint/lint.ts` |
| 15 | CI workflow and `npm run ci` | `.github/workflows/ci.yml`, `package.json` scripts |

---

### Task 1: Project scaffold, build, test runner

**Files:**
- Create: `package.json` (private ESM package, scripts, devDependencies only)
- Create: `package-lock.json` (generated by `npm install`; committed so CI can `npm ci`)
- Create: `tsconfig.json` (strict, target ES2022, module/moduleResolution NodeNext, `noEmit`)
- Create: `.gitignore`
- Create: `tools/test/run-tests.mjs` (portable test launcher: Node 20's `node --test` has no glob support and npm runs scripts through `cmd.exe` on Windows, which does not expand globs)
- Create: `tools/build/build.mjs` (esbuild: `src/entry/*.ts` → six `dist/*.js`)
- Create: `src/version.ts`
- Create: `src/entry/hook.ts`, `src/entry/core.ts`, `src/entry/daemon.ts`, `src/entry/worker.ts`, `src/entry/mcp.ts`, `src/entry/cli.ts`
- Test: `test/unit/version.test.ts`
- Test: `test/integration/build.test.ts` (spawns `node` and esbuild, so it is not a pure unit test; it lives under `test/integration/` to keep `npm run test:unit` fast and side-effect free)

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `export const PLUGIN_VERSION: string` in `src/version.ts` (`'0.0.0'`; must always equal `package.json` `"version"`).
  - npm scripts (later tasks call exactly these names):
    - `build` → `node tools/build/build.mjs` (writes `dist/{hook,core,daemon,worker,mcp,cli}.js`, nothing else)
    - `typecheck` → `tsc -p tsconfig.json`
    - `test` → every `*.test.ts` under `test/unit` and `test/integration`
    - `test:unit` → every `*.test.ts` under `test/unit`
    - `test:integration` → every `*.test.ts` under `test/integration`
    - `lint` → placeholder echo; **Task 14 replaces it** with `tsx tools/lint/lint.ts`
    - `ci` → `npm run lint && npm run typecheck && npm run build && npm test` (exactly this string; Task 15 appends ` && npm run sim:smoke` and pins the result with a test, so `typecheck` always stays in `ci`)
  - `package.json` `engines.node` = `">=20.6"`: the floor for contributors' dev tooling (tests and lint load TypeScript through `tsx`, which needs Node ≥ 20.6 for `--import`). Code under `src/` and `dist/` still targets Node 20 (esbuild `target: 'node20'`).
  - `node tools/build/build.mjs [--outdir <dir>] [--metafile <file>]`: empties the output directory, bundles the six entry points as ESM for `node20` with only `node:*` imports left, and writes the esbuild metafile JSON to `<file>` when `--metafile` is given. Nothing in Plan 1 consumes the metafile: Task 14 implements L-NET (11-testing §3.10) over the `import`s in `src/**/*.ts`, and `dist/` scanning, which can use this metafile, is added by a later plan. Unknown arguments → exit 2 with `build: unknown argument <arg>` on stderr.
  - `node tools/test/run-tests.mjs <dir>...`: runs every `*.test.ts` under the given directories (recursive, sorted by code unit) with `tsx --test`; exits 0 with a message when there are none; otherwise exits with the test runner's status.
  - Each `dist/<name>.js` prints `cowork-sync <name> <PLUGIN_VERSION>\n` for `--version` and is a no-op (exit 0, no output) otherwise.

- [ ] **Step 0: Scaffold the toolchain and install dev dependencies**

Write `package.json`:

```json
{
  "name": "cowork-sync",
  "version": "0.0.0",
  "private": true,
  "description": "Real-time code sync between Claude Code sessions on different PCs, over a shared git remote.",
  "license": "UNLICENSED",
  "type": "module",
  "engines": {
    "node": ">=20.6"
  },
  "scripts": {
    "build": "node tools/build/build.mjs",
    "typecheck": "tsc -p tsconfig.json",
    "test": "node tools/test/run-tests.mjs test/unit test/integration",
    "test:unit": "node tools/test/run-tests.mjs test/unit",
    "test:integration": "node tools/test/run-tests.mjs test/integration",
    "lint": "echo lint: no rules yet - replaced in Task 14",
    "ci": "npm run lint && npm run typecheck && npm run build && npm test"
  },
  "devDependencies": {
    "@types/node": "^20.17.10",
    "esbuild": "^0.24.2",
    "fast-check": "^3.23.2",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3"
  }
}
```

Write `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "tools/**/*.ts"]
}
```

Write `.gitignore`:

```gitignore
node_modules/
dist/
.build/
*.tsbuildinfo
```

Write `tools/test/run-tests.mjs`:

```js
// Portable test launcher: finds every *.test.ts under the given directories
// (recursively, sorted by code unit) and runs them with `tsx --test`.
// Needed because Node 20's `node --test` does not expand glob patterns and
// npm runs scripts through cmd.exe on Windows, which does not expand them either.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function collect(dir, out) {
  if (!existsSync(dir)) return;
  const names = readdirSync(dir).sort();
  for (const name of names) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (name.endsWith('.test.ts')) out.push(p);
  }
}

function tsxCliPath() {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('tsx/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.tsx;
  return join(dirname(pkgPath), bin);
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  process.stderr.write('usage: node tools/test/run-tests.mjs <dir> [<dir>...]\n');
  process.exit(2);
}
const files = [];
for (const d of dirs) collect(resolve(repoRoot, d), files);
if (files.length === 0) {
  process.stdout.write(`run-tests: no *.test.ts files under ${dirs.join(', ')}\n`);
  process.exit(0);
}
const args = [tsxCliPath(), '--test', ...files.map((f) => relative(repoRoot, f))];
const r = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' });
if (r.error) {
  process.stderr.write(`run-tests: ${r.error.message}\n`);
  process.exit(1);
}
process.exit(r.status ?? 1);
```

Run: `npm install`
Expected: `package-lock.json` and `node_modules/` are created; `npm ls --depth=0` lists `@types/node@20.x`, `esbuild@0.24.x`, `fast-check@3.x`, `tsx@4.x`, `typescript@5.x`. npm 11 may print `npm warn install-scripts ... esbuild ... (postinstall: node install.js)`: this is expected and harmless (esbuild finds its platform binary through its optional dependency without the postinstall step; Step 4 proves the build works).

- [ ] **Step 1: Write the failing tests**

Write `test/unit/version.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLUGIN_VERSION } from '../../src/version.js';

test('PLUGIN_VERSION is a semver string equal to package.json version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(PLUGIN_VERSION, pkg.version);
});

test('package.json declares devDependencies only, ESM and the Node >=20.6 dev floor', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
  assert.equal(pkg.peerDependencies, undefined);
  assert.deepEqual(pkg.engines, { node: '>=20.6' });
  assert.deepEqual(Object.keys(pkg.devDependencies as object).sort(), ['@types/node', 'esbuild', 'fast-check', 'tsx', 'typescript']);
});
```

Write `test/integration/build.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_VERSION } from '../../src/version.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const buildScript = join(repoRoot, 'tools', 'build', 'build.mjs');
const ENTRY_NAMES = ['cli', 'core', 'daemon', 'hook', 'mcp', 'worker'];

interface Metafile {
  outputs: Record<string, { imports: { path: string; kind: string; external?: boolean }[] }>;
}

test('build produces exactly the six dist entry points, each runnable on its own', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cowork-build-'));
  const out = join(tmp, 'dist');
  const metaPath = join(tmp, 'meta', 'metafile.json');
  try {
    const first = spawnSync(process.execPath, [buildScript, '--outdir', out], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(first.status, 0, `build failed:\n${first.stdout}\n${first.stderr}`);
    writeFileSync(join(out, 'stale.js'), 'leftover from an earlier build\n');

    const r = spawnSync(process.execPath, [buildScript, '--outdir', out, '--metafile', metaPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `build failed:\n${r.stdout}\n${r.stderr}`);
    assert.deepEqual(readdirSync(out).sort(), ENTRY_NAMES.map((n) => `${n}.js`));

    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Metafile;
    const outputs = Object.keys(meta.outputs);
    assert.equal(outputs.length, 6, `metafile outputs: ${outputs.join(', ')}`);
    for (const [file, info] of Object.entries(meta.outputs)) {
      for (const imp of info.imports) {
        assert.equal(imp.external, true, `${file} bundles ${imp.path} instead of importing a built-in`);
        assert.ok(imp.path.startsWith('node:'), `${file} imports non-builtin ${imp.path}`);
      }
    }

    for (const name of ENTRY_NAMES) {
      const file = join(out, `${name}.js`);
      const v = spawnSync(process.execPath, [file, '--version'], { encoding: 'utf8' });
      assert.equal(v.status, 0, `${name}.js --version failed: ${v.stderr}`);
      assert.equal(v.stdout, `cowork-sync ${name} ${PLUGIN_VERSION}\n`);

      const noop = spawnSync(process.execPath, [file], { encoding: 'utf8', input: '' });
      assert.equal(noop.status, 0, `${name}.js without arguments failed: ${noop.stderr}`);
      assert.equal(noop.stdout, '');
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('build refuses an unknown argument', () => {
  const r = spawnSync(process.execPath, [buildScript, '--bogus'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown argument --bogus/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL. Both files fail to load with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '<repo>\src\version.js' imported from <repo>\test\unit\version.test.ts` (and the same for `test\integration\build.test.ts`); the summary shows `fail 2`.

- [ ] **Step 3: Write the minimal implementation**

Write `src/version.ts`:

```ts
// Single source of the plugin version. Must equal package.json "version"
// (asserted by test/unit/version.test.ts).
export const PLUGIN_VERSION = '0.0.0';
```

Write `src/entry/hook.ts`:

```ts
// Stub entry point for dist/hook.js (glossary §6). Plan 1 only proves the
// bundle builds and runs: `--version` prints the version, anything else is a no-op.
import { PLUGIN_VERSION } from '../version.js';

if (process.argv.slice(2).includes('--version')) {
  process.stdout.write(`cowork-sync hook ${PLUGIN_VERSION}\n`);
}
```

Write `src/entry/core.ts`:

```ts
// Stub entry point for dist/core.js (glossary §6). Plan 1 only proves the
// bundle builds and runs: `--version` prints the version, anything else is a no-op.
import { PLUGIN_VERSION } from '../version.js';

if (process.argv.slice(2).includes('--version')) {
  process.stdout.write(`cowork-sync core ${PLUGIN_VERSION}\n`);
}
```

Write `src/entry/daemon.ts`:

```ts
// Stub entry point for dist/daemon.js (glossary §6). Plan 1 only proves the
// bundle builds and runs: `--version` prints the version, anything else is a no-op.
import { PLUGIN_VERSION } from '../version.js';

if (process.argv.slice(2).includes('--version')) {
  process.stdout.write(`cowork-sync daemon ${PLUGIN_VERSION}\n`);
}
```

Write `src/entry/worker.ts`:

```ts
// Stub entry point for dist/worker.js (glossary §6). Plan 1 only proves the
// bundle builds and runs: `--version` prints the version, anything else is a no-op.
import { PLUGIN_VERSION } from '../version.js';

if (process.argv.slice(2).includes('--version')) {
  process.stdout.write(`cowork-sync worker ${PLUGIN_VERSION}\n`);
}
```

Write `src/entry/mcp.ts`:

```ts
// Stub entry point for dist/mcp.js (glossary §6). Plan 1 only proves the
// bundle builds and runs: `--version` prints the version, anything else is a no-op.
import { PLUGIN_VERSION } from '../version.js';

if (process.argv.slice(2).includes('--version')) {
  process.stdout.write(`cowork-sync mcp ${PLUGIN_VERSION}\n`);
}
```

Write `src/entry/cli.ts`:

```ts
// Stub entry point for dist/cli.js (glossary §6). Plan 1 only proves the
// bundle builds and runs: `--version` prints the version, anything else is a no-op.
import { PLUGIN_VERSION } from '../version.js';

if (process.argv.slice(2).includes('--version')) {
  process.stdout.write(`cowork-sync cli ${PLUGIN_VERSION}\n`);
}
```

Write `tools/build/build.mjs`:

```js
// Bundles the six plugin entry points of glossary §6 into single-file ESM
// bundles: src/entry/<name>.ts -> <outdir>/<name>.js (default outdir: dist/).
// The output directory is emptied first, so it holds exactly the six files.
// No runtime dependencies: every import left after bundling is a Node built-in.
//
// Usage: node tools/build/build.mjs [--outdir <dir>] [--metafile <file>]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ENTRY_NAMES = ['hook', 'core', 'daemon', 'worker', 'mcp', 'cli'];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function fail(message, code) {
  process.stderr.write(`build: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { outdir: join(repoRoot, 'dist'), metafile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--outdir' || a === '--metafile') && i + 1 < argv.length) {
      opts[a.slice(2)] = resolve(argv[++i]);
    } else {
      fail(`unknown argument ${a}`, 2);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  rmSync(opts.outdir, { recursive: true, force: true });
  mkdirSync(opts.outdir, { recursive: true });
  const entryPoints = {};
  for (const name of ENTRY_NAMES) entryPoints[name] = join(repoRoot, 'src', 'entry', `${name}.ts`);
  const result = await build({
    entryPoints,
    outdir: opts.outdir,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    splitting: false,
    sourcemap: false,
    legalComments: 'none',
    charset: 'utf8',
    metafile: true,
    logLevel: 'warning',
  });
  if (opts.metafile) {
    mkdirSync(dirname(opts.metafile), { recursive: true });
    writeFileSync(opts.metafile, JSON.stringify(result.metafile, null, 2) + '\n');
  }
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err), 1));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 4 tests (`build produces exactly the six dist entry points, each runnable on its own`, `build refuses an unknown argument`, `PLUGIN_VERSION is a semver string equal to package.json version`, `package.json declares devDependencies only, ESM and the Node >=20.6 dev floor`), `fail 0`.

Run: `npm run typecheck`
Expected: exits 0 with no output from `tsc`.

Run: `npm run build` then `node dist/cli.js --version`
Expected: `dist/` contains exactly `cli.js core.js daemon.js hook.js mcp.js worker.js`; the second command prints `cowork-sync cli 0.0.0`.

Run: `npm run test:unit` and `npm run test:integration`
Expected: PASS with 2 tests each.

Run: `npm run ci`
Expected: `lint: no rules yet - replaced in Task 14`, then typecheck, build and all tests pass; exit code 0.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore tools/test/run-tests.mjs tools/build/build.mjs src/version.ts src/entry/hook.ts src/entry/core.ts src/entry/daemon.ts src/entry/worker.ts src/entry/mcp.ts src/entry/cli.ts test/unit/version.test.ts test/integration/build.test.ts
git commit -m "build: scaffold TypeScript toolchain, esbuild bundle of six entry stubs, test runner" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Two `-m` flags give the blank line between subject and trailer in Git Bash, PowerShell and `cmd.exe` alike; a `\n` inside one `-m` is not expanded by PowerShell or `cmd.exe`.)

---

### Task 2: Clock port and anchor helpers; VirtualClock

**Files:**
- Create: `src/ports/clock.ts` (Clock port, `realClock`, the single local-anchor helper of INV-CLOCK)
- Create: `test/sim/vclock.ts` (VirtualClock for SIM runs)
- Test: `test/unit/clock.test.ts`

**Interfaces:**
- Consumes: Task 1 toolchain (`npx tsx --test`, `npm run typecheck`), `fast-check` dev dependency.
- Produces (exactly as in 00-header.md):
  - `src/ports/clock.ts`:
    - `export interface Clock { monoMs(): number; wallMs(): number; sleep(ms: number): Promise<void>; }`
    - `export const realClock: Clock` — `monoMs` = `performance.now()`, `wallMs` = `Date.now()`, `sleep` = a real timer (negative `ms` treated as 0).
    - `export interface Anchor { readonly mono: number; readonly wall: number; }`
    - `export function anchorNow(clock: Clock): Anchor` — returns a frozen object.
    - `export function elapsedMono(clock: Clock, a: Anchor): number` — `max(0, Δmono)`; observer-side waits.
    - `export function ownStaleness(clock: Clock, a: Anchor): number` — `max(Δwall, Δmono)`.
    - `export function suspendGapMs(clock: Clock, a: Anchor): number` — `Δwall − Δmono` (negative when the wall clock was set back).
    - `export const SUSPEND_GAP_THRESHOLD_MS = 5000`.
    - This is the only file under `src/` allowed to read `Date.now()`, `new Date()` or `performance.now()` (lint L-CLOCK, Task 14).
  - `test/sim/vclock.ts`:
    - `export const SIM_WALL_EPOCH_MS = 1_767_225_600_000` — 2026-01-01T00:00:00Z, the fixed origin of every virtual wall clock. Task 13's tests import it from here instead of redefining it. They use it to check that peer clocks and commit dates lie in the SIM window; the harness itself never adds the epoch, and there is no default `wallMsForDates`.
    - `export class VirtualClock implements Clock` with `constructor(opts?: { wallOffsetMs?: number; startMono?: number; driftPpm?: number })`, `monoMs()`, `wallMs()`, `sleep(ms)`, `advance(ms)`, `suspend(ms)`.
    - **`wallOffsetMs` is an OFFSET from `SIM_WALL_EPOCH_MS`, never an absolute time.** A peer with a 10-minute-fast clock gets `{ wallOffsetMs: 600_000 }`; passing `SIM_WALL_EPOCH_MS + skew` adds the epoch twice and puts the clock in 2082 (a test pins this).
    - Wall time is always `wallMs() === SIM_WALL_EPOCH_MS + wallOffsetMs + A + round(A × driftPpm / 1e6) + S`, where `A` is the total passed to `advance` (and `sleep`) and `S` the total passed to `suspend`. Mono is `startMono + A`.
    - Initial values: `monoMs() === startMono` (default 0); `wallMs() === SIM_WALL_EPOCH_MS + wallOffsetMs` (default offset 0). `startMono` and the offset never produce drift. Two clocks built with the same options and fed the same steps read identical values, so commit dates and ULIDs derived from `wallMs()` are reproducible.
    - `advance(ms)`: mono moves forward by `ms`; wall moves forward by `ms × (1 + driftPpm/1e6)`. Drift accrues on the running total `A` and is rounded to whole milliseconds once (not per step), so 20 000 steps of 1 ms at 100 ppm drift exactly as far as one 20 000 ms step (2 ms), and `wallMs()` is an integer whenever the offset and the steps are integers, like `Date.now()`.
    - `suspend(ms)`: wall only moves forward by exactly `ms`, with no drift (Δwall − Δmono grows by `ms`).
    - Drift shows up in `suspendGapMs` the way a real fast or slow quartz does: +100 ppm adds 100 ms of gap per 1 000 s of `advance`; −250 ppm makes the gap negative, and `ownStaleness` still returns at least Δmono.
    - **`sleep(ms)`: calls `advance(max(0, ms))` (so drift applies) and resolves on a microtask; it never waits for real time and never blocks on another component.** Task 5's `VirtualScheduler` and Task 13's harness rely on this: code that sleeps under a VirtualClock simply moves its own peer's time forward.
    - Consumers: Task 5 (`VirtualScheduler.step` calls `advance`), Task 13 (the harness does `import { VirtualClock } from './vclock.js'`: per-peer clocks get `{ wallOffsetMs: skewMs, driftPpm }`, the scheduler clock gets no offset; Task 13's tests do `import { SIM_WALL_EPOCH_MS } from '../sim/vclock.js'`).
    - `advance`/`suspend` throw `RangeError` for a negative or non-finite `ms`. The constructor throws `RangeError` for a non-finite `wallOffsetMs`, a negative or non-finite `startMono`, or a `driftPpm` that is non-finite or has `|driftPpm| ≥ 1_000_000` (at −1e6 ppm the wall would stop; beyond it, it would run backwards). Within that range the wall never moves backwards for integer steps (property test).

- [ ] **Step 1: Write the failing test**

Write `test/unit/clock.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  type Clock,
  realClock,
  anchorNow,
  elapsedMono,
  ownStaleness,
  suspendGapMs,
  SUSPEND_GAP_THRESHOLD_MS,
} from '../../src/ports/clock.js';
import { SIM_WALL_EPOCH_MS, VirtualClock } from '../sim/vclock.js';

// One random clock step for the property tests. `as const` keeps `kind` typed as
// 'advance' | 'suspend' so `clock[s.kind](s.ms)` type-checks.
const step = fc.record({
  kind: fc.constantFrom('advance' as const, 'suspend' as const),
  ms: fc.integer({ min: 0, max: 120_000 }),
});

test('SUSPEND_GAP_THRESHOLD_MS is 5 s (11-testing §3.2)', () => {
  assert.equal(SUSPEND_GAP_THRESHOLD_MS, 5000);
});

test('realClock.monoMs never goes backwards', () => {
  let prev = realClock.monoMs();
  for (let i = 0; i < 10_000; i++) {
    const now = realClock.monoMs();
    assert.ok(now >= prev, `mono went back: ${prev} -> ${now}`);
    prev = now;
  }
});

test('realClock.wallMs is epoch milliseconds', () => {
  const before = Date.now();
  const w = realClock.wallMs();
  const after = Date.now();
  assert.ok(w >= before && w <= after, `${before} <= ${w} <= ${after}`);
});

test('realClock.sleep waits about the requested time and treats negatives as 0', async () => {
  const a = anchorNow(realClock);
  await realClock.sleep(30);
  assert.ok(elapsedMono(realClock, a) >= 25, `slept only ${elapsedMono(realClock, a)} ms`);
  await realClock.sleep(-5);
});

test('anchorNow returns a frozen {mono, wall} pair from the given clock', () => {
  const c = new VirtualClock({ startMono: 1234, wallOffsetMs: 600_000 });
  const a = anchorNow(c);
  assert.equal(a.mono, 1234);
  assert.equal(a.wall, c.wallMs());
  assert.ok(Object.isFrozen(a));
});

test('advance moves both clocks; helpers see no suspend', () => {
  const c = new VirtualClock();
  const a = anchorNow(c);
  c.advance(1000);
  assert.equal(elapsedMono(c, a), 1000);
  assert.equal(ownStaleness(c, a), 1000);
  assert.equal(suspendGapMs(c, a), 0);
});

test('suspend moves wall only: observers keep Δmono, own staleness takes Δwall', () => {
  const c = new VirtualClock();
  const a = anchorNow(c);
  c.advance(1000);
  c.suspend(7000);
  assert.equal(elapsedMono(c, a), 1000);
  assert.equal(ownStaleness(c, a), 8000);
  assert.equal(suspendGapMs(c, a), 7000);
  assert.ok(suspendGapMs(c, a) > SUSPEND_GAP_THRESHOLD_MS);
});

test('a wall clock set backwards never shortens own staleness below Δmono', () => {
  let mono = 0;
  let wall = 1_000_000;
  const c: Clock = { monoMs: () => mono, wallMs: () => wall, sleep: async () => {} };
  const a = anchorNow(c);
  mono += 2000;
  wall -= 60_000;
  assert.equal(elapsedMono(c, a), 2000);
  assert.equal(ownStaleness(c, a), 2000);
  assert.equal(suspendGapMs(c, a), -62_000);
});

test('VirtualClock: startMono, wall offset, sleep advances virtual time', async () => {
  const c0 = new VirtualClock();
  const plus = new VirtualClock({ wallOffsetMs: 600_000 });
  const minus = new VirtualClock({ wallOffsetMs: -600_000, startMono: 50 });
  assert.equal(c0.monoMs(), 0);
  assert.equal(plus.wallMs() - c0.wallMs(), 600_000);
  assert.equal(minus.wallMs() - c0.wallMs(), -600_000);
  assert.equal(minus.monoMs(), 50);
  const a = anchorNow(c0);
  await c0.sleep(250);
  assert.equal(elapsedMono(c0, a), 250);
  assert.equal(suspendGapMs(c0, a), 0);
  await c0.sleep(-10);
  assert.equal(elapsedMono(c0, a), 250);
});

test('SIM_WALL_EPOCH_MS is 2026-01-01T00:00:00Z and wallOffsetMs is an offset from it, never an absolute time', () => {
  assert.equal(SIM_WALL_EPOCH_MS, 1_767_225_600_000);
  assert.equal(new Date(SIM_WALL_EPOCH_MS).toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(new VirtualClock().wallMs(), SIM_WALL_EPOCH_MS);
  assert.equal(new VirtualClock({ wallOffsetMs: 600_000 }).wallMs(), SIM_WALL_EPOCH_MS + 600_000);
  assert.equal(new VirtualClock({ wallOffsetMs: -600_000 }).wallMs(), SIM_WALL_EPOCH_MS - 600_000);
  // The misuse this pins: passing an absolute time as the offset adds the epoch twice.
  const misused = new VirtualClock({ wallOffsetMs: SIM_WALL_EPOCH_MS });
  assert.equal(new Date(misused.wallMs()).toISOString(), '2082-01-01T00:00:00.000Z');
});

test('driftPpm: advance and sleep move wall by ms*(1+driftPpm/1e6); mono and suspend do not drift', async () => {
  const fast = new VirtualClock({ driftPpm: 100 });
  const a = anchorNow(fast);
  fast.advance(1_000_000);
  assert.equal(fast.monoMs(), 1_000_000);
  assert.equal(fast.wallMs() - SIM_WALL_EPOCH_MS, 1_000_100);
  assert.equal(suspendGapMs(fast, a), 100);
  await fast.sleep(1_000_000);
  assert.equal(fast.monoMs(), 2_000_000);
  assert.equal(fast.wallMs() - SIM_WALL_EPOCH_MS, 2_000_200);
  fast.suspend(5000);
  assert.equal(fast.monoMs(), 2_000_000);
  assert.equal(fast.wallMs() - SIM_WALL_EPOCH_MS, 2_005_200);

  // A slow clock with an offset and a start mono: neither the offset nor startMono drifts.
  const slow = new VirtualClock({ driftPpm: -250, wallOffsetMs: -600_000, startMono: 5000 });
  assert.equal(slow.wallMs(), SIM_WALL_EPOCH_MS - 600_000);
  assert.equal(slow.monoMs(), 5000);
  const b = anchorNow(slow);
  slow.advance(2_000_000);
  assert.equal(slow.wallMs() - b.wall, 1_999_500);
  assert.equal(elapsedMono(slow, b), 2_000_000);
  assert.equal(ownStaleness(slow, b), 2_000_000);
  assert.equal(suspendGapMs(slow, b), -500);
});

test('driftPpm accrues on the total advanced time: many small steps drift as far as one big step', () => {
  const small = new VirtualClock({ driftPpm: 100 });
  const big = new VirtualClock({ driftPpm: 100 });
  for (let i = 0; i < 20_000; i++) small.advance(1);
  big.advance(20_000);
  assert.equal(small.monoMs(), 20_000);
  assert.equal(small.wallMs() - SIM_WALL_EPOCH_MS, 20_002);
  assert.equal(small.wallMs(), big.wallMs());
  assert.ok(Number.isInteger(small.wallMs()));
});

test('VirtualClock rejects negative and non-finite steps and out-of-range options', () => {
  const c = new VirtualClock();
  assert.throws(() => c.advance(-1), RangeError);
  assert.throws(() => c.advance(Number.NaN), RangeError);
  assert.throws(() => c.suspend(-1), RangeError);
  assert.throws(() => c.suspend(Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => new VirtualClock({ wallOffsetMs: Number.NaN }), RangeError);
  assert.throws(() => new VirtualClock({ startMono: -1 }), RangeError);
  assert.throws(() => new VirtualClock({ driftPpm: Number.NaN }), RangeError);
  assert.throws(() => new VirtualClock({ driftPpm: 1_000_000 }), RangeError);
  assert.throws(() => new VirtualClock({ driftPpm: -1_000_000 }), RangeError);
  assert.equal(c.monoMs(), 0);
  assert.equal(c.wallMs(), SIM_WALL_EPOCH_MS);
});

test('wall never moves backwards and stays an integer for integer steps, at any allowed drift', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -999_999, max: 999_999 }),
      fc.integer({ min: -600_000, max: 600_000 }),
      fc.array(step, { maxLength: 50 }),
      (driftPpm, offset, steps) => {
        const c = new VirtualClock({ wallOffsetMs: offset, driftPpm });
        let prevWall = c.wallMs();
        let prevMono = c.monoMs();
        for (const s of steps) {
          c[s.kind](s.ms);
          const wall = c.wallMs();
          assert.ok(Number.isInteger(wall), `wall ${wall} is not an integer`);
          assert.ok(wall >= prevWall, `wall went back: ${prevWall} -> ${wall}`);
          assert.ok(c.monoMs() >= prevMono);
          prevWall = wall;
          prevMono = c.monoMs();
        }
      },
    ),
    { seed: 20261002, numRuns: 300 },
  );
});

test('INV-CLOCK: helper results do not depend on the wall offset (±600 s), at any drift', () => {
  fc.assert(
    fc.property(fc.integer({ min: -600_000, max: 600_000 }), fc.integer({ min: -1000, max: 1000 }), fc.array(step, { maxLength: 30 }), (offset, driftPpm, steps) => {
      const ref = new VirtualClock({ driftPpm });
      const off = new VirtualClock({ wallOffsetMs: offset, driftPpm });
      const aRef = anchorNow(ref);
      const aOff = anchorNow(off);
      for (const s of steps) {
        ref[s.kind](s.ms);
        off[s.kind](s.ms);
        assert.equal(elapsedMono(off, aOff), elapsedMono(ref, aRef));
        assert.equal(ownStaleness(off, aOff), ownStaleness(ref, aRef));
        assert.equal(suspendGapMs(off, aOff), suspendGapMs(ref, aRef));
      }
    }),
    { seed: 20261002, numRuns: 200 },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/unit/clock.test.ts`
Expected: FAIL — the file does not load: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '<repo>\src\ports\clock.js' imported from <repo>\test\unit\clock.test.ts`.

- [ ] **Step 3: Write minimal implementation**

Write `src/ports/clock.ts`:

```ts
// Clock port (11-testing §3.2) and the single local-anchor helper (INV-CLOCK,
// glossary §21; 02-protocol PRO-10). This is the only file in src/ that may
// read Date.now(), new Date() or performance.now() (lint L-CLOCK).
//
// Rules the helpers encode:
// - Every timer is a Δ from a local anchor; no wall reading is ever compared
//   with a reading from another machine.
// - Observers (waiting on someone else) use Δmono, which does not count
//   suspend, so they err toward waiting longer.
// - A peer judging its own staleness uses max(Δwall, Δmono), so it errs
//   toward "I may be stale".
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export interface Clock {
  /** Monotonic milliseconds; never goes backwards within a process. */
  monoMs(): number;
  /** Wall-clock milliseconds since the Unix epoch. */
  wallMs(): number;
  /** Resolves after `ms` milliseconds of this clock's time (negative = 0). */
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  monoMs: () => performance.now(),
  wallMs: () => Date.now(),
  sleep: async (ms: number) => {
    await delay(Math.max(0, ms));
  },
};

export interface Anchor {
  readonly mono: number;
  readonly wall: number;
}

export const SUSPEND_GAP_THRESHOLD_MS = 5000;

export function anchorNow(clock: Clock): Anchor {
  return Object.freeze({ mono: clock.monoMs(), wall: clock.wallMs() });
}

/** Observer-side wait: Δmono since the anchor, never negative. */
export function elapsedMono(clock: Clock, a: Anchor): number {
  return Math.max(0, clock.monoMs() - a.mono);
}

/** Own staleness: max(Δwall, Δmono), so a suspend or a forward wall jump counts. */
export function ownStaleness(clock: Clock, a: Anchor): number {
  return Math.max(clock.wallMs() - a.wall, elapsedMono(clock, a));
}

/** Δwall − Δmono since the anchor; above SUSPEND_GAP_THRESHOLD_MS means the PC slept. Negative when the wall clock was set back. */
export function suspendGapMs(clock: Clock, a: Anchor): number {
  return clock.wallMs() - a.wall - (clock.monoMs() - a.mono);
}
```

Write `test/sim/vclock.ts`:

```ts
// VirtualClock: per-peer virtual time for SIM runs (11-testing §3.2; F-PEER-4
// wall offset, drift and suspend gaps).
//   mono = startMono + A
//   wall = SIM_WALL_EPOCH_MS + wallOffsetMs + A + round(A * driftPpm / 1e6) + S
// where A is the total passed to advance()/sleep() and S the total passed to
// suspend(). Drift is computed from the running total and rounded once, so it
// is never lost to per-step rounding and wall stays an integer for integer
// steps. Two clocks with the same options fed the same steps read identical
// values, so commit dates derived from wallMs() give reproducible commit oids.
import type { Clock } from '../../src/ports/clock.js';

/** 2026-01-01T00:00:00Z: fixed origin of every virtual wall clock. `wallOffsetMs` is relative to it. */
export const SIM_WALL_EPOCH_MS = 1_767_225_600_000;

const PPM = 1_000_000;

function checkStep(what: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`VirtualClock.${what}: expected a finite ms >= 0, got ${ms}`);
}

export class VirtualClock implements Clock {
  private readonly startMono: number;
  /** SIM_WALL_EPOCH_MS + wallOffsetMs. */
  private readonly wallBase: number;
  private readonly driftPpm: number;
  /** A: total advanced (both clocks). */
  private advancedMs = 0;
  /** S: total suspended (wall only, no drift). */
  private suspendedMs = 0;

  /**
   * @param opts.wallOffsetMs OFFSET from SIM_WALL_EPOCH_MS (e.g. ±600_000 for a skewed peer), never an absolute time. Default 0.
   * @param opts.startMono initial monoMs(), >= 0. Default 0.
   * @param opts.driftPpm wall runs fast (+) or slow (−) by this many parts per million of advanced time; |driftPpm| < 1e6. Default 0.
   */
  constructor(opts?: { wallOffsetMs?: number; startMono?: number; driftPpm?: number }) {
    const offset = opts?.wallOffsetMs ?? 0;
    const start = opts?.startMono ?? 0;
    const drift = opts?.driftPpm ?? 0;
    if (!Number.isFinite(offset)) throw new RangeError(`VirtualClock: wallOffsetMs must be finite, got ${offset}`);
    if (!Number.isFinite(start) || start < 0) throw new RangeError(`VirtualClock: startMono must be finite and >= 0, got ${start}`);
    if (!Number.isFinite(drift) || Math.abs(drift) >= PPM) {
      throw new RangeError(`VirtualClock: driftPpm must be finite with |driftPpm| < ${PPM}, got ${drift}`);
    }
    this.startMono = start;
    this.wallBase = SIM_WALL_EPOCH_MS + offset;
    this.driftPpm = drift;
  }

  monoMs(): number {
    return this.startMono + this.advancedMs;
  }

  wallMs(): number {
    const driftMs = Math.round((this.advancedMs * this.driftPpm) / PPM);
    return this.wallBase + this.advancedMs + driftMs + this.suspendedMs;
  }

  /** Advances virtual time by max(0, ms) via advance() (so drift applies) and resolves on a microtask; never waits for real time. */
  async sleep(ms: number): Promise<void> {
    this.advance(Math.max(0, ms));
  }

  /** Mono moves forward by `ms`; wall by `ms * (1 + driftPpm / 1e6)`, accrued on the running total. */
  advance(ms: number): void {
    checkStep('advance', ms);
    this.advancedMs += ms;
  }

  /** The PC sleeps for `ms`: wall moves by exactly `ms` (no drift), mono does not (Δwall − Δmono grows by ms). */
  suspend(ms: number): void {
    checkStep('suspend', ms);
    this.suspendedMs += ms;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/unit/clock.test.ts`
Expected: PASS — 15 tests, `fail 0`.

Run: `npm run typecheck`
Expected: exits 0. (If `c[s.kind]` or `ref[s.kind]` reports TS7053, the `as const` on the `fc.constantFrom` arguments of the shared `step` arbitrary was dropped; it is required so `s.kind` has type `'advance' | 'suspend'`.)

- [ ] **Step 5: Commit**

```bash
git add src/ports/clock.ts test/sim/vclock.ts test/unit/clock.test.ts
git commit -m "feat(ports): Clock port with local-anchor helpers (INV-CLOCK) and VirtualClock" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Random port (real + seeded), randomHex, randomInt, ulid

**Files:**
- Create: `src/ports/random.ts`
- Test: `test/unit/random.test.ts`

**Interfaces:**
- Consumes: `import type { Clock } from './clock.js'` (`src/ports/clock.ts`, Task 2) — only `clock.wallMs()` is read, by `ulid`.
- Produces (exactly as in 00-header.md):
  - `export interface Random { bytes(n: number): Uint8Array; }` — `n` must be an integer ≥ 0, else `RangeError`.
  - `export const realRandom: Random` — `crypto.randomBytes`, copied into a plain `Uint8Array`.
  - `export function seededRandom(seed: string): Random` — sfc32 whose 128-bit state is the first 16 bytes of `sha256(UTF-8 seed)` read as four little-endian uint32 (a, b, c, d), warmed up by 12 discarded outputs; each 32-bit output is emitted little-endian into one continuous byte stream, so `bytes(3)` then `bytes(5)` equals `bytes(8)` from a fresh generator with the same seed. Golden vector: `randomHex(seededRandom('cowork'), 16) === '9cd5ba725424fadd4621fed4bd155f99'`.
  - `export function randomHex(r: Random, nBytes: number): string` — lowercase hex, `2 * nBytes` chars.
  - `export function randomInt(r: Random, maxExclusive: number): number` — uniform in `[0, maxExclusive)`, `1 ≤ maxExclusive ≤ 2^32` (else `RangeError`); draws 4 bytes as a little-endian uint32 and rejects values `≥ 2^32 − (2^32 mod maxExclusive)` (no modulo bias).
  - `export function ulid(r: Random, clock: Clock): string` — 26 chars of Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`): 10 chars of `floor(clock.wallMs())` as a 48-bit integer (`RangeError` outside `[0, 2^48 − 1]`), then 16 chars encoding exactly 10 bytes from `r.bytes(10)` big-endian, 5 bits per char. Not monotonic within one millisecond; uniqueness comes from the 80 random bits, and no decision may order ULIDs from different machines (INV-CLOCK).
  - This is the only file under `src/` allowed to use `crypto.randomBytes`, `randomUUID` or `Math.random` (lint L-RANDOM, Task 14).

- [ ] **Step 1: Write the failing test**

Write `test/unit/random.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import type { Clock } from '../../src/ports/clock.js';
import { type Random, realRandom, seededRandom, randomHex, randomInt, ulid } from '../../src/ports/random.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function fixedClock(wall: number): Clock {
  return { monoMs: () => 0, wallMs: () => wall, sleep: async () => {} };
}

/** A Random that replays the given bytes, then throws. */
function scripted(bytes: number[]): Random {
  let i = 0;
  return {
    bytes(n: number): Uint8Array {
      if (i + n > bytes.length) throw new Error('scripted Random exhausted');
      const out = Uint8Array.from(bytes.slice(i, i + n));
      i += n;
      return out;
    },
  };
}

/** Independent reference sfc32 (public-domain formulation). */
function referenceSfc32(seed: string, nBytes: number): string {
  const h = createHash('sha256').update(seed, 'utf8').digest();
  let a = h.readUInt32LE(0), b = h.readUInt32LE(4), c = h.readUInt32LE(8), d = h.readUInt32LE(12);
  const next = (): number => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) next();
  const out = Buffer.alloc(Math.ceil(nBytes / 4) * 4);
  for (let i = 0; i < out.length; i += 4) out.writeUInt32LE(next(), i);
  return out.subarray(0, nBytes).toString('hex');
}

function decodeUlidRandom(s: string): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const ch of s) {
    acc = (acc << 5) | CROCKFORD.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}

test('realRandom returns n fresh bytes', () => {
  const a = realRandom.bytes(32);
  const b = realRandom.bytes(32);
  assert.ok(a instanceof Uint8Array);
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, b);
  assert.equal(realRandom.bytes(0).length, 0);
  assert.throws(() => realRandom.bytes(-1), RangeError);
  assert.throws(() => realRandom.bytes(1.5), RangeError);
});

test('seededRandom: golden vectors (sfc32 seeded from sha256, 12 warm-up rounds)', () => {
  assert.equal(randomHex(seededRandom('cowork'), 16), '9cd5ba725424fadd4621fed4bd155f99');
  assert.equal(randomHex(seededRandom(''), 8), '3ce97530734d55cb');
  assert.equal(randomHex(seededRandom('홍길동'), 8), 'c28a951704848970');
  for (const seed of ['cowork', '', 'seed-1', '홍길동']) {
    assert.equal(randomHex(seededRandom(seed), 37), referenceSfc32(seed, 37), `seed ${JSON.stringify(seed)}`);
  }
});

test('seededRandom: same seed same stream, different seed different stream', () => {
  assert.deepEqual(seededRandom('a').bytes(64), seededRandom('a').bytes(64));
  assert.notDeepEqual(seededRandom('a').bytes(64), seededRandom('b').bytes(64));
  assert.throws(() => seededRandom('a').bytes(-1), RangeError);
});

test('seededRandom: the byte stream does not depend on how it is split into calls', () => {
  fc.assert(
    fc.property(fc.string(), fc.array(fc.integer({ min: 0, max: 17 }), { maxLength: 20 }), (seed, sizes) => {
      const total = sizes.reduce((s, n) => s + n, 0);
      const r = seededRandom(seed);
      const parts = Buffer.concat(sizes.map((n) => r.bytes(n)));
      assert.deepEqual(parts, Buffer.from(seededRandom(seed).bytes(total)));
    }),
    { seed: 20261002, numRuns: 200 },
  );
});

test('randomHex: lowercase hex, 2*nBytes chars', () => {
  const r = seededRandom('hex');
  assert.match(randomHex(r, 8), /^[0-9a-f]{16}$/);
  assert.equal(randomHex(r, 0), '');
  assert.equal(randomHex(scripted([0xab, 0x01, 0xff]), 3), 'ab01ff');
});

test('randomInt: argument checks', () => {
  const r = seededRandom('int');
  for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 32 + 1]) {
    assert.throws(() => randomInt(r, bad), RangeError, `maxExclusive ${bad}`);
  }
  assert.equal(randomInt(r, 1), 0);
  const big = randomInt(r, 2 ** 32);
  assert.ok(Number.isInteger(big) && big >= 0 && big < 2 ** 32);
});

test('randomInt: rejects the biased tail instead of taking a modulo', () => {
  // 2^32 mod 3 = 1, so 0xFFFFFFFF is the only rejected value for max 3.
  const r = scripted([0xff, 0xff, 0xff, 0xff, 0x05, 0x00, 0x00, 0x00]);
  assert.equal(randomInt(r, 3), 2);
});

test('randomInt: every value in range, roughly uniform', () => {
  const r = seededRandom('uniform');
  const counts = new Array<number>(6).fill(0);
  for (let i = 0; i < 60_000; i++) {
    const v = randomInt(r, 6);
    assert.ok(v >= 0 && v < 6);
    counts[v]!++;
  }
  for (const c of counts) assert.ok(c > 9_400 && c < 10_600, `bucket count ${c}`);
});

test('ulid: time part follows the ULID spec example', () => {
  const zeros: Random = { bytes: (n) => new Uint8Array(n) };
  const ones: Random = { bytes: (n) => new Uint8Array(n).fill(0xff) };
  assert.equal(ulid(zeros, fixedClock(1469918176385)), '01ARYZ6S410000000000000000');
  assert.equal(ulid(ones, fixedClock(0)), '0000000000ZZZZZZZZZZZZZZZZ');
  assert.equal(ulid(zeros, fixedClock(2 ** 48 - 1)), '7ZZZZZZZZZ0000000000000000');
  assert.throws(() => ulid(zeros, fixedClock(2 ** 48)), RangeError);
  assert.throws(() => ulid(zeros, fixedClock(-1)), RangeError);
});

test('ulid: golden value from a seeded Random and a fixed wall time', () => {
  assert.equal(ulid(seededRandom('cowork'), fixedClock(1_767_225_600_000)), '01KDVDNA00KKAVMWJM4KXDTHH1');
});

test('ulid: 26 Crockford chars whose random part round-trips the 10 random bytes', () => {
  fc.assert(
    fc.property(fc.uint8Array({ minLength: 10, maxLength: 10 }), fc.integer({ min: 0, max: 2 ** 48 - 1 }), (bytes, wall) => {
      const id = ulid(scripted([...bytes]), fixedClock(wall));
      assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
      assert.deepEqual(decodeUlidRandom(id.slice(10)), [...bytes]);
      let t = 0;
      for (const ch of id.slice(0, 10)) t = t * 32 + CROCKFORD.indexOf(ch);
      assert.equal(t, wall);
    }),
    { seed: 20261002, numRuns: 300 },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/unit/random.test.ts`
Expected: FAIL — the file does not load: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '<repo>\src\ports\random.js' imported from <repo>\test\unit\random.test.ts`.

- [ ] **Step 3: Write minimal implementation**

Write `src/ports/random.ts`:

```ts
// Random port (11-testing §3.2). This is the only file in src/ that may use
// crypto.randomBytes, randomUUID or Math.random (lint L-RANDOM).
// Release builds bind realRandom; SIM runs bind seededRandom(seed) so that
// peer ids, ULIDs, nonces and preview ids are reproducible (TST-03).
import { createHash, randomBytes } from 'node:crypto';
import type { Clock } from './clock.js';

export interface Random {
  /** n fresh bytes (n: integer >= 0). */
  bytes(n: number): Uint8Array;
}

function checkCount(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`Random.bytes: n must be an integer >= 0, got ${n}`);
}

export const realRandom: Random = {
  bytes(n: number): Uint8Array {
    checkCount(n);
    return new Uint8Array(randomBytes(n));
  },
};

/**
 * Deterministic PRNG: sfc32 whose 128-bit state is the first 16 bytes of
 * sha256(UTF-8 seed) read as four little-endian uint32, warmed up by 12
 * discarded outputs. Output words are emitted little-endian as one byte
 * stream, so bytes(3) followed by bytes(5) equals bytes(8).
 */
export function seededRandom(seed: string): Random {
  const h = createHash('sha256').update(seed, 'utf8').digest();
  let a = h.readUInt32LE(0);
  let b = h.readUInt32LE(4);
  let c = h.readUInt32LE(8);
  let d = h.readUInt32LE(12);
  const next = (): number => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) next();
  let word = 0;
  let left = 0;
  return {
    bytes(n: number): Uint8Array {
      checkCount(n);
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (left === 0) {
          word = next();
          left = 4;
        }
        out[i] = word & 0xff;
        word >>>= 8;
        left--;
      }
      return out;
    },
  };
}

export function randomHex(r: Random, nBytes: number): string {
  return Buffer.from(r.bytes(nBytes)).toString('hex');
}

const TWO_POW_32 = 0x1_0000_0000;

/** Uniform integer in [0, maxExclusive), 1 <= maxExclusive <= 2^32, by rejection sampling on uint32 (no modulo bias). */
export function randomInt(r: Random, maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > TWO_POW_32) {
    throw new RangeError(`randomInt: maxExclusive must be an integer in [1, 2^32], got ${maxExclusive}`);
  }
  const limit = TWO_POW_32 - (TWO_POW_32 % maxExclusive);
  for (;;) {
    const b = r.bytes(4);
    const u = (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
    if (u < limit) return u % maxExclusive;
  }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_TIME_MAX = 2 ** 48 - 1;

/**
 * ULID (26 chars, Crockford base32): 10 chars of the 48-bit wall-clock
 * millisecond timestamp, then 16 chars of 80 random bits. Ids are unique by
 * their random part; the time part is informational only (INV-CLOCK: no
 * decision may order ULIDs from different machines).
 */
export function ulid(r: Random, clock: Clock): string {
  const ms = Math.floor(clock.wallMs());
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > ULID_TIME_MAX) throw new RangeError(`ulid: wall time out of range: ${ms}`);
  let time = '';
  let t = ms;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const bytes = r.bytes(10);
  let rand = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rand += CROCKFORD[(acc >>> bits) & 31]!;
    }
    acc &= (1 << bits) - 1;
  }
  return time + rand;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/unit/random.test.ts`
Expected: PASS — 11 tests, `fail 0`.

Run: `npm run typecheck`
Expected: exits 0.

Run: `npm test`
Expected: PASS — every test of Tasks 1–3 (26 tests), `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/ports/random.ts test/unit/random.test.ts
git commit -m "feat(ports): Random port with seeded sfc32, randomHex, unbiased randomInt and ulid" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Fs port and FaultFs

Spec: 11-testing §3.2 (`Fs` row: "read/write/rename/link/unlink/stat/lock-probe, all on `Buffer`s … SIM binding: real disk + fault hooks: fail rename/link/write with EACCES/EPERM/EBUSY/ENOSPC"), fault F-FS-1 (POSIX EACCES emulation via the `Fs` port), F-FS-8 (filesystem without hard links: every `link` fails), glossary §26.1 W1/W3 (one short share-all read per user file; Node's `fs.readFile` opens with `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE` on Windows and closes right after the read), lint L-UTF8-WRITE. The `lock-probe` method and the SIM binding's lock/delay emulation quoted from that row are **not** built here; see the deferral decision below.

Decisions fixed by this task:
- `realFs` is a thin `node:fs/promises` wrapper. Every method takes or returns `Buffer`s; `writeFile` refuses a non-`Buffer` at run time as well (a string slipped past a cast is the M11 defect).
- `stat` maps **only** `ENOENT` to `null`; every other error is rethrown.
- `readdir` sorts by UTF-16 code unit (`a < b`), never by locale or code point, so the order is the same on NTFS, APFS and ext4 (Review Focus 5).
- `rmrf` is `fs.rm(p, { recursive: true, force: true, maxRetries: 3 })`: a missing path is fine, and Windows' transient `EBUSY`/`EPERM` on just-closed handles is retried.
- `FaultFs` errors are built exactly like Node's own fs errors: a plain `Error` (not a subclass) with the platform's negative libuv `errno` and description taken from `util.getSystemErrorMap()`, `code`, `syscall`, `path`, and `dest` for `rename`/`link`; message `"<CODE>: <description>, <syscall> '<path>'"` plus `" -> '<dest>'"` for two-path calls. Syscalls: `readFile` → `open`, `writeFile` → `open` (`write` for `ENOSPC`), `rename` → `rename`, `link` → `link`, `unlink` → `unlink`.
- Deliberate deviation: an injected `ENOSPC` on `writeFile` also carries `path`. A real one from `fs.promises.writeFile` comes from the fd-based `write` call and has no `path`. The task text requires `path` on every injected error, so do not "fix" this toward the real shape without changing that requirement.
- Rule matching: the first rule in insertion order whose `op` matches and whose `pathIncludes` is a substring of the path (for `rename`/`link`: of either path). Each hit decrements `times`; the rule is dropped at 0. `times: Infinity` is allowed (F-FS-8: every `link` fails). `times <= 0` or `NaN` is refused by `addRule`.
- A faulted call throws **before** delegating, so it has no side effect on disk.
- `hits` key = `` `${op}:${code}:${pathIncludes}` ``, one counter per rule, incremented on every injected failure (header Interfaces, `test/sim/faultfs.ts`). Example: the rule `{ op: 'writeFile', pathIncludes: 'target-busy', code: 'EBUSY', times: 2 }` counts under `'writeFile:EBUSY:target-busy'`. Two rules with the same `op`, `code` and `pathIncludes` share one key and therefore one counter. A rule that never fires has no entry (`hits.get(key)` is `undefined`, not `0`).
- `stat`, `mkdirp`, `readdir`, `rmrf` are never faulted (not in `FaultOp`); they pass through.
- **Deferred to Plan 2 (not silently omitted):** the `Fs` port has no lock probe and no `fsync`, and `FaultFs`/`FaultRule` have no delay or lock emulation, although 11-testing §3.2's `Fs` row lists "lock-probe" and the SIM binding's "emulate locks, delay" (`fsync` is also needed by `deny.prerecord`, 06 §3.6.6). Header Interfaces: "Lock probe, fsync and delay/lock emulation (11-testing §3.2 Fs row) are added by Plan 2, whose verifying writer is their first user." Do not add `lockProbe`, `fsync`, a `delayMs` rule field or a `'locked'` fault kind in this task: no Plan 1 code calls them, and their semantics (what a probe returns while another process holds the file; whether a delayed call advances the `VirtualClock`) are fixed by that writer's spec. Plan 2 extends `Fs`, `realFs`, `FaultOp`/`FaultRule` and `FaultFs` together, so every `Fs` implementation gains the methods in the same commit.

**Files:**
- Create: `src/ports/fs.ts`
- Create: `test/sim/faultfs.ts`
- Test: `test/unit/fs.test.ts`
- Test: `test/unit/faultfs.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (Task 1's toolchain only: `npx tsx --test`).
- Produces:
  - `src/ports/fs.ts`: `export interface FsStat { size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean; }`, `export interface Fs { readFile(p: string): Promise<Buffer>; writeFile(p: string, data: Buffer): Promise<void>; rename(from: string, to: string): Promise<void>; link(existing: string, newPath: string): Promise<void>; unlink(p: string): Promise<void>; stat(p: string): Promise<FsStat | null>; mkdirp(p: string): Promise<void>; readdir(p: string): Promise<string[]>; rmrf(p: string): Promise<void>; }`, `export const realFs: Fs`.
  - `test/sim/faultfs.ts`: `export type FaultOp = 'readFile' | 'writeFile' | 'rename' | 'link' | 'unlink'`, `export interface FaultRule { op: FaultOp; pathIncludes: string; code: 'EACCES' | 'EPERM' | 'EBUSY' | 'ENOSPC'; times: number; }`, `export class FaultFs implements Fs { constructor(inner: Fs); addRule(r: FaultRule): void; readonly hits: Map<string, number>; /* key `${op}:${code}:${pathIncludes}`, one counter per rule; + Fs methods */ }`.
  - Not produced (Plan 2, per the header): lock probe, `fsync`, delay/lock emulation.

- [ ] **Step 1: Write the failing test for `realFs`**

Create `test/unit/fs.test.ts`:

```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realFs } from '../../src/ports/fs.js';

// Temp dir with a space and non-ASCII characters (Review Focus 1 flavour);
// makeTempRoot() arrives only in Task 9, so this test builds its own.
let base = '';
let dir = '';

before(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowork-fs-'));
  dir = path.join(base, '공 백 dir');
  await fsp.mkdir(dir);
});

after(async () => {
  await fsp.rm(base, { recursive: true, force: true, maxRetries: 3 });
});

// UTF-8 BOM, "a", CRLF, NUL, invalid UTF-8 (0xFF 0xFE), "b", LF.
const BYTES = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x00, 0xff, 0xfe, 0x62, 0x0a]);

async function caught(p: Promise<unknown>): Promise<NodeJS.ErrnoException> {
  try {
    await p;
  } catch (e) {
    return e as NodeJS.ErrnoException;
  }
  throw new Error('expected the promise to reject');
}

test('writeFile then readFile round-trips bytes exactly', async () => {
  const p = path.join(dir, 'bytes.bin');
  await realFs.writeFile(p, BYTES);
  const back = await realFs.readFile(p);
  assert.ok(Buffer.isBuffer(back));
  assert.deepEqual(back, BYTES);
});

test('writeFile refuses a string at run time', async () => {
  const p = path.join(dir, 'string.txt');
  const err = await caught(realFs.writeFile(p, 'text' as unknown as Buffer));
  assert.ok(err instanceof TypeError);
  assert.equal(await realFs.stat(p), null);
});

test('stat returns null for a missing path and fields for files and directories', async () => {
  assert.equal(await realFs.stat(path.join(dir, 'missing.txt')), null);

  const f = path.join(dir, 'stat.bin');
  await realFs.writeFile(f, BYTES);
  const fs1 = await realFs.stat(f);
  assert.ok(fs1 !== null);
  assert.equal(fs1.size, BYTES.length);
  assert.equal(fs1.isFile, true);
  assert.equal(fs1.isDirectory, false);
  assert.equal(typeof fs1.mtimeMs, 'number');
  assert.ok(fs1.mtimeMs > 0);

  const d = await realFs.stat(dir);
  assert.ok(d !== null);
  assert.equal(d.isFile, false);
  assert.equal(d.isDirectory, true);
});

test('rename replaces an existing target', async () => {
  const a = path.join(dir, 'rename-a.txt');
  const b = path.join(dir, 'rename-b.txt');
  await realFs.writeFile(a, Buffer.from('new\n'));
  await realFs.writeFile(b, Buffer.from('old\n'));
  await realFs.rename(a, b);
  assert.equal(await realFs.stat(a), null);
  assert.deepEqual(await realFs.readFile(b), Buffer.from('new\n'));
});

test('link creates a second name that outlives the first', async () => {
  const a = path.join(dir, 'link-a.txt');
  const b = path.join(dir, 'link-b.txt');
  await realFs.writeFile(a, BYTES);
  await realFs.link(a, b);
  await realFs.unlink(a);
  assert.equal(await realFs.stat(a), null);
  assert.deepEqual(await realFs.readFile(b), BYTES);
});

test('unlink of a missing file rejects with a real ENOENT', async () => {
  const p = path.join(dir, 'never-existed.txt');
  const err = await caught(realFs.unlink(p));
  assert.equal(err.code, 'ENOENT');
  assert.equal(err.syscall, 'unlink');
  assert.equal(err.path, p);
});

test('mkdirp creates nested directories and is idempotent', async () => {
  const deep = path.join(dir, 'x', 'y y', 'z');
  await realFs.mkdirp(deep);
  await realFs.mkdirp(deep);
  const s = await realFs.stat(deep);
  assert.ok(s !== null && s.isDirectory);
});

test('readdir returns names in UTF-16 code-unit order', async () => {
  const sub = path.join(dir, 'sorted');
  await realFs.mkdirp(sub);
  // Created in a scrambled order. No case pairs (NTFS/APFS are case-insensitive)
  // and no Hangul (HFS+ would return NFD). '😀' (U+1F600, code units D83D DE00)
  // sorts BEFORE 'ｚ' (U+FF5A) by code unit but AFTER it by code point.
  const names = ['ｚ.txt', 'b.txt', '😀.txt', '9', '_x', 'A.txt', '10'];
  for (const n of names) await realFs.writeFile(path.join(sub, n), Buffer.from(n));
  assert.deepEqual(await realFs.readdir(sub), ['10', '9', 'A.txt', '_x', 'b.txt', '😀.txt', 'ｚ.txt']);
});

test('rmrf removes a tree and ignores a missing path', async () => {
  const t = path.join(dir, 'tree');
  await realFs.mkdirp(path.join(t, 'a', 'b'));
  await realFs.writeFile(path.join(t, 'a', 'b', 'f.bin'), BYTES);
  await realFs.rmrf(t);
  assert.equal(await realFs.stat(t), null);
  await realFs.rmrf(t);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/unit/fs.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (cannot find module `src/ports/fs.js`); no test passes.

- [ ] **Step 3: Write minimal implementation**

Create `src/ports/fs.ts`:

```ts
// Fs port (11-testing §3.2). Every read and write of user and cowork files under
// src/ goes through this interface, on Buffers only (lint L-UTF8-WRITE).
// Production binds realFs; SIM binds test/sim/faultfs.ts over realFs.
// Lock probe and fsync are not part of the port yet: Plan 2 adds them with the verifying writer.
import { promises as fsp } from 'node:fs';

export interface FsStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
}

export interface Fs {
  readFile(p: string): Promise<Buffer>;
  writeFile(p: string, data: Buffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  link(existing: string, newPath: string): Promise<void>;
  unlink(p: string): Promise<void>;
  stat(p: string): Promise<FsStat | null>; // null on ENOENT
  mkdirp(p: string): Promise<void>;
  readdir(p: string): Promise<string[]>; // sorted by code unit
  rmrf(p: string): Promise<void>;
}

function hasCode(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === code;
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const realFs: Fs = {
  // One open + whole-file read + close. On Windows libuv opens with share-all
  // (read|write|delete), so an editor's save is never blocked by a held handle
  // beyond this single call (glossary §26.1 W1, W3).
  async readFile(p: string): Promise<Buffer> {
    return fsp.readFile(p);
  },

  async writeFile(p: string, data: Buffer): Promise<void> {
    if (!Buffer.isBuffer(data)) {
      throw new TypeError(`Fs.writeFile requires a Buffer (got ${typeof data}) for ${p}`);
    }
    await fsp.writeFile(p, data);
  },

  async rename(from: string, to: string): Promise<void> {
    await fsp.rename(from, to);
  },

  async link(existing: string, newPath: string): Promise<void> {
    await fsp.link(existing, newPath);
  },

  async unlink(p: string): Promise<void> {
    await fsp.unlink(p);
  },

  async stat(p: string): Promise<FsStat | null> {
    try {
      const s = await fsp.stat(p);
      return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() };
    } catch (e) {
      if (hasCode(e, 'ENOENT')) return null;
      throw e;
    }
  },

  async mkdirp(p: string): Promise<void> {
    await fsp.mkdir(p, { recursive: true });
  },

  async readdir(p: string): Promise<string[]> {
    const names = await fsp.readdir(p);
    return names.sort(byCodeUnit);
  },

  async rmrf(p: string): Promise<void> {
    await fsp.rm(p, { recursive: true, force: true, maxRetries: 3 });
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/unit/fs.test.ts`
Expected: PASS — 9 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/ports/fs.ts test/unit/fs.test.ts
git commit -m "feat(ports): add Buffer-only Fs port with code-unit sorted readdir" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Write the failing test for `FaultFs`**

Create `test/unit/faultfs.test.ts`:

```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSystemErrorName } from 'node:util';
import { realFs } from '../../src/ports/fs.js';
import { FaultFs } from '../sim/faultfs.js';

type FsErr = NodeJS.ErrnoException & { dest?: string };

let base = '';
let dir = '';

before(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowork-faultfs-'));
  dir = path.join(base, '공 백 dir');
  await fsp.mkdir(dir);
});

after(async () => {
  await fsp.rm(base, { recursive: true, force: true, maxRetries: 3 });
});

async function caught(p: Promise<unknown>): Promise<FsErr> {
  try {
    await p;
  } catch (e) {
    return e as FsErr;
  }
  throw new Error('expected the promise to reject');
}

test('a rule fails the matching op `times` times, then passes through', async () => {
  const ffs = new FaultFs(realFs);
  const p = path.join(dir, 'target-busy.txt');
  ffs.addRule({ op: 'writeFile', pathIncludes: 'target-busy', code: 'EBUSY', times: 2 });

  for (let i = 0; i < 2; i++) {
    const err = await caught(ffs.writeFile(p, Buffer.from('x\n')));
    assert.equal(err.code, 'EBUSY');
    assert.equal(err.syscall, 'open');
    assert.equal(err.path, p);
  }
  await ffs.writeFile(p, Buffer.from('ok\n'));
  assert.deepEqual(await ffs.readFile(p), Buffer.from('ok\n'));
  assert.equal(ffs.hits.get('writeFile:EBUSY:target-busy'), 2);
});

test('injected errors are indistinguishable in shape from real Node fs errors', async () => {
  const missing = path.join(dir, 'missing-for-shape.txt');
  const real = await caught(realFs.unlink(missing));

  const ffs = new FaultFs(realFs);
  const victim = path.join(dir, 'victim.txt');
  await realFs.writeFile(victim, Buffer.from('v\n'));
  ffs.addRule({ op: 'unlink', pathIncludes: 'victim', code: 'EPERM', times: 1 });
  const fake = await caught(ffs.unlink(victim));

  assert.equal(fake.constructor, Error);
  assert.equal(real.constructor, Error);
  assert.deepEqual(Object.keys(fake).sort(), Object.keys(real).sort());
  assert.equal(fake.code, 'EPERM');
  assert.equal(fake.syscall, 'unlink');
  assert.equal(fake.path, victim);
  assert.equal(typeof fake.errno, 'number');
  assert.equal(getSystemErrorName(fake.errno as number), 'EPERM');
  assert.match(fake.message, /^EPERM: [^,]+, unlink '.+'$/);
  assert.ok(fake.message.endsWith(`unlink '${victim}'`));
  // The faulted unlink had no side effect.
  assert.deepEqual(await realFs.readFile(victim), Buffer.from('v\n'));
});

test('rename and link errors carry dest like real ones and match either path', async () => {
  const realRename = await caught(realFs.rename(path.join(dir, 'nope-a'), path.join(dir, 'nope-b')));

  const ffs = new FaultFs(realFs);
  const from = path.join(dir, 'r-from.txt');
  const to = path.join(dir, 'r-to.locked');
  await realFs.writeFile(from, Buffer.from('r\n'));
  ffs.addRule({ op: 'rename', pathIncludes: '.locked', code: 'EACCES', times: 1 });
  const fake = await caught(ffs.rename(from, to));

  assert.deepEqual(Object.keys(fake).sort(), Object.keys(realRename).sort());
  assert.equal(fake.code, 'EACCES');
  assert.equal(fake.syscall, 'rename');
  assert.equal(fake.path, from);
  assert.equal(fake.dest, to);
  assert.ok(fake.message.endsWith(`rename '${from}' -> '${to}'`));
  assert.equal(await realFs.stat(to), null);

  ffs.addRule({ op: 'link', pathIncludes: 'r-from', code: 'EPERM', times: 1 });
  const linkErr = await caught(ffs.link(from, path.join(dir, 'r-link.txt')));
  assert.equal(linkErr.syscall, 'link');
  assert.equal(linkErr.dest, path.join(dir, 'r-link.txt'));
});

test('times: Infinity fails every call (filesystem without hard links, F-FS-8)', async () => {
  const ffs = new FaultFs(realFs);
  const src = path.join(dir, 'nolink-src.txt');
  await realFs.writeFile(src, Buffer.from('n\n'));
  ffs.addRule({ op: 'link', pathIncludes: '', code: 'EPERM', times: Infinity });
  for (let i = 0; i < 5; i++) {
    const err = await caught(ffs.link(src, path.join(dir, `nolink-${i}.txt`)));
    assert.equal(err.code, 'EPERM');
  }
  assert.equal(ffs.hits.get('link:EPERM:'), 5);
});

test('ENOSPC on writeFile reports syscall write and leaves the old bytes', async () => {
  const ffs = new FaultFs(realFs);
  const p = path.join(dir, 'full-disk.txt');
  await realFs.writeFile(p, Buffer.from('old\n'));
  ffs.addRule({ op: 'writeFile', pathIncludes: 'full-disk', code: 'ENOSPC', times: 1 });
  const err = await caught(ffs.writeFile(p, Buffer.from('new\n')));
  assert.equal(err.code, 'ENOSPC');
  assert.equal(err.syscall, 'write');
  assert.deepEqual(await realFs.readFile(p), Buffer.from('old\n'));
});

test('readFile faults report syscall open', async () => {
  const ffs = new FaultFs(realFs);
  const p = path.join(dir, 'chmod000.txt');
  await realFs.writeFile(p, Buffer.from('c\n'));
  ffs.addRule({ op: 'readFile', pathIncludes: 'chmod000', code: 'EACCES', times: 1 });
  const err = await caught(ffs.readFile(p));
  assert.equal(err.code, 'EACCES');
  assert.equal(err.syscall, 'open');
  assert.equal(err.path, p);
  assert.deepEqual(await ffs.readFile(p), Buffer.from('c\n'));
});

test('the first matching rule wins, in insertion order', async () => {
  const ffs = new FaultFs(realFs);
  const p = path.join(dir, 'order.txt');
  await realFs.writeFile(p, Buffer.from('o\n'));
  ffs.addRule({ op: 'readFile', pathIncludes: 'order', code: 'EACCES', times: 1 });
  ffs.addRule({ op: 'readFile', pathIncludes: 'order.txt', code: 'EBUSY', times: 1 });
  assert.equal((await caught(ffs.readFile(p))).code, 'EACCES');
  assert.equal((await caught(ffs.readFile(p))).code, 'EBUSY');
  assert.deepEqual(await ffs.readFile(p), Buffer.from('o\n'));
});

test('non-matching paths, other ops and non-faultable methods pass through', async () => {
  const ffs = new FaultFs(realFs);
  ffs.addRule({ op: 'writeFile', pathIncludes: 'only-this-one', code: 'EBUSY', times: 1 });
  const sub = path.join(dir, 'pass', 'through');
  await ffs.mkdirp(sub);
  const p = path.join(sub, 'free.txt');
  await ffs.writeFile(p, Buffer.from('f\n'));
  assert.deepEqual(await ffs.readFile(p), Buffer.from('f\n'));
  assert.deepEqual(await ffs.readdir(sub), ['free.txt']);
  const s = await ffs.stat(p);
  assert.ok(s !== null && s.isFile);
  await ffs.rmrf(path.join(dir, 'pass'));
  assert.equal(await ffs.stat(p), null);
  assert.equal(ffs.hits.size, 0);
});

test('addRule refuses times <= 0 and NaN', () => {
  const ffs = new FaultFs(realFs);
  assert.throws(() => ffs.addRule({ op: 'unlink', pathIncludes: 'x', code: 'EBUSY', times: 0 }), RangeError);
  assert.throws(() => ffs.addRule({ op: 'unlink', pathIncludes: 'x', code: 'EBUSY', times: -1 }), RangeError);
  assert.throws(() => ffs.addRule({ op: 'unlink', pathIncludes: 'x', code: 'EBUSY', times: Number.NaN }), RangeError);
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx tsx --test test/unit/faultfs.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (cannot find module `test/sim/faultfs.js`).

- [ ] **Step 8: Write minimal implementation**

Create `test/sim/faultfs.ts`:

```ts
// FaultFs: the SIM binding of the Fs port (11-testing §3.2). Wraps another Fs
// (normally realFs) and fails selected calls with errors built exactly like
// Node's own fs errors, so production code cannot tell them apart.
// hits: key `${op}:${code}:${pathIncludes}`, one counter per rule (header Interfaces).
// Lock probe, fsync and delay/lock emulation (11-testing §3.2 Fs row) arrive with Plan 2.
import { getSystemErrorMap } from 'node:util';
import type { Fs, FsStat } from '../../src/ports/fs.js';

export type FaultOp = 'readFile' | 'writeFile' | 'rename' | 'link' | 'unlink';

export interface FaultRule {
  op: FaultOp;
  pathIncludes: string;
  code: 'EACCES' | 'EPERM' | 'EBUSY' | 'ENOSPC';
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

function syscallFor(op: FaultOp, code: FaultRule['code']): string {
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

export class FaultFs implements Fs {
  readonly hits = new Map<string, number>();
  private readonly inner: Fs;
  private readonly rules: ActiveRule[] = [];

  constructor(inner: Fs) {
    this.inner = inner;
  }

  addRule(r: FaultRule): void {
    if (!(r.times > 0)) throw new RangeError(`FaultFs: times must be > 0 (got ${r.times})`);
    this.rules.push({ rule: { ...r }, key: ruleKey(r), left: r.times });
  }

  // Throws before the inner call, so a faulted call has no side effect.
  private check(op: FaultOp, p: string, dest?: string): void {
    const i = this.rules.findIndex(
      (a) =>
        a.rule.op === op &&
        (p.includes(a.rule.pathIncludes) || (dest !== undefined && dest.includes(a.rule.pathIncludes))),
    );
    if (i < 0) return;
    const a = this.rules[i];
    if (a === undefined) return;
    a.left -= 1;
    if (a.left <= 0) this.rules.splice(i, 1);
    this.hits.set(a.key, (this.hits.get(a.key) ?? 0) + 1);
    throw errnoError(a.rule.code, syscallFor(op, a.rule.code), p, dest);
  }

  async readFile(p: string): Promise<Buffer> {
    this.check('readFile', p);
    return this.inner.readFile(p);
  }

  async writeFile(p: string, data: Buffer): Promise<void> {
    this.check('writeFile', p);
    return this.inner.writeFile(p, data);
  }

  async rename(from: string, to: string): Promise<void> {
    this.check('rename', from, to);
    return this.inner.rename(from, to);
  }

  async link(existing: string, newPath: string): Promise<void> {
    this.check('link', existing, newPath);
    return this.inner.link(existing, newPath);
  }

  async unlink(p: string): Promise<void> {
    this.check('unlink', p);
    return this.inner.unlink(p);
  }

  async stat(p: string): Promise<FsStat | null> {
    return this.inner.stat(p);
  }

  async mkdirp(p: string): Promise<void> {
    return this.inner.mkdirp(p);
  }

  async readdir(p: string): Promise<string[]> {
    return this.inner.readdir(p);
  }

  async rmrf(p: string): Promise<void> {
    return this.inner.rmrf(p);
  }
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx tsx --test test/unit/faultfs.test.ts test/unit/fs.test.ts`
Expected: PASS — 18 tests, 0 failures.

- [ ] **Step 10: Commit**

```bash
git add test/sim/faultfs.ts test/unit/faultfs.test.ts
git commit -m "test(sim): add FaultFs with Node-identical errno errors" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Scheduler port and VirtualScheduler

Spec: 11-testing §3.2 (`Scheduler` row: `schedule(task, atMono)`, `yieldPoint(name)`; real binding = Node timers / event loop; SIM binding = seeded queue, one step at a time, `yieldPoint` lets the harness interleave another peer's step or a concurrent write), §3.3 Run step 2 ("the scheduler executes one step at a time … at every `yieldPoint` the scheduler may run a concurrent operation"), F-ED-4 (concurrent write at writer `yieldPoint`s).

Decisions fixed by this task:
- `realScheduler(clock)` never runs a task synchronously inside `schedule()` and never before `clock.monoMs() >= atMono`. It uses a re-arm loop: `setTimeout(arm, min(ceil(remaining), 2^31 − 1))` until the clock reaches `atMono`. That covers Node timers firing slightly early relative to `performance.now()` and the 2^31 − 1 ms `setTimeout` ceiling (beyond it Node fires after 1 ms with a `TimeoutOverflowWarning`). Timers are not `unref`'d: a scheduled daemon task keeps the process alive.
- A real task that throws or rejects is not swallowed: it surfaces as an unhandled rejection (process-fatal by Node's default). Daemon code wraps its own tasks.
- `realScheduler.yieldPoint()` yields one turn of the event loop (`setImmediate`), so pending I/O callbacks run.
- `VirtualScheduler` keeps a queue ordered by `(atMono, insertion order)`. `step()` removes the earliest task **before** running it, moves the `VirtualClock` **forward** to `atMono` with `advance()` (both clocks) when `atMono` is in the future and never backward, awaits the task, and propagates its error. `step()` is not re-entrant: calling it from inside a running task rejects. A concurrent operation at a `yieldPoint` is run directly by the `onYield` handler, not as a scheduled task.
- `yieldPoint(name)` awaits `onYield(name)` when a handler is set; otherwise it resolves without effect.
- `runUntilIdle(maxSteps)` returns the number of steps run; it stops early when the queue is empty. Hitting the cap is not an error; callers check `pending()`.
- Ties are broken by insertion order, so the scheduler itself never draws from `random`. Per the header contract it exposes the constructor's stream as `readonly random: Random`, the seeded stream that `onYield` handlers and engines draw from.
- `schedule()` refuses a non-finite `atMono` (`RangeError`): `NaN` or `Infinity` would silently break ordering.

**Files:**
- Create: `src/ports/scheduler.ts`
- Create: `test/sim/vscheduler.ts`
- Test: `test/unit/scheduler.test.ts`
- Test: `test/unit/vscheduler.test.ts`

**Interfaces:**
- Consumes:
  - Task 2: `src/ports/clock.ts` — `interface Clock { monoMs(): number; wallMs(): number; sleep(ms: number): Promise<void>; }`, `const realClock: Clock`; `test/sim/vclock.ts` — `class VirtualClock implements Clock { constructor(opts?: { wallOffsetMs?: number; startMono?: number; driftPpm?: number }); monoMs(): number; wallMs(): number; advance(ms: number): void; }` (built here with no options, so no drift: `advance(ms)` moves both clocks by exactly `ms`).
  - Task 3: `src/ports/random.ts` — `interface Random { bytes(n: number): Uint8Array; }`, `seededRandom(seed: string): Random`.
- Produces:
  - `src/ports/scheduler.ts`: `export type Task = () => void | Promise<void>`, `export interface Scheduler { schedule(task: Task, atMono: number): void; yieldPoint(name: string): Promise<void>; }`, `export function realScheduler(clock: Clock): Scheduler`.
  - `test/sim/vscheduler.ts`: `export class VirtualScheduler implements Scheduler { constructor(clock: VirtualClock, random: Random); readonly random: Random; schedule(task: Task, atMono: number): void; yieldPoint(name: string): Promise<void>; onYield: ((name: string) => void | Promise<void>) | null; step(): Promise<boolean>; runUntilIdle(maxSteps: number): Promise<number>; pending(): number; }`.

- [ ] **Step 1: Write the failing test for `realScheduler`**

Create `test/unit/scheduler.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realClock } from '../../src/ports/clock.js';
import { realScheduler } from '../../src/ports/scheduler.js';

test('runs tasks in atMono order and never before atMono', async () => {
  const sched = realScheduler(realClock);
  const t0 = realClock.monoMs();
  const seen: Array<{ name: string; at: number; ran: number }> = [];
  await new Promise<void>((done) => {
    const rec = (name: string, at: number) => (): void => {
      seen.push({ name, at, ran: realClock.monoMs() });
      if (seen.length === 3) done();
    };
    sched.schedule(rec('late', t0 + 100), t0 + 100);
    sched.schedule(rec('early', t0 + 20), t0 + 20);
    sched.schedule(rec('mid', t0 + 60), t0 + 60);
  });
  assert.deepEqual(
    seen.map((s) => s.name),
    ['early', 'mid', 'late'],
  );
  for (const s of seen) assert.ok(s.ran >= s.at, `${s.name} ran at ${s.ran} before ${s.at}`);
});

test('a task due in the past runs asynchronously, never inside schedule()', async () => {
  const sched = realScheduler(realClock);
  let ran = false;
  sched.schedule(() => {
    ran = true;
  }, realClock.monoMs() - 1000);
  assert.equal(ran, false);
  await new Promise<void>((r) => setTimeout(r, 20));
  assert.equal(ran, true);
});

test('async tasks are started at their time', async () => {
  const sched = realScheduler(realClock);
  const t0 = realClock.monoMs();
  const done = await new Promise<number>((resolve) => {
    sched.schedule(async () => {
      await Promise.resolve();
      resolve(realClock.monoMs());
    }, t0 + 15);
  });
  assert.ok(done >= t0 + 15);
});

test('yieldPoint lets already-queued event-loop work run first', async () => {
  const sched = realScheduler(realClock);
  const order: string[] = [];
  setImmediate(() => order.push('immediate'));
  await sched.yieldPoint('apply.between_paths');
  order.push('after-yield');
  assert.deepEqual(order, ['immediate', 'after-yield']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/unit/scheduler.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (cannot find module `src/ports/scheduler.js`).

- [ ] **Step 3: Write minimal implementation**

Create `src/ports/scheduler.ts`:

```ts
// Scheduler port (11-testing §3.2). Production: Node timers and the event loop.
// SIM: test/sim/vscheduler.ts (seeded queue, one step at a time).
import type { Clock } from './clock.js';

export type Task = () => void | Promise<void>;

export interface Scheduler {
  schedule(task: Task, atMono: number): void;
  yieldPoint(name: string): Promise<void>;
}

// setTimeout's ceiling; a larger delay makes Node fire after 1 ms instead.
const MAX_TIMER_MS = 2_147_483_647;

export function realScheduler(clock: Clock): Scheduler {
  return {
    schedule(task: Task, atMono: number): void {
      const arm = (): void => {
        const remaining = atMono - clock.monoMs();
        if (remaining <= 0) {
          // A throw or rejection is deliberately left unhandled (loud);
          // daemon code wraps its own tasks.
          void Promise.resolve().then(task);
          return;
        }
        // Re-arm until the clock really reached atMono: timers may fire a
        // fraction of a millisecond early, and long delays are capped.
        setTimeout(arm, Math.min(Math.ceil(remaining), MAX_TIMER_MS));
      };
      setImmediate(arm);
    },

    yieldPoint(): Promise<void> {
      return new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/unit/scheduler.test.ts`
Expected: PASS — 4 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/ports/scheduler.ts test/unit/scheduler.test.ts
git commit -m "feat(ports): add Scheduler port with timer-backed realScheduler" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Write the failing test for `VirtualScheduler`**

Create `test/unit/vscheduler.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededRandom } from '../../src/ports/random.js';
import { VirtualClock } from '../sim/vclock.js';
import { VirtualScheduler } from '../sim/vscheduler.js';

function make(): { clock: VirtualClock; sched: VirtualScheduler } {
  const clock = new VirtualClock();
  const sched = new VirtualScheduler(clock, seededRandom('vscheduler-test'));
  return { clock, sched };
}

test('runs the earliest task first and breaks ties by insertion order', async () => {
  const { clock, sched } = make();
  const t0 = clock.monoMs();
  const order: string[] = [];
  sched.schedule(() => void order.push('c'), t0 + 30);
  sched.schedule(() => void order.push('a1'), t0 + 10);
  sched.schedule(() => void order.push('x'), t0 + 20);
  sched.schedule(() => void order.push('a2'), t0 + 10);
  sched.schedule(() => void order.push('a3'), t0 + 10);
  assert.equal(sched.pending(), 5);
  while (await sched.step()) {
    /* drain */
  }
  assert.deepEqual(order, ['a1', 'a2', 'a3', 'x', 'c']);
  assert.equal(sched.pending(), 0);
});

test('step() on an empty queue returns false and leaves the clock alone', async () => {
  const { clock, sched } = make();
  const t0 = clock.monoMs();
  assert.equal(await sched.step(), false);
  assert.equal(clock.monoMs(), t0);
});

test('step() advances both clocks forward to atMono before running the task', async () => {
  const { clock, sched } = make();
  const m0 = clock.monoMs();
  const w0 = clock.wallMs();
  let seenMono = -1;
  sched.schedule(() => {
    seenMono = clock.monoMs();
  }, m0 + 500);
  assert.equal(await sched.step(), true);
  assert.equal(seenMono, m0 + 500);
  assert.equal(clock.monoMs(), m0 + 500);
  assert.equal(clock.wallMs(), w0 + 500);
});

test('a task due in the past runs without moving the clock backward', async () => {
  const { clock, sched } = make();
  clock.advance(1000);
  const t1 = clock.monoMs();
  sched.schedule(() => undefined, t1 - 100);
  assert.equal(await sched.step(), true);
  assert.equal(clock.monoMs(), t1);
});

test('step() awaits an async task to completion', async () => {
  const { clock, sched } = make();
  const order: string[] = [];
  sched.schedule(async () => {
    await Promise.resolve();
    await Promise.resolve();
    order.push('task-end');
  }, clock.monoMs());
  await sched.step();
  order.push('after-step');
  assert.deepEqual(order, ['task-end', 'after-step']);
});

test('tasks scheduled from inside a task are queued, not run inline', async () => {
  const { clock, sched } = make();
  const t0 = clock.monoMs();
  const order: string[] = [];
  sched.schedule(() => void order.push('later'), t0 + 100);
  sched.schedule(() => {
    order.push('first');
    sched.schedule(() => void order.push('child'), t0 + 50);
  }, t0 + 10);
  await sched.step();
  assert.deepEqual(order, ['first']);
  assert.equal(sched.pending(), 2);
  await sched.runUntilIdle(10);
  assert.deepEqual(order, ['first', 'child', 'later']);
});

test('a throwing task rejects step(), is removed, and the scheduler stays usable', async () => {
  const { clock, sched } = make();
  const t0 = clock.monoMs();
  const order: string[] = [];
  sched.schedule(() => {
    throw new Error('boom');
  }, t0 + 1);
  sched.schedule(() => void order.push('next'), t0 + 2);
  await assert.rejects(sched.step(), /boom/);
  assert.equal(sched.pending(), 1);
  assert.equal(await sched.step(), true);
  assert.deepEqual(order, ['next']);
});

test('step() called from inside a running task rejects (single-step only)', async () => {
  const { clock, sched } = make();
  let innerError: unknown = null;
  sched.schedule(async () => {
    try {
      await sched.step();
    } catch (e) {
      innerError = e;
    }
  }, clock.monoMs());
  sched.schedule(() => undefined, clock.monoMs() + 1);
  assert.equal(await sched.step(), true);
  assert.ok(innerError instanceof Error);
  assert.match(innerError.message, /re-entered/);
  assert.equal(sched.pending(), 1);
});

test('yieldPoint resolves without a handler and awaits the handler when set', async () => {
  const { sched } = make();
  await sched.yieldPoint('nobody-listening');

  const seen: string[] = [];
  sched.onYield = async (name: string): Promise<void> => {
    await Promise.resolve();
    seen.push(`yield:${name}`);
  };
  await sched.yieldPoint('apply.between_paths');
  seen.push('after');
  assert.deepEqual(seen, ['yield:apply.between_paths', 'after']);

  sched.onYield = null;
  await sched.yieldPoint('again');
  assert.deepEqual(seen, ['yield:apply.between_paths', 'after']);
});

test('a yieldPoint inside a task lets onYield interleave a concurrent operation', async () => {
  const { clock, sched } = make();
  const order: string[] = [];
  sched.onYield = (name: string): void => {
    order.push(`concurrent-at-${name}`);
  };
  sched.schedule(async () => {
    order.push('phase1');
    await sched.yieldPoint('writer.phase1');
    order.push('phase2');
  }, clock.monoMs());
  await sched.step();
  assert.deepEqual(order, ['phase1', 'concurrent-at-writer.phase1', 'phase2']);
});

test('runUntilIdle stops at maxSteps and reports the steps run', async () => {
  const { clock, sched } = make();
  let n = 0;
  const forever = (): void => {
    n++;
    sched.schedule(forever, clock.monoMs() + 1000);
  };
  sched.schedule(forever, clock.monoMs());
  assert.equal(await sched.runUntilIdle(5), 5);
  assert.equal(n, 5);
  assert.equal(sched.pending(), 1);

  const { clock: c2, sched: s2 } = make();
  s2.schedule(() => undefined, c2.monoMs() + 1);
  s2.schedule(() => undefined, c2.monoMs() + 2);
  assert.equal(await s2.runUntilIdle(100), 2);
  assert.equal(s2.pending(), 0);
});

test('schedule refuses a non-finite atMono', () => {
  const { sched } = make();
  assert.throws(() => sched.schedule(() => undefined, Number.NaN), RangeError);
  assert.throws(() => sched.schedule(() => undefined, Number.POSITIVE_INFINITY), RangeError);
  assert.equal(sched.pending(), 0);
});

test('exposes the seeded random it was built with', () => {
  const clock = new VirtualClock();
  const random = seededRandom('exposed');
  const sched = new VirtualScheduler(clock, random);
  assert.equal(sched.random, random);
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx tsx --test test/unit/vscheduler.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (cannot find module `test/sim/vscheduler.js`).

- [ ] **Step 8: Write minimal implementation**

Create `test/sim/vscheduler.ts`:

```ts
// VirtualScheduler: the SIM binding of the Scheduler port (11-testing §3.2, §3.3).
// One task per step(); time only moves when step() advances the VirtualClock
// to the next task's atMono. Ties are broken by insertion order.
import type { Random } from '../../src/ports/random.js';
import type { Scheduler, Task } from '../../src/ports/scheduler.js';
import type { VirtualClock } from './vclock.js';

interface Entry {
  task: Task;
  atMono: number;
  seq: number;
}

export class VirtualScheduler implements Scheduler {
  onYield: ((name: string) => void | Promise<void>) | null = null;
  // Not used for ordering (ties are insertion-ordered); exposed so onYield
  // handlers and engines draw from the scheduler's seeded stream.
  readonly random: Random;
  private readonly clock: VirtualClock;
  private readonly queue: Entry[] = [];
  private nextSeq = 0;
  private running = false;

  constructor(clock: VirtualClock, random: Random) {
    this.clock = clock;
    this.random = random;
  }

  schedule(task: Task, atMono: number): void {
    if (!Number.isFinite(atMono)) {
      throw new RangeError(`VirtualScheduler: atMono must be finite (got ${atMono})`);
    }
    this.queue.push({ task, atMono, seq: this.nextSeq++ });
  }

  async yieldPoint(name: string): Promise<void> {
    const handler = this.onYield;
    if (handler !== null) await handler(name);
  }

  async step(): Promise<boolean> {
    if (this.running) {
      throw new Error('VirtualScheduler: step() re-entered from inside a running task');
    }
    // The queue is in insertion (seq) order, so a strict "<" keeps the
    // earliest-inserted entry among equal atMono values.
    let best = -1;
    let bestAt = 0;
    for (let i = 0; i < this.queue.length; i++) {
      const e = this.queue[i];
      if (e === undefined) continue;
      if (best < 0 || e.atMono < bestAt) {
        best = i;
        bestAt = e.atMono;
      }
    }
    if (best < 0) return false;
    const [entry] = this.queue.splice(best, 1);
    if (entry === undefined) return false;
    const now = this.clock.monoMs();
    if (entry.atMono > now) this.clock.advance(entry.atMono - now);
    this.running = true;
    try {
      await entry.task();
    } finally {
      this.running = false;
    }
    return true;
  }

  async runUntilIdle(maxSteps: number): Promise<number> {
    let n = 0;
    while (n < maxSteps && (await this.step())) n++;
    return n;
  }

  pending(): number {
    return this.queue.length;
  }
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx tsx --test test/unit/vscheduler.test.ts test/unit/scheduler.test.ts`
Expected: PASS — 17 tests, 0 failures.

- [ ] **Step 10: Commit**

```bash
git add test/sim/vscheduler.ts test/unit/vscheduler.test.ts
git commit -m "test(sim): add single-step VirtualScheduler with yieldPoint interleaving" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: crashpoint and the catalogue file

Spec: 11-testing §2 (`crashpoint(name)`: "a production call at a named step boundary … no-op in release builds; in test builds the harness may kill the process there"), §3.2 (`crashpoint(name)` row: real = no-op; SIM = throws `KilledAt(name)` or lets STRESS kill the process), §3.6 (crashpoint catalogue; "a lint that keeps `test/crashpoints.json` equal to the set of `crashpoint()` call sites"), §3.10 L-CRASHPOINTS, TST-06. Glossary §25.2 item 10: the call sites are placed by chapters 01, 05, 06 and 08, i.e. by later plans.

Decisions fixed by this task:
- `crashpoint(name)` calls the installed handler with `name` and otherwise does nothing. **The handler decides** what happens: a SIM handler throws `new KilledAt(name)` (at a chosen point or hit count), a STRESS handler kills the process, an observer handler only counts hits (§3.6 requires ≥ 100 kills per name per night, which needs hit counting). With the throwing handler, `crashpoint("x")` throws `KilledAt("x")`; with no handler it is a no-op.
- The handler is module-global. That is sufficient for SIM because the `VirtualScheduler` runs exactly one peer step at a time, so the harness knows which peer is running when the handler fires.
- `KilledAt` is an `Error` subclass with `name = 'KilledAt'` and `readonly point`; `instanceof KilledAt` works natively (target ES2022).
- `setCrashHandler` exists in every build; compiling it out of release builds (`TEST_SEAM_IN_RELEASE`, L-DIST) is a later bundle-lint concern, not part of this task.
- `test/crashpoints.json` is a plain JSON array of the 20 catalogue names of 11-testing §3.6 (the `adopt.lock` / `adopt.index_renamed` / `adopt.ref` row is three names; `registry.cas` is one name for two call sites), sorted by code unit, unique, 2-space indented, LF line endings, trailing newline, no BOM. It is `string[]` because Task 14's `lintCrashpoints(callSites: string[], catalogue: string[])` takes it as is. Plan 1 places no call site.
- The `Ports` bundle type (`src/ports/index.ts`) is not part of this task: it references `GitRunner`, so Task 9 creates it together with `src/git/runner.ts`. This task therefore leaves `npm run typecheck` clean.

**Files:**
- Create: `src/ports/crashpoint.ts`
- Create: `test/crashpoints.json`
- Test: `test/unit/crashpoint.test.ts`
- Test: `test/unit/crashpoints-catalogue.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (the crashpoint port has no dependencies); the npm scripts `typecheck` and `test` from Task 1.
- Produces:
  - `src/ports/crashpoint.ts`: `export class KilledAt extends Error { readonly point: string; constructor(point: string); }`, `export function crashpoint(name: string): void`, `export function setCrashHandler(h: ((name: string) => void) | null): void`.
  - `test/crashpoints.json`: `string[]`, the catalogue names sorted by code unit (L-CRASHPOINTS source of truth, read as is by Task 14's `lintCrashpoints(callSites: string[], catalogue: string[])`).

- [ ] **Step 1: Write the failing test for `crashpoint`**

Create `test/unit/crashpoint.test.ts`:

```ts
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { crashpoint, setCrashHandler, KilledAt } from '../../src/ports/crashpoint.js';

afterEach(() => {
  setCrashHandler(null);
});

test('without a handler crashpoint is a no-op', () => {
  assert.equal(crashpoint('apply.intent'), undefined);
  assert.doesNotThrow(() => crashpoint('x'));
});

test('with a killing handler crashpoint("x") throws KilledAt("x")', () => {
  setCrashHandler((name) => {
    throw new KilledAt(name);
  });
  assert.throws(
    () => crashpoint('x'),
    (err: unknown) => {
      assert.ok(err instanceof KilledAt);
      assert.ok(err instanceof Error);
      assert.equal(err.point, 'x');
      assert.equal(err.name, 'KilledAt');
      assert.match(err.message, /\bx\b/);
      return true;
    },
  );
});

test('an observing handler sees every name in order and does not kill', () => {
  const seen: string[] = [];
  setCrashHandler((name) => {
    seen.push(name);
  });
  crashpoint('apply.intent');
  crashpoint('apply.group.phase1');
  crashpoint('apply.intent');
  assert.deepEqual(seen, ['apply.intent', 'apply.group.phase1', 'apply.intent']);
});

test('a selective handler kills only at the armed point and hit', () => {
  let hits = 0;
  setCrashHandler((name) => {
    if (name === 'publish.sent' && ++hits === 2) throw new KilledAt(name);
  });
  crashpoint('publish.out_built');
  crashpoint('publish.sent');
  assert.throws(() => crashpoint('publish.sent'), KilledAt);
});

test('setCrashHandler(null) restores the no-op', () => {
  setCrashHandler((name) => {
    throw new KilledAt(name);
  });
  setCrashHandler(null);
  assert.doesNotThrow(() => crashpoint('stop.flushed'));
});

test('KilledAt is constructible on its own', () => {
  const k = new KilledAt('registry.cas');
  assert.equal(k.point, 'registry.cas');
  assert.equal(k.name, 'KilledAt');
  assert.ok(typeof k.stack === 'string');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/unit/crashpoint.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (cannot find module `src/ports/crashpoint.js`).

- [ ] **Step 3: Write minimal implementation**

Create `src/ports/crashpoint.ts`:

```ts
// crashpoint port (11-testing §3.2, §3.6). Production code calls
// crashpoint("<name>") exactly at the anchored step of the catalogue in
// test/crashpoints.json. With no handler installed (release and normal runs)
// the call does nothing. A test harness installs a handler that decides:
// SIM throws KilledAt(name), STRESS kills the process, an observer only counts.

export class KilledAt extends Error {
  readonly point: string;

  constructor(point: string) {
    super(`killed at crashpoint ${point}`);
    this.name = 'KilledAt';
    this.point = point;
  }
}

let handler: ((name: string) => void) | null = null;

export function crashpoint(name: string): void {
  if (handler !== null) handler(name);
}

// Test builds only (TEST_SEAM_IN_RELEASE is enforced by the dist lint later).
export function setCrashHandler(h: ((name: string) => void) | null): void {
  handler = h;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/unit/crashpoint.test.ts`
Expected: PASS — 6 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/ports/crashpoint.ts test/unit/crashpoint.test.ts
git commit -m "feat(ports): add crashpoint port with KilledAt and test handler" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Write the failing test for the catalogue file**

Create `test/unit/crashpoints-catalogue.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 11-testing §3.6, one entry per name (the adopt row is three names;
// registry.cas has two call sites but one name). Sorted by code unit.
const CATALOGUE_3_6 = [
  'adopt.index_renamed',
  'adopt.lock',
  'adopt.ref',
  'apply.between_groups',
  'apply.group.mid',
  'apply.group.phase1',
  'apply.group.phase2',
  'apply.intent',
  'apply.state',
  'deny.prerecord',
  'join.first_apply',
  'publish.landed',
  'publish.out_built',
  'publish.sent',
  'recover.displaced',
  'recover.reanchor',
  'registry.cas',
  'save.branch_pushed',
  'snapshot.index_written',
  'stop.flushed',
];

const raw = readFileSync(new URL('../crashpoints.json', import.meta.url));

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

test('crashpoints.json is the full §3.6 catalogue', () => {
  const parsed: unknown = JSON.parse(raw.toString('utf8'));
  assert.ok(Array.isArray(parsed));
  assert.deepEqual(parsed, CATALOGUE_3_6);
});

test('names are unique, sorted by code unit and well-formed', () => {
  const names = JSON.parse(raw.toString('utf8')) as string[];
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual([...names].sort(byCodeUnit), names);
  for (const n of names) assert.match(n, /^[a-z]+(\.[a-z0-9_]+)+$/);
});

test('file is UTF-8 without BOM, LF only, with a trailing newline', () => {
  assert.notDeepEqual(raw.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  assert.equal(raw.includes(0x0d), false);
  assert.equal(raw[raw.length - 1], 0x0a);
  assert.equal(raw.toString('utf8'), `${JSON.stringify(CATALOGUE_3_6, null, 2)}\n`);
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx tsx --test test/unit/crashpoints-catalogue.test.ts`
Expected: FAIL — `ENOENT: no such file or directory, open '…/test/crashpoints.json'` (thrown while loading the test file).

- [ ] **Step 8: Write the catalogue file**

Create `test/crashpoints.json` (LF line endings, trailing newline, no BOM):

```json
[
  "adopt.index_renamed",
  "adopt.lock",
  "adopt.ref",
  "apply.between_groups",
  "apply.group.mid",
  "apply.group.phase1",
  "apply.group.phase2",
  "apply.intent",
  "apply.state",
  "deny.prerecord",
  "join.first_apply",
  "publish.landed",
  "publish.out_built",
  "publish.sent",
  "recover.displaced",
  "recover.reanchor",
  "registry.cas",
  "save.branch_pushed",
  "snapshot.index_written",
  "stop.flushed"
]
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx tsx --test test/unit/crashpoints-catalogue.test.ts test/unit/crashpoint.test.ts`
Expected: PASS — 9 tests, 0 failures.

- [ ] **Step 10: Typecheck and run the whole suite**

Run: `npm run typecheck`
Expected: exit code 0, no diagnostics (both new test files and `src/ports/crashpoint.ts` are inside the `tsconfig.json` `include`).

Run: `npm test`
Expected: PASS — every test of Tasks 1–6, `fail 0`.

- [ ] **Step 11: Commit**

```bash
git add test/crashpoints.json test/unit/crashpoints-catalogue.test.ts
git commit -m "test(ports): add crashpoint catalogue (11-testing 3.6)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `enc()` branch-name encoding and the git version floor

**Files:**
- Create: `src/git/enc.ts`
- Create: `src/git/version.ts`
- Test: `test/unit/enc.test.ts`
- Test: `test/unit/gitVersion.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure functions; `fast-check` dev dependency pinned in Task 1). `src/ports/index.ts` does not exist yet (Task 9 creates it together with `src/git/runner.ts`), so the whole project type-checks cleanly at the end of this task.
- Produces (exactly as in 00-header.md):
  - `src/git/enc.ts`: `export const ENC_MAX_BYTES = 150;` · `export class EncTooLongError extends Error {}` · `export function enc(branch: string): string;`
  - `src/git/version.ts`: `export interface GitVersion { major: number; minor: number; patch: number; raw: string; }` · `export const GIT_FLOOR: GitVersion;` (2.43.0) · `export function parseGitVersion(stdout: string): GitVersion;` · `export function meetsFloor(v: GitVersion): boolean;`

Spec: glossary §4 — `enc(b)`: percent-encode every byte of the branch name outside `[A-Za-z0-9_-]` as `%XX` (uppercase hex); result ≤ 150 bytes, else refuse the branch. Glossary §18 — floor **git ≥ 2.43**.

Decisions pinned by the tests below:
- `enc` works on the UTF-8 bytes of the name. The output is pure ASCII, so its `.length` is its byte length.
- `enc('')` throws a plain `Error` (an empty branch name cannot form `refs/cowork/<enc(b)>/board`).
- A string containing a lone UTF-16 surrogate throws a plain `Error`: `Buffer.from(s, 'utf8')` would turn every lone surrogate into U+FFFD, so two different inputs would map to the same ref (not injective).
- `parseGitVersion` reads the first line of `git version` output (callers run `git version`, not `git --version`; see Task 8's `args[0]` rule). `raw` is everything after `git version ` on that line, trimmed. A missing patch component (`2.45`) parses as patch 0. Anything else throws.

---

- [ ] **Step 1: Write the failing test for `enc()`**

Create `test/unit/enc.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import * as fc from 'fast-check';
import { enc, EncTooLongError, ENC_MAX_BYTES } from '../../src/git/enc.js';

test('ENC_MAX_BYTES is 150 (glossary §4)', () => {
  assert.equal(ENC_MAX_BYTES, 150);
});

test('enc keeps [A-Za-z0-9_-] and percent-encodes every other byte with uppercase hex', () => {
  const cases: Array<[string, string]> = [
    ['main', 'main'],
    ['my_branch-2', 'my_branch-2'],
    ['Feat/ABC', 'Feat%2FABC'],
    ['feature/login', 'feature%2Flogin'],
    ['release-1.2', 'release-1%2E2'],
    ['a b', 'a%20b'],
    ['100%', '100%25'],
    ['x~y', 'x%7Ey'],
    ['tab\there', 'tab%09here'],
    ['line\nbreak', 'line%0Abreak'],
    ['é', '%C3%A9'],
    ['한글', '%ED%95%9C%EA%B8%80'],
    ['😀', '%F0%9F%98%80'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(enc(input), expected, `enc(${JSON.stringify(input)})`);
  }
});

test('enc is injective on names that differ only by an escape sequence', () => {
  assert.notEqual(enc('a/b'), enc('a%2Fb'));
  assert.equal(enc('a%2Fb'), 'a%252Fb');
});

test('enc accepts exactly ENC_MAX_BYTES encoded bytes and refuses one more', () => {
  assert.equal(enc('a'.repeat(150)), 'a'.repeat(150));
  assert.throws(() => enc('a'.repeat(151)), EncTooLongError);
  assert.equal(enc('a'.repeat(147) + '/'), 'a'.repeat(147) + '%2F');
  assert.throws(() => enc('a'.repeat(148) + '/'), EncTooLongError);
  // '한' is 3 UTF-8 bytes -> 9 encoded bytes: 16 x 9 = 144 fits, 17 x 9 = 153 does not.
  assert.equal(enc('한'.repeat(16)).length, 144);
  assert.throws(() => enc('한'.repeat(17)), EncTooLongError);
});

test('EncTooLongError is an Error with its own name', () => {
  try {
    enc('x'.repeat(400));
    assert.fail('expected a throw');
  } catch (e) {
    assert.ok(e instanceof EncTooLongError);
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'EncTooLongError');
  }
});

test('enc refuses an empty name and lone surrogates with a plain Error', () => {
  for (const bad of ['', '\uD800', 'a\uDC00b', 'x\uD83D']) {
    assert.throws(
      () => enc(bad),
      (e: unknown) => e instanceof Error && !(e instanceof EncTooLongError),
      `enc(${JSON.stringify(bad)})`,
    );
  }
});

function isUnreservedByte(b: number): boolean {
  return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f || b === 0x2d;
}

function expectedEncodedLength(s: string): number {
  let n = 0;
  for (const b of Buffer.from(s, 'utf8')) n += isUnreservedByte(b) ? 1 : 3;
  return n;
}

function checkProperty(s: string): void {
  const expectedLen = expectedEncodedLength(s);
  if (expectedLen > ENC_MAX_BYTES) {
    assert.throws(() => enc(s), EncTooLongError);
    return;
  }
  const e = enc(s);
  assert.equal(e.length, expectedLen);
  assert.match(e, /^(?:[A-Za-z0-9_-]|%[0-9A-F]{2})*$/);
  assert.equal(decodeURIComponent(e), s);
}

// Strings are built from code points so the test works with every fast-check major version.
const anyCodePoint = fc.integer({ min: 0, max: 0x10ffff }).filter((c) => c < 0xd800 || c > 0xdfff);
const printableAscii = fc.integer({ min: 0x20, max: 0x7e });

test('property: enc output is canonical, round-trips through decodeURIComponent, and respects the cap', () => {
  fc.assert(
    fc.property(
      fc.array(anyCodePoint, { minLength: 1, maxLength: 40 }).map((cps) => String.fromCodePoint(...cps)),
      checkProperty,
    ),
    { numRuns: 500 },
  );
  fc.assert(
    fc.property(
      fc.array(printableAscii, { minLength: 1, maxLength: 200 }).map((cps) => String.fromCodePoint(...cps)),
      checkProperty,
    ),
    { numRuns: 500 },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/unit/enc.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (cannot find `src/git/enc.js`), every test in the file reported as failed.

- [ ] **Step 3: Write the minimal implementation**

Create `src/git/enc.ts`:

```ts
import { Buffer } from 'node:buffer';

/** Glossary §4: the encoded branch name may be at most this many bytes. */
export const ENC_MAX_BYTES = 150;

/** Thrown when enc(b) would exceed ENC_MAX_BYTES; v1 refuses such a branch. */
export class EncTooLongError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'EncTooLongError';
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isUnreservedByte(b: number): boolean {
  return (
    (b >= 0x30 && b <= 0x39) || // 0-9
    (b >= 0x41 && b <= 0x5a) || // A-Z
    (b >= 0x61 && b <= 0x7a) || // a-z
    b === 0x5f || // _
    b === 0x2d // -
  );
}

/**
 * Glossary §4: percent-encode every UTF-8 byte of the branch name outside [A-Za-z0-9_-]
 * as %XX (uppercase hex). The result is ASCII, so its length is its byte length.
 */
export function enc(branch: string): string {
  if (branch.length === 0) {
    throw new Error('enc: the branch name is empty');
  }
  if (LONE_SURROGATE.test(branch)) {
    throw new Error('enc: the branch name contains a lone UTF-16 surrogate');
  }
  let out = '';
  for (const b of Buffer.from(branch, 'utf8')) {
    out += isUnreservedByte(b) ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0');
    if (out.length > ENC_MAX_BYTES) {
      throw new EncTooLongError(`enc: the encoded branch name exceeds ${ENC_MAX_BYTES} bytes`);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test test/unit/enc.test.ts`
Expected: PASS — 7 tests, 0 failures.

- [ ] **Step 5: Commit**

```
git add src/git/enc.ts test/unit/enc.test.ts
git commit -m "feat(git): add enc() branch-name encoding (glossary §4)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Write the failing test for the version floor**

Create `test/unit/gitVersion.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GIT_FLOOR, meetsFloor, parseGitVersion, type GitVersion } from '../../src/git/version.js';

test('GIT_FLOOR is 2.43.0 (glossary §18)', () => {
  assert.deepEqual({ ...GIT_FLOOR }, { major: 2, minor: 43, patch: 0, raw: '2.43.0' });
  assert.ok(Object.isFrozen(GIT_FLOOR));
});

test('parseGitVersion reads the real outputs of `git version`', () => {
  const cases: Array<[string, GitVersion]> = [
    ['git version 2.55.0.windows.3\n', { major: 2, minor: 55, patch: 0, raw: '2.55.0.windows.3' }],
    ['git version 2.55.0.windows.3\r\n', { major: 2, minor: 55, patch: 0, raw: '2.55.0.windows.3' }],
    ['git version 2.43.0\n', { major: 2, minor: 43, patch: 0, raw: '2.43.0' }],
    ['git version 2.39.3 (Apple Git-146)\n', { major: 2, minor: 39, patch: 3, raw: '2.39.3 (Apple Git-146)' }],
    ['git version 2.44.0-rc1\n', { major: 2, minor: 44, patch: 0, raw: '2.44.0-rc1' }],
    ['git version 2.45\n', { major: 2, minor: 45, patch: 0, raw: '2.45' }],
    ['\uFEFF  git version 2.47.1\nsecond line ignored\n', { major: 2, minor: 47, patch: 1, raw: '2.47.1' }],
    ['git version 10.0.12', { major: 10, minor: 0, patch: 12, raw: '10.0.12' }],
  ];
  for (const [stdout, expected] of cases) {
    assert.deepEqual(parseGitVersion(stdout), expected, JSON.stringify(stdout));
  }
});

test('parseGitVersion throws on anything that is not `git version <n>.<n>[.<n>]`', () => {
  for (const bad of ['', '\n', 'git version\n', 'git version abc\n', 'version 2.43.0\n', 'gitversion 2.43.0', 'git version .43.0', 'git version 2\n']) {
    assert.throws(() => parseGitVersion(bad), Error, JSON.stringify(bad));
  }
});

test('meetsFloor compares (major, minor, patch) against 2.43.0', () => {
  const v = (major: number, minor: number, patch: number): GitVersion => ({ major, minor, patch, raw: `${major}.${minor}.${patch}` });
  assert.equal(meetsFloor(v(2, 43, 0)), true);
  assert.equal(meetsFloor(v(2, 43, 5)), true);
  assert.equal(meetsFloor(v(2, 55, 0)), true);
  assert.equal(meetsFloor(v(3, 0, 0)), true);
  assert.equal(meetsFloor(v(2, 42, 99)), false);
  assert.equal(meetsFloor(v(2, 9, 0)), false);
  assert.equal(meetsFloor(v(1, 99, 99)), false);
  assert.equal(meetsFloor(parseGitVersion('git version 2.39.3 (Apple Git-146)')), false);
  assert.equal(meetsFloor(parseGitVersion('git version 2.55.0.windows.3')), true);
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx tsx --test test/unit/gitVersion.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (cannot find `src/git/version.js`).

- [ ] **Step 8: Write the minimal implementation**

Create `src/git/version.ts`:

```ts
export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

/** Glossary §18: git ≥ 2.43. */
export const GIT_FLOOR: GitVersion = Object.freeze({ major: 2, minor: 43, patch: 0, raw: '2.43.0' });

const PREFIX = 'git version ';
const NUMBERS = /^(\d+)\.(\d+)(?:\.(\d+))?/;

/** Parses the first line of `git version` output, e.g. "git version 2.55.0.windows.3". */
export function parseGitVersion(stdout: string): GitVersion {
  const firstLine = (stdout.replace(/^\uFEFF/, '').trimStart().split(/\r?\n/)[0] ?? '').trim();
  if (!firstLine.startsWith(PREFIX)) {
    throw new Error(`parseGitVersion: unexpected output ${JSON.stringify(firstLine.slice(0, 80))}`);
  }
  const raw = firstLine.slice(PREFIX.length).trim();
  const m = NUMBERS.exec(raw);
  if (m === null || m[1] === undefined || m[2] === undefined) {
    throw new Error(`parseGitVersion: no version number in ${JSON.stringify(raw.slice(0, 80))}`);
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    raw,
  };
}

export function meetsFloor(v: GitVersion): boolean {
  if (v.major !== GIT_FLOOR.major) return v.major > GIT_FLOOR.major;
  if (v.minor !== GIT_FLOOR.minor) return v.minor > GIT_FLOOR.minor;
  return v.patch >= GIT_FLOOR.patch;
}
```

- [ ] **Step 9: Run the tests to verify they pass, and type-check**

Run: `npx tsx --test test/unit/gitVersion.test.ts test/unit/enc.test.ts`
Expected: PASS — 11 tests, 0 failures.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0, no output (no diagnostics). Any diagnostic is a failure of this task; in particular none may mention `src/git/enc.ts`, `src/git/version.ts`, `test/unit/enc.test.ts` or `test/unit/gitVersion.test.ts`.

- [ ] **Step 10: Commit**

```
git add src/git/version.ts test/unit/gitVersion.test.ts
git commit -m "feat(git): add git version parser and 2.43.0 floor (glossary §18)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: DAEMON_ENV builder and the glossary §18 argv/env builder

**Files:**
- Create: `src/git/env.ts`
- Create: `src/git/flags.ts`
- Test: `test/unit/env.test.ts`
- Test: `test/unit/flags.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (both modules are pure; no git is spawned, no `process.env`/`process.platform` is read, no git config is read — `core.sshCommand` arrives as `GitBase.sshCommand`). `src/ports/index.ts` does not exist yet (Task 9 creates it), so the project type-checks cleanly at the end of this task.
- Produces (exactly as in 00-header.md):
  - `src/git/env.ts`: `export const FORCED_ENV: Readonly<Record<string, string>>;` · `export function buildDaemonEnv(source: Record<string, string | undefined>, passthrough: string[]): Record<string, string>;`
  - `src/git/flags.ts`: `export type GitClass = 'local' | 'network' | 'attr' | 'refupdate';` · `export interface GitIdentity { name: string; email: string; }` · `export interface GitCallOptions { class: GitClass; cwd: string; filterDrivers?: string[]; attrTree?: string; fsmonitor?: boolean; identity?: GitIdentity; wallMsForDates?: number; indexFile?: string; stdin?: Buffer; extraEnv?: Record<string, string>; }` (`cwd` and `stdin` are not read by the builder; Task 9 applies them at spawn) · `export interface GitInvocation { argv: string[]; env: Record<string, string>; }` · `export interface GitBase { hooksPath: string; platform: NodeJS.Platform; daemonEnv: Record<string, string>; testBuild: boolean; sshCommand?: string; }` (`sshCommand` = the user's `core.sshCommand`, resolved once by the caller on the start path with `git config --get core.sshCommand`; effective ssh command precedence (09-security §2): `daemonEnv.GIT_SSH_COMMAND` > `sshCommand` > `GIT_SSH` (+variant) > `'ssh'`, BatchMode options appended to it) · `export function buildGitInvocation(args: string[], opts: GitCallOptions, base: GitBase): GitInvocation;` · `export const MERGE_FLAGS: readonly string[];` · `export const DIFF_FAMILY: ReadonlySet<string>;`
  - Task 9 (`createGitRunner`) spawns `git` with exactly `invocation.argv` (the `git` executable itself is not in `argv`), `invocation.env` as the complete environment, `opts.cwd` as cwd, and stdin piped from `opts.stdin` or ignored. It forwards `GitRunnerDeps.sshCommand` into `GitBase.sshCommand` unchanged (the field is optional, so a `GitBase` literal without it still type-checks).

Spec: 09-security §3.4 (allowlist, credential/transport set, passthrough, never-list, forced values on top; ssh BatchMode appended, `-batch` for plink, nothing for `simple`), glossary §18 (every `-c` override, MERGE_FLAGS, diff-family flags, network class, watchdogs are Task 9), 09-security §3.3 / SEC-02 (`--no-recurse-submodules` on every fetch), SEC-03 (identity and `+0000`).

Decisions pinned by the tests below (decision 5 is also the `GitBase.sshCommand` comment in 00-header.md Interfaces):
1. **Env names compare case-insensitively; the source spelling is kept.** Real `process.env` on Windows spells `Path`, `windir`, `SystemDrive`, `ProgramData`; the spec lists `PATH`, `WINDIR`, `SYSTEMDRIVE`, `PROGRAMDATA`. A case-sensitive allowlist would drop variables Git and GCM need on the primary dev OS. The never-list is matched the same way, so `claude_code_messaging_token` is dropped too. Two case variants that both exist in a POSIX source (`http_proxy` and `HTTP_PROXY`) are both kept (curl reads them differently); only the forced keys remove every case variant before being set (09 §3.4 item 5: forced values override a passed-through `GCM_*`).
2. **`args[0]` is the git subcommand.** The builder places every `-c` before it and the per-command flags right after it, so `args[0]` must not start with `-`. Use `['version']`, not `['--version']`.
3. **Fetch flags key on the subcommand** (`args[0] === 'fetch'`, SEC-02 "on every fetch"); `http.lowSpeed*` and the ssh command key on `class === 'network'`; `core.longpaths=true` keys on `base.platform === 'win32'`; the three fsync/reflog flags key on `class === 'refupdate'`; `attr.tree` is added whenever `attrTree` is given (validated as a 40- or 64-hex oid) and is not enforced for `class: 'attr'` in Plan 1 (fixtures run `add` before any `EPOCH_BASE` exists).
4. **`+0000` without dates in release builds.** SEC-03 requires `+0000` on every live/board commit, glossary §18 forbids `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` in release builds. When `identity` is given the builder sets `TZ=UTC0` (measured on Git for Windows 2.55 with a `+0900` machine: commits carry `+0000`; POSIX libc reads the same value). Dates are set (`@<seconds> +0000`) only when `base.testBuild && wallMsForDates !== undefined`; `wallMsForDates` is ignored in release builds (lint L-DIST catches a leak).
5. **Effective ssh command** (09-security §2, same order as git's own `connect.c`): the first that is *set* of
   1. `GIT_SSH_COMMAND` in `base.daemonEnv` (any case, decision 1 — so a lower-case `git_ssh_command` is level 1 too);
   2. `base.sshCommand` — the user's `core.sshCommand`, which this pure builder cannot read from git config, so the caller resolves it once on the start path (`git config --get core.sshCommand`) and passes it in; it is kept verbatim, including a quoted `-i "<key path>"` with spaces or Hangul;
   3. `GIT_SSH` (single-quoted, because git runs `GIT_SSH_COMMAND` through `sh` and `C:\Program Files\PuTTY\plink.exe` has a space);
   4. `ssh`.

   An empty or whitespace-only value is *unset* at every level, and on network calls blank `GIT_SSH_COMMAND`/`GIT_SSH` entries are removed from the env (git would otherwise run an empty command instead of falling through to `core.sshCommand`). Variant: `GIT_SSH_VARIANT` (`ssh` / `plink` / `putty` / `tortoiseplink` / `simple`; anything else means auto), whichever level supplied the command; else the basename of the program — the first shell word for levels 1 and 2 (both are command lines to git), the whole value for level 3 — case-insensitive, `.exe` stripped. `ssh` → append ` -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3`; `plink`/`putty`/`tortoiseplink` → append ` -batch`; `simple` or an unrecognised program → nothing is appended and the builder does **not** set `GIT_SSH_COMMAND` (a user's level-1 value stays exactly as it was), so git resolves level 1–3 itself exactly as the user configured it (the watchdog bounds the call). The options are appended, never replacing the command (SEC-05). git's `ssh.variant` config key is not visible to the builder; `GIT_SSH_VARIANT` covers the same need. `base.sshCommand` may not contain NUL, CR or LF (the builder throws); `''` means unset.
6. **Env layering order:** `base.daemonEnv` → `extraEnv` (keys equal to a forced key, any case, are skipped) → `indexFile` → identity + `TZ` → test dates → ssh command (network class only; reads the env as layered so far, then `base.sshCommand`) → `FORCED_ENV` last. Output keys are sorted by code unit so snapshots are stable.

---

- [ ] **Step 1: Write the failing test for `buildDaemonEnv`**

Create `test/unit/env.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDaemonEnv, FORCED_ENV } from '../../src/git/env.js';

test('FORCED_ENV is exactly the glossary §18 set and is frozen', () => {
  assert.deepEqual({ ...FORCED_ENV }, {
    LC_ALL: 'C',
    LANGUAGE: '',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    SSH_ASKPASS_REQUIRE: 'never',
    GIT_OPTIONAL_LOCKS: '0',
  });
  assert.ok(Object.isFrozen(FORCED_ENV));
});

// A Windows-shaped environment, written literally so the test runs the same on every OS.
const WIN_SOURCE: Record<string, string | undefined> = {
  Path: 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd',
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\system32\\cmd.exe',
  USERPROFILE: 'C:\\Users\\홍길동',
  TEMP: 'C:\\Users\\홍길동\\AppData\\Local\\Temp',
  TMP: 'C:\\Users\\홍길동\\AppData\\Local\\Temp',
  APPDATA: 'C:\\Users\\홍길동\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\홍길동\\AppData\\Local',
  ProgramData: 'C:\\ProgramData',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  HOMEDRIVE: 'C:',
  HOMEPATH: '\\Users\\홍길동',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  windir: 'C:\\Windows',
  SystemDrive: 'C:',
  COMPUTERNAME: 'DESKTOP-DEMO',
  USERNAME: '홍길동',
  OS: 'Windows_NT',
  GCM_PROVIDER: 'github',
  GCM_INTERACTIVE: 'always',
  HTTPS_PROXY: 'http://proxy.corp.example:8080',
  JAVA_HOME: 'C:\\jdk-21',
  CLAUDE_CODE_MESSAGING_TOKEN: 'tok-secret',
  CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\claude-inbox',
  CLAUDE_PROJECT_DIR: 'C:\\r',
  ELECTRON_RUN_AS_NODE: '1',
  VSCODE_PID: '4242',
  NODE_OPTIONS: '--inspect',
  GIT_DIR: 'C:\\elsewhere\\.git',
  GIT_INDEX_FILE: 'C:\\elsewhere\\index',
  GIT_ASKPASS: 'C:\\askpass.exe',
  SSH_ASKPASS: 'C:\\askpass.exe',
  GIT_TRACE2_EVENT: 'C:\\trace.json',
  GIT_CONFIG_PARAMETERS: "'core.hookspath'='C:\\evil'",
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: 'C:\\evil',
  GIT_AUTHOR_EMAIL: 'real.person@corp.example',
  GIT_COMMITTER_NAME: 'Real Person',
  GIT_EDITOR: 'code --wait',
  GIT_EXEC_PATH: 'C:\\evil\\libexec',
  '=C:': 'C:\\r',
  UNSET: undefined,
};

test('Windows-shaped source: allowlist by any case, source spelling kept, never-list dropped, forced on top', () => {
  const out = buildDaemonEnv(WIN_SOURCE, ['JAVA_HOME', 'GIT_DIR', 'claude_code_messaging_token', '=C:']);
  assert.deepEqual(out, {
    APPDATA: 'C:\\Users\\홍길동\\AppData\\Roaming',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    GCM_INTERACTIVE: 'never',
    GCM_PROVIDER: 'github',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\홍길동',
    HTTPS_PROXY: 'http://proxy.corp.example:8080',
    JAVA_HOME: 'C:\\jdk-21',
    LANGUAGE: '',
    LC_ALL: 'C',
    LOCALAPPDATA: 'C:\\Users\\홍길동\\AppData\\Local',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    Path: 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd',
    ProgramData: 'C:\\ProgramData',
    ProgramFiles: 'C:\\Program Files',
    SSH_ASKPASS_REQUIRE: 'never',
    SystemDrive: 'C:',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Users\\홍길동\\AppData\\Local\\Temp',
    TMP: 'C:\\Users\\홍길동\\AppData\\Local\\Temp',
    USERPROFILE: 'C:\\Users\\홍길동',
    windir: 'C:\\Windows',
  });
});

test('POSIX-shaped source: LC_*, XDG_*, proxies in both cases, ssh and git config transport survive', () => {
  const out = buildDaemonEnv(
    {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/hong',
      TMPDIR: '/tmp',
      LANG: 'ko_KR.UTF-8',
      LC_CTYPE: 'ko_KR.UTF-8',
      LC_ALL: 'ko_KR.UTF-8',
      LANGUAGE: 'ko',
      XDG_CONFIG_HOME: '/home/hong/.config',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      SSH_AUTH_SOCK: '/run/user/1000/ssh-agent.sock',
      SSH_AGENT_PID: '999',
      http_proxy: 'http://proxy:3128',
      HTTPS_PROXY: 'http://proxy:3128',
      no_proxy: 'localhost',
      ALL_PROXY: 'socks5://proxy:1080',
      GIT_SSH_COMMAND: 'ssh -i ~/.ssh/work',
      GIT_CONFIG_GLOBAL: '/home/hong/.gitconfig-work',
      GIT_CONFIG_NOSYSTEM: '1',
      gcm_interactive: 'always',
      SHELL: '/bin/zsh',
      TERM: 'xterm-256color',
      EDITOR: 'vim',
      USER: 'hong',
      GIT_WORK_TREE: '/elsewhere',
      GIT_NAMESPACE: 'ns',
      GIT_COMMON_DIR: '/elsewhere/.git',
      GIT_OBJECT_DIRECTORY: '/elsewhere/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/elsewhere/alt',
      GIT_EXTERNAL_DIFF: '/bin/evil-diff',
      NODE_PATH: '/opt/node_modules',
      GIT_TRACE: '1',
      GIT_TRACE_PACKET: '1',
      GIT_AUTHOR_NAME: 'Hong',
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00+09:00',
      GIT_COMMITTER_DATE: '2020-01-01T00:00:00+09:00',
    },
    [],
  );
  assert.deepEqual(out, {
    ALL_PROXY: 'socks5://proxy:1080',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_GLOBAL: '/home/hong/.gitconfig-work',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_SSH_COMMAND: 'ssh -i ~/.ssh/work',
    GIT_TERMINAL_PROMPT: '0',
    HOME: '/home/hong',
    HTTPS_PROXY: 'http://proxy:3128',
    LANG: 'ko_KR.UTF-8',
    LANGUAGE: '',
    LC_ALL: 'C',
    LC_CTYPE: 'ko_KR.UTF-8',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    SSH_AGENT_PID: '999',
    SSH_ASKPASS_REQUIRE: 'never',
    SSH_AUTH_SOCK: '/run/user/1000/ssh-agent.sock',
    TMPDIR: '/tmp',
    XDG_CONFIG_HOME: '/home/hong/.config',
    XDG_RUNTIME_DIR: '/run/user/1000',
    http_proxy: 'http://proxy:3128',
    no_proxy: 'localhost',
  });
});

test('09-security §7 item 2: session secrets and git redirections never survive, even when passed through', () => {
  const names = ['GIT_INDEX_FILE', 'GIT_DIR', 'CLAUDE_CODE_MESSAGING_TOKEN', 'NODE_OPTIONS', 'GIT_ASKPASS'];
  const source: Record<string, string> = { HTTPS_PROXY: 'http://p:1', SSH_AUTH_SOCK: '/tmp/agent' };
  for (const n of names) source[n] = 'x';
  const out = buildDaemonEnv(source, names);
  for (const n of names) assert.equal(out[n], undefined, n);
  assert.equal(out.HTTPS_PROXY, 'http://p:1');
  assert.equal(out.SSH_AUTH_SOCK, '/tmp/agent');
});

const NEVER_SAMPLES = [
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CONFIG_DIR',
  'ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK', 'NODE_OPTIONS', 'NODE_PATH', 'SSH_ASKPASS', 'GIT_ASKPASS',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_12', 'GIT_EXEC_PATH', 'GIT_TRACE', 'GIT_TRACE2_EVENT', 'GIT_TRACE_PACKET',
  'GIT_EXTERNAL_DIFF', 'GIT_EDITOR', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
];

test('every never-list name is dropped in any case, even when passed through', () => {
  for (const name of NEVER_SAMPLES) {
    for (const spelled of [name, name.toLowerCase()]) {
      const out = buildDaemonEnv({ [spelled]: 'x', PATH: '/bin' }, [name, name.toLowerCase()]);
      const leaked = Object.keys(out).filter((k) => k.toUpperCase() === name);
      assert.deepEqual(leaked, [], spelled);
      assert.equal(out.PATH, '/bin');
    }
  }
});

const ALLOW_SAMPLES = [
  'PATH', 'Path', 'SystemRoot', 'ComSpec', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'TMPDIR', 'LANG',
  'LC_CTYPE', 'LC_MESSAGES', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramData', 'ProgramFiles',
  'HOMEDRIVE', 'HOMEPATH', 'PATHEXT', 'WINDIR', 'windir', 'SYSTEMDRIVE', 'SystemDrive',
  'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
  'GCM_PROVIDER', 'GCM_CREDENTIAL_STORE', 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy',
  'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy', 'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_SSH_VARIANT',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
];

test('every allowlisted name survives without passthrough, spelled as in the source', () => {
  for (const name of ALLOW_SAMPLES) {
    const out = buildDaemonEnv({ [name]: 'v' }, []);
    assert.equal(out[name], 'v', name);
  }
});

test('names outside the allowlist need passthrough (matched in any case)', () => {
  const source = { SHELL: '/bin/zsh', TERM: 'xterm', USER: 'hong', USERNAME: '홍길동', EDITOR: 'vim', 'ProgramFiles(x86)': 'C:\\x86', SECRET_FILTER_KEY_FILE: '/k' };
  const none = buildDaemonEnv(source, []);
  for (const k of Object.keys(source)) assert.equal(none[k], undefined, k);
  const some = buildDaemonEnv(source, ['secret_filter_key_file', 'USERNAME']);
  assert.equal(some.SECRET_FILTER_KEY_FILE, '/k');
  assert.equal(some.USERNAME, '홍길동');
  assert.equal(some.SHELL, undefined);
});

test('forced values replace every case variant of the same name', () => {
  const source = {
    LC_ALL: 'ko_KR.UTF-8',
    lc_all: 'x',
    LANGUAGE: 'ko',
    GCM_INTERACTIVE: 'always',
    gcm_interactive: 'always',
    GIT_TERMINAL_PROMPT: '1',
    Git_Optional_Locks: '1',
    SSH_ASKPASS_REQUIRE: 'force',
  };
  const out = buildDaemonEnv(source, Object.keys(source));
  assert.deepEqual(out, { ...FORCED_ENV });
});

test('undefined values, NUL bytes and names containing "=" are skipped', () => {
  const out = buildDaemonEnv({ PATH: '/bin\0/evil', HOME: undefined, '=C:': 'C:\\r', TMP: '/tmp' }, ['=C:']);
  assert.deepEqual(out, { ...FORCED_ENV, TMP: '/tmp' });
});

test('output keys are sorted by code unit and independent of source order', () => {
  const entries = Object.entries(WIN_SOURCE);
  const a = buildDaemonEnv(Object.fromEntries(entries), ['JAVA_HOME']);
  const b = buildDaemonEnv(Object.fromEntries(entries.slice().reverse()), ['JAVA_HOME']);
  assert.deepEqual(Object.keys(a), Object.keys(a).slice().sort());
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('buildDaemonEnv does not mutate its inputs', () => {
  const source = Object.freeze({ PATH: '/bin', GIT_DIR: '/x' });
  const passthrough = Object.freeze(['GIT_DIR']) as unknown as string[];
  buildDaemonEnv(source, passthrough);
  assert.deepEqual(source, { PATH: '/bin', GIT_DIR: '/x' });
  assert.deepEqual(passthrough, ['GIT_DIR']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/unit/env.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (cannot find `src/git/env.js`).

- [ ] **Step 3: Write the minimal implementation of `env.ts`**

Create `src/git/env.ts`:

```ts
/**
 * DAEMON_ENV builder: 09-security §3.4 is the single allowlist and never-list.
 * Names are compared case-insensitively (Windows spells Path, windir, SystemDrive, ProgramData);
 * the spelling found in the source is kept in the output.
 */

/** Glossary §18 forced values, applied on top of everything (09-security §3.4 item 5). */
export const FORCED_ENV: Readonly<Record<string, string>> = Object.freeze({
  LC_ALL: 'C',
  LANGUAGE: '',
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  SSH_ASKPASS_REQUIRE: 'never',
  GIT_OPTIONAL_LOCKS: '0',
});

// 09-security §3.4 item 1: base allowlist.
const BASE_ALLOW_NAMES = ['PATH', 'SYSTEMROOT', 'COMSPEC', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'TMPDIR', 'LANG'];
const BASE_ALLOW_PREFIXES = ['LC_'];

// 09-security §3.4 item 2: credential and transport set (lower-case proxy forms match case-insensitively).
const TRANSPORT_ALLOW_NAMES = [
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'HOMEDRIVE', 'HOMEPATH', 'PATHEXT', 'WINDIR',
  'SYSTEMDRIVE', 'DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'HTTP_PROXY', 'HTTPS_PROXY',
  'NO_PROXY', 'ALL_PROXY', 'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_SSH_VARIANT', 'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
];
const TRANSPORT_ALLOW_PREFIXES = ['XDG_', 'GCM_'];

// 09-security §3.4 item 4: never-list (always dropped, even if passed through).
const NEVER_NAMES = [
  'NODE_OPTIONS', 'NODE_PATH', 'SSH_ASKPASS', 'GIT_ASKPASS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE',
  'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_EXEC_PATH', 'GIT_EXTERNAL_DIFF', 'GIT_EDITOR',
];
const NEVER_PREFIXES = [
  'CLAUDE_', 'ELECTRON_', 'VSCODE_', 'GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_', 'GIT_TRACE', 'GIT_AUTHOR_',
  'GIT_COMMITTER_',
];

const ALLOW_NAMES: ReadonlySet<string> = new Set([...BASE_ALLOW_NAMES, ...TRANSPORT_ALLOW_NAMES]);
const ALLOW_PREFIXES: readonly string[] = [...BASE_ALLOW_PREFIXES, ...TRANSPORT_ALLOW_PREFIXES];
const NEVER: ReadonlySet<string> = new Set(NEVER_NAMES);
const FORCED_UPPER: ReadonlySet<string> = new Set(Object.keys(FORCED_ENV).map((k) => k.toUpperCase()));

function isNever(upper: string): boolean {
  return NEVER.has(upper) || NEVER_PREFIXES.some((p) => upper.startsWith(p));
}

function isAllowlisted(upper: string): boolean {
  return ALLOW_NAMES.has(upper) || ALLOW_PREFIXES.some((p) => upper.startsWith(p));
}

function isUsableName(name: string): boolean {
  return name.length > 0 && !name.includes('=') && !name.includes('\0');
}

function sortedCopy(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(env).sort()) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Builds DAEMON_ENV once, at spawn, from the spawning hook's environment (09-security §3.4):
 * allowlist ∪ credential/transport set ∪ passthrough, minus the never-list, with FORCED_ENV on top.
 */
export function buildDaemonEnv(
  source: Record<string, string | undefined>,
  passthrough: string[],
): Record<string, string> {
  const passUpper = new Set(passthrough.map((n) => n.toUpperCase()));
  const out: Record<string, string> = {};
  for (const name of Object.keys(source)) {
    const value = source[name];
    if (value === undefined || value.includes('\0') || !isUsableName(name)) continue;
    const upper = name.toUpperCase();
    if (isNever(upper) || FORCED_UPPER.has(upper)) continue;
    if (!isAllowlisted(upper) && !passUpper.has(upper)) continue;
    out[name] = value;
  }
  for (const [name, value] of Object.entries(FORCED_ENV)) out[name] = value;
  return sortedCopy(out);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test test/unit/env.test.ts`
Expected: PASS — 11 tests, 0 failures.

- [ ] **Step 5: Commit**

```
git add src/git/env.ts test/unit/env.test.ts
git commit -m "feat(git): add DAEMON_ENV builder with allowlist and never-list (09-security §3.4)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Write the failing test for `buildGitInvocation` (argv/env snapshots + Review Focus 4)**

Create `test/unit/flags.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { buildDaemonEnv, FORCED_ENV } from '../../src/git/env.js';
import {
  buildGitInvocation,
  DIFF_FAMILY,
  MERGE_FLAGS,
  type GitBase,
  type GitCallOptions,
  type GitInvocation,
} from '../../src/git/flags.js';

// Review Focus 1 shape: hooks path with a space and Hangul.
const HOOKS_POSIX = '/home/홍길동/My Repos/demo/.git/cowork/empty-hooks';
const HOOKS_WIN = 'C:\\Users\\홍길동\\My Repos\\demo\\.git\\cowork\\empty-hooks';
const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const OID_A = '1111111111111111111111111111111111111111';
const OID_B = '2222222222222222222222222222222222222222';
const SSH_BATCH = '-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3';

const POSIX_ENV = buildDaemonEnv({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/hong', LANG: 'ko_KR.UTF-8' }, []);

function base(over: Partial<GitBase> = {}): GitBase {
  return { hooksPath: HOOKS_POSIX, platform: 'linux', daemonEnv: POSIX_ENV, testBuild: false, ...over };
}

function local(over: Partial<GitCallOptions> = {}): GitCallOptions {
  return { class: 'local', cwd: '/home/홍길동/My Repos/demo', ...over };
}

/** The `-c` pairs every call carries (glossary §18), in builder order. */
function always(hooksPath: string): string[] {
  return [
    '-c', `core.hooksPath=${hooksPath}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.quotepath=off',
    '-c', 'commit.gpgSign=false',
    '-c', 'tag.gpgSign=false',
    '-c', 'gc.auto=0',
    '-c', 'maintenance.auto=false',
    '-c', 'fetch.fsckObjects=true',
    '-c', 'transfer.fsckObjects=true',
    '-c', 'protocol.ext.allow=never',
    '-c', 'core.askPass=',
    '-c', 'submodule.recurse=false',
  ];
}
const LFS = ['-c', 'filter.lfs.required=true'];
const NETWORK = ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=10'];
const FETCH_FLAGS = ['--no-write-fetch-head', '--no-auto-maintenance', '--no-tags', '--no-recurse-submodules'];
const REFUPDATE = ['-c', 'core.logAllRefUpdates=always', '-c', 'core.fsync=committed,reference,index', '-c', 'core.fsyncMethod=batch'];

/** Every -c precedes the subcommand, no -c key repeats, no -X option, env keys sorted. */
function assertWellFormed(inv: GitInvocation, sub: string): void {
  let i = 0;
  while (inv.argv[i] === '-c') i += 2;
  assert.equal(inv.argv[i], sub, 'subcommand position');
  assert.ok(!inv.argv.slice(i + 1).includes('-c'), 'a -c after the subcommand would be a subcommand argument');
  const keys = inv.argv
    .slice(0, i)
    .filter((_, k) => k % 2 === 1)
    .map((kv) => kv.slice(0, kv.indexOf('=')).toLowerCase());
  assert.equal(new Set(keys).size, keys.length, `duplicate -c key in ${JSON.stringify(keys)}`);
  assert.ok(!inv.argv.some((a) => a.startsWith('-X')), 'no -X merge options (glossary §18)');
  assert.deepEqual(Object.keys(inv.env), Object.keys(inv.env).slice().sort(), 'env keys sorted');
}

test('the daemon env used by these snapshots', () => {
  assert.deepEqual(POSIX_ENV, {
    GCM_INTERACTIVE: 'never',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    HOME: '/home/hong',
    LANG: 'ko_KR.UTF-8',
    LANGUAGE: '',
    LC_ALL: 'C',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    SSH_ASKPASS_REQUIRE: 'never',
  });
});

test('snapshot: local status on linux', () => {
  const inv = buildGitInvocation(['status', '--porcelain=v2', '-z'], local(), base());
  assert.deepEqual(inv, {
    argv: [...always(HOOKS_POSIX), ...LFS, 'status', '--porcelain=v2', '-z'],
    env: POSIX_ENV,
  });
  assertWellFormed(inv, 'status');
  // stdin and cwd are for the runner; they never change argv or env.
  assert.deepEqual(buildGitInvocation(['status', '--porcelain=v2', '-z'], local({ stdin: Buffer.from('x') }), base()), inv);
});

test('snapshot: core.longpaths=true is added on win32 only', () => {
  const args = ['status', '--porcelain=v2', '-z'];
  const win = buildGitInvocation(args, local({ cwd: 'C:\\Users\\홍길동\\My Repos\\demo' }), base({ platform: 'win32', hooksPath: HOOKS_WIN }));
  assert.deepEqual(win.argv, [...always(HOOKS_WIN), '-c', 'core.longpaths=true', ...LFS, ...args]);
  assertWellFormed(win, 'status');
  for (const platform of ['linux', 'darwin'] as const) {
    const other = buildGitInvocation(args, local(), base({ platform }));
    assert.ok(!other.argv.includes('core.longpaths=true'), platform);
  }
});

test('snapshot: network fetch adds lowSpeed, the four fetch flags and the BatchMode ssh command', () => {
  const inv = buildGitInvocation(
    ['fetch', 'file:///srv/remote.git', '+refs/cowork/main/board:refs/cowork-remote/main/board'],
    { class: 'network', cwd: '/r' },
    base(),
  );
  assert.deepEqual(inv, {
    argv: [
      ...always(HOOKS_POSIX), ...LFS, ...NETWORK,
      'fetch', ...FETCH_FLAGS,
      'file:///srv/remote.git', '+refs/cowork/main/board:refs/cowork-remote/main/board',
    ],
    env: { ...POSIX_ENV, GIT_SSH_COMMAND: `ssh ${SSH_BATCH}` },
  });
  assertWellFormed(inv, 'fetch');
});

test('fetch flags are added on every fetch, whatever the class (SEC-02)', () => {
  const inv = buildGitInvocation(['fetch', 'origin'], local(), base());
  assert.deepEqual(inv.argv, [...always(HOOKS_POSIX), ...LFS, 'fetch', ...FETCH_FLAGS, 'origin']);
  assert.equal(inv.env.GIT_SSH_COMMAND, undefined, 'ssh command is network class only');
  assert.ok(!inv.argv.includes('http.lowSpeedLimit=1000'), 'lowSpeed is network class only');
});

test('snapshot: network push and ls-remote get lowSpeed but no fetch flags', () => {
  const push = buildGitInvocation(
    ['push', '--porcelain', 'file:///srv/remote.git', `${OID_A}:refs/cowork/main/board`],
    { class: 'network', cwd: '/r' },
    base(),
  );
  assert.deepEqual(push.argv, [
    ...always(HOOKS_POSIX), ...LFS, ...NETWORK,
    'push', '--porcelain', 'file:///srv/remote.git', `${OID_A}:refs/cowork/main/board`,
  ]);
  assertWellFormed(push, 'push');
  const ls = buildGitInvocation(['ls-remote', '--exit-code', 'file:///srv/remote.git', 'refs/heads/main'], { class: 'network', cwd: '/r' }, base());
  assert.deepEqual(ls.argv, [...always(HOOKS_POSIX), ...LFS, ...NETWORK, 'ls-remote', '--exit-code', 'file:///srv/remote.git', 'refs/heads/main']);
  assert.equal(ls.env.GIT_SSH_COMMAND, `ssh ${SSH_BATCH}`);
});

test('DIFF_FAMILY is exactly the glossary §18 / 09 §2 family', () => {
  assert.deepEqual([...DIFF_FAMILY].sort(), ['blame', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'log', 'show']);
});

test('snapshot: every diff-family command gets --no-ext-diff --no-textconv right after the subcommand', () => {
  for (const sub of DIFF_FAMILY) {
    const inv = buildGitInvocation([sub, '--', 'src/a.ts'], local(), base());
    assert.deepEqual(inv.argv, [...always(HOOKS_POSIX), ...LFS, sub, '--no-ext-diff', '--no-textconv', '--', 'src/a.ts'], sub);
    assertWellFormed(inv, sub);
  }
  for (const sub of ['cat-file', 'ls-files', 'rev-parse', 'merge-tree']) {
    const inv = buildGitInvocation([sub, 'x'], local(), base());
    assert.ok(!inv.argv.includes('--no-ext-diff'), sub);
  }
});

test('MERGE_FLAGS is the glossary §18 set, frozen', () => {
  assert.deepEqual([...MERGE_FLAGS], ['-c', 'merge.renormalize=false', '-c', 'merge.renames=true', '-c', 'merge.directoryRenames=false']);
  assert.ok(Object.isFrozen(MERGE_FLAGS));
});

test('snapshot: merge-tree (attr class) and merge-file carry MERGE_FLAGS before the subcommand', () => {
  const mt = buildGitInvocation(
    ['merge-tree', '--write-tree', '-z', `--merge-base=${OID_A}`, OID_B, OID_A],
    { class: 'attr', cwd: '/r', attrTree: TREE },
    base(),
  );
  assert.deepEqual(mt.argv, [
    ...always(HOOKS_POSIX), ...LFS, '-c', `attr.tree=${TREE}`, ...MERGE_FLAGS,
    'merge-tree', '--write-tree', '-z', `--merge-base=${OID_A}`, OID_B, OID_A,
  ]);
  assertWellFormed(mt, 'merge-tree');
  const mf = buildGitInvocation(['merge-file', '-p', '--object-id', OID_A, OID_B, OID_A], local(), base());
  assert.deepEqual(mf.argv, [...always(HOOKS_POSIX), ...LFS, ...MERGE_FLAGS, 'merge-file', '-p', '--object-id', OID_A, OID_B, OID_A]);
  assertWellFormed(mf, 'merge-file');
});

test('snapshot: refupdate class adds reflog and fsync flags; other classes do not', () => {
  const inv = buildGitInvocation(
    ['update-ref', '--create-reflog', 'refs/cowork-local/main/state', OID_B, OID_A],
    { class: 'refupdate', cwd: '/r' },
    base(),
  );
  assert.deepEqual(inv.argv, [
    ...always(HOOKS_POSIX), ...LFS, ...REFUPDATE,
    'update-ref', '--create-reflog', 'refs/cowork-local/main/state', OID_B, OID_A,
  ]);
  assertWellFormed(inv, 'update-ref');
  for (const cls of ['local', 'network', 'attr'] as const) {
    const other = buildGitInvocation(['update-ref', 'refs/x', OID_A], { class: cls, cwd: '/r' }, base());
    assert.ok(!other.argv.includes('core.fsyncMethod=batch'), cls);
  }
});

test('snapshot: attr add with filter drivers (sorted, de-duplicated, lfs always) and attr.tree', () => {
  const inv = buildGitInvocation(
    ['add', '--', 'src/settings.py'],
    { class: 'attr', cwd: '/r', attrTree: TREE, filterDrivers: ['secret', 'lfs', 'git-crypt', 'secret'] },
    base(),
  );
  assert.deepEqual(inv.argv, [
    ...always(HOOKS_POSIX),
    '-c', 'filter.git-crypt.required=true',
    '-c', 'filter.lfs.required=true',
    '-c', 'filter.secret.required=true',
    '-c', `attr.tree=${TREE}`,
    'add', '--', 'src/settings.py',
  ]);
  assertWellFormed(inv, 'add');
});

test('fsmonitor: true sets core.fsmonitor=true, default false', () => {
  const on = buildGitInvocation(['status'], local({ fsmonitor: true }), base());
  assert.deepEqual(on.argv.slice(0, 4), ['-c', `core.hooksPath=${HOOKS_POSIX}`, '-c', 'core.fsmonitor=true']);
  const off = buildGitInvocation(['status'], local({ fsmonitor: false }), base());
  assert.deepEqual(off.argv.slice(2, 4), ['-c', 'core.fsmonitor=false']);
});

test('identity sets author/committer and TZ=UTC0; dates only in test builds', () => {
  const identity = { name: 'peer-7f3a', email: '7f3a9c@cowork.invalid' };
  const idEnv = {
    GIT_AUTHOR_EMAIL: '7f3a9c@cowork.invalid',
    GIT_AUTHOR_NAME: 'peer-7f3a',
    GIT_COMMITTER_EMAIL: '7f3a9c@cowork.invalid',
    GIT_COMMITTER_NAME: 'peer-7f3a',
    TZ: 'UTC0',
  };
  const args = ['commit-tree', TREE, '-p', OID_A, '-m', 'board'];
  const release = buildGitInvocation(args, local({ identity, wallMsForDates: 1_700_000_000_999 }), base({ testBuild: false }));
  assert.deepEqual(release.env, { ...POSIX_ENV, ...idEnv });
  assertWellFormed(release, 'commit-tree');
  const testBuild = buildGitInvocation(args, local({ identity, wallMsForDates: 1_700_000_000_999 }), base({ testBuild: true }));
  assert.deepEqual(testBuild.env, {
    ...POSIX_ENV,
    ...idEnv,
    GIT_AUTHOR_DATE: '@1700000000 +0000',
    GIT_COMMITTER_DATE: '@1700000000 +0000',
  });
  const datesOnly = buildGitInvocation(args, local({ wallMsForDates: 0 }), base({ testBuild: true }));
  assert.deepEqual(datesOnly.env, { ...POSIX_ENV, GIT_AUTHOR_DATE: '@0 +0000', GIT_COMMITTER_DATE: '@0 +0000' });
  const none = buildGitInvocation(args, local(), base({ testBuild: true }));
  assert.deepEqual(none.env, POSIX_ENV);
});

test('indexFile sets GIT_INDEX_FILE', () => {
  const inv = buildGitInvocation(['read-tree', TREE], { class: 'refupdate', cwd: '/r', indexFile: '/r/.git/cowork/tmp/snap index' }, base());
  assert.deepEqual(inv.env, { ...POSIX_ENV, GIT_INDEX_FILE: '/r/.git/cowork/tmp/snap index' });
});

test('extraEnv adds variables but never overrides FORCED_ENV (any case); explicit options beat it', () => {
  const inv = buildGitInvocation(
    ['status'],
    local({
      indexFile: '/b/index',
      extraEnv: {
        LC_ALL: 'ko_KR.UTF-8',
        lc_all: 'x',
        LANGUAGE: 'ko',
        GCM_INTERACTIVE: 'always',
        gcm_interactive: 'always',
        GIT_TERMINAL_PROMPT: '1',
        GIT_INDEX_FILE: '/a/index',
        HOME: '/tmp/h',
        FOO: 'bar',
      },
    }),
    base(),
  );
  // Check the forced keys first: assert.deepEqual narrows inv.env's static type afterwards.
  for (const [k, v] of Object.entries(FORCED_ENV)) assert.equal(inv.env[k], v, k);
  assert.deepEqual(inv.env, { ...POSIX_ENV, FOO: 'bar', GIT_INDEX_FILE: '/b/index', HOME: '/tmp/h' });
});

test('ssh: the BatchMode options are appended to the effective ssh command, never replacing it', () => {
  const cases: Array<[source: Record<string, string>, expected: string | undefined]> = [
    [{}, `ssh ${SSH_BATCH}`],
    [{ GIT_SSH_COMMAND: 'ssh -i "/home/hong/My Keys/id_work"' }, `ssh -i "/home/hong/My Keys/id_work" ${SSH_BATCH}`],
    [{ GIT_SSH_COMMAND: '"C:/Program Files/OpenSSH/ssh.exe" -F nul' }, `"C:/Program Files/OpenSSH/ssh.exe" -F nul ${SSH_BATCH}`],
    [{ git_ssh_command: 'ssh -4' }, `ssh -4 ${SSH_BATCH}`],
    [{ GIT_SSH: 'C:\\Program Files\\PuTTY\\plink.exe' }, "'C:\\Program Files\\PuTTY\\plink.exe' -batch"],
    [{ GIT_SSH: '/opt/tortoise/TortoisePlink.exe' }, "'/opt/tortoise/TortoisePlink.exe' -batch"],
    [{ GIT_SSH: "/usr/bin/o'ssh", GIT_SSH_VARIANT: 'ssh' }, `'/usr/bin/o'\\''ssh' ${SSH_BATCH}`],
    [{ GIT_SSH_COMMAND: 'plink -load work' }, 'plink -load work -batch'],
    [{ GIT_SSH_COMMAND: 'my-wrapper', GIT_SSH_VARIANT: 'putty' }, 'my-wrapper -batch'],
    [{ GIT_SSH_COMMAND: 'my-wrapper --x' }, 'my-wrapper --x'],
    [{ GIT_SSH_COMMAND: 'ssh', GIT_SSH_VARIANT: 'simple' }, 'ssh'],
    [{ GIT_SSH: '/usr/local/bin/ssh-wrap' }, undefined],
  ];
  for (const [source, expected] of cases) {
    const daemonEnv = buildDaemonEnv({ PATH: '/bin', ...source }, []);
    const inv = buildGitInvocation(['ls-remote', 'git@github.com:team/repo.git'], { class: 'network', cwd: '/r' }, base({ daemonEnv }));
    assert.equal(inv.env.GIT_SSH_COMMAND, expected, JSON.stringify(source));
    const variants = Object.keys(inv.env).filter((k) => k.toUpperCase() === 'GIT_SSH_COMMAND');
    assert.ok(variants.length <= 1, `one spelling of GIT_SSH_COMMAND: ${JSON.stringify(variants)}`);
  }
});

test('ssh: effective command precedence GIT_SSH_COMMAND > core.sshCommand > GIT_SSH > ssh (09-security §2)', () => {
  // core.sshCommand values carrying an identity-file path with a space and Hangul (Review Focus 1 shape).
  const KEY_CMD = 'ssh -i "/home/홍길동/My Keys/id_work" -o IdentitiesOnly=yes';
  const WIN_KEY_CMD = '"C:/Program Files/OpenSSH/ssh.exe" -i "C:/Users/홍길동/.ssh/id_ed25519"';
  const PLINK = 'C:\\Program Files\\PuTTY\\plink.exe';
  const cases: Array<[label: string, source: Record<string, string>, sshCommand: string | undefined, expected: string | undefined]> = [
    // Level 1: GIT_SSH_COMMAND in the daemon env wins over core.sshCommand and GIT_SSH.
    ['L1 env command beats core.sshCommand and GIT_SSH', { GIT_SSH_COMMAND: 'ssh -4', GIT_SSH: PLINK }, KEY_CMD, `ssh -4 ${SSH_BATCH}`],
    ['L1 env plink command beats an ssh core.sshCommand', { GIT_SSH_COMMAND: 'plink -load work' }, KEY_CMD, 'plink -load work -batch'],
    // Level 2: core.sshCommand, kept verbatim with its key path, wins over GIT_SSH.
    ['L2 core.sshCommand key path, nothing in env', {}, KEY_CMD, `${KEY_CMD} ${SSH_BATCH}`],
    ['L2 core.sshCommand beats GIT_SSH', { GIT_SSH: PLINK }, KEY_CMD, `${KEY_CMD} ${SSH_BATCH}`],
    ['L2 core.sshCommand quoted Windows program and key path', {}, WIN_KEY_CMD, `${WIN_KEY_CMD} ${SSH_BATCH}`],
    ['L2 core.sshCommand trailing whitespace trimmed', {}, 'ssh -i ~/.ssh/work   ', `ssh -i ~/.ssh/work ${SSH_BATCH}`],
    ['L2 core.sshCommand plink key path gets -batch', {}, 'plink -i "C:/Users/홍길동/keys/work.ppk"', 'plink -i "C:/Users/홍길동/keys/work.ppk" -batch'],
    ['L2 core.sshCommand with GIT_SSH_VARIANT=tortoiseplink', { GIT_SSH_VARIANT: 'tortoiseplink' }, 'C:/tools/tp.exe -i k.ppk', 'C:/tools/tp.exe -i k.ppk -batch'],
    ['L2 blank env command falls through to core.sshCommand', { GIT_SSH_COMMAND: '   ' }, KEY_CMD, `${KEY_CMD} ${SSH_BATCH}`],
    // Nothing appended: GIT_SSH_COMMAND stays unset, so git applies core.sshCommand itself, unchanged.
    ['L2 core.sshCommand with GIT_SSH_VARIANT=simple', { GIT_SSH_VARIANT: 'simple' }, KEY_CMD, undefined],
    ['L2 core.sshCommand unrecognised wrapper', { GIT_SSH: PLINK }, '/opt/bin/ssh-wrap --profile work', undefined],
    // Level 3: GIT_SSH with its variant.
    ['L3 blank core.sshCommand falls through to GIT_SSH', { GIT_SSH: '/usr/bin/plink' }, '   ', "'/usr/bin/plink' -batch"],
    ['L3 GIT_SSH plink', { GIT_SSH: PLINK }, undefined, "'C:\\Program Files\\PuTTY\\plink.exe' -batch"],
    ['L3 GIT_SSH ssh basename', { GIT_SSH: '/usr/bin/ssh' }, undefined, `'/usr/bin/ssh' ${SSH_BATCH}`],
    ['L3 GIT_SSH with GIT_SSH_VARIANT=simple', { GIT_SSH: '/usr/bin/ssh', GIT_SSH_VARIANT: 'simple' }, undefined, undefined],
    // Level 4: plain ssh.
    ['L4 nothing anywhere', {}, undefined, `ssh ${SSH_BATCH}`],
    ['L4 empty core.sshCommand', {}, '', `ssh ${SSH_BATCH}`],
    ['L4 blank GIT_SSH_COMMAND and GIT_SSH', { GIT_SSH_COMMAND: '', GIT_SSH: ' ' }, undefined, `ssh ${SSH_BATCH}`],
    ['L4 blank everything, simple variant', { GIT_SSH_COMMAND: ' ', GIT_SSH_VARIANT: 'simple' }, ' ', undefined],
  ];
  for (const [label, source, sshCommand, expected] of cases) {
    const daemonEnv = buildDaemonEnv({ PATH: '/bin', ...source }, []);
    const inv = buildGitInvocation(['fetch', 'git@github.com:team/repo.git'], { class: 'network', cwd: '/r' }, base({ daemonEnv, sshCommand }));
    assert.equal(inv.env.GIT_SSH_COMMAND, expected, label);
    const sshKeys = Object.keys(inv.env).filter((k) => k.toUpperCase() === 'GIT_SSH_COMMAND' || k.toUpperCase() === 'GIT_SSH');
    for (const k of sshKeys) assert.notEqual((inv.env[k] ?? '').trim(), '', `${label}: blank ${k} left in env`);
    assert.ok(Object.keys(inv.env).filter((k) => k.toUpperCase() === 'GIT_SSH_COMMAND').length <= 1, label);
  }
});

test('ssh: local classes leave the user ssh command untouched and ignore core.sshCommand', () => {
  const daemonEnv = buildDaemonEnv({ PATH: '/bin', GIT_SSH_COMMAND: 'ssh -i k' }, []);
  const inv = buildGitInvocation(['status'], local(), base({ daemonEnv, sshCommand: 'ssh -i other' }));
  assert.equal(inv.env.GIT_SSH_COMMAND, 'ssh -i k');
  for (const cls of ['local', 'attr', 'refupdate'] as const) {
    const other = buildGitInvocation(['fetch', 'origin'], { class: cls, cwd: '/r' }, base({ sshCommand: 'ssh -i other' }));
    assert.equal(other.env.GIT_SSH_COMMAND, undefined, cls);
  }
});

test('Review Focus 4: the user git config and locale cannot leak into cowork git calls', () => {
  // A session that has a Korean locale and tries to inject config through the environment.
  const daemonEnv = buildDaemonEnv(
    {
      PATH: '/usr/bin',
      HOME: '/home/hong',
      LANG: 'ko_KR.UTF-8',
      LC_MESSAGES: 'ko_KR.UTF-8',
      LANGUAGE: 'ko',
      GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/evil' 'commit.gpgSign'='true'",
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: '/evil/fsmonitor-hook',
      GIT_CONFIG_KEY_1: 'url.https://evil.example/.insteadOf',
      GIT_CONFIG_VALUE_1: 'https://github.com/',
    },
    [],
  );
  const inv = buildGitInvocation(
    ['commit', '-q', '-m', 'live'],
    local({ identity: { name: 'peer-1', email: 'p1@cowork.invalid' } }),
    base({ daemonEnv }),
  );
  assertWellFormed(inv, 'commit');
  const pairs = inv.argv.slice(0, inv.argv.indexOf('commit')).filter((_, k) => k % 2 === 1);
  // The repository's own core.hooksPath, core.fsmonitor hook and commit.gpgSign=true lose to these -c values.
  assert.ok(pairs.includes(`core.hooksPath=${HOOKS_POSIX}`));
  assert.ok(pairs.includes('core.fsmonitor=false'));
  assert.ok(pairs.includes('commit.gpgSign=false'));
  assert.ok(pairs.includes('tag.gpgSign=false'));
  assert.ok(pairs.includes('core.quotepath=off'));
  // Output stays in English: LC_ALL=C overrides LANG/LC_MESSAGES, LANGUAGE is emptied.
  assert.equal(inv.env.LC_ALL, 'C');
  assert.equal(inv.env.LANGUAGE, '');
  assert.equal(inv.env.LANG, 'ko_KR.UTF-8');
  // Environment-injected config never reaches git.
  for (const k of Object.keys(inv.env)) {
    assert.ok(!k.toUpperCase().startsWith('GIT_CONFIG_'), k);
  }
  // The user's core.sshCommand (resolved by the caller) stays the effective ssh command; BatchMode is appended, not substituted.
  const net = buildGitInvocation(
    ['ls-remote', '--exit-code', 'git@github.com:team/repo.git', 'refs/heads/main'],
    { class: 'network', cwd: '/r' },
    base({ daemonEnv, sshCommand: 'ssh -i ~/.ssh/work' }),
  );
  assertWellFormed(net, 'ls-remote');
  assert.equal(net.env.GIT_SSH_COMMAND, `ssh -i ~/.ssh/work ${SSH_BATCH}`);
  assert.equal(net.env.LC_ALL, 'C');
  // url.*.insteadOf in the user's config files cannot be overridden by -c; it is refused at /cowork start (glossary §18, later plan).
});

test('invalid calls throw instead of building a wrong command line', () => {
  const bad: Array<[string[], GitCallOptions, GitBase]> = [
    [[], local(), base()],
    [['--version'], local(), base()],
    [['-C', '/x', 'status'], local(), base()],
    [[''], local(), base()],
    [['status'], local({ filterDrivers: ['a=b'] }), base()],
    [['status'], local({ filterDrivers: ['has space'] }), base()],
    [['status'], local({ filterDrivers: [''] }), base()],
    [['status'], local({ attrTree: 'HEAD' }), base()],
    [['status'], local({ attrTree: 'abc123' }), base()],
    [['status'], { class: 'bogus', cwd: '/r' } as unknown as GitCallOptions, base()],
    [['status'], local({ identity: { name: 'a\nb', email: 'x@cowork.invalid' } }), base()],
    [['status'], local({ identity: { name: 'p', email: '<x@cowork.invalid>' } }), base()],
    [['status'], local({ identity: { name: '', email: 'x@cowork.invalid' } }), base()],
    [['status'], local({ indexFile: '' }), base()],
    [['status'], local(), base({ hooksPath: '' })],
    [['status'], local(), base({ hooksPath: '/x\n/y' })],
    [['status'], local({ wallMsForDates: Number.NaN }), base({ testBuild: true })],
    [['status'], local({ wallMsForDates: -1 }), base({ testBuild: true })],
    [['status'], local(), base({ sshCommand: 'ssh -i k\nrm -rf ~' })],
    [['status'], local(), base({ sshCommand: 'ssh\r' })],
    [['status'], local(), base({ sshCommand: 'ssh\0-i k' })],
  ];
  for (const [args, opts, b] of bad) {
    assert.throws(() => buildGitInvocation(args, opts, b), Error, JSON.stringify({ args, opts }));
  }
  // A release build ignores wallMsForDates entirely, including bad values.
  assert.doesNotThrow(() => buildGitInvocation(['status'], local({ wallMsForDates: Number.NaN }), base({ testBuild: false })));
  assert.doesNotThrow(() => buildGitInvocation(['version'], local(), base()));
  // An empty core.sshCommand means "not configured".
  assert.doesNotThrow(() => buildGitInvocation(['ls-remote', 'origin'], { class: 'network', cwd: '/r' }, base({ sshCommand: '' })));
});

test('buildGitInvocation does not mutate its inputs', () => {
  const daemonEnv = Object.freeze({ ...POSIX_ENV });
  const args = Object.freeze(['fetch', 'origin']) as unknown as string[];
  const opts = Object.freeze(local({ class: 'network', filterDrivers: ['secret'] }));
  buildGitInvocation(args, opts, base({ daemonEnv }));
  assert.deepEqual(args, ['fetch', 'origin']);
  assert.deepEqual(daemonEnv, POSIX_ENV);
  assert.deepEqual(opts.filterDrivers, ['secret']);
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx tsx --test test/unit/flags.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (cannot find `src/git/flags.js`).

- [ ] **Step 8: Write the minimal implementation of `flags.ts`**

Create `src/git/flags.ts`:

```ts
import type { Buffer } from 'node:buffer';
import { FORCED_ENV } from './env.js';

export type GitClass = 'local' | 'network' | 'attr' | 'refupdate';

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitCallOptions {
  class: GitClass;
  cwd: string;
  /** Each gets -c filter.<d>.required=true; lfs is always added. */
  filterDrivers?: string[];
  /** -c attr.tree=<oid> (attribute-reading commands). */
  attrTree?: string;
  /** -c core.fsmonitor=true|false (default false). */
  fsmonitor?: boolean;
  /** Live/board commits: GIT_AUTHOR_NAME/EMAIL, GIT_COMMITTER_NAME/EMAIL and TZ=UTC0 so the offset is +0000. */
  identity?: GitIdentity;
  /** Test builds only: GIT_AUTHOR_DATE/GIT_COMMITTER_DATE. Ignored when base.testBuild is false. */
  wallMsForDates?: number;
  /** GIT_INDEX_FILE for private indexes. */
  indexFile?: string;
  /** When set, piped to git by the runner; otherwise stdin is ignored. Not used by this builder. */
  stdin?: Buffer;
  /** Never overrides FORCED_ENV. */
  extraEnv?: Record<string, string>;
}

export interface GitInvocation {
  /** Arguments after the git executable. */
  argv: string[];
  /** The complete environment of the git process. */
  env: Record<string, string>;
}

export interface GitBase {
  hooksPath: string;
  platform: NodeJS.Platform;
  daemonEnv: Record<string, string>;
  testBuild: boolean;
  /**
   * The user's core.sshCommand, resolved once by the caller (start path) with `git config --get core.sshCommand`.
   * Effective ssh command precedence (09-security §2): daemonEnv.GIT_SSH_COMMAND > sshCommand > GIT_SSH (+variant) > 'ssh'.
   * '' or whitespace means not configured.
   */
  sshCommand?: string;
}

/** Glossary §18: on every merge-tree / merge-file; never -X options. */
export const MERGE_FLAGS: readonly string[] = Object.freeze([
  '-c', 'merge.renormalize=false',
  '-c', 'merge.renames=true',
  '-c', 'merge.directoryRenames=false',
]);

/** Glossary §18 / 09-security §2: commands that get --no-ext-diff --no-textconv. */
export const DIFF_FAMILY: ReadonlySet<string> = new Set(['diff', 'diff-tree', 'diff-index', 'diff-files', 'log', 'show', 'blame']);

const CLASSES: ReadonlySet<string> = new Set(['local', 'network', 'attr', 'refupdate']);
const MERGE_COMMANDS: ReadonlySet<string> = new Set(['merge-tree', 'merge-file']);
const DIFF_FLAGS: readonly string[] = ['--no-ext-diff', '--no-textconv'];
const FETCH_FLAGS: readonly string[] = ['--no-write-fetch-head', '--no-auto-maintenance', '--no-tags', '--no-recurse-submodules'];
const SSH_BATCH_OPTIONS = '-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3';
const PLINK_BATCH_OPTION = '-batch';
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const FORCED_UPPER: ReadonlySet<string> = new Set(Object.keys(FORCED_ENV).map((k) => k.toUpperCase()));

function fail(message: string): never {
  throw new Error(`buildGitInvocation: ${message}`);
}

function checkConfigValue(what: string, value: string): void {
  if (value.length === 0 || /[\0\r\n]/.test(value)) fail(`invalid ${what} ${JSON.stringify(value)}`);
}

function checkDriverName(d: string): void {
  // -c splits at the first '=', so a driver name may not contain one.
  if (d.length === 0 || /[=\s\0]/.test(d)) fail(`invalid filter driver name ${JSON.stringify(d)}`);
}

function checkIdentField(what: string, value: string): void {
  if (value.trim().length === 0 || /[\0\r\n<>]/.test(value)) fail(`invalid identity ${what} ${JSON.stringify(value)}`);
}

/** Sets name=value after removing every other case variant of name. */
function setEnv(env: Record<string, string>, name: string, value: string): void {
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) {
    if (k !== name && k.toUpperCase() === upper) delete env[k];
  }
  env[name] = value;
}

/** Removes every case variant of name whose value is empty or whitespace only. */
function dropBlank(env: Record<string, string>, name: string): void {
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === upper && (env[k] ?? '').trim() === '') delete env[k];
  }
}

function getEnv(env: Record<string, string>, name: string): string | undefined {
  const exact = env[name];
  if (exact !== undefined) return exact;
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === upper) return env[k];
  }
  return undefined;
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** First word of a shell command line, honouring single and double quotes. */
function firstWord(cmd: string): string {
  let i = 0;
  while (i < cmd.length && /\s/.test(cmd.charAt(i))) i++;
  let word = '';
  let quote = '';
  for (; i < cmd.length; i++) {
    const ch = cmd.charAt(i);
    if (quote !== '') {
      if (ch === quote) quote = '';
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) break;
    word += ch;
  }
  return word;
}

function programBase(program: string): string {
  const parts = program.split(/[\\/]/);
  return (parts[parts.length - 1] ?? '').toLowerCase().replace(/\.exe$/, '');
}

type SshVariant = 'ssh' | 'plink' | 'simple' | 'unknown';

function sshVariant(setting: string | undefined, program: string): SshVariant {
  const v = (setting ?? '').trim().toLowerCase();
  if (v === 'ssh') return 'ssh';
  if (v === 'plink' || v === 'putty' || v === 'tortoiseplink') return 'plink';
  if (v === 'simple') return 'simple';
  const b = programBase(program);
  if (b === 'ssh') return 'ssh';
  if (b === 'plink' || b === 'tortoiseplink') return 'plink';
  return 'unknown';
}

function isSet(v: string | undefined): v is string {
  return v !== undefined && v.trim() !== '';
}

/**
 * 09-security §2 / §3.4 item 5: the effective ssh command is the first that is set of
 * GIT_SSH_COMMAND (env), core.sshCommand (configCommand), GIT_SSH (+ GIT_SSH_VARIANT), 'ssh';
 * the glossary §18 BatchMode options are appended to it (-batch for plink variants), never
 * replacing it. Returns null when nothing is appended (simple or unrecognised program): the env
 * is then left without a GIT_SSH_COMMAND of ours, git resolves the user's command itself and the
 * watchdog bounds the call.
 */
function batchSshCommand(env: Record<string, string>, configCommand: string | undefined): string | null {
  const command = getEnv(env, 'GIT_SSH_COMMAND');
  const program = getEnv(env, 'GIT_SSH');
  let line: string;
  let prog: string;
  if (isSet(command)) {
    line = command.replace(/\s+$/, '');
    prog = firstWord(command);
  } else if (isSet(configCommand)) {
    line = configCommand.replace(/\s+$/, '');
    prog = firstWord(configCommand);
  } else if (isSet(program)) {
    line = shQuote(program);
    prog = program;
  } else {
    line = 'ssh';
    prog = 'ssh';
  }
  const variant = sshVariant(getEnv(env, 'GIT_SSH_VARIANT'), prog);
  if (variant === 'ssh') return `${line} ${SSH_BATCH_OPTIONS}`;
  if (variant === 'plink') return `${line} ${PLINK_BATCH_OPTION}`;
  return null;
}

function buildEnv(opts: GitCallOptions, base: GitBase): Record<string, string> {
  const env: Record<string, string> = { ...base.daemonEnv };
  if (opts.extraEnv !== undefined) {
    for (const name of Object.keys(opts.extraEnv).sort()) {
      const value = opts.extraEnv[name];
      if (value === undefined || FORCED_UPPER.has(name.toUpperCase())) continue;
      setEnv(env, name, value);
    }
  }
  if (opts.indexFile !== undefined) {
    checkConfigValue('indexFile', opts.indexFile);
    setEnv(env, 'GIT_INDEX_FILE', opts.indexFile);
  }
  if (opts.identity !== undefined) {
    checkIdentField('name', opts.identity.name);
    checkIdentField('email', opts.identity.email);
    setEnv(env, 'GIT_AUTHOR_NAME', opts.identity.name);
    setEnv(env, 'GIT_AUTHOR_EMAIL', opts.identity.email);
    setEnv(env, 'GIT_COMMITTER_NAME', opts.identity.name);
    setEnv(env, 'GIT_COMMITTER_EMAIL', opts.identity.email);
    // SEC-03: +0000 on every live/board commit without setting dates in release builds.
    setEnv(env, 'TZ', 'UTC0');
  }
  if (base.testBuild && opts.wallMsForDates !== undefined) {
    const ms = opts.wallMsForDates;
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`buildGitInvocation: invalid wallMsForDates ${String(ms)}`);
    }
    const date = `@${Math.floor(ms / 1000)} +0000`;
    setEnv(env, 'GIT_AUTHOR_DATE', date);
    setEnv(env, 'GIT_COMMITTER_DATE', date);
  }
  if (opts.class === 'network') {
    // A blank GIT_SSH_COMMAND/GIT_SSH is "unset" (09 §2); git would run it as an empty command instead.
    dropBlank(env, 'GIT_SSH_COMMAND');
    dropBlank(env, 'GIT_SSH');
    const ssh = batchSshCommand(env, base.sshCommand);
    if (ssh !== null) setEnv(env, 'GIT_SSH_COMMAND', ssh);
  }
  for (const [name, value] of Object.entries(FORCED_ENV)) setEnv(env, name, value);
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(env).sort()) {
    const v = env[k];
    if (v !== undefined) sorted[k] = v;
  }
  return sorted;
}

/**
 * Glossary §18: the argv (after the git executable) and the complete environment for one git call.
 * args[0] must be the subcommand; every -c override is placed before it.
 */
export function buildGitInvocation(args: string[], opts: GitCallOptions, base: GitBase): GitInvocation {
  const sub = args[0];
  if (sub === undefined || sub.length === 0 || sub.startsWith('-')) {
    fail(`args[0] must be a git subcommand, got ${JSON.stringify(sub)}`);
  }
  if (!CLASSES.has(opts.class)) fail(`unknown class ${JSON.stringify(opts.class)}`);
  checkConfigValue('hooksPath', base.hooksPath);
  if (base.sshCommand !== undefined && /[\0\r\n]/.test(base.sshCommand)) {
    fail(`invalid sshCommand ${JSON.stringify(base.sshCommand)}`);
  }

  const pre: string[] = [];
  const c = (kv: string): void => {
    pre.push('-c', kv);
  };
  c(`core.hooksPath=${base.hooksPath}`);
  c(`core.fsmonitor=${opts.fsmonitor === true ? 'true' : 'false'}`);
  c('core.quotepath=off');
  c('commit.gpgSign=false');
  c('tag.gpgSign=false');
  c('gc.auto=0');
  c('maintenance.auto=false');
  c('fetch.fsckObjects=true');
  c('transfer.fsckObjects=true');
  c('protocol.ext.allow=never');
  c('core.askPass=');
  c('submodule.recurse=false');
  if (base.platform === 'win32') c('core.longpaths=true');

  const drivers = new Set<string>(['lfs']);
  for (const d of opts.filterDrivers ?? []) {
    checkDriverName(d);
    drivers.add(d);
  }
  for (const d of [...drivers].sort()) c(`filter.${d}.required=true`);

  if (opts.attrTree !== undefined) {
    if (!OID.test(opts.attrTree)) fail(`attrTree must be a 40- or 64-hex oid, got ${JSON.stringify(opts.attrTree)}`);
    c(`attr.tree=${opts.attrTree}`);
  }
  if (opts.class === 'refupdate') {
    c('core.logAllRefUpdates=always');
    c('core.fsync=committed,reference,index');
    c('core.fsyncMethod=batch');
  }
  if (opts.class === 'network') {
    c('http.lowSpeedLimit=1000');
    c('http.lowSpeedTime=10');
  }
  if (MERGE_COMMANDS.has(sub)) pre.push(...MERGE_FLAGS);

  const post: string[] = [];
  if (DIFF_FAMILY.has(sub)) post.push(...DIFF_FLAGS);
  if (sub === 'fetch') post.push(...FETCH_FLAGS);

  return {
    argv: [...pre, sub, ...post, ...args.slice(1)],
    env: buildEnv(opts, base),
  };
}
```

- [ ] **Step 9: Run the tests to verify they pass, and type-check**

Run: `npx tsx --test test/unit/flags.test.ts test/unit/env.test.ts`
Expected: PASS — 33 tests (22 in `flags.test.ts`, 11 in `env.test.ts`), 0 failures.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0, no output (no diagnostics). `src/ports/index.ts` does not exist yet (Task 9 creates it together with `src/git/runner.ts`), so the whole project type-checks cleanly. Any diagnostic is a failure of this task; in particular none may mention `src/git/env.ts`, `src/git/flags.ts`, `test/unit/env.test.ts` or `test/unit/flags.test.ts`.

- [ ] **Step 10: Commit**

```
git add src/git/flags.ts test/unit/flags.test.ts
git commit -m "feat(git): add glossary §18 argv/env builder for every git call class" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Git runner — spawn, watchdog, process-tree kill; Ports bundle (+ test temp roots)

**Files:**
- Create: `src/git/runner.ts`
- Create: `src/ports/index.ts` (the `Ports` bundle type; it lives here because it needs `GitRunner`, so `npm run typecheck` is clean after every task)
- Create: `test/helpers/tmp.ts`
- Test: `test/unit/runner.test.ts` (pure: `watchdogMs`, `WATCHDOG`)
- Test: `test/integration/runner.test.ts` (real git: paths, stdin, exit codes, `sshCommand` passthrough, the `Ports` bundle, Review Focus 1, 2, 4)

**Interfaces:**
- Consumes:
  - `Clock`, `realClock` from `src/ports/clock.ts` (Task 2)
  - `Random`, `realRandom` from `src/ports/random.ts` (Task 3)
  - `Fs`, `realFs` from `src/ports/fs.ts` (Task 4)
  - `Scheduler`, `realScheduler(clock: Clock): Scheduler` from `src/ports/scheduler.ts` (Task 5)
  - `buildDaemonEnv(source: Record<string, string | undefined>, passthrough: string[]): Record<string, string>` from `src/git/env.ts` (Task 8)
  - `buildGitInvocation(args: string[], opts: GitCallOptions, base: GitBase): GitInvocation`, `GitCallOptions`, `GitClass`, `GitBase` from `src/git/flags.ts` (Task 8). `GitBase` is `{ hooksPath: string; platform: NodeJS.Platform; daemonEnv: Record<string, string>; testBuild: boolean; sshCommand?: string; }`; Task 8 resolves the effective ssh command for `class: 'network'` with the 09-security §2 precedence `daemonEnv.GIT_SSH_COMMAND` > `base.sshCommand` > `GIT_SSH` (+ variant) > `ssh`, and appends the BatchMode options (` -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3` for the ssh variant). Task 8 always adds `-c commit.gpgSign=false`. This task relies on `GitInvocation.argv` being the arguments **after** the git binary (the binary is `deps.gitPath ?? 'git'`) and `GitInvocation.env` being the **complete** child environment (DAEMON_ENV + identity/date/index vars + ssh command + FORCED_ENV), so the runner passes it to `spawn` unchanged. `buildGitInvocation` throws on invalid input (Task 8 decision 2: `args[0]` must be the git subcommand and must not start with `-`, so callers use `['version']`, never `['--version']`).
- Produces (exactly as in 00-header.md):
  - `interface GitResult { code: number; stdout: Buffer; stderr: Buffer; killedByWatchdog: boolean; durationMs: number; }`
  - `interface GitRunner { run(args: string[], opts: GitCallOptions): Promise<GitResult>; }`
  - `interface GitRunnerDeps { clock: Clock; hooksPath: string; daemonEnv: Record<string, string>; gitPath?: string; platform?: NodeJS.Platform; testBuild?: boolean; watchdogOverrideMs?: number; sshCommand?: string; }` — `sshCommand` is the user's `core.sshCommand`, resolved once by the caller (the start path, a later plan) with `git config --get core.sshCommand`; the runner passes it to `GitBase.sshCommand` unchanged and never reads git config itself.
  - `function createGitRunner(deps: GitRunnerDeps): GitRunner`
  - `function watchdogMs(args: string[], cls: GitClass): number | null`
  - `const WATCHDOG = { fetch: 45_000, push: 90_000, readHash: 120_000 } as const`
  - `src/ports/index.ts`: `interface Ports { clock: Clock; random: Random; scheduler: Scheduler; fs: Fs; git: GitRunner; }`
  - `test/helpers/tmp.ts`: `makeTempRoot(label: string): Promise<{ root: string; cleanup: () => Promise<void> }>` (root contains `"공 백 dir"`), `testRunner(clock?: Clock): GitRunner`

**Behaviour pinned by this task (glossary §18, §20):**
- `watchdogMs(args, cls)` finds the subcommand as the first argument that is not a global option (`-c <v>` and `-C <v>` skip their value; any other `-…` is skipped) and returns:
  - `push` → `WATCHDOG.push` (90 s); `fetch` → `WATCHDOG.fetch` (45 s);
  - any other command of class `network` (`ls-remote`, `clone`) → `WATCHDOG.fetch` (45 s);
  - `add`, `hash-object`, and `cat-file` **with** `--filters` → `WATCHDOG.readHash` (120 s);
  - `update-ref`, `update-index`, `commit-tree`, `read-tree` → `null` (never killed, whatever the class);
  - everything else → `null`.
- `deps.watchdogOverrideMs` (tests only) replaces the watchdog of **every** command except the four never-killed plumbing commands, which stay unkillable.
- Watchdog timers are real `setTimeout`s (git runs in real time even under a VirtualClock); `durationMs` is `deps.clock.monoMs()` at close minus at spawn.
- Tree kill: on Windows `taskkill /pid <pid> /T /F`; on POSIX git is spawned with `detached: true` (its own process group) and killed with `process.kill(-pid, 'SIGKILL')`. The kill mechanism follows the **host** OS (`process.platform`); `deps.platform` only feeds `GitBase.platform` for argv building. After a kill the runner waits up to 5 s for stdio to close, then destroys the pipes and resolves.
- stdin is `'ignore'` unless `opts.stdin` is set, in which case it is piped and ended with those bytes.
- A spawn failure (missing binary, bad cwd) **resolves** with `code: -1`, `killedByWatchdog: false` and `spawn failed: <message>` in `stderr`; it never rejects. A process killed by a signal (no exit code) also reports `code: -1`.
- Invalid arguments are a caller bug, not a git failure: `run` calls `buildGitInvocation` before creating the promise, so a builder error (for example `args[0]` starting with `-`, as in `['--version']`) is **thrown synchronously** from `run` and nothing is spawned. Every test and caller passes the subcommand first (`['version']`).
- `deps.sshCommand` is copied into `GitBase.sshCommand` for every call; only `class: 'network'` calls turn it into `GIT_SSH_COMMAND` (Task 8). A `GIT_SSH_COMMAND` in `deps.daemonEnv` outranks it (09-security §2).
- `testRunner()` binds `realClock` (or the given clock), `testBuild: true`, `daemonEnv = buildDaemonEnv(process.env, [])`, no `sshCommand`, and a shared empty hooks directory `<tmpdir>/cowork-test-empty-hooks`. It relies on the Task 8 allowlist keeping `PATH`/`Path`, because fixture hooks and filters (Tasks 11, 12) start `node` through it.

- [ ] **Step 1: Write the failing unit test for `watchdogMs`**

Create `test/unit/runner.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WATCHDOG, watchdogMs } from '../../src/git/runner.js';

test('WATCHDOG holds the glossary §18 values', () => {
  assert.deepEqual(WATCHDOG, { fetch: 45_000, push: 90_000, readHash: 120_000 });
});

test('fetch and push get their own watchdogs', () => {
  assert.equal(watchdogMs(['fetch', '--no-tags', 'origin'], 'network'), 45_000);
  assert.equal(watchdogMs(['push', '--porcelain', 'origin', 'HEAD:refs/x'], 'network'), 90_000);
});

test('other network-class commands use the fetch watchdog', () => {
  assert.equal(watchdogMs(['ls-remote', '--exit-code', 'file:///r.git'], 'network'), 45_000);
  assert.equal(watchdogMs(['clone', '-q', 'file:///r.git', 'd'], 'network'), 45_000);
});

test('read/hash commands get 120 s; cat-file only with --filters', () => {
  assert.equal(watchdogMs(['add', '--', 'a.txt'], 'attr'), 120_000);
  assert.equal(watchdogMs(['hash-object', '--path=a.txt', '--stdin'], 'attr'), 120_000);
  assert.equal(watchdogMs(['cat-file', '--filters', 'HEAD:a.txt'], 'attr'), 120_000);
  assert.equal(watchdogMs(['cat-file', '-p', 'HEAD:a.txt'], 'local'), null);
});

test('ref-updating plumbing is never killed', () => {
  for (const sub of ['update-ref', 'update-index', 'commit-tree', 'read-tree']) {
    assert.equal(watchdogMs([sub, 'x'], 'refupdate'), null, sub);
    assert.equal(watchdogMs([sub, 'x'], 'network'), null, sub);
  }
});

test('everything else has no watchdog', () => {
  assert.equal(watchdogMs(['rev-parse', 'HEAD'], 'local'), null);
  assert.equal(watchdogMs(['status', '--porcelain=v2', '-z'], 'local'), null);
  assert.equal(watchdogMs([], 'local'), null);
});

test('leading global options are skipped when finding the subcommand', () => {
  assert.equal(watchdogMs(['-c', 'core.x=y', '-C', 'dir', 'fetch'], 'network'), 45_000);
  assert.equal(watchdogMs(['--no-pager', 'update-ref', 'refs/x', 'y'], 'refupdate'), null);
});
```

- [ ] **Step 2: Run the unit test to verify it fails**

Run: `npx tsx --test test/unit/runner.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (cannot find module `src/git/runner.js`).

- [ ] **Step 3: Write the runner**

Create `src/git/runner.ts`:

```ts
// The single git runner (glossary §18). This is the only file in src/ that may
// import node:child_process (lints L-PORTS, L-GIT-SPAWN).
import { spawn, type ChildProcess } from 'node:child_process';
import type { Clock } from '../ports/clock.js';
import { buildGitInvocation, type GitBase, type GitCallOptions, type GitClass } from './flags.js';

export interface GitResult { code: number; stdout: Buffer; stderr: Buffer; killedByWatchdog: boolean; durationMs: number; }
export interface GitRunner { run(args: string[], opts: GitCallOptions): Promise<GitResult>; }
export interface GitRunnerDeps {
  clock: Clock;
  hooksPath: string;
  daemonEnv: Record<string, string>;
  gitPath?: string;
  platform?: NodeJS.Platform;
  testBuild?: boolean;
  watchdogOverrideMs?: number;
  /**
   * The user's `core.sshCommand`, resolved once by the caller (start path) with
   * `git config --get core.sshCommand`. Passed to GitBase unchanged; Task 8 applies the
   * 09-security §2 precedence (daemonEnv GIT_SSH_COMMAND > this > GIT_SSH > ssh) and appends BatchMode.
   */
  sshCommand?: string;
}

export const WATCHDOG = { fetch: 45_000, push: 90_000, readHash: 120_000 } as const;

/** Ref-updating plumbing: never killed, whatever the deps say (glossary §18). */
const NEVER_KILLED: ReadonlySet<string> = new Set(['update-ref', 'update-index', 'commit-tree', 'read-tree']);

/** Grace period for stdio to close after a tree kill before the streams are destroyed. */
const CLOSE_GRACE_MS = 5_000;

/** The git subcommand: the first argument that is not a global option (-c/-C take a value). */
function subcommandOf(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-c' || a === '-C') { i++; continue; }
    if (a.startsWith('-')) continue;
    return a;
  }
  return undefined;
}

export function watchdogMs(args: string[], cls: GitClass): number | null {
  const sub = subcommandOf(args);
  if (sub === undefined || NEVER_KILLED.has(sub)) return null;
  if (sub === 'push') return WATCHDOG.push;
  if (sub === 'fetch') return WATCHDOG.fetch;
  if (cls === 'network') return WATCHDOG.fetch;
  if (sub === 'add' || sub === 'hash-object') return WATCHDOG.readHash;
  if (sub === 'cat-file' && args.includes('--filters')) return WATCHDOG.readHash;
  return null;
}

/** Kills git and every descendant. Uses the host OS, not deps.platform (which only shapes argv). */
function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      k.on('error', () => resolve());
      k.on('exit', () => resolve());
    });
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  return Promise.resolve();
}

export function createGitRunner(deps: GitRunnerDeps): GitRunner {
  const platform = deps.platform ?? process.platform;
  const gitPath = deps.gitPath ?? 'git';
  const base: GitBase = {
    hooksPath: deps.hooksPath,
    platform,
    daemonEnv: deps.daemonEnv,
    testBuild: deps.testBuild ?? false,
    ...(deps.sshCommand !== undefined ? { sshCommand: deps.sshCommand } : {}),
  };

  return {
    run(args: string[], opts: GitCallOptions): Promise<GitResult> {
      const inv = buildGitInvocation(args, opts, base);
      const sub = subcommandOf(args);
      const limit = sub !== undefined && NEVER_KILLED.has(sub)
        ? null
        : (deps.watchdogOverrideMs ?? watchdogMs(args, opts.class));
      const started = deps.clock.monoMs();

      return new Promise<GitResult>((resolve) => {
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let killed = false;
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        let grace: NodeJS.Timeout | undefined;

        const finish = (code: number, extraErr?: string): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (grace) clearTimeout(grace);
          if (extraErr !== undefined) err.push(Buffer.from(extraErr, 'utf8'));
          resolve({
            code,
            stdout: Buffer.concat(out),
            stderr: Buffer.concat(err),
            killedByWatchdog: killed,
            durationMs: deps.clock.monoMs() - started,
          });
        };

        let child: ChildProcess;
        try {
          child = spawn(gitPath, inv.argv, {
            cwd: opts.cwd,
            env: inv.env,
            stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
            windowsHide: true,
            // POSIX: own process group, so kill(-pid) reaches grandchildren.
            detached: process.platform !== 'win32',
          });
        } catch (e) {
          finish(-1, `spawn failed: ${(e as Error).message}`);
          return;
        }

        child.stdout!.on('data', (b: Buffer) => out.push(b));
        child.stderr!.on('data', (b: Buffer) => err.push(b));
        child.on('error', (e) => finish(-1, `spawn failed: ${e.message}`));
        let exitCode: number | null = null;
        let exited = false;
        child.on('exit', (code) => {
          exited = true;
          exitCode = code;
          if (killed) grace = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish(exitCode ?? -1);
          }, CLOSE_GRACE_MS);
        });
        child.on('close', (code) => finish(code ?? exitCode ?? -1));

        if (opts.stdin && child.stdin) {
          child.stdin.on('error', () => { /* git may exit before reading all of stdin */ });
          child.stdin.end(opts.stdin);
        }

        if (limit !== null) {
          timer = setTimeout(() => {
            if (exited) return; // git finished on its own; only stdio is still draining
            killed = true;
            void killTree(child);
          }, limit);
        }
      });
    },
  };
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `npx tsx --test test/unit/runner.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing integration test (real git)**

Create `test/integration/runner.test.ts`. It pins Review Focus 1 (spaced, non-ASCII paths), 2 (grandchild heartbeat stops after a watchdog kill) and 4 (a repo whose `core.hooksPath` hook demonstrably runs under plain `git commit` — proven by a control commit without any cowork flag — and whose `commit.gpgSign=true` demonstrably breaks a plain commit, yet `runGit` commits without running the hook and without a signature). It also checks that `GitRunnerDeps.sshCommand` reaches git with the 09-security §2 precedence, and that the `Ports` bundle type accepts the real ports plus a runner.

The control commits use `spawnSync('git', …)` directly on purpose: they must carry none of cowork's `-c` flags. Lint L-GIT-SPAWN covers `src/` only, so a test may spawn git for a control.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeTempRoot, testRunner } from '../helpers/tmp.js';
import { createGitRunner } from '../../src/git/runner.js';
import { buildDaemonEnv } from '../../src/git/env.js';
import { realClock, type Clock } from '../../src/ports/clock.js';
import { realRandom } from '../../src/ports/random.js';
import { realScheduler } from '../../src/ports/scheduler.js';
import { realFs } from '../../src/ports/fs.js';
import type { Ports } from '../../src/ports/index.js';

const ID = { name: 'Test Peer', email: 'peer@cowork.invalid' };
const SSH_BATCH = '-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3';

/** process.env without any GIT_SSH* variable, so a developer's or CI's ssh settings cannot outrank the case under test. */
function envWithoutSsh(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_SSH')));
}

/** Single-quote a path for a sh command line; forward slashes work on every OS. */
function shq(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
}

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function initRepo(root: string, name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const r = await testRunner().run(['init', '-q', '-b', 'main', dir], { class: 'local', cwd: root });
  assert.equal(r.code, 0, r.stderr.toString('utf8'));
  return dir;
}

test('makeTempRoot gives a path with a space and Hangul, and cleanup removes it', async () => {
  const { root, cleanup } = await makeTempRoot('tmp-shape');
  assert.ok(root.includes('공 백 dir'), root);
  assert.ok(existsSync(root));
  await cleanup();
  assert.equal(existsSync(root), false);
});

test('runGit works in a repo under a spaced, non-ASCII path (Review Focus 1)', async () => {
  const { root, cleanup } = await makeTempRoot('runner-path');
  try {
    const repo = await initRepo(root, '저장소 one');
    const r = await testRunner().run(['rev-parse', '--show-toplevel'], { class: 'local', cwd: repo });
    assert.equal(r.code, 0, r.stderr.toString('utf8'));
    assert.equal(r.killedByWatchdog, false);
    assert.equal(resolve(r.stdout.toString('utf8').trim()), resolve(repo));
  } finally {
    await cleanup();
  }
});

test('stdin is piped when given and stdout is returned as bytes', async () => {
  const { root, cleanup } = await makeTempRoot('runner-stdin');
  try {
    const repo = await initRepo(root, 'r');
    const r = await testRunner().run(['hash-object', '--stdin'], { class: 'local', cwd: repo, stdin: Buffer.from('hello\n') });
    assert.equal(r.code, 0, r.stderr.toString('utf8'));
    assert.ok(Buffer.isBuffer(r.stdout));
    assert.equal(r.stdout.toString('utf8').trim(), 'ce013625030ba8dba906f756967f9e9ca394464a');
  } finally {
    await cleanup();
  }
});

test('a failing command returns its exit code and English stderr even with LANG=ko_KR.UTF-8', async () => {
  const { root, cleanup } = await makeTempRoot('runner-fail');
  try {
    const repo = await initRepo(root, 'r');
    const git = createGitRunner({
      clock: realClock,
      hooksPath: join(root, 'empty-hooks'),
      daemonEnv: buildDaemonEnv({ ...process.env, LANG: 'ko_KR.UTF-8', LC_MESSAGES: 'ko_KR.UTF-8' }, []),
      testBuild: true,
    });
    const r = await git.run(['rev-parse', '--verify', 'refs/heads/does-not-exist'], { class: 'local', cwd: repo });
    assert.notEqual(r.code, 0);
    assert.equal(r.killedByWatchdog, false);
    assert.match(r.stderr.toString('utf8'), /fatal: Needed a single revision/);
  } finally {
    await cleanup();
  }
});

test('durationMs is measured with the injected clock', async () => {
  const { root, cleanup } = await makeTempRoot('runner-clock');
  try {
    let t = 0;
    const clock: Clock = { monoMs: () => (t += 1000), wallMs: () => 0, sleep: async () => {} };
    const r = await testRunner(clock).run(['version'], { class: 'local', cwd: root });
    assert.equal(r.code, 0);
    assert.equal(r.durationMs, 1000);
  } finally {
    await cleanup();
  }
});

test('a missing git binary resolves with code -1 and the reason in stderr', async () => {
  const { root, cleanup } = await makeTempRoot('runner-nogit');
  try {
    const git = createGitRunner({
      clock: realClock,
      hooksPath: join(root, 'empty-hooks'),
      daemonEnv: buildDaemonEnv(process.env, []),
      gitPath: join(root, 'no-such-git'),
      testBuild: true,
    });
    const r = await git.run(['version'], { class: 'local', cwd: root });
    assert.equal(r.code, -1);
    assert.equal(r.killedByWatchdog, false);
    assert.match(r.stderr.toString('utf8'), /spawn failed/);
  } finally {
    await cleanup();
  }
});

test('user config core.hooksPath and commit.gpgSign=true break plain git but not runGit (Review Focus 4)', async () => {
  const { root, cleanup } = await makeTempRoot('runner-userconfig');
  try {
    const repo = await initRepo(root, 'r'); // repo = <root>/r
    const userHooks = join(root, 'user hooks');
    await mkdir(userHooks, { recursive: true });
    // githooks(5): pre-commit runs with the work-tree root as cwd, so ../hook-ran.txt is <root>/hook-ran.txt.
    // A relative path keeps the spaced, Hangul temp root out of the sh source. LF-only buffer (Review Focus 3).
    const marker = join(root, 'hook-ran.txt');
    await writeFile(join(userHooks, 'pre-commit'), Buffer.from('#!/bin/sh\necho ran > ../hook-ran.txt\nexit 1\n', 'utf8'), { mode: 0o755 });

    const git = testRunner();
    for (const [k, v] of [
      ['core.hooksPath', userHooks.replace(/\\/g, '/')],
      ['commit.gpgSign', 'true'],
      ['gpg.format', 'openpgp'],
      ['gpg.program', join(root, 'no-such-gpg.exe').replace(/\\/g, '/')],
    ] as const) {
      const c = await git.run(['config', k, v], { class: 'local', cwd: repo });
      assert.equal(c.code, 0, c.stderr.toString('utf8'));
    }
    await writeFile(join(repo, 'a.txt'), Buffer.from('a\n'));
    const add = await git.run(['add', 'a.txt'], { class: 'local', cwd: repo });
    assert.equal(add.code, 0, add.stderr.toString('utf8'));

    const headIsUnborn = async (): Promise<boolean> =>
      (await git.run(['rev-parse', '--verify', '-q', 'HEAD'], { class: 'local', cwd: repo })).code !== 0;
    // Plain git: no cowork -c flags at all; identity through the environment only.
    const plainEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: ID.name, GIT_AUTHOR_EMAIL: ID.email,
      GIT_COMMITTER_NAME: ID.name, GIT_COMMITTER_EMAIL: ID.email,
    };

    // Control 1: the user's hook really runs on this OS and really rejects the commit.
    assert.equal(existsSync(marker), false);
    const control = spawnSync('git', ['commit', '-q', '-m', 'control'], { cwd: repo, env: plainEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(control.error, undefined, String(control.error));
    assert.notEqual(control.status, 0, 'control commit must be rejected by the user pre-commit hook');
    assert.ok(existsSync(marker), `the user hook did not run under plain git: ${control.stderr.toString('utf8')}`);
    assert.ok(await headIsUnborn(), 'the control commit must not have been created');
    await unlink(marker);

    // Control 2: with the hook skipped, commit.gpgSign=true and the missing gpg program really fail a plain commit.
    const control2 = spawnSync('git', ['commit', '--no-verify', '-q', '-m', 'control'], { cwd: repo, env: plainEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.notEqual(control2.status, 0, 'commit.gpgSign=true with a missing gpg must fail a plain commit');
    assert.equal(existsSync(marker), false);
    assert.ok(await headIsUnborn());

    // runGit: cowork's -c core.hooksPath and -c commit.gpgSign=false win over the repository config.
    const commit = await git.run(['commit', '-q', '-m', 'first'], { class: 'local', cwd: repo, identity: ID, wallMsForDates: 1_700_000_000_000 });
    assert.equal(commit.code, 0, commit.stderr.toString('utf8'));
    assert.equal(existsSync(marker), false, 'the user hook must not run under runGit');
    const body = await git.run(['cat-file', 'commit', 'HEAD'], { class: 'local', cwd: repo });
    assert.equal(body.code, 0, body.stderr.toString('utf8'));
    assert.doesNotMatch(body.stdout.toString('utf8'), /gpgsig/);
    assert.match(body.stdout.toString('utf8'), /^author Test Peer <peer@cowork\.invalid> 1700000000 \+0000$/m);
  } finally {
    await cleanup();
  }
});

test('GitRunnerDeps.sshCommand reaches network-class git calls with the 09-security §2 precedence', async () => {
  const { root, cleanup } = await makeTempRoot('runner-ssh');
  try {
    const repo = await initRepo(root, 'r');
    const dump = join(root, 'ssh dump.cjs');
    await writeFile(dump, Buffer.from(`process.stdout.write(process.env.GIT_SSH_COMMAND ?? '<unset>');\n`, 'utf8'));
    const set = await testRunner().run(['config', 'alias.sshdump', `!node ${shq(dump)}`], { class: 'local', cwd: repo });
    assert.equal(set.code, 0, set.stderr.toString('utf8'));

    const noSsh = envWithoutSsh();
    const dumpWith = async (daemonEnv: Record<string, string>, cls: 'network' | 'local', sshCommand?: string): Promise<string> => {
      const git = createGitRunner({
        clock: realClock,
        hooksPath: join(root, 'empty-hooks'),
        daemonEnv,
        testBuild: true,
        ...(sshCommand !== undefined ? { sshCommand } : {}),
      });
      const r = await git.run(['sshdump'], { class: cls, cwd: repo });
      assert.equal(r.code, 0, r.stderr.toString('utf8'));
      return r.stdout.toString('utf8');
    };
    const plain = buildDaemonEnv(noSsh, []);
    const userKey = 'ssh -i "/keys/id work"';
    // No setting anywhere: plain ssh with BatchMode.
    assert.equal(await dumpWith(plain, 'network'), `ssh ${SSH_BATCH}`);
    // The user's core.sshCommand is kept and BatchMode is appended to it.
    assert.equal(await dumpWith(plain, 'network', userKey), `${userKey} ${SSH_BATCH}`);
    // GIT_SSH_COMMAND in the daemon env outranks core.sshCommand.
    assert.equal(await dumpWith(buildDaemonEnv({ ...noSsh, GIT_SSH_COMMAND: 'ssh -4' }, []), 'network', userKey), `ssh -4 ${SSH_BATCH}`);
    // Only network-class calls get an ssh command.
    assert.equal(await dumpWith(plain, 'local', userKey), '<unset>');
  } finally {
    await cleanup();
  }
});

test('the Ports bundle accepts the real ports and the git runner', async () => {
  const { root, cleanup } = await makeTempRoot('runner-ports');
  try {
    const ports: Ports = {
      clock: realClock,
      random: realRandom,
      scheduler: realScheduler(realClock),
      fs: realFs,
      git: testRunner(),
    };
    const r = await ports.git.run(['version'], { class: 'local', cwd: root });
    assert.equal(r.code, 0, r.stderr.toString('utf8'));
    assert.match(r.stdout.toString('utf8'), /^git version \d+\.\d+/);
  } finally {
    await cleanup();
  }
});

test('ref-updating plumbing is never killed, even with a 1 ms override', async () => {
  const { root, cleanup } = await makeTempRoot('runner-neverkill');
  try {
    const repo = await initRepo(root, 'r');
    const blob = await testRunner().run(['hash-object', '-w', '--stdin'], { class: 'local', cwd: repo, stdin: Buffer.from('x\n') });
    const oid = blob.stdout.toString('utf8').trim();
    const git = createGitRunner({
      clock: realClock,
      hooksPath: join(root, 'empty-hooks'),
      daemonEnv: buildDaemonEnv(process.env, []),
      testBuild: true,
      watchdogOverrideMs: 1,
    });
    const r = await git.run(['update-ref', 'refs/cowork-test/blob', oid], { class: 'refupdate', cwd: repo });
    assert.equal(r.killedByWatchdog, false);
    assert.equal(r.code, 0, r.stderr.toString('utf8'));
  } finally {
    await cleanup();
  }
});

test('a watchdog kill takes down the whole process tree (Review Focus 2)', async () => {
  const { root, cleanup } = await makeTempRoot('runner-treekill');
  const pidFile = join(root, 'pids.txt');
  try {
    const repo = await initRepo(root, 'r');
    const hb = join(root, 'heart beat.txt');
    const beater = join(root, 'beater.cjs');
    const spawner = join(root, 'spawner.cjs');
    await writeFile(beater, Buffer.from(
      `const fs = require('fs');\n` +
      `fs.appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');\n` +
      `setInterval(() => fs.appendFileSync(process.argv[2], 'x'), 20);\n`, 'utf8'));
    await writeFile(spawner, Buffer.from(
      `const fs = require('fs');\n` +
      `const { spawn } = require('child_process');\n` +
      `fs.appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');\n` +
      `spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: 'ignore' });\n` +
      `setInterval(() => {}, 1000);\n`, 'utf8'));
    const git = testRunner();
    const set = await git.run(['config', 'alias.hb', `!node ${shq(spawner)} ${shq(beater)} ${shq(hb)}`], { class: 'local', cwd: repo });
    assert.equal(set.code, 0, set.stderr.toString('utf8'));

    const killer = createGitRunner({
      clock: realClock,
      hooksPath: join(root, 'empty-hooks'),
      daemonEnv: buildDaemonEnv(process.env, []),
      testBuild: true,
      watchdogOverrideMs: 3_000,
    });
    const r = await killer.run(['hb'], { class: 'local', cwd: repo });
    assert.equal(r.killedByWatchdog, true);
    assert.notEqual(r.code, 0);
    assert.ok(existsSync(hb), 'the grandchild ran before the kill');
    await pause(500);
    const s1 = statSync(hb).size;
    await pause(1_000);
    const s2 = statSync(hb).size;
    assert.ok(s1 > 0);
    assert.equal(s2, s1, 'heartbeat file kept growing: a grandchild survived the kill');
  } finally {
    // Reap survivors so a broken kill fails this test instead of hanging the run.
    if (existsSync(pidFile)) {
      for (const line of readFileSync(pidFile, 'utf8').split('\n')) {
        const pid = Number(line);
        if (pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ } }
      }
    }
    await cleanup();
  }
});
```

The process tree in the Review Focus 2 test is `git` → (`sh` for the `!` alias) → `node spawner.cjs` → `node beater.cjs`; the beater is a great-grandchild of the runner's child. A `child.kill()` without the tree kill leaves `spawner` and `beater` running (verified on Windows 11 / Git 2.55: the assertion "heartbeat file kept growing" fires).

- [ ] **Step 6: Run the integration test to verify it fails**

Run: `npx tsx --test test/integration/runner.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (cannot find module `test/helpers/tmp.js`). The `import type { Ports }` line is erased by `tsx`, so the missing `src/ports/index.ts` is not reported at run time; Step 9's type-check covers it.

- [ ] **Step 7: Write the test helpers**

Create `test/helpers/tmp.ts`:

```ts
// Test-only helpers: temp roots whose path contains a space and non-ASCII
// characters (Review Focus 1), and a git runner bound for tests.
import { mkdirSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realClock, type Clock } from '../../src/ports/clock.js';
import { buildDaemonEnv } from '../../src/git/env.js';
import { createGitRunner, type GitRunner } from '../../src/git/runner.js';

const SPACED_SEGMENT = '공 백 dir';

export async function makeTempRoot(label: string): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const safe = label.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  // realpath (native) expands Windows 8.3 short names and macOS /var -> /private/var,
  // so paths we compare against git output are the canonical spelling.
  const base = realpathSync.native(await mkdtemp(join(tmpdir(), `cowork-${safe}-`)));
  const root = join(base, SPACED_SEGMENT);
  await mkdir(root, { recursive: true });
  return {
    root,
    cleanup: () => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

let emptyHooks: string | undefined;

function emptyHooksDir(): string {
  if (emptyHooks === undefined) {
    emptyHooks = join(realpathSync.native(tmpdir()), 'cowork-test-empty-hooks');
    mkdirSync(emptyHooks, { recursive: true });
  }
  return emptyHooks;
}

export function testRunner(clock?: Clock): GitRunner {
  return createGitRunner({
    clock: clock ?? realClock,
    hooksPath: emptyHooksDir(),
    daemonEnv: buildDaemonEnv(process.env as Record<string, string | undefined>, []),
    testBuild: true,
  });
}
```

- [ ] **Step 8: Create the `Ports` bundle type**

Create `src/ports/index.ts` (type-only; the integration test's `const ports: Ports = …` is its consumer, checked by `tsc` in Step 9):

```ts
// The bundle of side-effect ports every daemon, worker, CLI and MCP component
// receives (11-testing §3.2). Production binds the real implementations; SIM
// binds VirtualClock, seededRandom, VirtualScheduler, FaultFs and the same
// real git runner (git is never mocked).
import type { Clock } from './clock.js';
import type { Random } from './random.js';
import type { Scheduler } from './scheduler.js';
import type { Fs } from './fs.js';
import type { GitRunner } from '../git/runner.js';

export interface Ports {
  clock: Clock;
  random: Random;
  scheduler: Scheduler;
  fs: Fs;
  git: GitRunner;
}
```

- [ ] **Step 9: Run both test files to verify they pass, and type-check**

Run: `npx tsx --test test/unit/runner.test.ts test/integration/runner.test.ts`
Expected: PASS (7 unit + 11 integration tests, 0 failures). The Review Focus 2 test takes about 5 s (3 s watchdog + 1.5 s observation). If the Review Focus 4 test fails at "the user hook did not run under plain git", the control is broken on this machine (hook not executable, CRLF in the hook, or `sh` missing), not the runner: fix the environment, never weaken the control.

Run: `npm run typecheck`
Expected: exit 0, no diagnostics. `src/ports/index.ts` and its `GitRunner` import now both exist, and `GitBase.sshCommand` (Task 8) matches what `createGitRunner` passes.

- [ ] **Step 10: Commit**

```bash
git add src/git/runner.ts src/ports/index.ts test/helpers/tmp.ts test/unit/runner.test.ts test/integration/runner.test.ts
git commit -m "feat(git): single git runner with watchdogs and process-tree kill; Ports bundle" -m "Adds createGitRunner (glossary §18): spawns git with the Task 8 argv/env, watchdogs fetch 45 s / push 90 s / read-hash 120 s, never kills ref-updating plumbing, and kills the whole process tree (taskkill /T on Windows, process group on POSIX). GitRunnerDeps.sshCommand (the user's core.sshCommand) is passed to the argv/env builder unchanged. Adds the Ports bundle type (src/ports/index.ts) and test helpers makeTempRoot (path with '공 백 dir') and testRunner." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Push-outcome classifier

**Files:**
- Create: `src/git/classify.ts`
- Test: `test/unit/classify.test.ts`

**Interfaces:**
- Consumes: nothing (pure function; the caller supplies the observation it made after a fresh fetch).
- Produces (exactly as in 00-header.md):
  - `export type PushOutcome = 'landed' | 'lease_lost' | 'transient' | 'nonretryable';`
  - `export interface PushObservation { refMovedSinceLease: boolean; ourOpIdsPresent: boolean; previousStreak: number; }`
  - `export const NONRETRYABLE_STREAK = 3;`
  - `export function classifyPush(o: PushObservation): { outcome: PushOutcome; streak: number };`

Spec: glossary §26.2 item 2 and 09-security SEC-04 — after any rejection the caller fetches; **our op ids present → landed; the leased ref moved → lease lost (retry in the next window); ref unchanged and our ids absent → transient (retry with backoff); the 3rd consecutive rejection of the same publish with the ref unchanged → `NONRETRYABLE`** (PIN, human `/cowork resume`). Message text never selects among these outcomes.

Rules pinned by the tests below:
- Precedence: `ourOpIdsPresent` wins over `refMovedSinceLease` (our own landed push is what moved the ref) → `landed`, streak 0.
- Otherwise `refMovedSinceLease` → `lease_lost`, streak 0 (the next attempt is built on a new lease, so it is a new publish and the "consecutive, ref unchanged" chain is broken).
- Otherwise `streak = previousStreak + 1`; `streak >= NONRETRYABLE_STREAK` → `nonretryable`, else `transient`. The exact streak is returned because a later plan reads "transient streak ≥ 2" to engage the push-budget fallback (glossary §27.2).
- The observation has no text field. A test spreads rejection text onto the object and shows the result is identical (the executable form of "message text never decides").
- `previousStreak` must be a non-negative safe integer (`RangeError` otherwise); the two flags must be real booleans (`TypeError` otherwise), so a caller bug cannot silently become a transient retry.

---

- [ ] **Step 1: Write the failing test**

Create `test/unit/classify.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPush,
  NONRETRYABLE_STREAK,
  type PushObservation,
  type PushOutcome,
} from '../../src/git/classify.js';

test('NONRETRYABLE_STREAK is 3 (glossary §26.2 item 2)', () => {
  assert.equal(NONRETRYABLE_STREAK, 3);
});

// Exhaustive table: ourOpIdsPresent x refMovedSinceLease x previousStreak 0..4.
const TABLE: Array<[ourOpIdsPresent: boolean, refMovedSinceLease: boolean, previousStreak: number, outcome: PushOutcome, streak: number]> = [
  [true, false, 0, 'landed', 0],
  [true, false, 1, 'landed', 0],
  [true, false, 2, 'landed', 0],
  [true, false, 3, 'landed', 0],
  [true, false, 4, 'landed', 0],
  [true, true, 0, 'landed', 0],
  [true, true, 1, 'landed', 0],
  [true, true, 2, 'landed', 0],
  [true, true, 3, 'landed', 0],
  [true, true, 4, 'landed', 0],
  [false, true, 0, 'lease_lost', 0],
  [false, true, 1, 'lease_lost', 0],
  [false, true, 2, 'lease_lost', 0],
  [false, true, 3, 'lease_lost', 0],
  [false, true, 4, 'lease_lost', 0],
  [false, false, 0, 'transient', 1],
  [false, false, 1, 'transient', 2],
  [false, false, 2, 'nonretryable', 3],
  [false, false, 3, 'nonretryable', 4],
  [false, false, 4, 'nonretryable', 5],
];

test('classifyPush follows the outcome table', () => {
  for (const [ourOpIdsPresent, refMovedSinceLease, previousStreak, outcome, streak] of TABLE) {
    const o: PushObservation = { refMovedSinceLease, ourOpIdsPresent, previousStreak };
    assert.deepEqual(classifyPush(o), { outcome, streak }, JSON.stringify(o));
  }
});

test('three consecutive unchanged-ref rejections of one publish become nonretryable', () => {
  let streak = 0;
  const seen: PushOutcome[] = [];
  for (let i = 0; i < 3; i++) {
    const r = classifyPush({ refMovedSinceLease: false, ourOpIdsPresent: false, previousStreak: streak });
    seen.push(r.outcome);
    streak = r.streak;
  }
  assert.deepEqual(seen, ['transient', 'transient', 'nonretryable']);
  assert.equal(streak, NONRETRYABLE_STREAK);
});

test('a lease loss or a landing between transients restarts the count', () => {
  let streak = 0;
  const steps: Array<[boolean, boolean]> = [
    [false, false], // transient 1
    [false, false], // transient 2
    [false, true], // lease lost -> 0
    [false, false], // transient 1
    [false, false], // transient 2
    [true, false], // landed -> 0
    [false, false], // transient 1
  ];
  const outcomes: PushOutcome[] = [];
  for (const [ourOpIdsPresent, refMovedSinceLease] of steps) {
    const r = classifyPush({ refMovedSinceLease, ourOpIdsPresent, previousStreak: streak });
    outcomes.push(r.outcome);
    streak = r.streak;
  }
  assert.deepEqual(outcomes, ['transient', 'transient', 'lease_lost', 'transient', 'transient', 'landed', 'transient']);
  assert.equal(streak, 1);
});

test('rejection text never changes the outcome', () => {
  const texts = [
    ' ! [remote rejected] refs/cowork/main/board -> refs/cowork/main/board (cannot lock ref)',
    ' ! [remote rejected] HEAD -> refs/cowork/main/board (failed)',
    'error: fatal error in commit_refs',
    'remote: error: GH013: Repository rule violations found',
    ' ! [rejected] (stale info)',
  ];
  for (const [ourOpIdsPresent, refMovedSinceLease, previousStreak, outcome, streak] of TABLE) {
    for (const stderr of texts) {
      const withText = { refMovedSinceLease, ourOpIdsPresent, previousStreak, stderr, message: stderr } as PushObservation;
      assert.deepEqual(classifyPush(withText), { outcome, streak });
    }
  }
});

test('classifyPush rejects a bad previousStreak with RangeError', () => {
  for (const previousStreak of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => classifyPush({ refMovedSinceLease: false, ourOpIdsPresent: false, previousStreak }),
      RangeError,
      String(previousStreak),
    );
  }
});

test('classifyPush rejects non-boolean flags with TypeError', () => {
  const bad = [
    { refMovedSinceLease: 'no', ourOpIdsPresent: false, previousStreak: 0 },
    { refMovedSinceLease: false, ourOpIdsPresent: undefined, previousStreak: 0 },
    { refMovedSinceLease: 0, ourOpIdsPresent: 1, previousStreak: 0 },
  ];
  for (const o of bad) {
    assert.throws(() => classifyPush(o as unknown as PushObservation), TypeError, JSON.stringify(o));
  }
});

test('classifyPush does not mutate its input', () => {
  const o: PushObservation = Object.freeze({ refMovedSinceLease: false, ourOpIdsPresent: false, previousStreak: 1 });
  assert.deepEqual(classifyPush(o), { outcome: 'transient', streak: 2 });
  assert.deepEqual(o, { refMovedSinceLease: false, ourOpIdsPresent: false, previousStreak: 1 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/unit/classify.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (cannot find `src/git/classify.js`).

- [ ] **Step 3: Write the minimal implementation**

Create `src/git/classify.ts`:

```ts
export type PushOutcome = 'landed' | 'lease_lost' | 'transient' | 'nonretryable';

/**
 * What the caller observed after a rejected (or unclear) push followed by a fresh fetch.
 * There is deliberately no field for the rejection text: message text never decides
 * (glossary §26.2 item 2, 09-security SEC-04).
 */
export interface PushObservation {
  /** The leased remote ref now points somewhere other than the lease value. */
  refMovedSinceLease: boolean;
  /** The fetched board contains the op ids of the publish we tried to push. */
  ourOpIdsPresent: boolean;
  /** Consecutive transient rejections of this same publish before this one. */
  previousStreak: number;
}

/** The 3rd consecutive transient rejection of the same publish is NONRETRYABLE. */
export const NONRETRYABLE_STREAK = 3;

export function classifyPush(o: PushObservation): { outcome: PushOutcome; streak: number } {
  if (typeof o.refMovedSinceLease !== 'boolean' || typeof o.ourOpIdsPresent !== 'boolean') {
    throw new TypeError('classifyPush: refMovedSinceLease and ourOpIdsPresent must be booleans');
  }
  if (!Number.isSafeInteger(o.previousStreak) || o.previousStreak < 0) {
    throw new RangeError(`classifyPush: previousStreak must be a non-negative integer, got ${String(o.previousStreak)}`);
  }
  if (o.ourOpIdsPresent) {
    return { outcome: 'landed', streak: 0 };
  }
  if (o.refMovedSinceLease) {
    return { outcome: 'lease_lost', streak: 0 };
  }
  const streak = o.previousStreak + 1;
  return { outcome: streak >= NONRETRYABLE_STREAK ? 'nonretryable' : 'transient', streak };
}
```

- [ ] **Step 4: Run the test to verify it passes, and type-check**

Run: `npx tsx --test test/unit/classify.test.ts`
Expected: PASS — 8 tests, 0 failures.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0, no diagnostics.

- [ ] **Step 5: Commit**

```
git add src/git/classify.ts test/unit/classify.test.ts
git commit -m "feat(git): classify push rejections by outcome, never by text (glossary §26.2 item 2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Bare-remote fixture with server-side hooks

**Files:**
- Create: `test/sim/remote.ts`
- Test: `test/integration/remote.test.ts`

**Interfaces:**
- Consumes:
  - `GitRunner`, `createGitRunner(deps: GitRunnerDeps): GitRunner` from `src/git/runner.ts` (Task 9)
  - `makeTempRoot(label: string)`, `testRunner(clock?: Clock)` from `test/helpers/tmp.ts` (Task 9)
  - `buildDaemonEnv(source, passthrough)` from `src/git/env.ts` (Task 8) — the test relies on the 09-security §3.4 allowlist keeping `GIT_CONFIG_GLOBAL` and `PATH`/`Path`
  - `realClock` from `src/ports/clock.ts` (Task 2)
- Produces (exactly as in 00-header.md):
  - `type RejectKind = 'transient-failed' | 'commit_refs' | 'policy'`
  - `interface RemoteLogEntry { ref: string; old: string; new: string; }`
  - `interface RefTxEntry { state: string; old: string; new: string; ref: string; }`
  - `interface BareRemote { dir: string; url: string; rejectNext(n: number, kind: RejectKind, refSubstring?: string): Promise<void>; clearRejects(): Promise<void>; readRemoteLog(): Promise<RemoteLogEntry[]>; readRefTxLog(): Promise<RefTxEntry[]>; refs(): Promise<Record<string, string>>; }`
  - `async function createBareRemote(root: string, git: GitRunner, defaultBranch?: string): Promise<BareRemote>`

**Behaviour pinned by this task (11-testing §3.3 setup step 1, host emulation):**
- Layout under `root`: `remote.git/` (the bare repo), `remote-control.json` (reject rule), `remote-log.jsonl` (post-receive), `reftx-log.jsonl` (reference-transaction). One remote per root: a second `createBareRemote` on the same root throws `already exists`.
- `url` is `pathToFileURL(dir).href` (percent-encoded `file://` URL; git url-decodes it, verified with `공 백 dir` on Windows).
- Hooks: each of `pre-receive`, `post-receive`, `reference-transaction` is a two-line sh shim `#!/bin/sh\nexec node "$0.js" "$@"\n` plus an LF-only node script `<name>.js`. Both are written from LF-only buffers and the writer throws if a CR byte is present (Review Focus 3). The sample hooks git creates are removed. The bare repo's own config pins `core.hooksPath` to its absolute `hooks` directory (forward slashes), so a user-global `core.hooksPath` cannot switch the fixture hooks off. The client's `-c core.hooksPath=<empty>` from `runGit` does not reach the server side: git clears `GIT_CONFIG_PARAMETERS` for the local `receive-pack` it spawns.
- `pre-receive` reads all of stdin (`<old> <new> <ref>` lines), then reads `remote-control.json` `{count, kind, refSubstring}`. If `count > 0` and any updated ref contains `refSubstring` (empty string matches every ref), it decrements `count` (temp file + rename), prints the kind's text to stderr and exits 1, which rejects the whole push and leaves every ref unchanged:
  - `transient-failed` → prints nothing; git reports `[remote rejected] <ref> (pre-receive hook declined)`. Real GitHub prints `(failed)` here; the fixture cannot reproduce host text, which is fine because classification (Task 10) never reads text.
  - `policy` → `policy: blocked`
  - `commit_refs` → `fatal error in commit_refs`
- `post-receive` appends one JSON line `{"ref","old","new"}` per updated ref to `remote-log.jsonl`, in git's order. A deletion has `new` = 40 zeros; a creation has `old` = 40 zeros.
- `reference-transaction` appends `{"state","old","new","ref"}` for every line of the `committed` state only to `reftx-log.jsonl`.
- `refs()` returns `for-each-ref` of the bare repo as `ref → oid` with keys sorted by code unit; `{}` for an empty remote. `readRemoteLog()`/`readRefTxLog()` return `[]` when the file does not exist yet.
- Git refuses to delete the bare remote's current branch (`receive.denyDeleteCurrent`, `refs/heads/<defaultBranch>`). Tests and later oracles (Task 13 INV-OID) that exercise deletions must use other refs, e.g. `refs/cowork/main/code`.

- [ ] **Step 1: Write the failing test**

Create `test/integration/remote.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempRoot, testRunner } from '../helpers/tmp.js';
import { createGitRunner, type GitRunner } from '../../src/git/runner.js';
import { buildDaemonEnv } from '../../src/git/env.js';
import { realClock } from '../../src/ports/clock.js';
import { createBareRemote } from '../sim/remote.js';

const ID = { name: 'Fixture', email: 'fixture@cowork.invalid' };
const ZERO = '0000000000000000000000000000000000000000';

/** A plain work repo with one commit on main; returns its dir and the commit oid. */
async function workRepo(root: string, git: GitRunner, name: string, content: string): Promise<{ dir: string; oid: string }> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const ok = async (args: string[]) => {
    const r = await git.run(args, { class: 'local', cwd: dir, identity: ID, wallMsForDates: 1_700_000_000_000 });
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr.toString('utf8')}`);
    return r.stdout.toString('utf8').trim();
  };
  await ok(['init', '-q', '-b', 'main']);
  await writeFile(join(dir, 'f.txt'), Buffer.from(content, 'utf8'));
  await ok(['add', 'f.txt']);
  await ok(['commit', '-q', '-m', content.trim()]);
  return { dir, oid: await ok(['rev-parse', 'HEAD']) };
}

async function push(git: GitRunner, cwd: string, url: string, refspec: string) {
  return git.run(['push', '--porcelain', url, refspec], { class: 'network', cwd });
}

test('createBareRemote under a spaced, non-ASCII root accepts a push and logs it', async () => {
  const { root, cleanup } = await makeTempRoot('remote-basic');
  try {
    const git = testRunner();
    const remote = await createBareRemote(root, git);
    assert.ok(remote.dir.includes('공 백 dir'));
    assert.match(remote.url, /^file:\/\//);
    const { dir, oid } = await workRepo(root, git, 'work', 'one\n');
    const r = await push(git, dir, remote.url, 'HEAD:refs/heads/main');
    assert.equal(r.code, 0, r.stderr.toString('utf8'));
    assert.deepEqual(await remote.refs(), { 'refs/heads/main': oid });
    assert.deepEqual(await remote.readRemoteLog(), [{ ref: 'refs/heads/main', old: ZERO, new: oid }]);
    const tx = await remote.readRefTxLog();
    assert.ok(tx.some((e) => e.state === 'committed' && e.ref === 'refs/heads/main' && e.new === oid), JSON.stringify(tx));
  } finally {
    await cleanup();
  }
});

test('hook files are LF-only and the shim is exactly two lines (Review Focus 3)', async () => {
  const { root, cleanup } = await makeTempRoot('remote-lf');
  try {
    const remote = await createBareRemote(root, testRunner());
    for (const name of ['pre-receive', 'post-receive', 'reference-transaction']) {
      const shim = await readFile(join(remote.dir, 'hooks', name));
      assert.equal(shim.toString('utf8'), '#!/bin/sh\nexec node "$0.js" "$@"\n');
      const js = await readFile(join(remote.dir, 'hooks', `${name}.js`));
      assert.equal(js.includes(0x0d), false, `${name}.js contains CR`);
    }
  } finally {
    await cleanup();
  }
});

test('rejectNext(policy) is enforced by the pre-receive hook, then the next push lands (Review Focus 3)', async () => {
  const { root, cleanup } = await makeTempRoot('remote-policy');
  try {
    const git = testRunner();
    const remote = await createBareRemote(root, git);
    const { dir, oid } = await workRepo(root, git, 'work', 'one\n');
    await remote.rejectNext(1, 'policy');
    const rejected = await push(git, dir, remote.url, 'HEAD:refs/heads/main');
    assert.notEqual(rejected.code, 0);
    const text = rejected.stdout.toString('utf8') + rejected.stderr.toString('utf8');
    assert.match(text, /policy: blocked/);
    assert.match(text, /pre-receive hook declined/);
    assert.deepEqual(await remote.refs(), {});
    assert.deepEqual(await remote.readRemoteLog(), []);
    const control = JSON.parse(await readFile(join(root, 'remote-control.json'), 'utf8')) as { count: number };
    assert.equal(control.count, 0, 'the hook decremented its counter');

    const landed = await push(git, dir, remote.url, 'HEAD:refs/heads/main');
    assert.equal(landed.code, 0, landed.stderr.toString('utf8'));
    assert.deepEqual(await remote.refs(), { 'refs/heads/main': oid });
  } finally {
    await cleanup();
  }
});

test('commit_refs and transient-failed print their texts and leave the ref unchanged', async () => {
  const { root, cleanup } = await makeTempRoot('remote-kinds');
  try {
    const git = testRunner();
    const remote = await createBareRemote(root, git);
    const { dir } = await workRepo(root, git, 'work', 'one\n');

    await remote.rejectNext(1, 'commit_refs');
    const a = await push(git, dir, remote.url, 'HEAD:refs/heads/main');
    const aText = a.stdout.toString('utf8') + a.stderr.toString('utf8');
    assert.notEqual(a.code, 0);
    assert.match(aText, /fatal error in commit_refs/);
    assert.match(aText, /\[remote rejected\] .*\(pre-receive hook declined\)/);

    await remote.rejectNext(2, 'transient-failed');
    for (let i = 0; i < 2; i++) {
      const b = await push(git, dir, remote.url, 'HEAD:refs/heads/main');
      const bText = b.stdout.toString('utf8') + b.stderr.toString('utf8');
      assert.notEqual(b.code, 0);
      assert.match(bText, /pre-receive hook declined/);
      assert.doesNotMatch(bText, /policy: blocked|commit_refs/);
    }
    assert.deepEqual(await remote.refs(), {});
  } finally {
    await cleanup();
  }
});

test('refSubstring limits rejection to matching refs; clearRejects removes the rule', async () => {
  const { root, cleanup } = await makeTempRoot('remote-substring');
  try {
    const git = testRunner();
    const remote = await createBareRemote(root, git);
    const { dir, oid } = await workRepo(root, git, 'work', 'one\n');

    await remote.rejectNext(5, 'policy', 'refs/cowork/');
    const main = await push(git, dir, remote.url, 'HEAD:refs/heads/main');
    assert.equal(main.code, 0, main.stderr.toString('utf8'));
    const board = await push(git, dir, remote.url, 'HEAD:refs/cowork/main/board');
    assert.notEqual(board.code, 0);

    await remote.clearRejects();
    assert.equal(existsSync(join(root, 'remote-control.json')), false);
    const again = await push(git, dir, remote.url, 'HEAD:refs/cowork/main/board');
    assert.equal(again.code, 0, again.stderr.toString('utf8'));
    assert.deepEqual(await remote.refs(), { 'refs/cowork/main/board': oid, 'refs/heads/main': oid });
  } finally {
    await cleanup();
  }
});

test('the remote log records deletions and non-fast-forward updates with old and new oids', async () => {
  const { root, cleanup } = await makeTempRoot('remote-log');
  try {
    const git = testRunner();
    const remote = await createBareRemote(root, git);
    const one = await workRepo(root, git, 'one', 'one\n');
    const two = await workRepo(root, git, 'two', 'two\n');
    assert.equal((await push(git, one.dir, remote.url, 'HEAD:refs/cowork/main/code')).code, 0);
    assert.equal((await push(git, two.dir, remote.url, '+HEAD:refs/cowork/main/code')).code, 0);
    assert.equal((await push(git, two.dir, remote.url, ':refs/cowork/main/code')).code, 0);
    assert.deepEqual(await remote.readRemoteLog(), [
      { ref: 'refs/cowork/main/code', old: ZERO, new: one.oid },
      { ref: 'refs/cowork/main/code', old: one.oid, new: two.oid },
      { ref: 'refs/cowork/main/code', old: two.oid, new: ZERO },
    ]);
    const tx = await remote.readRefTxLog();
    assert.ok(tx.every((e) => e.state === 'committed'));
    assert.ok(tx.some((e) => e.ref === 'refs/cowork/main/code' && e.old === two.oid && e.new === ZERO), JSON.stringify(tx));
  } finally {
    await cleanup();
  }
});

test('a user-global core.hooksPath does not switch off the fixture hooks', async () => {
  const { root, cleanup } = await makeTempRoot('remote-globalhooks');
  try {
    const globalCfg = join(root, 'user global.gitconfig');
    const nowhere = join(root, 'nowhere').replace(/\\/g, '/');
    await writeFile(globalCfg, Buffer.from(`[core]\n\thooksPath = "${nowhere}"\n`, 'utf8'));
    const git = createGitRunner({
      clock: realClock,
      hooksPath: join(root, 'empty-hooks'),
      daemonEnv: buildDaemonEnv({ ...process.env, GIT_CONFIG_GLOBAL: globalCfg }, []),
      testBuild: true,
    });
    const remote = await createBareRemote(root, git);
    const { dir } = await workRepo(root, git, 'work', 'one\n');
    await remote.rejectNext(1, 'policy');
    const r = await push(git, dir, remote.url, 'HEAD:refs/heads/main');
    assert.notEqual(r.code, 0);
    assert.match(r.stdout.toString('utf8') + r.stderr.toString('utf8'), /policy: blocked/);
  } finally {
    await cleanup();
  }
});

test('creating a second remote in the same root is refused', async () => {
  const { root, cleanup } = await makeTempRoot('remote-twice');
  try {
    const git = testRunner();
    await createBareRemote(root, git);
    await assert.rejects(createBareRemote(root, git), /already exists/);
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/integration/remote.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (cannot find module `test/sim/remote.js`).

- [ ] **Step 3: Write the fixture**

Create `test/sim/remote.ts`:

```ts
// Bare-remote fixture with server-side hooks (11-testing §3.3 setup step 1).
// Hooks are LF-only node scripts behind a two-line sh shim, so they run with
// Git for Windows' sh as well as on macOS/Linux (Review Focus 3).
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GitRunner } from '../../src/git/runner.js';

export type RejectKind = 'transient-failed' | 'commit_refs' | 'policy';
export interface RemoteLogEntry { ref: string; old: string; new: string; }
export interface RefTxEntry { state: string; old: string; new: string; ref: string; }
export interface BareRemote {
  dir: string;
  url: string;
  rejectNext(n: number, kind: RejectKind, refSubstring?: string): Promise<void>;
  clearRejects(): Promise<void>;
  readRemoteLog(): Promise<RemoteLogEntry[]>;
  readRefTxLog(): Promise<RefTxEntry[]>;
  refs(): Promise<Record<string, string>>;
}

const SHIM = '#!/bin/sh\nexec node "$0.js" "$@"\n';

function readStdinJs(): string {
  return [
    "const fs = require('fs');",
    'function stdinLines() {',
    "  const text = fs.readFileSync(0, 'utf8');",
    "  return text.split('\\n').filter((l) => l.length > 0).map((l) => {",
    "    const [oldOid, newOid, ref] = l.split(' ');",
    '    return { old: oldOid, new: newOid, ref };',
    '  });',
    '}',
  ].join('\n');
}

function preReceiveJs(controlFile: string): string {
  return [
    readStdinJs(),
    `const control = ${JSON.stringify(controlFile)};`,
    'const updates = stdinLines();',
    'let c = null;',
    "try { c = JSON.parse(fs.readFileSync(control, 'utf8')); } catch { c = null; }",
    'if (c && c.count > 0 && updates.some((u) => u.ref.includes(c.refSubstring))) {',
    '  c.count -= 1;',
    "  fs.writeFileSync(control + '.tmp', JSON.stringify(c));",
    "  fs.renameSync(control + '.tmp', control);",
    "  if (c.kind === 'policy') process.stderr.write('policy: blocked\\n');",
    "  if (c.kind === 'commit_refs') process.stderr.write('fatal error in commit_refs\\n');",
    '  process.exit(1);',
    '}',
    'process.exit(0);',
    '',
  ].join('\n');
}

function postReceiveJs(logFile: string): string {
  return [
    readStdinJs(),
    `const log = ${JSON.stringify(logFile)};`,
    'const lines = stdinLines().map((u) => JSON.stringify({ ref: u.ref, old: u.old, new: u.new }) + "\\n").join("");',
    'if (lines.length > 0) fs.appendFileSync(log, lines);',
    '',
  ].join('\n');
}

function refTxJs(logFile: string): string {
  return [
    readStdinJs(),
    `const log = ${JSON.stringify(logFile)};`,
    'const state = process.argv[2];',
    'const updates = stdinLines();',
    "if (state === 'committed') {",
    '  const lines = updates.map((u) => JSON.stringify({ state, old: u.old, new: u.new, ref: u.ref }) + "\\n").join("");',
    '  if (lines.length > 0) fs.appendFileSync(log, lines);',
    '}',
    '',
  ].join('\n');
}

async function writeLf(path: string, text: string, mode: number): Promise<void> {
  // Built from LF-only literals; assert so a CRLF can never sneak in (Review Focus 3).
  const buf = Buffer.from(text, 'utf8');
  if (buf.includes(0x0d)) throw new Error(`hook ${path} contains CR`);
  await writeFile(path, buf, { mode });
}

async function readJsonl<T>(file: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return text.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as T);
}

export async function createBareRemote(root: string, git: GitRunner, defaultBranch = 'main'): Promise<BareRemote> {
  const dir = join(root, 'remote.git');
  if (await stat(dir).catch(() => null)) throw new Error(`createBareRemote: ${dir} already exists`);
  const controlFile = join(root, 'remote-control.json');
  const remoteLog = join(root, 'remote-log.jsonl');
  const refTxLog = join(root, 'reftx-log.jsonl');

  const init = await git.run(['init', '-q', '--bare', '-b', defaultBranch, dir], { class: 'local', cwd: root });
  if (init.code !== 0) throw new Error(`git init --bare failed: ${init.stderr.toString('utf8')}`);

  const hooks = join(dir, 'hooks');
  await rm(hooks, { recursive: true, force: true }); // drop git's *.sample files
  await mkdir(hooks, { recursive: true });
  for (const [name, js] of [
    ['pre-receive', preReceiveJs(controlFile)],
    ['post-receive', postReceiveJs(remoteLog)],
    ['reference-transaction', refTxJs(refTxLog)],
  ] as const) {
    await writeLf(join(hooks, name), SHIM, 0o755);
    await writeLf(join(hooks, `${name}.js`), js, 0o644);
  }
  // Pin the hooks directory in the remote's own config so a user-global
  // core.hooksPath cannot redirect the server side away from the fixture hooks.
  const pin = await git.run(['config', 'core.hooksPath', hooks.replace(/\\/g, '/')], { class: 'local', cwd: dir });
  if (pin.code !== 0) throw new Error(`git config core.hooksPath failed: ${pin.stderr.toString('utf8')}`);

  const url = pathToFileURL(dir).href;

  return {
    dir,
    url,
    async rejectNext(n, kind, refSubstring = '') {
      const tmp = `${controlFile}.tmp`;
      await writeFile(tmp, Buffer.from(JSON.stringify({ count: n, kind, refSubstring }), 'utf8'));
      await rename(tmp, controlFile);
    },
    async clearRejects() {
      await rm(controlFile, { force: true });
    },
    readRemoteLog: () => readJsonl<RemoteLogEntry>(remoteLog),
    readRefTxLog: () => readJsonl<RefTxEntry>(refTxLog),
    async refs() {
      const r = await git.run(['for-each-ref', '--format=%(refname) %(objectname)'], { class: 'local', cwd: dir });
      if (r.code !== 0) throw new Error(`for-each-ref failed: ${r.stderr.toString('utf8')}`);
      const out: Record<string, string> = {};
      const pairs = r.stdout.toString('utf8').split('\n').filter((l) => l.length > 0).map((l) => {
        const sp = l.lastIndexOf(' ');
        return [l.slice(0, sp), l.slice(sp + 1)] as const;
      });
      pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      for (const [ref, oid] of pairs) out[ref] = oid;
      return out;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/integration/remote.test.ts`
Expected: PASS (8 tests).

Negative check while developing (do not commit): replacing the `core.hooksPath` pin with any other key makes `a user-global core.hooksPath does not switch off the fixture hooks` fail (verified on Windows 11 / Git 2.55), so that test really covers the pin.

- [ ] **Step 5: Commit**

```bash
git add test/sim/remote.ts test/integration/remote.test.ts
git commit -m "test(sim): bare-remote fixture with pre-receive, post-receive and reference-transaction hooks

createBareRemote installs LF-only node hooks behind a sh shim (works with
Git for Windows sh), pins core.hooksPath in the remote's config, rejects the
next N pushes by kind and ref substring, and logs every ref update.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Peer clones, counting secret filter, big BOM+CRLF fixture, retry for fixture git network calls

**Files:**
- Create: `test/sim/fixtures/bigBomCrlf.ts`
- Create: `test/helpers/retryGit.ts` (retry for the git network calls of test fixtures; this is the first task that needs it, and Task 13's NaiveEngine uses it too)
- Create: `test/sim/peers.ts`
- Test: `test/unit/bigBomCrlf.test.ts` (pure, no git)
- Test: `test/unit/canary.test.ts` (pure, no git)
- Test: `test/unit/retryGit.test.ts` (pure, a fake run function, no git)
- Test: `test/integration/peers.test.ts` (real git)

**Interfaces:**
- Consumes:
  - `Random`, `seededRandom(seed: string): Random`, `randomInt(r: Random, maxExclusive: number): number` from `src/ports/random.ts` (Task 3)
  - `GitCallOptions` (type) from `src/git/flags.ts` (Task 8); `GitRunner` from `src/git/runner.ts` (Task 9)
  - `makeTempRoot(label)`, `testRunner(clock?)` from `test/helpers/tmp.ts` (Task 9)
  - `BareRemote` (`url`, `refs()`, and `rejectNext(n, kind, refSubstring?)` in `peers.test.ts`), `createBareRemote(root, git, defaultBranch?)` from `test/sim/remote.ts` (Task 11)
- Produces (exactly as in 00-header.md):
  - `test/helpers/retryGit.ts`: `interface GitAttempt { code: number; stderr: string; }`, `class RetryGitError extends Error { readonly attempts: GitAttempt[] }`, `interface RetryGitOptions { attempts: number; label: string; nothingLanded?: () => Promise<boolean>; pauseMs?: number; }`, `async function retryGit<R extends { code: number; stderr: Buffer }>(run: () => Promise<R>, opts: RetryGitOptions): Promise<R>`
  - `function canary(runId: string): string` — `` `COWORK_CANARY_${runId}` `` (11-testing §3.7); the secret filter replaces exactly this string
  - `interface PeerOptions { name: string; autocrlf: boolean; withFilter: boolean; }`
  - `interface PeerClone { name: string; dir: string; filterCountFile: string; opts: PeerOptions; canary: string; }`
  - `async function seedRemote(remote: BareRemote, root: string, git: GitRunner, files: Record<string, Buffer>): Promise<string>` — returns the commit oid on `main`
  - `async function clonePeer(remote: BareRemote, root: string, opts: PeerOptions, git: GitRunner): Promise<PeerClone>`
  - `function generateBigBomCrlf(lines: number, random: Random): Buffer`

**Behaviour pinned by this task (11-testing §3.3 setup steps 2–3, §3.7):**
- `retryGit(run, opts)` runs `run` (a git network call) until it exits 0, at most `opts.attempts` times, and returns that result.
  - Why: in the dry run of this plan, under heavy parallel load on Windows (`npm test` running beside the SIM smoke), `seedRemote`'s push to the local `file://` remote exited 1 with an empty stderr while nothing landed. This happened twice in about 30 `npm test` runs, both times in `peers.test.ts`.
  - After a non-zero exit it calls `opts.nothingLanded()` when given. It retries only when that returns true, that is, when the remote shows that nothing landed. When it returns false, it throws at once: `<label>: attempt <k> failed and the remote changed, so it was not retried`. Calls that write nothing to the remote (fetch, clone) omit `nothingLanded` and are always retried.
  - Before each retry it pauses `opts.pauseMs` (default 200 ms) of real time. That never reaches an op-log or a commit.
  - After the last failed attempt it throws `RetryGitError` with the message `<label>: failed <n> of <n> attempts` followed by one line per attempt, `  attempt <i>: code=<exit code> stderr: <stderr on one line, or (empty)>`. `error.attempts` holds the same codes and stderr texts.
  - `attempts` must be a positive integer (`RangeError` otherwise).
- `seedRemote` commits **exactly** `files` (keys are POSIX relative paths, values are bytes; it adds nothing) in a temporary work repo `<root>/seed` (refused if it exists, removed afterwards), with `core.autocrlf=false` in that repo so stored bytes equal the given bytes on every OS (Git for Windows' system config defaults `core.autocrlf=true`). The commit uses a fixed identity `Cowork Seed <seed@cowork.invalid>`, the fixed date `1_700_000_000_000` ms (through `wallMsForDates`, so `testBuild` runners only), message `seed`, `--allow-empty`. It is pushed to `refs/heads/main` through `retryGit` (3 attempts; nothing landed = the remote's `refs/heads/main` is still what it was before the push). Same `files` → same oid, in any root, on any OS.
- The secret attribute is **committed by the caller** in `.gitattributes` (`secret.txt filter=secret`), not added by the fixture: `attr.tree=<EPOCH_BASE>` (glossary §18) reads attributes from a tree and ignores the work tree, but it would still read `.git/info/attributes`, so a per-peer `info/attributes` would hide attribute-source bugs in later plans. The stored form of `secret.txt` holds the placeholder `@@SECRET@@`. Task 13's seed must include both files if it wants the filter exercised.
- `clonePeer` (`opts.name` must match `^[A-Za-z0-9_-]+$`; the directory `<root>/<name>` must not exist):
  1. `git clone -q --no-checkout -c core.autocrlf=<true|false> <remote.url> <dir>` (class `network`), so every peer has an explicit `core.autocrlf` in its own config. The clone goes through `retryGit` (3 attempts). A clone writes nothing to the remote, and `<dir>` is removed before each attempt, because a failed attempt may leave a partial directory;
  2. when `withFilter`: writes the LF-only node script `<dir>/.git/cowork-secret-filter.js` and sets `filter.secret.clean = node '<script>' clean '<countFile>' %f` and `filter.secret.smudge = node '<script>' smudge '<countFile>' %f` (paths single-quoted with forward slashes, so a root containing `공 백 dir` works under Git for Windows' sh; git shell-quotes `%f` itself);
  3. `git checkout -q main`, with `filterDrivers: ['secret']` (→ `-c filter.secret.required=true`) when `withFilter`, so the smudge filter runs during the first checkout.
- **Canary (11-testing §2 glossary row, §3.7 "secret filter"):** `canary(runId)` returns `` `COWORK_CANARY_${runId}` `` and refuses a `runId` outside `^[A-Za-z0-9_-]+$` (so the value is a plain ASCII token: no CR to trip the LF-only check on the filter script that embeds it, and nothing that could make the exact-string replacement or the latin1 round trip ambiguous). `clonePeer`'s signature carries no run id (00-header), so the fixture derives one: `runId = sha256(path.resolve(root))`, first 12 lowercase hex chars. Every peer cloned under the same `root` (one run) therefore has the same `PeerClone.canary`; peers under different temp roots get different canaries. `PeerClone.canary` is set for every peer, with or without the filter.
- Determinism boundary: the canary differs between the two temp roots of Task 13's determinism test. That does not change any oid, because the canary exists only in filtered work-tree bytes (the stored blob holds `@@SECRET@@`) and Plan 1's harness clones with `withFilter: false`. If a later plan compares work-tree bytes across roots, the run id must come from the SIM seed instead — a header change (a `runId` on `PeerOptions` or `clonePeer`), not a change inside this task.
- `filterCountFile` is always `<dir>/.git/cowork-filter-count.log`; it does not exist for peers without the filter. The filter script is written per peer with that peer's canary embedded; it appends exactly one line `<clean|smudge> <path>` per invocation and is byte-preserving apart from the replacement of **exactly** the peer's canary string (clean: `peer.canary` → `@@SECRET@@`; smudge: the reverse). Near misses — another run's canary, a prefix of it, the dashed `COWORK-CANARY-…` spelling — pass through unchanged.
- A peer without the filter still sees `filter=secret` in `.gitattributes` with no driver configured; git passes the content through unchanged (a teammate without the driver).
- `generateBigBomCrlf(lines, random)` returns the UTF-8 BOM followed by exactly `lines` lines, each terminated by CRLF (no bare LF or CR), deterministic for a given `Random` (it draws only through `randomInt`). Content: classes with `@property` getters and `.setter`s, `@staticmethod`, `@overload` stubs, `sys.platform` branches, Hangul comments. Blocks are never cut (comment padding fills the end), so the output parses as Python. 26,436 lines (the team file's size) ≈ 1.3 MB.

- [ ] **Step 1: Write the failing unit test for the BOM+CRLF generator**

Create `test/unit/bigBomCrlf.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateBigBomCrlf } from '../sim/fixtures/bigBomCrlf.js';
import { seededRandom } from '../../src/ports/random.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function body(buf: Buffer): string {
  assert.ok(buf.subarray(0, 3).equals(BOM), 'starts with the UTF-8 BOM');
  return buf.subarray(3).toString('utf8');
}

test('BOM, exactly N CRLF-terminated lines, no bare LF or CR', () => {
  for (const n of [1, 7, 8, 9, 50, 5_000]) {
    const text = body(generateBigBomCrlf(n, seededRandom(`lines-${n}`)));
    assert.equal(text.split('\r\n').length - 1, n, `line count for ${n}`);
    assert.ok(text.endsWith('\r\n'));
    const stripped = text.replace(/\r\n/g, '');
    assert.equal(stripped.includes('\n'), false, 'bare LF');
    assert.equal(stripped.includes('\r'), false, 'bare CR');
  }
});

test('zero lines is the BOM alone', () => {
  assert.ok(generateBigBomCrlf(0, seededRandom('zero')).equals(BOM));
});

test('same seed gives identical bytes; another seed gives different bytes', () => {
  const a = generateBigBomCrlf(2_000, seededRandom('fixture-seed'));
  const b = generateBigBomCrlf(2_000, seededRandom('fixture-seed'));
  const c = generateBigBomCrlf(2_000, seededRandom('other-seed'));
  assert.ok(a.equals(b));
  assert.equal(a.equals(c), false);
});

test('content has the §3.7 features: classes, decorators, setters, overloads, platform branches, Hangul', () => {
  const text = body(generateBigBomCrlf(5_000, seededRandom('features')));
  for (const needle of ['class Widget', '@property', '.setter', '@staticmethod', '@overload', 'sys.platform == "win32"', '한글 주석']) {
    assert.ok(text.includes(needle), needle);
  }
  assert.equal(Buffer.from(text, 'utf8').toString('utf8'), text, 'valid UTF-8');
});

test('26,436 lines is about 1.3 MB (the team-file stand-in, big26k.py)', () => {
  const buf = generateBigBomCrlf(26_436, seededRandom('big26k'));
  assert.ok(buf.length >= 1_100_000 && buf.length <= 1_600_000, `size ${buf.length}`);
});
```

- [ ] **Step 2: Run the unit test to verify it fails**

Run: `npx tsx --test test/unit/bigBomCrlf.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (cannot find module `test/sim/fixtures/bigBomCrlf.js`).

- [ ] **Step 3: Write the generator**

Create `test/sim/fixtures/bigBomCrlf.ts`:

```ts
// Generated BOM + CRLF Python source (11-testing §3.7 `big_bomcrlf.py` / `big26k.py`):
// classes, decorators, property getters/setters, @overload stubs, platform branches
// and Hangul comments. Deterministic for a given Random; never reads a real file.
import { randomInt, type Random } from '../../../src/ports/random.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const HEADER = [
  '# -*- coding: utf-8 -*-',
  '"""Generated fixture module for cowork-sync tests. Do not edit by hand."""',
  'from __future__ import annotations',
  '',
  'import os',
  'import sys',
  'from typing import Any, overload',
  '',
];

function classBlock(n: number, k: number): string[] {
  return [
    `class Widget${n}(object):`,
    `    """Generated widget ${n}: one integer value, a list of labels and a lookup table used by the fixture tests."""`,
    '',
    `    def __init__(self, value: int = ${k}, labels: list[str] | None = None, *, strict: bool = False) -> None:`,
    '        self._value = value',
    `        self._labels: list[str] = list(labels) if labels is not None else [f"label-{i}-${n}" for i in range(${k % 5})]`,
    '        self._strict = strict',
    '',
    '    @property',
    '    def value(self) -> int:',
    `        """Current value of widget ${n}; the setter rejects negative numbers when strict."""`,
    '        return self._value',
    '',
    '    @value.setter',
    '    def value(self, new_value: int) -> None:',
    '        if self._strict and new_value < 0:',
    `            raise ValueError(f"widget ${n}: negative value {new_value} is not allowed in strict mode")`,
    '        self._value = new_value',
    '',
    '    @staticmethod',
    `    def describe(label: str = "w${n}", *, verbose: bool = False) -> str:`,
    `        return f"{label}: widget ${n} of kind {${k} % 7} (verbose={verbose})" if verbose else f"{label}: widget ${n}"`,
    '',
    '    def as_dict(self) -> dict[str, Any]:',
    `        return {"id": ${n}, "value": self._value, "labels": list(self._labels), "strict": self._strict, "kind": "widget"}`,
    '',
    '',
  ];
}

function overloadBlock(n: number): string[] {
  return [
    '@overload',
    `def convert_${n}(value: int, *, strict: bool = False, default: int | None = None) -> int: ...`,
    '@overload',
    `def convert_${n}(value: str, *, strict: bool = False, default: str | None = None) -> str: ...`,
    `def convert_${n}(value: Any, *, strict: bool = False, default: Any = None) -> Any:`,
    `    """Identity conversion ${n} with an overload pair; returns the default when value is None."""`,
    '    return default if value is None else value',
    '',
    '',
  ];
}

function platformBlock(n: number): string[] {
  return [
    'if sys.platform == "win32":',
    `    DATA_DIR_${n} = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "cowork", "fixtures", "${n}")`,
    'else:',
    `    DATA_DIR_${n} = os.path.join(os.path.expanduser("~"), ".local", "share", "cowork", "fixtures", "${n}")`,
    '',
  ];
}

function commentBlock(n: number, k: number): string[] {
  return [
    `# 설정 블록 ${n}: 값 ${k} 를 확인합니다 (한글 주석) — generated configuration entry for the fixture tests`,
    `SETTING_${n} = {"name": "setting_${n}", "limit": ${k}, "enabled": ${k % 2 === 0 ? 'True' : 'False'}, "path": "config/settings/setting_${n}.json"}`,
    '',
  ];
}

/**
 * Returns UTF-8 BOM + exactly `lines` lines, each terminated by CRLF (no bare LF, no bare CR).
 * Blocks are never cut: when the next block does not fit, the rest is comment padding,
 * so the module stays valid Python. At 26,436 lines (the size of the pilot's largest
 * file) the result is about 1.3 MB.
 */
export function generateBigBomCrlf(lines: number, random: Random): Buffer {
  const target = Math.max(0, Math.floor(lines));
  const out: string[] = HEADER.slice(0, target);
  let n = 0;
  while (out.length < target) {
    const k = randomInt(random, 1000);
    let block: string[];
    switch (randomInt(random, 4)) {
      case 0: block = classBlock(n, k); break;
      case 1: block = overloadBlock(n); break;
      case 2: block = platformBlock(n); break;
      default: block = commentBlock(n, k); break;
    }
    if (out.length + block.length > target) break;
    out.push(...block);
    n++;
  }
  while (out.length < target) out.push(`# padding ${out.length + 1}`);
  const body = target === 0 ? '' : out.join('\r\n') + '\r\n';
  return Buffer.concat([BOM, Buffer.from(body, 'utf8')]);
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `npx tsx --test test/unit/bigBomCrlf.test.ts`
Expected: PASS (5 tests). For reference, 26,436 lines measured 1,306,507 bytes and `python -c "import ast; ast.parse(open(p, encoding='utf-8-sig').read())"` accepted the output.

- [ ] **Step 5: Write the failing tests for retryGit, the canary, seed, peers and the secret filter**

Create `test/unit/retryGit.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryGit, RetryGitError } from '../helpers/retryGit.js';

/** A fake git call that returns the scripted results in order and counts its calls. */
function fakeRun(results: Array<{ code: number; stderr: string }>): { run: () => Promise<{ code: number; stderr: Buffer }>; calls: () => number } {
  let n = 0;
  return {
    async run() {
      const r = results[n] ?? assert.fail(`unexpected call ${n + 1}`);
      n++;
      return { code: r.code, stderr: Buffer.from(r.stderr, 'utf8') };
    },
    calls: () => n,
  };
}

test('retryGit: two failures, then success; the remote is checked after each failure', async () => {
  const f = fakeRun([{ code: 1, stderr: '' }, { code: 128, stderr: 'fatal: x' }, { code: 0, stderr: '' }]);
  let checks = 0;
  const r = await retryGit(f.run, { attempts: 3, label: 'push', pauseMs: 0, nothingLanded: async () => { checks++; return true; } });
  assert.equal(r.code, 0);
  assert.equal(f.calls(), 3);
  assert.equal(checks, 2);
});

test('retryGit: a call that always fails throws after the last attempt and lists all three', async () => {
  const f = fakeRun([
    { code: 1, stderr: '' },
    { code: 128, stderr: 'fatal: unable to access\nsecond line\n' },
    { code: 1, stderr: 'error: failed to push some refs\n' },
  ]);
  await assert.rejects(retryGit(f.run, { attempts: 3, label: 'seedRemote: git push', pauseMs: 0 }), (e: unknown) => {
    assert.ok(e instanceof RetryGitError);
    assert.equal(e.message, [
      'seedRemote: git push: failed 3 of 3 attempts',
      '  attempt 1: code=1 stderr: (empty)',
      '  attempt 2: code=128 stderr: fatal: unable to access second line',
      '  attempt 3: code=1 stderr: error: failed to push some refs',
    ].join('\n'));
    assert.deepEqual(e.attempts.map((a) => a.code), [1, 128, 1]);
    return true;
  });
  assert.equal(f.calls(), 3);
});

test('retryGit does not retry when the remote shows that something landed', async () => {
  const f = fakeRun([{ code: 1, stderr: 'error: x' }]);
  await assert.rejects(retryGit(f.run, { attempts: 3, label: 'push', pauseMs: 0, nothingLanded: async () => false }), (e: unknown) => {
    assert.ok(e instanceof RetryGitError);
    assert.equal(e.message, 'push: attempt 1 failed and the remote changed, so it was not retried\n  attempt 1: code=1 stderr: error: x');
    return true;
  });
  assert.equal(f.calls(), 1);
});

test('retryGit returns a first success without asking the remote, and needs a positive attempt count', async () => {
  const f = fakeRun([{ code: 0, stderr: '' }]);
  const r = await retryGit(f.run, { attempts: 3, label: 'fetch', nothingLanded: async () => assert.fail('not asked after a success') });
  assert.equal(r.code, 0);
  for (const attempts of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(retryGit(f.run, { attempts, label: 'x' }), RangeError);
  }
  assert.equal(f.calls(), 1);
});
```

Create `test/unit/canary.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canary } from '../sim/peers.js';

test('canary(runId) is exactly COWORK_CANARY_<runId>', () => {
  assert.equal(canary('r1'), 'COWORK_CANARY_r1');
  assert.equal(canary('3f9a0c1b2d4e'), 'COWORK_CANARY_3f9a0c1b2d4e');
  assert.equal(canary('seed-7_A'), 'COWORK_CANARY_seed-7_A');
});

test('different run ids give different canaries; the same run id gives the same one', () => {
  assert.notEqual(canary('run1'), canary('run2'));
  assert.equal(canary('run1'), canary('run1'));
});

test('canary refuses a run id that is not a plain token', () => {
  for (const bad of ['', 'a b', "a'b", 'a"b', 'a\rb', 'a\nb', 'a/b', '한글', 'a%b']) {
    assert.throws(() => canary(bad), /bad run id/, JSON.stringify(bad));
  }
});
```

Create `test/integration/peers.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempRoot, testRunner } from '../helpers/tmp.js';
import { createBareRemote } from '../sim/remote.js';
import { canary, clonePeer, seedRemote } from '../sim/peers.js';
import type { GitRunner } from '../../src/git/runner.js';

const ID = { name: 'Peer', email: 'peer@cowork.invalid' };
const CANARY_SHAPE = /^COWORK_CANARY_[0-9a-f]{12}$/;

/** Seed files: the secret attribute is committed in .gitattributes; the stored secret is the placeholder. */
function seedFiles(): Record<string, Buffer> {
  return {
    '.gitattributes': Buffer.from('secret.txt filter=secret\n', 'utf8'),
    'secret.txt': Buffer.from('token=@@SECRET@@\n', 'utf8'),
    'a.txt': Buffer.from('x\ny\n', 'utf8'),
    'src/한글 dir/b.py': Buffer.from('print("b")\n', 'utf8'),
  };
}

async function out(git: GitRunner, args: string[], cwd: string, filterDrivers?: string[]): Promise<string> {
  const r = await git.run(args, { class: 'local', cwd, identity: ID, wallMsForDates: 1_700_000_100_000, ...(filterDrivers ? { filterDrivers } : {}) });
  assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr.toString('utf8')}`);
  return r.stdout.toString('utf8');
}

test('seedRemote pushes main and gives the same oid for the same files in another root', async () => {
  const a = await makeTempRoot('peers-seed-a');
  const b = await makeTempRoot('peers-seed-b');
  try {
    const git = testRunner();
    const ra = await createBareRemote(a.root, git);
    const rb = await createBareRemote(b.root, git);
    const oidA = await seedRemote(ra, a.root, git, seedFiles());
    const oidB = await seedRemote(rb, b.root, git, seedFiles());
    assert.match(oidA, /^[0-9a-f]{40}$/);
    assert.equal(oidA, oidB);
    assert.deepEqual(await ra.refs(), { 'refs/heads/main': oidA });
    assert.equal(existsSync(join(a.root, 'seed')), false, 'the seed work repo is removed');
    const stored = await out(git, ['cat-file', 'blob', 'refs/heads/main:a.txt'], ra.dir);
    assert.equal(stored, 'x\ny\n');
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

// Under heavy parallel load a push to the local remote can fail while nothing lands, so seedRemote
// pushes through retryGit. The remote's pre-receive hook (rejectNext, Task 11) stands in for that.
test('seedRemote retries a push that landed nothing and lists every attempt when all three fail', async () => {
  const a = await makeTempRoot('peers-retry-a');
  const b = await makeTempRoot('peers-retry-b');
  try {
    const git = testRunner();
    const ra = await createBareRemote(a.root, git);
    await ra.rejectNext(2, 'transient-failed');
    const oid = await seedRemote(ra, a.root, git, seedFiles());
    assert.deepEqual(await ra.refs(), { 'refs/heads/main': oid });

    const rb = await createBareRemote(b.root, git);
    await rb.rejectNext(3, 'transient-failed');
    await assert.rejects(seedRemote(rb, b.root, git, seedFiles()), (e: Error) => {
      const lines = e.message.split('\n');
      assert.match(lines[0] ?? '', /^seedRemote: git push .+ HEAD:refs\/heads\/main: failed 3 of 3 attempts$/);
      assert.deepEqual(lines.slice(1).map((l) => /^ {2}attempt (\d): code=[1-9][0-9]* stderr: /.exec(l)?.[1]), ['1', '2', '3']);
      return true;
    });
    assert.deepEqual(await rb.refs(), {});
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

test('autocrlf=true peers get CRLF work files, autocrlf=false peers get LF', async () => {
  const { root, cleanup } = await makeTempRoot('peers-eol');
  try {
    const git = testRunner();
    const remote = await createBareRemote(root, git);
    await seedRemote(remote, root, git, seedFiles());
    const win = await clonePeer(remote, root, { name: 'win', autocrlf: true, withFilter: false }, git);
    const nix = await clonePeer(remote, root, { name: 'nix', autocrlf: false, withFilter: false }, git);
    assert.equal((await readFile(join(win.dir, 'a.txt'))).toString('utf8'), 'x\r\ny\r\n');
    assert.equal((await readFile(join(nix.dir, 'a.txt'))).toString('utf8'), 'x\ny\n');
    assert.ok(existsSync(join(nix.dir, 'src', '한글 dir', 'b.py')));
    assert.equal((await out(git, ['config', 'core.autocrlf'], win.dir)).trim(), 'true');
    assert.equal((await out(git, ['config', 'core.autocrlf'], nix.dir)).trim(), 'false');
    assert.equal((await out(git, ['status', '--porcelain'], win.dir)), '');
    assert.equal((await out(git, ['status', '--porcelain'], nix.dir)), '');
    // One root = one run = one canary, for every peer, filter or not.
    assert.match(win.canary, CANARY_SHAPE);
    assert.equal(win.canary, nix.canary);
  } finally {
    await cleanup();
  }
});

test('peers in another temp root (another run) get another canary', async () => {
  const a = await makeTempRoot('peers-run-a');
  const b = await makeTempRoot('peers-run-b');
  try {
    const git = testRunner();
    const ra = await createBareRemote(a.root, git);
    const rb = await createBareRemote(b.root, git);
    await seedRemote(ra, a.root, git, seedFiles());
    await seedRemote(rb, b.root, git, seedFiles());
    const pa = await clonePeer(ra, a.root, { name: 'p0', autocrlf: false, withFilter: false }, git);
    const pb = await clonePeer(rb, b.root, { name: 'p0', autocrlf: false, withFilter: false }, git);
    assert.match(pa.canary, CANARY_SHAPE);
    assert.match(pb.canary, CANARY_SHAPE);
    assert.notEqual(pa.canary, pb.canary);
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

test('the counting secret filter smudges the canary in and cleans exactly that string out before it reaches the remote', async () => {
  const { root, cleanup } = await makeTempRoot('peers-filter');
  try {
    const git = testRunner();
    const remote = await createBareRemote(root, git);
    await seedRemote(remote, root, git, seedFiles());
    const peer = await clonePeer(remote, root, { name: 'alice', autocrlf: true, withFilter: true }, git);
    const C = peer.canary;
    assert.match(C, CANARY_SHAPE);

    // Checkout ran the smudge filter once, with the path, and wrote this run's canary.
    assert.equal((await readFile(join(peer.dir, 'secret.txt'))).toString('utf8'), `token=${C}\r\n`);
    const afterCheckout = (await readFile(peer.filterCountFile, 'utf8')).split('\n').filter((l) => l.length > 0);
    assert.deepEqual(afterCheckout, ['smudge secret.txt']);

    // An edit is cleaned on add: more count lines, the canary becomes the placeholder,
    // and near misses (another run's canary, the dashed spelling, a truncated canary) pass through.
    const otherRun = canary('otherrun');
    const dashed = 'COWORK-CANARY-7f3a9c';
    const truncated = C.slice(0, -1);
    await appendFile(
      join(peer.dir, 'secret.txt'),
      Buffer.from(`second=${C}\r\nother=${otherRun}\r\ndashed=${dashed}\r\ntruncated=${truncated}\r\n`, 'utf8'),
    );
    await out(git, ['add', 'secret.txt'], peer.dir, ['secret']);
    const afterAdd = (await readFile(peer.filterCountFile, 'utf8')).split('\n').filter((l) => l.length > 0);
    assert.ok(afterAdd.length > afterCheckout.length);
    assert.ok(afterAdd.slice(afterCheckout.length).every((l) => l === 'clean secret.txt'), afterAdd.join('|'));
    const expectedStored = `token=@@SECRET@@\nsecond=@@SECRET@@\nother=${otherRun}\ndashed=${dashed}\ntruncated=${truncated}\n`;
    const staged = await out(git, ['cat-file', 'blob', ':secret.txt'], peer.dir);
    assert.equal(staged, expectedStored);

    await out(git, ['commit', '-q', '-m', 'edit secret'], peer.dir, ['secret']);
    const pushed = await git.run(['push', '-q', remote.url, 'HEAD:refs/cowork/main/code'], { class: 'network', cwd: peer.dir });
    assert.equal(pushed.code, 0, pushed.stderr.toString('utf8'));
    const atRemote = await out(git, ['cat-file', 'blob', 'refs/cowork/main/code:secret.txt'], remote.dir);
    assert.equal(atRemote.includes(C), false);
    assert.equal(atRemote, expectedStored);
  } finally {
    await cleanup();
  }
});

test('a peer without the filter sees the placeholder and has no count file', async () => {
  const { root, cleanup } = await makeTempRoot('peers-nofilter');
  try {
    const git = testRunner();
    const remote = await createBareRemote(root, git);
    await seedRemote(remote, root, git, seedFiles());
    const bob = await clonePeer(remote, root, { name: 'bob', autocrlf: false, withFilter: false }, git);
    assert.equal((await readFile(join(bob.dir, 'secret.txt'))).toString('utf8'), 'token=@@SECRET@@\n');
    assert.equal(existsSync(bob.filterCountFile), false);
    assert.deepEqual(bob.opts, { name: 'bob', autocrlf: false, withFilter: false });
    assert.equal(bob.name, 'bob');
    assert.match(bob.canary, CANARY_SHAPE);
  } finally {
    await cleanup();
  }
});

test('clonePeer refuses an existing peer directory and a bad name', async () => {
  const { root, cleanup } = await makeTempRoot('peers-twice');
  try {
    const git = testRunner();
    const remote = await createBareRemote(root, git);
    await seedRemote(remote, root, git, seedFiles());
    await clonePeer(remote, root, { name: 'p1', autocrlf: false, withFilter: false }, git);
    await assert.rejects(clonePeer(remote, root, { name: 'p1', autocrlf: false, withFilter: false }, git), /already exists/);
    await assert.rejects(clonePeer(remote, root, { name: '../x', autocrlf: false, withFilter: false }, git), /bad peer name/);
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 6: Run the new tests to verify they fail**

Run: `npx tsx --test test/unit/retryGit.test.ts test/unit/canary.test.ts test/integration/peers.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` in all three files: cannot find module `test/helpers/retryGit.js` in `retryGit.test.ts`, and `test/sim/peers.js` in the other two.

- [ ] **Step 7: Write the retry helper and the peer fixture**

Create `test/helpers/retryGit.ts`:

```ts
// Retry for the git network calls of test fixtures (seedRemote's push, clonePeer's clone, the
// NaiveEngine's fetch). Under heavy parallel load on Windows, a push to the local file:// remote
// was seen to exit 1 with an empty stderr while nothing landed. A non-zero exit is retried only
// while the remote shows that nothing landed; the error thrown at the end lists the exit code and
// stderr of every failed attempt.
import { setTimeout as delay } from 'node:timers/promises';

export interface GitAttempt { code: number; stderr: string; }

export class RetryGitError extends Error {
  constructor(message: string, readonly attempts: GitAttempt[]) {
    super(message);
    this.name = 'RetryGitError';
  }
}

export interface RetryGitOptions {
  /** Total number of attempts, at least 1. */
  attempts: number;
  /** Names the call in the error message. */
  label: string;
  /**
   * Asked after each failed attempt: true when the remote shows that nothing landed, so the
   * same call may run again. Omit it for calls that write nothing to the remote (fetch, clone).
   */
  nothingLanded?: () => Promise<boolean>;
  /** Real-time pause before a retry, default 200 ms. It never reaches an op-log or a commit. */
  pauseMs?: number;
}

function report(head: string, failed: GitAttempt[]): string {
  return [head, ...failed.map((a, i) => `  attempt ${i + 1}: code=${a.code} stderr: ${a.stderr === '' ? '(empty)' : a.stderr}`)].join('\n');
}

/** Runs `run` until it exits 0, at most `opts.attempts` times, and returns that result. */
export async function retryGit<R extends { code: number; stderr: Buffer }>(run: () => Promise<R>, opts: RetryGitOptions): Promise<R> {
  if (!Number.isInteger(opts.attempts) || opts.attempts < 1) {
    throw new RangeError(`retryGit: attempts must be a positive integer, got ${opts.attempts}`);
  }
  const failed: GitAttempt[] = [];
  for (;;) {
    const r = await run();
    if (r.code === 0) return r;
    failed.push({ code: r.code, stderr: r.stderr.toString('utf8').replace(/\s+/g, ' ').trim() });
    if (failed.length >= opts.attempts) {
      throw new RetryGitError(report(`${opts.label}: failed ${failed.length} of ${opts.attempts} attempts`, failed), failed);
    }
    if (opts.nothingLanded !== undefined && !(await opts.nothingLanded())) {
      throw new RetryGitError(report(`${opts.label}: attempt ${failed.length} failed and the remote changed, so it was not retried`, failed), failed);
    }
    await delay(opts.pauseMs ?? 200);
  }
}
```

Run: `npx tsx --test test/unit/retryGit.test.ts`
Expected: PASS (4 tests).

Create `test/sim/peers.ts`:

```ts
// Peer clones for the SIM harness (11-testing §3.3 setup steps 2 and 3):
// seed the remote's main branch, clone N peers with a Windows (autocrlf=true)
// or POSIX (autocrlf=false) profile, and optionally install the counting
// clean/smudge secret filter `secret` (11-testing §3.7 "secret filter"), which
// replaces exactly this run's canary `COWORK_CANARY_<run>` with a placeholder.
import { createHash } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { GitCallOptions } from '../../src/git/flags.js';
import type { GitRunner } from '../../src/git/runner.js';
import { retryGit } from '../helpers/retryGit.js';
import type { BareRemote } from './remote.js';

const PLACEHOLDER = '@@SECRET@@';
const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;
const SEED_IDENTITY = { name: 'Cowork Seed', email: 'seed@cowork.invalid' };
const SEED_WALL_MS = 1_700_000_000_000; // fixed commit date: same files -> same seed oid on every OS

/** The per-run canary (11-testing §2, §3.7). The run id must be a plain token. */
export function canary(runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new Error(`canary: bad run id ${JSON.stringify(runId)}`);
  return `COWORK_CANARY_${runId}`;
}

/**
 * clonePeer's signature carries no run id, so one temp root = one run:
 * the run id is the first 12 hex chars of sha256(resolved root). Every peer
 * under the same root shares the canary; another root gets another one.
 */
function runIdForRoot(root: string): string {
  return createHash('sha256').update(resolve(root), 'utf8').digest('hex').slice(0, 12);
}

export interface PeerOptions { name: string; autocrlf: boolean; withFilter: boolean; }
export interface PeerClone { name: string; dir: string; filterCountFile: string; opts: PeerOptions; canary: string; }

/** Single-quote for the sh command line git uses for filter drivers; forward slashes work on every OS. */
function shq(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
}

async function must(git: GitRunner, args: string[], cwd: string, extra: Partial<GitCallOptions> = {}): Promise<string> {
  const r = await git.run(args, { class: 'local', cwd, ...extra });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr.toString('utf8')}`);
  return r.stdout.toString('utf8');
}

async function exists(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null)) !== null;
}

/**
 * The filter driver script for one peer, with that peer's canary embedded: byte-preserving
 * replace of exactly the canary string (both values are ASCII, so the latin1 round trip is
 * exact), one count line per invocation. LF only.
 */
function filterJs(secret: string): string {
  return [
    "const fs = require('fs');",
    'const [mode, countFile, path] = process.argv.slice(2);',
    `const SECRET = ${JSON.stringify(secret)};`,
    `const PLACEHOLDER = ${JSON.stringify(PLACEHOLDER)};`,
    "const text = fs.readFileSync(0).toString('latin1');",
    "const out = mode === 'clean' ? text.split(SECRET).join(PLACEHOLDER) : text.split(PLACEHOLDER).join(SECRET);",
    "fs.appendFileSync(countFile, mode + ' ' + (path || '') + '\\n');",
    "process.stdout.write(Buffer.from(out, 'latin1'));",
    '',
  ].join('\n');
}

/**
 * Commits exactly `files` (POSIX relative paths -> bytes) as one commit and pushes
 * it to refs/heads/main. core.autocrlf is forced off in the seed repo, so the stored
 * bytes are exactly the given bytes (Git for Windows' system config defaults it on).
 */
export async function seedRemote(remote: BareRemote, root: string, git: GitRunner, files: Record<string, Buffer>): Promise<string> {
  const dir = join(root, 'seed');
  if (await exists(dir)) throw new Error(`seedRemote: ${dir} already exists`);
  await must(git, ['init', '-q', '-b', 'main', dir], root);
  await must(git, ['config', 'core.autocrlf', 'false'], dir);
  for (const rel of Object.keys(files).sort()) {
    const abs = join(dir, ...rel.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, files[rel]!);
  }
  await must(git, ['add', '-A'], dir);
  await must(git, ['commit', '-q', '--allow-empty', '-m', 'seed'], dir, { identity: SEED_IDENTITY, wallMsForDates: SEED_WALL_MS });
  const oid = (await must(git, ['rev-parse', 'HEAD'], dir)).trim();
  // Retried while the remote's main is still what it was before the push (nothing landed).
  const before = (await remote.refs())['refs/heads/main'];
  await retryGit(() => git.run(['push', '-q', remote.url, 'HEAD:refs/heads/main'], { class: 'network', cwd: dir }), {
    attempts: 3,
    label: `seedRemote: git push ${remote.url} HEAD:refs/heads/main`,
    nothingLanded: async () => (await remote.refs())['refs/heads/main'] === before,
  });
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  return oid;
}

export async function clonePeer(remote: BareRemote, root: string, opts: PeerOptions, git: GitRunner): Promise<PeerClone> {
  if (!/^[A-Za-z0-9_-]+$/.test(opts.name)) throw new Error(`clonePeer: bad peer name ${JSON.stringify(opts.name)}`);
  const dir = join(root, opts.name);
  if (await exists(dir)) throw new Error(`clonePeer: ${dir} already exists`);
  const peerCanary = canary(runIdForRoot(root));
  const cloneArgs = ['clone', '-q', '--no-checkout', '-c', `core.autocrlf=${opts.autocrlf ? 'true' : 'false'}`, remote.url, dir];
  // A clone writes nothing to the remote. A failed attempt may leave a partial directory, so every attempt starts without one.
  await retryGit(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    return git.run(cloneArgs, { class: 'network', cwd: root });
  }, { attempts: 3, label: `clonePeer: git clone into ${dir}` });

  const gitDir = join(dir, '.git');
  const filterCountFile = join(gitDir, 'cowork-filter-count.log');
  if (opts.withFilter) {
    const script = join(gitDir, 'cowork-secret-filter.js');
    const buf = Buffer.from(filterJs(peerCanary), 'utf8');
    if (buf.includes(0x0d)) throw new Error('filter script contains CR');
    await writeFile(script, buf);
    await must(git, ['config', 'filter.secret.clean', `node ${shq(script)} clean ${shq(filterCountFile)} %f`], dir);
    await must(git, ['config', 'filter.secret.smudge', `node ${shq(script)} smudge ${shq(filterCountFile)} %f`], dir);
  }
  // Populate the work tree only now, so the smudge filter (if any) runs on checkout.
  await must(git, ['checkout', '-q', 'main'], dir, opts.withFilter ? { filterDrivers: ['secret'] } : {});
  return { name: opts.name, dir, filterCountFile, opts: { ...opts }, canary: peerCanary };
}
```

- [ ] **Step 8: Run all four test files to verify they pass**

Run: `npx tsx --test test/unit/bigBomCrlf.test.ts test/unit/canary.test.ts test/unit/retryGit.test.ts test/integration/peers.test.ts`
Expected: PASS (5 + 3 + 4 unit tests, 7 integration tests).

The retry test in `peers.test.ts` is the one that fails without `retryGit`. To confirm, during development only, replace the `retryGit(...)` call in `seedRemote` by a single push that throws on failure, `await must(git, ['push', '-q', remote.url, 'HEAD:refs/heads/main'], dir, { class: 'network' });`. That test then fails while the other six pass. Restore the `retryGit` call afterwards.

- [ ] **Step 9: Commit**

```bash
git add test/helpers/retryGit.ts test/sim/fixtures/bigBomCrlf.ts test/sim/peers.ts test/unit/bigBomCrlf.test.ts test/unit/canary.test.ts test/unit/retryGit.test.ts test/integration/peers.test.ts
git commit -m "test(sim): seeded remote, peer clones with autocrlf profiles and counting secret filter; retryGit for fixture network calls

seedRemote commits exactly the given files with a fixed identity and date
(same files -> same oid on every OS); clonePeer clones with an explicit
core.autocrlf and optionally installs the counting clean/smudge filter
'secret' before the first checkout. The filter replaces exactly the run's
canary COWORK_CANARY_<run> (canary(runId); one temp root = one run, so
every peer of a run shares PeerClone.canary). generateBigBomCrlf produces the
deterministic BOM+CRLF Python fixture (26,436 lines ~ 1.3 MB).

seedRemote's push and clonePeer's clone go through retryGit (test/helpers):
up to 3 attempts, retried only while the remote shows nothing landed, and the
final error lists every attempt's exit code and stderr. Under parallel load a
push to the local remote exited 1 with an empty stderr and nothing landed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: SIM harness skeleton, INV-FF / INV-OID oracles, NaiveEngine and determinism

**Files:**
- Create: `test/sim/harness.ts`
- Create: `test/sim/oracles.ts`
- Create: `test/sim/naiveEngine.ts`
- Test: `test/integration/sim.harness.test.ts`
- Test: `test/integration/sim.oracles.test.ts`
- Test: `test/integration/sim.naive.test.ts`

**Interfaces:**
- Consumes:
  - `seededRandom(seed: string): Random`, `randomInt(r: Random, maxExclusive: number): number`, `type Random` (Task 3, `src/ports/random.ts`)
  - `realFs: Fs` with `mkdirp`, `writeFile(p, Buffer)` and `readdir(p)` sorted by UTF-16 code unit (Task 4, `src/ports/fs.ts`; used by the readdir determinism test)
  - `SIM_WALL_EPOCH_MS` and `class VirtualClock` with `constructor(opts?: { wallOffsetMs?: number; startMono?: number; driftPpm?: number })`, `wallMs()`, `advance(ms)` (Task 2, `test/sim/vclock.ts`). `wallOffsetMs` is an offset from `SIM_WALL_EPOCH_MS`; the harness never adds the epoch itself.
  - `class VirtualScheduler` with `constructor(clock: VirtualClock, random: Random)`, `readonly random: Random`, `yieldPoint(name)`, `onYield`, `runUntilIdle(maxSteps: number): Promise<number>`, `pending(): number` (Task 5, `test/sim/vscheduler.ts`)
  - `type GitClass`, `interface GitCallOptions` (fields `class`, `cwd`, `identity`, `wallMsForDates`, `stdin`) (Task 8, `src/git/flags.ts`)
  - `interface GitRunner { run(args: string[], opts: GitCallOptions): Promise<GitResult> }` (Task 9, `src/git/runner.ts`); `makeTempRoot(label)`, `testRunner(clock?)` (Task 9, `test/helpers/tmp.ts`)
  - `createBareRemote(root, git, defaultBranch?): Promise<BareRemote>` with `dir`, `url`, `rejectNext(n, kind, refSubstring?)` (the NaiveEngine retry test arms it with `'transient-failed'`), `readRemoteLog()`, `readRefTxLog()`, `refs()`, and its file layout `<root>/remote-log.jsonl`, `<root>/reftx-log.jsonl` (Task 11, `test/sim/remote.ts`)
  - `seedRemote(remote, root, git, files): Promise<string>` (fixed identity and date), `clonePeer(remote, root, opts, git): Promise<PeerClone>`, `type PeerClone` (Task 12, `test/sim/peers.ts`)
  - `retryGit(run, { attempts, label, nothingLanded?, pauseMs? })` (Task 12, `test/helpers/retryGit.ts`): the NaiveEngine's fetch goes through it
- Produces (as in 00-header.md, plus one optional field):
  - `test/sim/harness.ts`: `SeedTuple`, `OpLogEntry`, `SimContext`, `SimEngine`, `EngineFactory`, `Oracle`, `runSim(t: SeedTuple, makeEngine: EngineFactory, oracles: Oracle[]): Promise<SimResult>`, and `SimResult` **with the added optional field `artifactsDir?: string`**. The field is set only when `ok` is false. It is the only interface addition in this task, and 00-header's `SimResult` already lists it.
  - `test/sim/oracles.ts`: `oracleFF(refPrefix: string): Oracle` (name `'INV-FF'`), `oracleOID(allowedDeletePrefixes: string[]): Oracle` (name `'INV-OID'`)
  - `test/sim/naiveEngine.ts`: `naiveEngine(opts?: { forcePush?: boolean }): EngineFactory`.
    - The engine calls `ctx.scheduler.yieldPoint('naive.beforePush')` between its commit and its first push.
    - A rejected leased push is retried in the same step. The engine re-fetches and compares the remote tip of `refs/cowork/main/code` with its lease. If the tip is unchanged, nothing landed (a transient rejection): it pushes the same commit again, at most 2 more times. If the tip moved, the lease was lost: it rebuilds the commit once on the new tip and pushes that. Each retry first awaits `ctx.scheduler.yieldPoint('naive.retry')`.
    - The `forcePush` mutant pushes once and never retries.
    - Op-log entries: `{ kind: 'commit', detail: '<oid> wall=<ms>' }` for every commit, a rebuilt one included, and one `{ kind: 'push', detail: 'ok <oid>' | 'rejected <oid> code=<n> <git output, paths masked>' }` per push attempt. A step's last push entry is its outcome: `ok <oid>`, or a final `rejected …`.
    - Consumers (Task 15) match only the `ok ` / `rejected ` prefix. A step has landed when any of its push entries starts with `ok `.

**Harness contract (what later plans rely on):**
- Each run gets its own temp root (`makeTempRoot('sim')`, so the root contains `공 백 dir`). When a run ends with `ok: true`, `runSim` removes the root before it returns.
- **On failure, the artifacts are kept (11-testing §3.3 Failure).**
  - When an oracle fails, `runSim` writes `<root>/artifacts/` and does **not** delete the temp root. `SimResult.artifactsDir` points to that directory.
  - The directory holds:
    - `op-log.jsonl`: one `OpLogEntry` per line, in order;
    - `remote-log.jsonl` and `reftx-log.jsonl`: copies of the Task 11 hook logs, empty if the hook never ran;
    - `remote.bundle`: `git bundle create --all` of the bare remote. If git refuses, `remote.bundle.err.txt` is written instead.
  - The peer clones stay in place under the kept root.
  - When an engine, a fixture or the scheduler check throws, `runSim` writes as many of the same artifacts as it can, keeps the root, and rejects with `runSim(<seed>): <message>; artifacts kept in <dir>`. The original error is the `cause`.
  - The caller deletes a kept root. It is `dirname(dirname(artifactsDir))`, the `mkdtemp` directory above `공 백 dir`.
  - Bundles of every peer, the trace and shrinking (TST-09) arrive with Plan 2's real engine.
- Layout under the root:
  - the bare remote from `createBareRemote(root, git, 'main')`;
  - `main`, seeded by `seedRemote` with `README.md` and `notes.txt` (`"seed\n"`);
  - peers `p0 … p{N-1}` from `clonePeer`. Odd-numbered peers use `autocrlf: true` (the Windows checkout profile). In Plan 1 every peer uses `withFilter: false`.
- Randomness:
  - `ctx.random = seededRandom(seed + '/sim')` is drawn in this fixed order:
    1. For each peer, in index order and right after its clone: the wall skew (`randomInt` over −600…+600 s, in whole seconds), then the drift (`randomInt` over −100…+100 ppm).
    2. For each step: the peer pick (`randomInt(random, peers)`), then the time delta (1 000–5 000 ms).
  - The shared `VirtualScheduler` gets `seededRandom(seed + '/scheduler')`. `onYield` handlers reach it as `ctx.scheduler.random`.
  - Changing this order changes every seeded pick sequence, including the recorded mutant seed below.
- Time:
  - Every peer has its own `VirtualClock({ wallOffsetMs: skewMs, driftPpm })`. `wallOffsetMs` is an offset from `SIM_WALL_EPOCH_MS` (2026-01-01T00:00:00Z), never an absolute time.
  - The scheduler's clock is `new VirtualClock()`.
  - Each step advances every peer clock and the scheduler's clock by the same delta.
- Identity and dates:
  - `ctx.git` is a plain `testRunner()`. The harness fills in nothing.
  - Every call that creates a commit, and every ref update that writes a reflog, must pass `identity` and `wallMsForDates` set to that peer's `clock.wallMs()`.
  - There is deliberately no default date. A commit made without one gets the real time, so the determinism test fails, instead of the commit silently landing at the epoch.
  - A missing identity fails loudly on CI runners, which have no `user.name`.
- Step `s`:
  1. The harness appends `{ step: s, peer, kind: 'step', detail: 'dt=<ms>' }` **before** it calls `engine.step(ctx)`. Engines read their step number from the last op-log entry.
  2. It drains the scheduler with `runUntilIdle(10000)`. Tasks still pending after that make it throw.
  3. It runs every `afterEveryOp` oracle in order. The first non-null message stops the run with `failure = { oracle, message, step: s }`.
- If `ops` steps finish with no failure, every `atQuiescence` oracle runs once. A failure there has `step = ops`.
- `runSim` reads `remoteRefs = await remote.refs()` just before it returns, on success and on failure.

**Determinism (Review Focus 5): exactly what is pinned, and the test for each:**

| Source of nondeterminism | How it is pinned | Test |
|---|---|---|
| Peer picks, step deltas, clock skews and drifts | Drawn only from `seededRandom(seed + '/sim')`, in a fixed order | `runSim peer picks, clock skews and virtual time come only from the seed`: the same seed gives the same op-log, a different seed gives a different one |
| Commit timestamps | Engine commits pass `wallMsForDates` = the peer's `VirtualClock.wallMs()`. The seed commit uses Task 12's fixed date. There is no default date. | `determinism: …` runs the same seed twice, in two temp roots, with 1.1 s of real time between the runs (git dates have 1 s resolution). Its `VIRTUAL-DATES` quiescence oracle checks that each landed commit's `%ct` equals `floor(wall / 1000)` for the virtual wall its engine logged, and that this falls inside the SIM window. |
| Commit identities | Every commit and every reflog write passes an explicit `identity` | The same identical-oid assertion |
| Directory listing order | Engines list directories only through `realFs.readdir`, which sorts by UTF-16 code unit (Task 4). `seedRemote` writes files in sorted key order (Task 12), and git sorts tree entries itself, so the order files were created in never reaches an oid. | `directory listings in a run come from the sorted Fs readdir, not from creation order`: files created in forward and in reverse order give identical op-logs, and the listing is `C.txt\|a b.txt\|a.txt\|b.txt\|한.txt` |
| Virtual-clock origin | `wallOffsetMs` is only an offset | `peer clocks read SIM_WALL_EPOCH_MS + skew …`. Passing `SIM_WALL_EPOCH_MS + skew` puts the wall in 2082 and fails this test. |
| Real wall clock, timer resolution, `GitResult.durationMs`, temp root path | Nothing that writes the op-log or a commit reads them. The one op-log entry that quotes git output, a rejected push, masks the remote URL, the remote directory and the temp root as `<remote>` / `<root>` (Step 13). | The identical-op-log assertions of both determinism tests (each uses two different temp roots) |
| Push retries | The NaiveEngine's retry path draws from no `Random` (`yieldPoint` draws nothing either), so a run without a rejection logs exactly one push per step, the same op-log as an engine without retries. A transient rejection (for example under heavy parallel load) adds `rejected` attempts to the op-log, so the same-seed equality is pinned for runs without one. | `a transient rejection is retried …` (attempts and `naive.retry` yields are exact); the `determinism: …` test |

- [ ] **Step 1: Write the failing harness tests**

`test/integration/sim.harness.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { realFs } from '../../src/ports/fs.js';
import { testRunner } from '../helpers/tmp.js';
import type { EngineFactory, Oracle, SimContext, SimResult } from '../sim/harness.js';
import { runSim } from '../sim/harness.js';
import { SIM_WALL_EPOCH_MS } from '../sim/vclock.js';

/** A failed run keeps its temp root; artifactsDir is <mkdtemp base>/공 백 dir/artifacts. */
async function dropArtifacts(dir: string | undefined): Promise<void> {
  if (dir === undefined) return;
  await rm(dirname(dirname(dir)), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** An engine that only records which peer ran and that peer's virtual wall clock. */
const recorder: EngineFactory = (_ctx, peer) => ({
  peer,
  async step(ctx: SimContext): Promise<void> {
    const step = ctx.opLog[ctx.opLog.length - 1]?.step ?? -1;
    ctx.opLog.push({ step, peer: peer.name, kind: 'noop', detail: `wall=${ctx.clocks.get(peer.name)?.wallMs()}` });
  },
});

test('runSim builds the remote and N peers, seeds main and runs exactly ops steps', async () => {
  const seen: SimContext[] = [];
  const probe: Oracle = {
    name: 'probe',
    async afterEveryOp(ctx) { seen.push(ctx); return null; },
  };
  const r = await runSim({ seed: 'harness-basic', peers: 3, ops: 6 }, recorder, [probe]);
  assert.equal(r.ok, true);
  assert.equal(r.failure, undefined);
  assert.equal(r.artifactsDir, undefined);
  assert.equal(seen.length, 6);
  const ctx = seen[0] as SimContext;
  assert.deepEqual(ctx.peers.map((p) => p.name), ['p0', 'p1', 'p2']);
  assert.deepEqual(ctx.peers.map((p) => p.opts.autocrlf), [false, true, false]);
  assert.deepEqual([...ctx.clocks.keys()], ['p0', 'p1', 'p2']);
  assert.match(ctx.root, /공 백 dir/);
  assert.equal(existsSync(ctx.root), false, 'a passing run removes its temp root');
  assert.deepEqual(r.opLog.filter((e) => e.kind === 'step').map((e) => e.step), [0, 1, 2, 3, 4, 5]);
  assert.equal(r.opLog.filter((e) => e.kind === 'noop').length, 6);
  assert.match(r.remoteRefs['refs/heads/main'] ?? '', /^[0-9a-f]{40,64}$/);
});

test('peer clocks read SIM_WALL_EPOCH_MS + skew (|skew| <= 600 s) + elapsed virtual time ± drift (<= 100 ppm)', async () => {
  const r = await runSim({ seed: 'harness-clock', peers: 4, ops: 8 }, recorder, []);
  assert.equal(r.ok, true);
  let elapsed = 0;
  for (const e of r.opLog) {
    if (e.kind === 'step') elapsed += Number(e.detail.slice('dt='.length));
    if (e.kind !== 'noop') continue;
    // A wallOffsetMs of SIM_WALL_EPOCH_MS + skew would add the epoch twice (year 2082) and fail here.
    const residual = Number(e.detail.slice('wall='.length)) - SIM_WALL_EPOCH_MS - elapsed;
    assert.ok(Math.abs(residual) <= 600_000 + Math.ceil((elapsed * 100) / 1e6), `${e.peer} residual ${residual}`);
  }
});

test('runSim stops at the first afterEveryOp violation, reports its step and keeps the artifacts', async () => {
  let quiescenceCalls = 0;
  const failAtStep2: Oracle = {
    name: 'PLANTED',
    async afterEveryOp(ctx) {
      const last = ctx.opLog[ctx.opLog.length - 1];
      return last !== undefined && last.step === 2 ? 'planted violation' : null;
    },
    async atQuiescence() { quiescenceCalls++; return null; },
  };
  const r = await runSim({ seed: 'harness-stop', peers: 2, ops: 10 }, recorder, [failAtStep2]);
  try {
    assert.equal(r.ok, false);
    assert.deepEqual(r.failure, { oracle: 'PLANTED', message: 'planted violation', step: 2 });
    assert.equal(Math.max(...r.opLog.map((e) => e.step)), 2);
    assert.equal(quiescenceCalls, 0);

    // 11-testing §3.3 Failure: op-log, remote log and a bundle of the remote survive the run.
    const dir = r.artifactsDir ?? assert.fail('no artifactsDir on a failed run');
    assert.match(dir, /공 백 dir[\\/]artifacts$/);
    const lines = (await readFile(join(dir, 'op-log.jsonl'), 'utf8')).split('\n').filter((l) => l !== '');
    assert.deepEqual(lines.map((l) => JSON.parse(l) as unknown), r.opLog);
    assert.ok(existsSync(join(dir, 'remote-log.jsonl')));
    assert.ok(existsSync(join(dir, 'reftx-log.jsonl')));
    const heads = await testRunner().run(['bundle', 'list-heads', join(dir, 'remote.bundle')], { class: 'local', cwd: dir });
    assert.equal(heads.code, 0, heads.stderr.toString('utf8'));
    assert.match(heads.stdout.toString('utf8'), new RegExp(`^${r.remoteRefs['refs/heads/main']} refs/heads/main$`, 'm'));
  } finally {
    await dropArtifacts(r.artifactsDir);
  }
});

test('runSim runs atQuiescence once after the budget, with step = ops', async () => {
  let calls = 0;
  const atEnd: Oracle = {
    name: 'END',
    async atQuiescence(ctx) { calls++; return ctx.opLog.length === 8 ? 'quiescence reached' : null; },
  };
  const r = await runSim({ seed: 'harness-quiet', peers: 2, ops: 4 }, recorder, [atEnd]);
  try {
    assert.equal(calls, 1);
    assert.deepEqual(r.failure, { oracle: 'END', message: 'quiescence reached', step: 4 });
    assert.ok(r.artifactsDir !== undefined && existsSync(join(r.artifactsDir, 'op-log.jsonl')));
  } finally {
    await dropArtifacts(r.artifactsDir);
  }
});

test('an engine that throws rejects runSim and the message names the kept artifacts', async () => {
  const thrower: EngineFactory = (_ctx, peer) => ({
    peer,
    async step(ctx) { if (ctx.opLog.length >= 3) throw new Error('engine exploded'); },
  });
  let dir: string | undefined;
  await assert.rejects(runSim({ seed: 'harness-throw', peers: 1, ops: 5 }, thrower, []), (e: Error) => {
    assert.match(e.message, /^runSim\(harness-throw\): engine exploded; artifacts kept in /);
    dir = e.message.slice(e.message.indexOf('artifacts kept in ') + 'artifacts kept in '.length);
    return true;
  });
  try {
    assert.ok(dir !== undefined && existsSync(join(dir, 'op-log.jsonl')) && existsSync(join(dir, 'remote.bundle')));
  } finally {
    await dropArtifacts(dir);
  }
});

test('runSim peer picks, clock skews and virtual time come only from the seed', async () => {
  const a = await runSim({ seed: 'harness-det', peers: 4, ops: 12 }, recorder, []);
  const b = await runSim({ seed: 'harness-det', peers: 4, ops: 12 }, recorder, []);
  const c = await runSim({ seed: 'harness-det-other', peers: 4, ops: 12 }, recorder, []);
  assert.deepEqual(a.opLog, b.opLog);
  assert.deepEqual(a.remoteRefs, b.remoteRefs);
  assert.notDeepEqual(a.opLog, c.opLog);
});

// Determinism pin (Review Focus 5): file-creation order must not reach the op-log. Engines list
// directories through the Fs port, whose readdir is sorted by code unit (Task 4).
test('directory listings in a run come from the sorted Fs readdir, not from creation order', async () => {
  const NAMES = ['b.txt', '한.txt', 'a.txt', 'C.txt', 'a b.txt'];
  const lister = (order: 'forward' | 'reverse'): EngineFactory => (_ctx, peer) => ({
    peer,
    async step(ctx) {
      const step = ctx.opLog[ctx.opLog.length - 1]?.step ?? -1;
      const dir = join(ctx.root, 'listing', `${peer.name}-${step}`);
      await realFs.mkdirp(dir);
      for (const n of order === 'forward' ? NAMES : [...NAMES].reverse()) await realFs.writeFile(join(dir, n), Buffer.from(n, 'utf8'));
      ctx.opLog.push({ step, peer: peer.name, kind: 'list', detail: (await realFs.readdir(dir)).join('|') });
    },
  });
  const t = { seed: 'harness-readdir', peers: 2, ops: 4 };
  const a: SimResult = await runSim(t, lister('forward'), []);
  const b: SimResult = await runSim(t, lister('reverse'), []);
  assert.deepEqual(a.opLog, b.opLog);
  const listed = a.opLog.filter((e) => e.kind === 'list').map((e) => e.detail);
  assert.equal(listed.length, 4);
  assert.ok(listed.every((d) => d === 'C.txt|a b.txt|a.txt|b.txt|한.txt'), listed.join(' / '));
});
```

- [ ] **Step 2: Run the harness tests to verify they fail**

Run: `npx tsx --test test/integration/sim.harness.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `test/sim/harness.js`.

- [ ] **Step 3: Write the harness**

`test/sim/harness.ts`:

```ts
// Deterministic multi-peer SIM loop (11-testing §3.3, Plan 1 skeleton).
// Same SeedTuple => same op-log and same remote ref oids (TST-03). What makes that true is pinned
// here and in the fixtures, not hoped for:
// - every random choice comes from seededRandom(seed + '/sim') or seededRandom(seed + '/scheduler');
// - every commit carries an explicit identity and a date from a VirtualClock (engines pass
//   GitCallOptions.wallMsForDates = clock.wallMs()); the seed commit uses Task 12's fixed date;
// - directory listings go through the Fs port, whose readdir is sorted by code unit (Task 4), and
//   git sorts tree entries itself, so file-creation order never reaches an oid;
// - nothing that reaches the op-log reads the real clock, timer resolution, GitResult.durationMs or
//   the temp root path.
// On a failure the temp root is kept and <root>/artifacts holds op-log.jsonl, copies of the remote
// logs and a bundle of the remote (11-testing §3.3 Failure).
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitRunner } from '../../src/git/runner.js';
import { randomInt, seededRandom, type Random } from '../../src/ports/random.js';
import { makeTempRoot, testRunner } from '../helpers/tmp.js';
import { clonePeer, seedRemote, type PeerClone } from './peers.js';
import { createBareRemote, type BareRemote } from './remote.js';
import { VirtualClock } from './vclock.js';
import { VirtualScheduler } from './vscheduler.js';

export interface SeedTuple { seed: string; peers: number; ops: number; }
export interface OpLogEntry { step: number; peer: string; kind: string; detail: string; }
export interface SimContext {
  root: string; remote: BareRemote; peers: PeerClone[]; git: GitRunner; random: Random;
  clocks: Map<string, VirtualClock>; scheduler: VirtualScheduler; opLog: OpLogEntry[];
}
export interface SimEngine { readonly peer: PeerClone; step(ctx: SimContext): Promise<void>; }
export type EngineFactory = (ctx: SimContext, peer: PeerClone) => SimEngine;
export interface Oracle {
  name: string;
  afterEveryOp?(ctx: SimContext): Promise<string | null>;
  atQuiescence?(ctx: SimContext): Promise<string | null>;
}
export interface SimResult {
  ok: boolean;
  failure?: { oracle: string; message: string; step: number };
  opLog: OpLogEntry[];
  remoteRefs: Record<string, string>;
  /** Set only when ok is false: <root>/artifacts; the temp root is kept and the caller removes it. */
  artifactsDir?: string;
}

/** Peer wall offsets are drawn from ±600 s and drifts from ±100 ppm (11-testing §3.2 Clock SIM binding, F-PEER-4). */
const MAX_SKEW_S = 600;
const MAX_DRIFT_PPM = 100;
/** Each step advances virtual time by 1–5 s. */
const STEP_MIN_MS = 1_000;
const STEP_SPREAD_MS = 4_000;
/** Scheduler tasks drained after each step; more means an engine reschedules itself forever. */
const MAX_TASKS_PER_STEP = 10_000;
const SEED_FILES: Record<string, Buffer> = {
  'README.md': Buffer.from('cowork-sync SIM fixture\n', 'utf8'),
  'notes.txt': Buffer.from('seed\n', 'utf8'),
};

async function firstFailure(
  oracles: Oracle[],
  phase: 'afterEveryOp' | 'atQuiescence',
  ctx: SimContext,
  step: number,
): Promise<SimResult['failure'] | undefined> {
  for (const o of oracles) {
    const check = o[phase];
    if (check === undefined) continue;
    const message = await check.call(o, ctx);
    if (message !== null) return { oracle: o.name, message, step };
  }
  return undefined;
}

async function copyOrEmpty(from: string, to: string): Promise<void> {
  try {
    await copyFile(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    await writeFile(to, Buffer.alloc(0));
  }
}

/**
 * Writes <root>/artifacts: op-log.jsonl, remote-log.jsonl and reftx-log.jsonl (copies of the
 * Task 11 hook logs, empty when the hook never ran) and remote.bundle (`git bundle create --all`
 * of the bare remote; remote.bundle.err.txt instead when git refuses, e.g. for an empty remote).
 */
async function keepArtifacts(root: string, git: GitRunner, remote: BareRemote | undefined, opLog: OpLogEntry[]): Promise<string> {
  const dir = join(root, 'artifacts');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'op-log.jsonl'), Buffer.from(opLog.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8'));
  await copyOrEmpty(join(root, 'remote-log.jsonl'), join(dir, 'remote-log.jsonl'));
  await copyOrEmpty(join(root, 'reftx-log.jsonl'), join(dir, 'reftx-log.jsonl'));
  if (remote !== undefined) {
    const b = await git.run(['bundle', 'create', '-q', join(dir, 'remote.bundle'), '--all'], { class: 'local', cwd: remote.dir });
    if (b.code !== 0) await writeFile(join(dir, 'remote.bundle.err.txt'), b.stderr);
  }
  return dir;
}

export async function runSim(t: SeedTuple, makeEngine: EngineFactory, oracles: Oracle[]): Promise<SimResult> {
  if (!Number.isInteger(t.peers) || t.peers < 1) throw new Error(`runSim: peers must be a positive integer, got ${t.peers}`);
  if (!Number.isInteger(t.ops) || t.ops < 0) throw new Error(`runSim: ops must be a non-negative integer, got ${t.ops}`);
  const { root, cleanup } = await makeTempRoot('sim');
  const git = testRunner();
  const opLog: OpLogEntry[] = [];
  let remote: BareRemote | undefined;
  let keep = false;
  try {
    const random = seededRandom(`${t.seed}/sim`);
    const schedClock = new VirtualClock();
    const scheduler = new VirtualScheduler(schedClock, seededRandom(`${t.seed}/scheduler`));

    remote = await createBareRemote(root, git, 'main');
    await seedRemote(remote, root, git, SEED_FILES);

    const peers: PeerClone[] = [];
    const clocks = new Map<string, VirtualClock>();
    for (let i = 0; i < t.peers; i++) {
      const name = `p${i}`;
      // Odd peers use the Windows checkout profile (core.autocrlf=true), 11-testing §3.3 setup 3.
      peers.push(await clonePeer(remote, root, { name, autocrlf: i % 2 === 1, withFilter: false }, git));
      // wallOffsetMs is an offset from SIM_WALL_EPOCH_MS (VirtualClock adds the epoch itself).
      const skewMs = (randomInt(random, 2 * MAX_SKEW_S + 1) - MAX_SKEW_S) * 1000;
      const driftPpm = randomInt(random, 2 * MAX_DRIFT_PPM + 1) - MAX_DRIFT_PPM;
      clocks.set(name, new VirtualClock({ wallOffsetMs: skewMs, driftPpm }));
    }

    const ctx: SimContext = { root, remote, peers, git, random, clocks, scheduler, opLog };
    const engines = peers.map((p) => makeEngine(ctx, p));

    let failure: SimResult['failure'] | undefined;
    for (let step = 0; step < t.ops && failure === undefined; step++) {
      const i = randomInt(random, engines.length);
      const engine = engines[i] as SimEngine;
      const dt = STEP_MIN_MS + randomInt(random, STEP_SPREAD_MS + 1);
      for (const c of clocks.values()) c.advance(dt);
      schedClock.advance(dt);
      // The 'step' entry comes first so the engine can read its step number from the op-log tail.
      opLog.push({ step, peer: engine.peer.name, kind: 'step', detail: `dt=${dt}` });
      await engine.step(ctx);
      await scheduler.runUntilIdle(MAX_TASKS_PER_STEP);
      if (scheduler.pending() > 0) throw new Error(`scheduler still has ${scheduler.pending()} tasks after step ${step}`);
      failure = await firstFailure(oracles, 'afterEveryOp', ctx, step);
    }
    if (failure === undefined) failure = await firstFailure(oracles, 'atQuiescence', ctx, t.ops);

    const remoteRefs = await remote.refs();
    if (failure === undefined) return { ok: true, opLog, remoteRefs };
    keep = true;
    const artifactsDir = await keepArtifacts(root, git, remote, opLog);
    return { ok: false, failure, opLog, remoteRefs, artifactsDir };
  } catch (e) {
    // A thrown engine/fixture error is a failure too: keep the root and say where it is.
    keep = true;
    const where = await keepArtifacts(root, git, remote, opLog).catch(() => root);
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`runSim(${t.seed}): ${message}; artifacts kept in ${where}`, { cause: e });
  } finally {
    if (!keep) await cleanup();
  }
}
```

- [ ] **Step 4: Run the harness tests to verify they pass**

Run: `npx tsx --test test/integration/sim.harness.test.ts`
Expected: PASS: 7 tests, 0 failures (about 9 s on Windows).

If `remoteRefs['refs/heads/main']` differs between the two `harness-det` runs, a Task 11 or Task 12 fixture made a commit whose date or identity did not come through `GitCallOptions` (for example, a raw `GIT_AUTHOR_DATE` in `extraEnv`). Fix it in that fixture, not here.

Negative check during development (do not commit). Make two changes in `test/sim/harness.ts`:
1. Change the import to `import { SIM_WALL_EPOCH_MS, VirtualClock } from './vclock.js';`. Without it, all 7 tests fail with a `ReferenceError` instead of the one assertion.
2. Change the peer clock to `new VirtualClock({ wallOffsetMs: SIM_WALL_EPOCH_MS + skewMs, driftPpm })`.

Run: `npx tsx --test test/integration/sim.harness.test.ts`
Expected: 7 tests, 6 pass, 1 fail. The failing test is `peer clocks read SIM_WALL_EPOCH_MS + skew …`, with `AssertionError [ERR_ASSERTION]: p<n> residual 17672…` (the epoch counted twice, about 1.767e12 ms). Then revert both lines by hand to the Step 3 code. `git checkout` cannot do it, because `harness.ts` is first committed in Step 5. This was verified on Windows 11 / Git 2.55 / Node 24.

- [ ] **Step 5: Commit**

```bash
git add test/sim/harness.ts test/integration/sim.harness.test.ts
git commit -m "test(sim): deterministic multi-peer SIM harness skeleton (runSim, op-log, oracle phases, failure artifacts)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Write the failing oracle tests**

Each test drives the remote with a scripted engine that plants exactly one kind of ref update. This shows that each oracle fires on its own planted violation and passes on the legal form.

- INV-FF checks only `<prefix><branch>/board` and `<prefix><branch>/code` (11-testing §3.4). Probe refs and refs with other names can be rewritten or deleted without failing it.
- INV-OID allows deletions only under the probe prefixes of both namespaces (glossary §4).
- Every failing run keeps its temp root, so each test removes it with `dropArtifacts`.

`test/integration/sim.oracles.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EngineFactory, SimContext } from '../sim/harness.js';
import { runSim } from '../sim/harness.js';
import { oracleFF, oracleOID } from '../sim/oracles.js';
import type { PeerClone } from '../sim/peers.js';

const PROBES = ['refs/cowork/probe-', 'refs/heads/cowork/probe-'];

/** A failed run keeps its temp root; artifactsDir is <mkdtemp base>/공 백 dir/artifacts. */
async function dropArtifacts(dir: string | undefined): Promise<void> {
  if (dir === undefined) return;
  await rm(dirname(dirname(dir)), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function gitOk(ctx: SimContext, peer: PeerClone, args: string[]): Promise<string> {
  const r = await ctx.git.run(args, {
    class: args[0] === 'push' || args[0] === 'fetch' ? 'network' : 'local',
    cwd: peer.dir,
    identity: { name: peer.name, email: `${peer.name}@cowork.invalid` },
    wallMsForDates: ctx.clocks.get(peer.name)?.wallMs(),
  });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString('utf8')}`);
  return r.stdout.toString('utf8').trim();
}

/** A new commit on top of the remote's main (same tree, message names the step). */
async function commitOnMain(ctx: SimContext, peer: PeerClone, step: number): Promise<string> {
  await gitOk(ctx, peer, ['fetch', '--no-tags', ctx.remote.url, '+refs/heads/main:refs/cowork-remote/main/branch']);
  const main = await gitOk(ctx, peer, ['rev-parse', 'refs/cowork-remote/main/branch']);
  return gitOk(ctx, peer, ['commit-tree', `${main}^{tree}`, '-p', main, '-m', `planted ${step}`]);
}

/** Runs `plan(step)` with whichever peer the harness picked. */
function scripted(plan: (ctx: SimContext, peer: PeerClone, step: number) => Promise<void>): EngineFactory {
  return (_ctx, peer) => ({
    peer,
    async step(ctx) { await plan(ctx, peer, ctx.opLog[ctx.opLog.length - 1]?.step ?? -1); },
  });
}

test('INV-FF passes for a creation followed by a fast-forward', async () => {
  const engine = scripted(async (ctx, peer, step) => {
    const c = await commitOnMain(ctx, peer, step);
    if (step === 0) await gitOk(ctx, peer, ['push', ctx.remote.url, `${c}:refs/cowork/main/code`]);
    if (step === 1) {
      await gitOk(ctx, peer, ['fetch', '--no-tags', ctx.remote.url, '+refs/cowork/main/code:refs/cowork-remote/main/code']);
      const tip = await gitOk(ctx, peer, ['rev-parse', 'refs/cowork-remote/main/code']);
      const child = await gitOk(ctx, peer, ['commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'child']);
      await gitOk(ctx, peer, ['push', ctx.remote.url, `${child}:refs/cowork/main/code`]);
    }
  });
  const r = await runSim({ seed: 'ff-pass', peers: 2, ops: 2 }, engine, [oracleFF('refs/cowork/')]);
  await dropArtifacts(r.artifactsDir);
  assert.equal(r.ok, true, r.failure?.message);
});

test('INV-FF fails on a non-fast-forward rewrite of refs/cowork/<branch>/code', async () => {
  const engine = scripted(async (ctx, peer, step) => {
    const c = await commitOnMain(ctx, peer, step);
    await gitOk(ctx, peer, ['push', ctx.remote.url, `+${c}:refs/cowork/main/code`]);
  });
  const r = await runSim({ seed: 'ff-fail', peers: 2, ops: 3 }, engine, [oracleFF('refs/cowork/')]);
  await dropArtifacts(r.artifactsDir);
  assert.equal(r.ok, false);
  assert.equal(r.failure?.oracle, 'INV-FF');
  assert.equal(r.failure?.step, 1);
  assert.match(r.failure?.message ?? '', /refs\/cowork\/main\/code moved [0-9a-f]+ -> [0-9a-f]+/);
});

test('INV-FF fails on a deletion of refs/cowork/<branch>/board', async () => {
  const engine = scripted(async (ctx, peer, step) => {
    if (step === 0) await gitOk(ctx, peer, ['push', ctx.remote.url, `${await commitOnMain(ctx, peer, step)}:refs/cowork/main/board`]);
    if (step === 1) await gitOk(ctx, peer, ['push', ctx.remote.url, ':refs/cowork/main/board']);
  });
  const r = await runSim({ seed: 'ff-delete', peers: 2, ops: 2 }, engine, [oracleFF('refs/cowork/')]);
  await dropArtifacts(r.artifactsDir);
  assert.deepEqual([r.failure?.oracle, r.failure?.step], ['INV-FF', 1]);
  assert.match(r.failure?.message ?? '', /^refs\/cowork\/main\/board deleted/);
});

test('INV-FF checks only <prefix><branch>/board|code: other refs may be rewritten', async () => {
  const engine = scripted(async (ctx, peer, step) => {
    const c = await commitOnMain(ctx, peer, step);
    await gitOk(ctx, peer, ['push', ctx.remote.url, `+${c}:refs/heads/scratch`, `+${c}:refs/cowork/main/other`, `+${c}:refs/cowork/probe-x`]);
  });
  const r = await runSim({ seed: 'ff-other', peers: 2, ops: 3 }, engine, [oracleFF('refs/cowork/')]);
  await dropArtifacts(r.artifactsDir);
  assert.equal(r.ok, true, r.failure?.message);
  assert.ok(r.remoteRefs['refs/cowork/main/other'] !== undefined);
});

test('INV-OID fails on a remote deletion outside the allowed prefixes', async () => {
  const engine = scripted(async (ctx, peer, step) => {
    if (step === 0) await gitOk(ctx, peer, ['push', ctx.remote.url, `${await commitOnMain(ctx, peer, step)}:refs/cowork/main/board`]);
    if (step === 1) await gitOk(ctx, peer, ['push', ctx.remote.url, ':refs/cowork/main/board']);
  });
  const r = await runSim({ seed: 'oid-fail', peers: 2, ops: 2 }, engine, [oracleOID(PROBES)]);
  await dropArtifacts(r.artifactsDir);
  assert.equal(r.ok, false);
  assert.deepEqual([r.failure?.oracle, r.failure?.step], ['INV-OID', 1]);
  assert.match(r.failure?.message ?? '', /refs\/cowork\/main\/board deleted/);
});

test('probe refs of both namespaces may be created and deleted under INV-FF and INV-OID together', async () => {
  const engine = scripted(async (ctx, peer, step) => {
    if (step === 0) {
      const c = await commitOnMain(ctx, peer, step);
      await gitOk(ctx, peer, ['push', ctx.remote.url, `${c}:refs/cowork/probe-${peer.name}`, `${c}:refs/heads/cowork/probe-${peer.name}`]);
    }
    if (step === 1) await gitOk(ctx, peer, ['push', ctx.remote.url, `:refs/cowork/probe-${peer.name}`, `:refs/heads/cowork/probe-${peer.name}`]);
  });
  const r = await runSim({ seed: 'oid-probe', peers: 1, ops: 2 }, engine, [oracleFF('refs/cowork/'), oracleFF('refs/heads/cowork/'), oracleOID(PROBES)]);
  await dropArtifacts(r.artifactsDir);
  assert.equal(r.ok, true, r.failure?.message);
  assert.deepEqual(Object.keys(r.remoteRefs), ['refs/heads/main']);
});
```

- [ ] **Step 7: Run the oracle tests to verify they fail**

Run: `npx tsx --test test/integration/sim.oracles.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `test/sim/oracles.js`.

- [ ] **Step 8: Write the oracles**

`test/sim/oracles.ts`:

```ts
// INV-FF and INV-OID oracles (11-testing §3.4) over the bare remote's hook logs.
// Plan 1 covers the remote-log clauses only. The trace clauses (INV-FF: no '+'/--force in a
// daemon push argv; INV-OID: only the deleting peer's own probe ref, and no push after a
// write-tree/commit-tree exit 128) need the trace port of Plan 2.
import type { Oracle, SimContext } from './harness.js';

const ZERO_OID = /^0+$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * INV-FF: every remote-log entry on a namespace ref `${refPrefix}<branch>/board` or
 * `${refPrefix}<branch>/code` (<branch> = enc(b), which never contains '/') is a fast-forward:
 * `old` is on `git rev-list --first-parent new`. Creations (old = 0…0) pass; a deletion
 * (new = 0…0) fails. Every other ref (probe refs, refs/heads/*, other names) is ignored.
 * Entries already checked in this run are not re-checked.
 */
export function oracleFF(refPrefix: string): Oracle {
  const namespaceRef = new RegExp(`^${escapeRegExp(refPrefix)}[^/]+/(?:board|code)$`);
  const checked = new WeakMap<SimContext, number>();
  return {
    name: 'INV-FF',
    async afterEveryOp(ctx: SimContext): Promise<string | null> {
      const log = await ctx.remote.readRemoteLog();
      for (let i = checked.get(ctx) ?? 0; i < log.length; i++) {
        const e = log[i];
        if (e === undefined || !namespaceRef.test(e.ref)) continue;
        if (ZERO_OID.test(e.old)) continue;
        if (ZERO_OID.test(e.new)) return `${e.ref} deleted (was ${e.old}); not a fast-forward`;
        const r = await ctx.git.run(['rev-list', '--first-parent', e.new], { class: 'local', cwd: ctx.remote.dir });
        if (r.code !== 0) return `rev-list --first-parent ${e.new} failed in the remote (exit ${r.code})`;
        const chain = r.stdout.toString('utf8').split('\n');
        if (!chain.includes(e.old)) return `${e.ref} moved ${e.old} -> ${e.new}, not a first-parent fast-forward`;
      }
      checked.set(ctx, log.length);
      return null;
    },
  };
}

/**
 * INV-OID: the remote's reference-transaction log shows no committed deletion except of refs
 * starting with one of allowedDeletePrefixes (the probe refs of both namespaces, glossary §4:
 * `refs/cowork/probe-` and the fallback `refs/heads/cowork/probe-`).
 */
export function oracleOID(allowedDeletePrefixes: string[]): Oracle {
  const allowed = [...allowedDeletePrefixes];
  return {
    name: 'INV-OID',
    async afterEveryOp(ctx: SimContext): Promise<string | null> {
      for (const e of await ctx.remote.readRefTxLog()) {
        if (e.state !== 'committed' || !ZERO_OID.test(e.new)) continue;
        if (!allowed.some((p) => e.ref.startsWith(p))) return `${e.ref} deleted on the remote (was ${e.old})`;
      }
      return null;
    },
  };
}
```

- [ ] **Step 9: Run the oracle tests to verify they pass**

Run: `npx tsx --test test/integration/sim.oracles.test.ts`
Expected: PASS: 6 tests, 0 failures (about 10 s on Windows).

- [ ] **Step 10: Commit**

```bash
git add test/sim/oracles.ts test/integration/sim.oracles.test.ts
git commit -m "test(sim): INV-FF (board/code refs) and INV-OID (probe prefixes) oracles over the remote hook logs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 11: Write the failing NaiveEngine, interleaving, retry, determinism and mutant tests**

The file has five tests:
- **Correct engine:** every step is published as a leased fast-forward.
- **Interleaving (11-testing §3.3 Run 2):** the engine factory installs an `onYield` handler on its first call. On every even step, the handler runs another peer's whole step at `naive.beforePush`. The yielding peer's leased push must then be rejected. The engine sees the moved tip, rebuilds its commit once on the teammate's commit (a new oid, not a resend) and lands it, and INV-FF must still hold. The handler ignores `naive.retry`, so the rebuilt push is not interleaved again.
- **Transient retry:** the `onYield` handler arms the remote's pre-receive hook with `rejectNext` (Task 11) at `naive.beforePush`: once at step 1, three times at step 3. Nothing lands, so the remote tip stays on the lease. Step 1 must log `rejected <c1>` and then `ok <c1>` (the same commit, no new commit entry). Step 3 must log `rejected <c3>` three times and stop. `naive.retry` is yielded once at step 1 and twice at step 3, and step 4 lands on the unchanged tip.
- **Determinism (Review Focus 5):** see the table above.
- **Mutant:** INV-FF kills the force-push mutant on the recorded seed `naive-mutant`, at the recorded step 5. This seed was checked by running it. If the harness draw order ever changes, rerun the test and record the new pick sequence and step in it. Do not loosen the assertions.

`test/integration/sim.naive.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomInt } from '../../src/ports/random.js';
import type { EngineFactory, Oracle, SeedTuple, SimEngine } from '../sim/harness.js';
import { runSim } from '../sim/harness.js';
import { naiveEngine } from '../sim/naiveEngine.js';
import { oracleFF, oracleOID } from '../sim/oracles.js';
import { SIM_WALL_EPOCH_MS } from '../sim/vclock.js';

const ORACLES = (): Oracle[] => [
  oracleFF('refs/cowork/'),
  oracleFF('refs/heads/cowork/'),
  oracleOID(['refs/cowork/probe-', 'refs/heads/cowork/probe-']),
];

/** A failed run keeps its temp root; artifactsDir is <mkdtemp base>/공 백 dir/artifacts. */
async function dropArtifacts(dir: string | undefined): Promise<void> {
  if (dir === undefined) return;
  await rm(dirname(dirname(dir)), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * Determinism pin: every landed commit's committer date is the virtual wall clock its engine
 * logged (`commit <oid> wall=<ms>`), and lies in the SIM window (epoch ± 600 s skew + run time),
 * so neither real time nor a doubled epoch can reach an oid.
 */
const commitDatesAreVirtual: Oracle = {
  name: 'VIRTUAL-DATES',
  async atQuiescence(ctx) {
    const wallOf = new Map<string, number>();
    for (const e of ctx.opLog) {
      if (e.kind !== 'commit') continue;
      const [oid, wall] = e.detail.split(' wall=');
      wallOf.set(oid ?? '', Number(wall));
    }
    const r = await ctx.git.run(['log', '--format=%H %ct', 'refs/cowork/main/code'], { class: 'local', cwd: ctx.remote.dir });
    if (r.code !== 0) return `git log failed: ${r.stderr.toString('utf8')}`;
    let checked = 0;
    for (const line of r.stdout.toString('utf8').split('\n').filter((l) => l !== '')) {
      const [oid = '', ct = ''] = line.split(' ');
      const wall = wallOf.get(oid);
      if (wall === undefined) continue; // the seed commit (Task 12's fixed date)
      if (Number(ct) !== Math.floor(wall / 1000)) return `${oid}: committer date ${ct} is not the virtual wall ${wall}`;
      if (Math.abs(wall - SIM_WALL_EPOCH_MS) > 600_000 + 3_600_000) return `${oid}: virtual wall ${wall} is outside the SIM window`;
      checked++;
    }
    return checked > 0 ? null : 'no engine commit reached refs/cowork/main/code';
  },
};

test('NaiveEngine: every step lands as a leased fast-forward and INV-FF/INV-OID hold', async () => {
  const r = await runSim({ seed: 'naive-pass', peers: 3, ops: 9 }, naiveEngine(), [...ORACLES(), commitDatesAreVirtual]);
  await dropArtifacts(r.artifactsDir);
  assert.equal(r.ok, true, r.failure?.message);
  const pushes = r.opLog.filter((e) => e.kind === 'push');
  assert.equal(pushes.length, 9);
  assert.ok(pushes.every((e) => e.detail.startsWith('ok ')), JSON.stringify(pushes));
  const last = pushes[pushes.length - 1];
  assert.equal(r.remoteRefs['refs/cowork/main/code'], last?.detail.slice(3));
});

// 11-testing §3.3 Run 2: at a yieldPoint the scheduler may run a concurrent operation. Here the
// handler runs another peer's whole naive step at 'naive.beforePush' on every even step, so the
// yielding peer pushes with a lease the teammate has just moved. The push loses, the engine sees
// the moved tip and rebuilds its commit once on top of the teammate's.
test('a teammate step interleaved at naive.beforePush makes the leased push lose, the commit is rebuilt once; INV-FF holds', async () => {
  const inner = naiveEngine();
  const engines = new Map<string, SimEngine>();
  const factory: EngineFactory = (ctx, peer) => {
    const engine = inner(ctx, peer);
    engines.set(peer.name, engine);
    if (ctx.scheduler.onYield === null) {
      let busy = false;
      ctx.scheduler.onYield = async (name) => {
        const last = ctx.opLog[ctx.opLog.length - 1];
        if (name !== 'naive.beforePush' || busy || last === undefined || last.step % 2 !== 0) return;
        const others = [...engines.values()].filter((e) => e.peer.name !== last.peer);
        const other = others[randomInt(ctx.scheduler.random, others.length)] as SimEngine;
        busy = true;
        try {
          ctx.opLog.push({ step: last.step, peer: other.peer.name, kind: 'interleave', detail: `at ${name} of ${last.peer}` });
          await other.step(ctx);
        } finally {
          busy = false;
        }
      };
    }
    return engine;
  };

  const r = await runSim({ seed: 'naive-interleave', peers: 3, ops: 6 }, factory, ORACLES());
  await dropArtifacts(r.artifactsDir);
  assert.equal(r.ok, true, r.failure?.message);
  for (const step of [0, 2, 4]) {
    const entries = r.opLog.filter((e) => e.step === step);
    assert.deepEqual(entries.map((e) => e.kind), ['step', 'commit', 'interleave', 'commit', 'push', 'push', 'commit', 'push'], `step ${step}`);
    // Commits in order: the yielding peer's, the teammate's, and the yielding peer's rebuilt one.
    const [own, teammate, rebuilt] = entries.filter((e) => e.kind === 'commit').map((e) => e.detail.split(' ')[0]);
    const pushes = entries.filter((e) => e.kind === 'push');
    assert.deepEqual(pushes.map((e) => e.detail.split(' ').slice(0, 2).join(' ')), [`ok ${teammate}`, `rejected ${own}`, `ok ${rebuilt}`], `step ${step}`);
    assert.match(pushes[1]?.detail ?? '', /^rejected [0-9a-f]{40,64} code=[1-9][0-9]* /);
    assert.notEqual(rebuilt, own, `step ${step}: a lost lease rebuilds the commit, it does not resend it`);
  }
  for (const step of [1, 3, 5]) {
    assert.ok(r.opLog.some((e) => e.step === step && e.kind === 'push' && e.detail.startsWith('ok ')), `step ${step}`);
  }
  const lastOk = r.opLog.filter((e) => e.kind === 'push' && e.detail.startsWith('ok ')).pop();
  assert.equal(r.remoteRefs['refs/cowork/main/code'], lastOk?.detail.slice(3));
});

// A rejection that lands nothing (here the remote's pre-receive hook, armed with rejectNext from
// Task 11) leaves the remote tip on the lease, so the engine resends the same commit after
// 'naive.retry'. Two such retries are allowed; a third rejection ends the step with a final
// `rejected`, and the next step builds on the unchanged tip.
test('a transient rejection is retried with the same commit; a third rejection in a row ends the step', async () => {
  const yields: string[] = [];
  const factory: EngineFactory = (ctx, peer) => {
    if (ctx.scheduler.onYield === null) {
      ctx.scheduler.onYield = async (name) => {
        const step = ctx.opLog[ctx.opLog.length - 1]?.step ?? -1;
        yields.push(`${step}:${name}`);
        if (name !== 'naive.beforePush') return;
        if (step === 1) await ctx.remote.rejectNext(1, 'transient-failed', 'refs/cowork/main/code');
        if (step === 3) await ctx.remote.rejectNext(3, 'transient-failed', 'refs/cowork/main/code');
      };
    }
    return naiveEngine()(ctx, peer);
  };

  const r = await runSim({ seed: 'naive-transient', peers: 2, ops: 5 }, factory, [...ORACLES(), commitDatesAreVirtual]);
  await dropArtifacts(r.artifactsDir);
  assert.equal(r.ok, true, r.failure?.message);
  /** One step without its 'step' entry, as "commit <oid>" and "<ok|rejected> <oid>". */
  const summary = (step: number): string[] => r.opLog
    .filter((e) => e.step === step && e.kind !== 'step')
    .map((e) => (e.kind === 'commit' ? `commit ${e.detail.split(' ')[0]}` : e.detail.split(' ').slice(0, 2).join(' ')));
  const c1 = summary(1)[0]?.slice('commit '.length);
  assert.deepEqual(summary(1), [`commit ${c1}`, `rejected ${c1}`, `ok ${c1}`]);
  const c3 = summary(3)[0]?.slice('commit '.length);
  assert.deepEqual(summary(3), [`commit ${c3}`, `rejected ${c3}`, `rejected ${c3}`, `rejected ${c3}`]);
  for (const step of [0, 2, 4]) assert.match(summary(step).join(' | '), /^commit ([0-9a-f]+) \| ok \1$/, `step ${step}`);
  assert.deepEqual(yields.filter((y) => y.endsWith(':naive.retry')), ['1:naive.retry', '3:naive.retry', '3:naive.retry']);
  for (const e of r.opLog.filter((x) => x.kind === 'push' && x.detail.startsWith('rejected '))) {
    assert.match(e.detail, /^rejected [0-9a-f]{40,64} code=[1-9][0-9]* /);
  }
  assert.equal(`ok ${r.remoteRefs['refs/cowork/main/code']}`, summary(4)[1]);
});

// Review Focus 5. Pinned: seeded Randoms, explicit identities, commit dates from VirtualClocks,
// sorted readdir. Two different temp roots and a real-time gap of more than one second (git
// dates have 1 s resolution) between the runs: a date taken from the real clock would change
// every oid of the second run.
test('determinism: the same SeedTuple twice gives the identical op-log and remote refs', async () => {
  const t: SeedTuple = { seed: 'determinism-7', peers: 3, ops: 8 };
  const a = await runSim(t, naiveEngine(), [...ORACLES(), commitDatesAreVirtual]);
  await delay(1_100);
  const b = await runSim(t, naiveEngine(), [...ORACLES(), commitDatesAreVirtual]);
  await dropArtifacts(a.artifactsDir);
  await dropArtifacts(b.artifactsDir);
  assert.equal(a.ok, true, a.failure?.message);
  assert.deepEqual(a.opLog, b.opLog);
  assert.deepEqual(a.remoteRefs, b.remoteRefs);
  assert.ok(a.remoteRefs['refs/cowork/main/code'] !== undefined);
});

// Seed 'naive-mutant' verified on Windows 11 / Git 2.55 / Node 24. The picks depend only on
// seededRandom and the harness draw order (per peer: skew, drift; per step: pick, dt), not on the
// OS: steps 0-5 pick p2, p1, p1, p1, p0, p2. p2 publishes at step 0, p1 and p0 publish on top of
// it, and at step 5 p2 builds on its stale view (its own step-0 commit) and its '+' push rewrites
// p0's commit.
test('mutant forcePush (stale view + "+" refspec) is killed by INV-FF', async () => {
  const r = await runSim({ seed: 'naive-mutant', peers: 3, ops: 12 }, naiveEngine({ forcePush: true }), ORACLES());
  await dropArtifacts(r.artifactsDir);
  assert.deepEqual(r.opLog.filter((e) => e.kind === 'step').map((e) => e.peer), ['p2', 'p1', 'p1', 'p1', 'p0', 'p2']);
  assert.equal(r.ok, false);
  assert.equal(r.failure?.oracle, 'INV-FF');
  assert.equal(r.failure?.step, 5);
  assert.match(r.failure?.message ?? '', /^refs\/cowork\/main\/code moved [0-9a-f]+ -> [0-9a-f]+, not a first-parent fast-forward$/);
});
```

- [ ] **Step 12: Run the NaiveEngine tests to verify they fail**

Run: `npx tsx --test test/integration/sim.naive.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `test/sim/naiveEngine.js`.

- [ ] **Step 13: Write the NaiveEngine**

The engine uses only plumbing on the fetched remote view: no worktree and no `git merge`. As a result, `autocrlf` peers hash the same bytes as LF peers.
- `hash-object --no-filters --stdin` stores the exact buffer.
- `mktree` replaces only `notes.txt`.
- `commit-tree` takes the peer's identity and its virtual wall clock. Both are also passed to `update-ref`, because its reflog entry records an identity and a date.

After committing, the engine logs `commit <oid> wall=<ms>`, reaches `yieldPoint('naive.beforePush')`, and then pushes. It logs every push attempt as `ok <oid>` or as `rejected <oid> code=<n> <git output>`.
- A rejected detail carries the exit code and git's own output (porcelain stdout, then stderr), squeezed onto one line. A rejection seen only in CI can then be diagnosed from what Task 15's smoke CLI prints: the op-log tail of a failing seed, or a `sim:smoke note` for a rejection that the retry absorbed. An earlier `rejected <oid>` with nothing else made a transient rejection on a Node 20 leg impossible to explain.
- The remote URL, the remote directory and the temp root (each also with `/` separators) are masked as `<remote>` and `<root>`. Op-logs from different temp roots therefore stay comparable.
- Examples. A lost lease: `rejected 8f59bec... code=1 To <remote> ! 8f59bec...:refs/cowork/main/code [rejected] (stale info) Done error: failed to push some refs to '<remote>'`. A push declined by the remote's pre-receive hook (`rejectNext`): `rejected 103b965... code=1 To <remote> ! 103b965...:refs/cowork/main/code [remote rejected] (pre-receive hook declined) Done error: failed to push some refs to '<remote>'`.
- Consumers match only the prefixes `ok ` and `rejected `. The words after `code=<n>` come from git and are not a contract.
- **Every fetch** (`fetchViews`, at the start of a step and after a rejected push) goes through `retryGit` (Task 12) with 3 attempts. A fetch writes nothing to the remote, so a failed one is simply run again. After the third failure the step throws a `RetryGitError` that lists every attempt's exit code and stderr. Fetch retries write nothing to the op-log.
- **Correct engine:** it fetches again on every step and pushes `<commit>:refs/cowork/main/code` with `--force-with-lease=refs/cowork/main/code:<fetched tip or empty>` and no `+`.
- **Retry (correct engine only):** after a rejected push the engine fetches again, with the same glob refspec as at the start of the step. A fetch of `refs/cowork/main/code` alone would fail before the first publish, when that ref does not exist yet. The engine then compares the new remote tip with its lease:
  - **Tip unchanged:** nothing landed, so the rejection was transient. In the dry run of this plan, one push to the local `file://` remote was rejected on Node 20 while other test files ran in parallel. The engine pushes the same commit with the same lease again, at most `TRANSIENT_RETRIES` (2) more times.
  - **Tip moved:** a teammate published first, so the lease was lost. The engine rebuilds its commit once on the new tip and pushes it with the new tip as the lease. The rebuilt commit has the same identity and virtual date, and it gets its own `commit` entry. A push that landed despite a non-zero exit also shows up as a moved tip, and the rebuilt commit then stacks on it as a fast-forward.
  - Before each retry the engine awaits `yieldPoint('naive.retry')`, not `naive.beforePush`. A test that interleaves at `naive.beforePush` therefore does not interleave the retry again.
  - The retry path draws no randomness. A run without a rejection logs one push per step, the same op-log as an engine without retries.
  - When the retries run out, the step ends on its last `rejected` entry. Task 15's liveness check reports such a step.
- **Mutant:** it fetches only on its first step, builds on its own stale view, and pushes `+<commit>:refs/cowork/main/code` once, without retries. That overwrites a teammate's commit as soon as another peer has published in between.

`test/sim/naiveEngine.ts`:

```ts
// Harness self-test engine. Each step appends "<peer>:<step>" to notes.txt on top of the freshly
// fetched refs/cowork/main/code (or main before the first publish), commits it with plumbing
// (no worktree, so autocrlf peers produce the same blobs), reaches the yield point
// 'naive.beforePush' (where a SIM test may interleave another peer, 11-testing §3.3 Run 2) and
// pushes it with a lease.
// A rejected leased push is retried within the same step. The engine re-fetches and compares the
// remote tip with its lease: an unchanged tip means nothing landed (a transient rejection), so the
// same push is retried up to TRANSIENT_RETRIES more times; a moved tip means the lease was lost, so
// the commit is rebuilt once on the new tip and pushed again. Every retry first awaits the yield
// point 'naive.retry'. The retry path draws no randomness, so without a rejection the op-log is
// exactly that of a single push.
// forcePush: true is the mutant: it never re-fetches after its first step, builds on its own stale
// view and pushes a "+" refspec once, without retries, so a teammate's commit is overwritten and
// INV-FF must fail.
import type { GitCallOptions, GitClass } from '../../src/git/flags.js';
import { retryGit } from '../helpers/retryGit.js';
import type { EngineFactory, SimContext, SimEngine } from './harness.js';
import type { PeerClone } from './peers.js';

const CODE_REF = 'refs/cowork/main/code';
const VIEW_CODE = 'refs/cowork-remote/main/code';
const VIEW_BRANCH = 'refs/cowork-remote/main/branch';
const NOTES = 'notes.txt';
/** Extra attempts of the same leased push while the remote tip still equals the lease. */
const TRANSIENT_RETRIES = 2;

class GitStepError extends Error {}

async function git(
  ctx: SimContext, peer: PeerClone, cls: GitClass, args: string[], extra: Partial<GitCallOptions> = {},
): Promise<{ code: number; out: Buffer; err: Buffer }> {
  const r = await ctx.git.run(args, { class: cls, cwd: peer.dir, ...extra });
  return { code: r.code, out: r.stdout, err: r.stderr };
}

/** Exit code plus git's own output for a failed push, on one line, with run-specific paths masked so op-logs stay comparable. */
function pushFailure(ctx: SimContext, r: { code: number; out: Buffer; err: Buffer }): string {
  let text = `${r.out.toString('utf8')} ${r.err.toString('utf8')}`.replace(/\s+/g, ' ').trim();
  const slash = (p: string): string => p.split('\\').join('/');
  for (const [s, mask] of [[ctx.remote.url, '<remote>'], [ctx.remote.dir, '<remote>'], [slash(ctx.remote.dir), '<remote>'], [ctx.root, '<root>'], [slash(ctx.root), '<root>']] as const) {
    text = text.split(s).join(mask);
  }
  return `code=${r.code} ${text}`;
}

async function gitOk(
  ctx: SimContext, peer: PeerClone, cls: GitClass, args: string[], extra: Partial<GitCallOptions> = {},
): Promise<string> {
  const r = await ctx.git.run(args, { class: cls, cwd: peer.dir, ...extra });
  if (r.code !== 0) throw new GitStepError(`${peer.name}: git ${args[0]} exited ${r.code}: ${r.stderr.toString('utf8').trim()}`);
  return r.stdout.toString('utf8').trim();
}

/** Resolves a local ref to an oid, or null when it does not exist. */
async function resolve(ctx: SimContext, peer: PeerClone, ref: string): Promise<string | null> {
  const r = await git(ctx, peer, 'local', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.code === 0 ? r.out.toString('utf8').trim() : null;
}

/**
 * The glob refspec also works before the first publish, when refs/cowork/main/code does not exist
 * yet. A fetch writes nothing to the remote, so retryGit may simply run it again.
 */
async function fetchViews(ctx: SimContext, peer: PeerClone): Promise<void> {
  const args = ['fetch', '--no-tags', ctx.remote.url, `+refs/heads/main:${VIEW_BRANCH}`, '+refs/cowork/*:refs/cowork-remote/*'];
  await retryGit(() => ctx.git.run(args, { class: 'network', cwd: peer.dir }), { attempts: 3, label: `${peer.name}: git fetch` });
}

/** Tree of `base` with notes.txt replaced by `blob`. */
async function treeWithNotes(ctx: SimContext, peer: PeerClone, base: string, blob: string): Promise<string> {
  const listing = await git(ctx, peer, 'local', ['ls-tree', '-z', base]);
  if (listing.code !== 0) throw new GitStepError(`${peer.name}: ls-tree ${base} failed`);
  const entries = listing.out.toString('utf8').split('\0').filter((e) => e !== '' && !e.endsWith(`\t${NOTES}`));
  entries.push(`100644 blob ${blob}\t${NOTES}`);
  return gitOk(ctx, peer, 'local', ['mktree', '-z'], { stdin: Buffer.from(entries.join('\0') + '\0', 'utf8') });
}

function currentStep(ctx: SimContext): number {
  const last = ctx.opLog[ctx.opLog.length - 1];
  if (last === undefined) throw new Error('naiveEngine: step() called before the harness logged the step');
  return last.step;
}

class NaiveEngine implements SimEngine {
  constructor(readonly peer: PeerClone, private readonly forcePush: boolean) {}

  async step(ctx: SimContext): Promise<void> {
    const peer = this.peer;
    const step = currentStep(ctx);
    const clock = ctx.clocks.get(peer.name);
    if (clock === undefined) throw new Error(`naiveEngine: no clock for ${peer.name}`);
    if (!this.forcePush || (await resolve(ctx, peer, VIEW_BRANCH)) === null) await fetchViews(ctx, peer);

    // Identity and date are always explicit: the date is this peer's virtual wall clock, never real
    // time. Peer clocks move only between steps, so a rebuilt commit gets the same date.
    const wall = clock.wallMs();
    const who: Partial<GitCallOptions> = { identity: { name: peer.name, email: `${peer.name}@cowork.invalid` }, wallMsForDates: wall };
    let leased = await resolve(ctx, peer, VIEW_CODE);
    let commit = await this.commitOn(ctx, step, leased, wall, who);

    await ctx.scheduler.yieldPoint('naive.beforePush');

    if (this.forcePush) {
      await this.pushOnce(ctx, step, commit, [ctx.remote.url, `+${commit}:${CODE_REF}`], who);
      return;
    }
    let transientLeft = TRANSIENT_RETRIES;
    let rebuilt = false;
    for (;;) {
      const lease = `--force-with-lease=${CODE_REF}:${leased ?? ''}`;
      if (await this.pushOnce(ctx, step, commit, [lease, ctx.remote.url, `${commit}:${CODE_REF}`], who)) return;
      await fetchViews(ctx, peer);
      const tip = await resolve(ctx, peer, VIEW_CODE);
      if (tip === leased) {
        // Nothing landed: retry the same push. A push that landed despite a non-zero exit shows up
        // as a moved tip instead, and the rebuilt commit stacks on it as a fast-forward.
        if (transientLeft === 0) return;
        transientLeft--;
      } else {
        // Lease lost: a teammate published first. Rebuild once on the new tip.
        if (rebuilt) return;
        rebuilt = true;
        leased = tip;
        commit = await this.commitOn(ctx, step, leased, wall, who);
      }
      await ctx.scheduler.yieldPoint('naive.retry');
    }
  }

  /** Commits notes.txt + "<peer>:<step>" on top of `leased` (or main before the first publish) and logs `commit <oid> wall=<ms>`. */
  private async commitOn(ctx: SimContext, step: number, leased: string | null, wall: number, who: Partial<GitCallOptions>): Promise<string> {
    const peer = this.peer;
    const base = leased ?? (await resolve(ctx, peer, VIEW_BRANCH));
    if (base === null) throw new GitStepError(`${peer.name}: no base commit after fetch`);
    const old = await git(ctx, peer, 'local', ['cat-file', 'blob', `${base}:${NOTES}`]);
    const content = Buffer.concat([old.code === 0 ? old.out : Buffer.alloc(0), Buffer.from(`${peer.name}:${step}\n`, 'utf8')]);
    const blob = await gitOk(ctx, peer, 'local', ['hash-object', '-w', '--no-filters', '--stdin'], { stdin: content });
    const tree = await treeWithNotes(ctx, peer, base, blob);
    const commit = await gitOk(ctx, peer, 'refupdate', ['commit-tree', tree, '-p', base, '-m', `naive ${peer.name}:${step}`], who);
    ctx.opLog.push({ step, peer: peer.name, kind: 'commit', detail: `${commit} wall=${wall}` });
    return commit;
  }

  /** One push attempt, logged as `ok <oid>` or `rejected <oid> code=<n> <git output>`; true when it landed. */
  private async pushOnce(ctx: SimContext, step: number, commit: string, args: string[], who: Partial<GitCallOptions>): Promise<boolean> {
    const pushed = await git(ctx, this.peer, 'network', ['push', '--porcelain', ...args]);
    if (pushed.code === 0) await gitOk(ctx, this.peer, 'refupdate', ['update-ref', VIEW_CODE, commit], who);
    ctx.opLog.push({ step, peer: this.peer.name, kind: 'push', detail: pushed.code === 0 ? `ok ${commit}` : `rejected ${commit} ${pushFailure(ctx, pushed)}` });
    return pushed.code === 0;
  }
}

export function naiveEngine(opts?: { forcePush?: boolean }): EngineFactory {
  const forcePush = opts?.forcePush === true;
  return (_ctx: SimContext, peer: PeerClone): SimEngine => new NaiveEngine(peer, forcePush);
}
```

- [ ] **Step 14: Run the NaiveEngine tests to verify they pass**

Run: `npx tsx --test test/integration/sim.naive.test.ts`
Expected: PASS: 5 tests, 0 failures (about 32 s on Windows 11 / Git 2.55 / Node 24). Each step spawns about 8 real git processes, and the determinism test runs twice with a 1.1 s gap between the runs.

The mutant test shows the pick sequence `p2, p1, p1, p1, p0, p2` and fails INV-FF at step 5. A different sequence means that Task 3's `seededRandom`/`randomInt` or the harness draw order differs from this plan. Fix that instead of picking another seed.

Negative check during development (do not commit): remove `wallMsForDates: wall` from `who` in `test/sim/naiveEngine.ts`.

Run: `npx tsx --test test/integration/sim.naive.test.ts`
Expected: 5 tests, 2 pass, 3 fail. The three tests that use the `VIRTUAL-DATES` oracle fail: `NaiveEngine: every step lands as a leased fast-forward …`, `a transient rejection is retried …` and `determinism: …`. Each fails with `AssertionError [ERR_ASSERTION]: <oid>: committer date 17908… is not the virtual wall 17672…`. The committer date is the real time in seconds, and the virtual wall is near `SIM_WALL_EPOCH_MS` in ms. The interleaving and mutant tests still pass, because they do not use that oracle. Then restore `wallMsForDates: wall` by hand to the Step 13 code. `git checkout` cannot do it, because `naiveEngine.ts` is first committed in Step 16. This was verified on Windows 11 / Git 2.55 / Node 24.

- [ ] **Step 15: Run the three SIM files together**

Run: `npx tsx --test test/integration/sim.harness.test.ts test/integration/sim.oracles.test.ts test/integration/sim.naive.test.ts`
Expected: PASS: 18 tests, 0 failures (about 32 s on Windows; the files run in parallel). No `cowork-sim-*` directory is left in the OS temp directory.

- [ ] **Step 16: Commit**

```bash
git add test/sim/naiveEngine.ts test/integration/sim.naive.test.ts
git commit -m "test(sim): NaiveEngine with naive.beforePush yield, retried rejections, interleaved lease loss, force-push mutant killed by INV-FF, same-seed determinism" -m "A rejected leased push is retried in the same step after yieldPoint('naive.retry'): the same commit up to 2 more times while the remote tip still equals the lease (nothing landed), or a commit rebuilt once on the new tip when the lease was lost. The forcePush mutant never retries." -m "Every push attempt is logged; a rejected one carries its exit code and git's porcelain/stderr on one line, with the remote URL, remote dir and temp root masked, so a CI-only rejection can be diagnosed from the op-log." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Lint suite skeleton

**Files:**
- Create: `tools/lint/rules.ts`
- Create: `tools/lint/lint.ts`
- Modify: `package.json` (`scripts.lint` = `tsx tools/lint/lint.ts`, set with `npm pkg set`; nothing else changes)
- Test: `test/unit/lint.rules.test.ts`
- Test: `test/integration/lint.cli.test.ts`

**Interfaces:**
- Consumes: `makeTempRoot(label: string): Promise<{ root: string; cleanup: () => Promise<void> }>` (Task 9, `test/helpers/tmp.ts`); the catalogue file `test/crashpoints.json` (Task 6: a JSON `string[]`, sorted, unique); the allow-listed files `src/git/runner.ts` (Task 9), `src/ports/clock.ts` (Task 2), `src/ports/random.ts` (Task 3), `src/ports/crashpoint.ts` (Task 6), `src/entry/mcp.ts` (Task 1); devDependency `typescript` (Task 1).
- Produces (exactly as in 00-header.md):
  - `export interface LintFinding { rule: string; file: string; line: number; message: string; }`
  - `export function lintSource(file: string, text: string): LintFinding[];` — `file` is repo-relative; backslashes are normalised to `/`; `line` is 1-based.
  - `export function lintCrashpoints(callSites: string[], catalogue: string[]): LintFinding[];`
  - CLI `tools/lint/lint.ts [--root <dir>]`: reads `<root>/test/crashpoints.json` first, then lints every `src/**/*.ts` (not `.d.ts`) under the root, prints `<RULE> <file>:<line> <message>` per finding on stderr and `lint: <n> files, <k> findings` on stdout; exit 0 clean, 1 on findings, 2 on a usage or catalogue error (catalogue missing, unreadable, not JSON, or not a JSON array of strings; the message `lint: test/crashpoints.json: …` goes to stderr and no summary line is printed). `npm run lint` runs it. (lint.ts exports nothing; `dist/` scanning is added by a later plan.)

**Rules implemented here** (11-testing §3.10; the rest of the table arrives with the code they police):

| Id | Flags | Allowed in |
|---|---|---|
| L-GIT-SPAWN | `spawn`/`spawnSync`/`exec`/`execSync`/`execFile`/`execFileSync`/`fork` whose first argument is the literal `git`, `git …` or a path ending in `git`/`git.exe` | `src/git/runner.ts` |
| L-PORTS | `child_process` / `node:child_process` loaded by `import`, `export … from`, `import x = require()`, `require()` or `import()` | `src/git/runner.ts` |
| L-NET | `http`, `https`, `http2`, `tls`, `net`, `dgram`, `dns` (bare or `node:`-prefixed, including subpaths such as `node:dns/promises`) loaded by any of the five forms above | an allow list that is **empty in Plan 1**; the IPC endpoint module (the only permitted `net` user, "net (outside IPC)") is added to it by the plan that writes it |
| L-CLOCK | `Date.now()`, `new Date(…)`, `performance.now()` | `src/ports/clock.ts` |
| L-RANDOM | `Math.random`, any `.randomBytes` / `.randomUUID`, importing `randomBytes` / `randomUUID` | `src/ports/random.ts` |
| L-PERMISSION | a `permissionDecision` property (assignment, object literal, type member) whose value or type contains the literal `"allow"` or `"ask"` | nowhere |
| L-REFS | a literal containing `refs/worktree/`; the literal `--force`; a literal or template starting with `+` that contains `refs/` (a forced refspec, including `` `+${oid}:refs/…` ``) unless it is an element of a `fetch` argv (glossary §4 fetch refspecs are `+`); a deletion refspec `:refs/…` other than `:refs/cowork/probe-…` / `:refs/heads/cowork/probe-…` | nowhere |
| L-MERGE-BASE | an argv whose subcommand is `merge-base`; an argv whose subcommand is `merge-tree` without `--merge-base` / `--merge-base=…` | nowhere |
| L-MERGE-OPTS | a literal with a whitespace-separated token that is `-X` or starts with `-X` (`-Xours`) or `--strategy-option` (the long form of `-X`); a token `--union`; a literal containing `merge=union`; an argv whose subcommand is `merge-file` without `--object-id` | nowhere |
| L-HASH-STDIN | an argv whose subcommand is `hash-object` containing `--stdin` but no `--path`/`--path=…` (the canon writer's `--no-filters` call is exempt, 11-testing §3.10) | nowhere |
| L-TOKEN | the name `CLAUDE_CODE_MESSAGING_TOKEN` inside any string literal or template, or as an identifier (`process.env.CLAUDE_CODE_MESSAGING_TOKEN`, a destructured or object key) | `src/entry/mcp.ts` |
| L-GIT-ATOMIC | a literal with a whitespace-separated token `--atomic` (glossary §26.2 item 1: never `--atomic`, on every host) | nowhere |
| L-CRASHPOINTS | `crashpoint(x)` whose argument is not a string literal (lintSource); a call-site name missing from `test/crashpoints.json` (lintCrashpoints) | `src/ports/crashpoint.ts` (the definition) |

An *argv* is an array literal whose first element is a plain string literal (the git subcommand), unless the array is the argument of `new Set(…)`/`new Map(…)` (command-class tables such as `new Set(['merge-tree', 'merge-file'])` in `src/git/flags.ts` are not argv). L-CRASHPOINTS checks call sites ⊆ catalogue in Plan 1, because no production call site exists yet; 11-testing TST-06 equality (every catalogued name has a call site) is switched on by the plan that places the first crashpoints.

What Plan 1 deliberately leaves out of these rows:
- **L-UTF8-WRITE** (an `fs` read with `utf8` encoding whose result feeds a write) needs dataflow tracking and arrives with Plan 2, whose verifying writer is the first code it polices.
- **L-CLOCK, second half** (wall-clock comparisons outside the local-anchor helper of `src/ports/clock.ts`) arrives with Plan 2; Plan 1 lints only the three raw clock reads.
- **L-NET, `dist/` half** (imports left in `dist/*.js` per the esbuild metafile) and its "non-documentation URL literal" clause arrive with the later plan that adds `dist/` scanning. Plan 1 lints the `src/**` imports only.
- **L-MERGE-OPTS, MERGE_FLAGS half** (a `merge-tree`/`merge-file` call without the glossary §18 MERGE_FLAGS) holds by construction in Plan 1: every git call goes through Task 8's `buildGitInvocation`, which prepends MERGE_FLAGS (pinned by Task 8's argv snapshots); its lint form is L-GIT-FLAGS of a later plan.
- **L-GIT-ATOMIC** is the Plan 1 slice of L-GIT-FORBIDDEN (`push --atomic`); the rest of L-GIT-FORBIDDEN arrives with the daemon code it polices.

- [ ] **Step 1: Write the failing rule tests**

`test/unit/lint.rules.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintSource, lintCrashpoints } from '../../tools/lint/rules.js';

function rules(file: string, text: string): string[] {
  return lintSource(file, text).map((f) => f.rule);
}

const F = 'src/daemon/example.ts';

test('L-GIT-SPAWN flags spawn of git outside the runner', () => {
  assert.ok(rules(F, `import { spawn } from 'node:child_process';\nspawn('git', ['status']);`).includes('L-GIT-SPAWN'));
  assert.ok(rules(F, `cp.execSync('git rev-parse HEAD');`).includes('L-GIT-SPAWN'));
  assert.ok(rules(F, `cp.execFile('C:\\\\Program Files\\\\Git\\\\cmd\\\\git.exe', []);`).includes('L-GIT-SPAWN'));
});

test('L-GIT-SPAWN passes inside src/git/runner.ts and for git.run()', () => {
  assert.deepEqual(rules('src/git/runner.ts', `import { spawn } from 'node:child_process';\nspawn('git', ['status']);`), []);
  assert.deepEqual(rules(F, `await git.run(['status', '--porcelain'], { class: 'local', cwd });`), []);
});

test('L-PORTS flags child_process outside the runner (import, export-from, import-equals, require, dynamic import)', () => {
  assert.deepEqual(rules(F, `import { spawn } from 'node:child_process';`), ['L-PORTS']);
  assert.deepEqual(rules(F, `import cp from 'child_process';`), ['L-PORTS']);
  assert.deepEqual(rules(F, `export { spawn } from 'node:child_process';`), ['L-PORTS']);
  assert.deepEqual(rules(F, `import cp = require('child_process');`), ['L-PORTS']);
  assert.deepEqual(rules(F, `const cp = require('child_process');`), ['L-PORTS']);
  assert.deepEqual(rules(F, `const cp = await import('node:child_process');`), ['L-PORTS']);
});

test('L-PORTS passes for the runner and for other node built-ins', () => {
  assert.deepEqual(rules('src/git/runner.ts', `import { spawn } from 'node:child_process';`), []);
  assert.deepEqual(rules(F, `import path from 'node:path';\nimport { createHash } from 'node:crypto';`), []);
});

test('L-NET flags network modules in every load form, bare or node:-prefixed, with no allowed file in Plan 1', () => {
  assert.deepEqual(rules(F, `import http from 'node:http';`), ['L-NET']);
  assert.deepEqual(rules(F, `const https = require('https');`), ['L-NET']);
  assert.deepEqual(rules(F, `const dns = await import('node:dns/promises');`), ['L-NET']);
  assert.deepEqual(rules(F, `export { connect } from 'node:tls';`), ['L-NET']);
  assert.deepEqual(rules(F, `import net = require('net');`), ['L-NET']);
  assert.deepEqual(rules(F, `import dgram from 'dgram';\nimport * as h2 from 'node:http2';`), ['L-NET', 'L-NET']);
  assert.deepEqual(rules('src/entry/mcp.ts', `import net from 'node:net';`), ['L-NET']);
});

test('L-NET passes for other built-ins, relative modules and plain strings', () => {
  assert.deepEqual(rules(F, `import path from 'node:path';\nimport { createHash } from 'node:crypto';\nimport { readFile } from 'node:fs/promises';`), []);
  assert.deepEqual(rules(F, `import { netmask } from './netmask.js';\nimport { dnsName } from '../http-like/dns.js';`), []);
  assert.deepEqual(rules(F, `const kind = 'net';\nconst scheme = 'https';`), []);
});

test('L-CLOCK flags Date.now(), new Date() and performance.now() outside the Clock port', () => {
  assert.deepEqual(rules(F, `const a = Date.now();`), ['L-CLOCK']);
  assert.deepEqual(rules(F, `const b = new Date();`), ['L-CLOCK']);
  assert.deepEqual(rules(F, `const c = performance.now();`), ['L-CLOCK']);
});

test('L-CLOCK passes in src/ports/clock.ts and for clock.wallMs()', () => {
  assert.deepEqual(rules('src/ports/clock.ts', `const a = Date.now(); const c = performance.now(); const d = new Date(a);`), []);
  assert.deepEqual(rules(F, `const w = clock.wallMs(); const m = clock.monoMs();`), []);
});

test('L-RANDOM flags Math.random, randomBytes and randomUUID outside the Random port', () => {
  assert.deepEqual(rules(F, `const r = Math.random();`), ['L-RANDOM']);
  assert.deepEqual(rules(F, `import { randomBytes } from 'node:crypto';`), ['L-RANDOM']);
  assert.deepEqual(rules(F, `const u = crypto.randomUUID();`), ['L-RANDOM']);
  assert.deepEqual(rules(F, `const b = nodeCrypto.randomBytes(8);`), ['L-RANDOM']);
});

test('L-RANDOM passes in src/ports/random.ts and for random.bytes()', () => {
  assert.deepEqual(rules('src/ports/random.ts', `import { randomBytes } from 'node:crypto';\nconst b = randomBytes(8);`), []);
  assert.deepEqual(rules(F, `const b = random.bytes(8);`), []);
});

test('L-PERMISSION flags permissionDecision "allow" and "ask"', () => {
  assert.deepEqual(rules(F, `const out = { hookSpecificOutput: { permissionDecision: 'allow' } };`), ['L-PERMISSION']);
  assert.deepEqual(rules(F, `const out = { permissionDecision: denied ? 'deny' : 'ask' };`), ['L-PERMISSION']);
  assert.deepEqual(rules(F, `o.permissionDecision = "allow";`), ['L-PERMISSION']);
  assert.deepEqual(rules(F, `interface Out { permissionDecision: 'deny' | 'ask'; }`), ['L-PERMISSION']);
});

test('L-PERMISSION passes for "deny" and for unrelated "allow" strings', () => {
  assert.deepEqual(rules(F, `const out = { hookSpecificOutput: { permissionDecision: 'deny' } };`), []);
  assert.deepEqual(rules(F, `interface Out { permissionDecision: 'deny'; }\nconst mode = 'allow';`), []);
});

test('L-REFS flags + refspecs, --force, deletion refspecs and refs/worktree/', () => {
  assert.deepEqual(rules(F, `await git.run(['push', url, '+refs/cowork/x/code:refs/cowork/x/code'], o);`), ['L-REFS']);
  assert.deepEqual(rules(F, 'await git.run([\'push\', url, `+${oid}:refs/cowork/${b}/code`], o);'), ['L-REFS']);
  assert.deepEqual(rules(F, `await git.run(['push', '--force', url, spec], o);`), ['L-REFS']);
  assert.deepEqual(rules(F, `await git.run(['push', url, ':refs/cowork/x/board'], o);`), ['L-REFS']);
  assert.deepEqual(rules(F, `const r = 'refs/worktree/cowork';`), ['L-REFS']);
});

test('L-REFS passes for leased pushes, fetch refspecs and the probe-ref deletion', () => {
  assert.deepEqual(rules(F, 'await git.run([\'push\', `--force-with-lease=refs/cowork/${b}/code:${tip}`, url, `${c}:refs/cowork/${b}/code`], o);'), []);
  assert.deepEqual(rules(F, `await git.run(['fetch', url, '+refs/cowork/x/board:refs/cowork-remote/x/board'], o);`), []);
  assert.deepEqual(rules(F, 'await git.run([\'push\', url, `:refs/cowork/probe-${peerId}`], o);'), []);
});

test('L-MERGE-BASE flags git merge-base and merge-tree without --merge-base', () => {
  assert.deepEqual(rules(F, `await git.run(['merge-base', a, b], o);`), ['L-MERGE-BASE']);
  assert.deepEqual(rules(F, `await git.run(['merge-tree', '--write-tree', p, tip], o);`), ['L-MERGE-BASE']);
});

test('L-MERGE-BASE passes for merge-tree with --merge-base and for command tables', () => {
  assert.deepEqual(rules(F, 'await git.run([\'merge-tree\', \'--write-tree\', `--merge-base=${a}`, p, tip], o);'), []);
  assert.deepEqual(rules(F, `await git.run(['merge-tree', '--write-tree', '--merge-base', a, p, tip], o);`), []);
  assert.deepEqual(rules(F, `const ATTR = new Set(['merge-tree', 'merge-file', 'add']);`), []);
  assert.deepEqual(rules(F, `const x = '--merge-base';`), []);
});

test('L-MERGE-OPTS flags -X / --strategy-option, --union, merge=union and merge-file without --object-id', () => {
  assert.deepEqual(rules(F, `await git.run(['merge-tree', '--write-tree', '--merge-base', a, '-X', 'ours', p, tip], o);`), ['L-MERGE-OPTS']);
  assert.deepEqual(rules(F, 'await git.run([\'merge-tree\', \'--write-tree\', `--merge-base=${a}`, \'-Xtheirs\', p, tip], o);'), ['L-MERGE-OPTS']);
  assert.deepEqual(rules(F, `await git.run(['merge-tree', '--write-tree', '--merge-base', a, '--strategy-option=renormalize', p, tip], o);`), ['L-MERGE-OPTS']);
  assert.deepEqual(rules(F, `const extra = 'merge-tree -X ours';`), ['L-MERGE-OPTS']);
  assert.deepEqual(rules(F, `await git.run(['merge-file', '-p', '--object-id', '--union', a, b, c], o);`), ['L-MERGE-OPTS']);
  assert.deepEqual(rules(F, `const attrs = '*.lock merge=union';`), ['L-MERGE-OPTS']);
  assert.deepEqual(rules(F, `await git.run(['merge-file', '-p', cur, base, other], o);`), ['L-MERGE-OPTS']);
});

test('L-MERGE-OPTS passes for merge-file --object-id, the MERGE_FLAGS table, command tables and lowercase -x', () => {
  assert.deepEqual(rules(F, `await git.run(['merge-file', '-p', '--object-id', a, b, c], o);`), []);
  assert.deepEqual(rules(F, `export const MERGE_FLAGS: readonly string[] = Object.freeze(['-c', 'merge.renormalize=false', '-c', 'merge.renames=true', '-c', 'merge.directoryRenames=false']);`), []);
  assert.deepEqual(rules(F, `const MERGE_COMMANDS: ReadonlySet<string> = new Set(['merge-tree', 'merge-file']);`), []);
  assert.deepEqual(rules(F, `await git.run(['ls-files', '-z', '-x', pattern], o);`), []);
});

test('L-HASH-STDIN flags hash-object --stdin without --path', () => {
  assert.deepEqual(rules(F, `await git.run(['hash-object', '-w', '--stdin'], o);`), ['L-HASH-STDIN']);
});

test('L-HASH-STDIN passes with --path, with --no-filters (canon writer) and for file input', () => {
  assert.deepEqual(rules(F, 'await git.run([\'hash-object\', \'--stdin\', `--path=${p}`], o);'), []);
  assert.deepEqual(rules(F, `await git.run(['hash-object', '-w', '--no-filters', '--stdin'], o);`), []);
  assert.deepEqual(rules(F, `await git.run(['hash-object', '--', stagedPath], o);`), []);
});

test('L-TOKEN flags CLAUDE_CODE_MESSAGING_TOKEN as identifier, key or literal outside src/entry/mcp.ts', () => {
  assert.deepEqual(rules(F, `const t = process.env.CLAUDE_CODE_MESSAGING_TOKEN;`), ['L-TOKEN']);
  assert.deepEqual(rules(F, `const t = process.env['CLAUDE_CODE_MESSAGING_TOKEN'];`), ['L-TOKEN']);
  assert.deepEqual(rules(F, `const { CLAUDE_CODE_MESSAGING_TOKEN: tok } = process.env;`), ['L-TOKEN']);
  assert.deepEqual(rules(F, 'const k = `${prefix}CLAUDE_CODE_MESSAGING_TOKEN`;'), ['L-TOKEN']);
  assert.deepEqual(rules('src/git/env.ts', `const NEVER = ['CLAUDE_CODE_MESSAGING_TOKEN', 'NODE_OPTIONS'];`), ['L-TOKEN']);
});

test('L-TOKEN passes in src/entry/mcp.ts, for the CLAUDE_ prefix list and for other CLAUDE_ names', () => {
  assert.deepEqual(rules('src/entry/mcp.ts', `const t = process.env.CLAUDE_CODE_MESSAGING_TOKEN;`), []);
  assert.deepEqual(rules('src/git/env.ts', `const NEVER_PREFIXES = ['CLAUDE_', 'ELECTRON_', 'VSCODE_'];`), []);
  assert.deepEqual(rules(F, `const s = process.env.CLAUDE_CODE_MESSAGING_SOCKET;`), []);
});

test('L-GIT-ATOMIC flags --atomic as an argv element or inside a command string', () => {
  assert.deepEqual(rules(F, `await git.run(['push', '--porcelain', '--atomic', url, a, b], o);`), ['L-GIT-ATOMIC']);
  assert.deepEqual(rules(F, `const cmd = 'push --atomic';`), ['L-GIT-ATOMIC']);
});

test('L-GIT-ATOMIC passes for --no-atomic and for non-literal mentions', () => {
  assert.deepEqual(rules(F, 'await git.run([\'push\', \'--porcelain\', \'--no-verify\', \'--no-atomic\', url, `${c}:refs/cowork/${b}/code`], o);'), []);
  assert.deepEqual(rules(F, `const caps = { atomic: true, pushOptions: false };`), []);
});

test('L-CRASHPOINTS flags a non-literal crashpoint() argument; passes for literals and the port itself', () => {
  assert.deepEqual(rules(F, `crashpoint(name);`), ['L-CRASHPOINTS']);
  assert.deepEqual(rules(F, `crashpoint('apply.intent');`), []);
  assert.deepEqual(rules('src/ports/crashpoint.ts', `export function crashpoint(name: string): void { if (h) h(name); }\ncrashpoint(x);`), []);
});

test('lintCrashpoints flags call sites missing from the catalogue', () => {
  const f = lintCrashpoints(['apply.intent', 'apply.bogus', 'apply.bogus'], ['apply.intent', 'publish.sent']);
  assert.equal(f.length, 1);
  assert.equal(f[0]?.rule, 'L-CRASHPOINTS');
  assert.match(f[0]?.message ?? '', /apply\.bogus/);
});

test('lintCrashpoints passes when every call site is catalogued (catalogue may be larger)', () => {
  assert.deepEqual(lintCrashpoints([], ['apply.intent']), []);
  assert.deepEqual(lintCrashpoints(['apply.intent'], ['apply.intent', 'publish.sent']), []);
});

test('findings carry the 1-based line and a forward-slash file path', () => {
  const f = lintSource('src\\daemon\\x.ts', `const a = 1;\nconst b = Date.now();\n`);
  assert.deepEqual(f.map((x) => [x.rule, x.file, x.line]), [['L-CLOCK', 'src/daemon/x.ts', 2]]);
});
```

- [ ] **Step 2: Run the rule tests to verify they fail**

Run: `npx tsx --test test/unit/lint.rules.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `tools/lint/rules.js` (the module does not exist yet).

- [ ] **Step 3: Write the rules module**

`tools/lint/rules.ts`:

```ts
import ts from 'typescript';

export interface LintFinding { rule: string; file: string; line: number; message: string; }

// Files allowed to do what a rule otherwise forbids (repo-relative, forward slashes).
const ALLOW: Readonly<Record<string, readonly string[]>> = {
  'L-GIT-SPAWN': ['src/git/runner.ts'],
  'L-PORTS': ['src/git/runner.ts'],
  'L-CLOCK': ['src/ports/clock.ts'],
  'L-RANDOM': ['src/ports/random.ts'],
  'L-CRASHPOINTS': ['src/ports/crashpoint.ts'],
  // Empty in Plan 1. The IPC endpoint module (the only permitted `net` user, 11-testing §3.10
  // "net (outside IPC)") is added here by the plan that writes it.
  'L-NET': [],
  'L-TOKEN': ['src/entry/mcp.ts'],
};

const SPAWN_FNS: ReadonlySet<string> = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
const CHILD_PROCESS: ReadonlySet<string> = new Set(['child_process', 'node:child_process']);
const NET_MODULES: ReadonlySet<string> = new Set(['http', 'https', 'http2', 'tls', 'net', 'dgram', 'dns']);
const SET_LIKE: ReadonlySet<string> = new Set(['Set', 'Map', 'WeakSet', 'WeakMap']);
const MESSAGING_TOKEN = 'CLAUDE_CODE_MESSAGING_TOKEN';

function normalizeFile(file: string): string {
  return file.split('\\').join('/');
}

function allowed(rule: string, file: string): boolean {
  return (ALLOW[rule] ?? []).includes(file);
}

/**
 * Text of a string literal or a no-substitution template; for a template expression, its literal
 * parts joined with "${}" in place of each substitution (so `+${oid}:refs/x` reads "+${}:refs/x").
 */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => '${}' + s.literal.text).join('');
  return null;
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function propName(name: ts.PropertyName | ts.MemberName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  return null;
}

/**
 * The module a node loads, for the five load forms: `import … from 'm'`, `export … from 'm'`,
 * `import x = require('m')`, `require('m')` and `import('m')`. Null for anything else.
 */
function loadedModule(node: ts.Node): string | null {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier.text;
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
    && ts.isStringLiteralLike(node.moduleReference.expression)) {
    return node.moduleReference.expression.text;
  }
  if (ts.isCallExpression(node)) {
    const arg0 = node.arguments[0];
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
    const isDynImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    if ((isRequire || isDynImport) && arg0 !== undefined && ts.isStringLiteralLike(arg0)) return arg0.text;
  }
  return null;
}

/** `net`, `node:net`, `dns/promises`, `node:dns/promises`, … */
function isNetModule(spec: string): boolean {
  const bare = spec.startsWith('node:') ? spec.slice('node:'.length) : spec;
  return NET_MODULES.has(bare.split('/')[0] ?? '');
}

function containsLiteral(node: ts.Node, values: ReadonlySet<string>): boolean {
  let hit = false;
  const visit = (n: ts.Node): void => {
    if (hit) return;
    const t = literalText(n);
    if (t !== null && values.has(t)) { hit = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

/**
 * A git argv array: an array literal whose first element is a string literal (the subcommand),
 * that is not the argument of `new Set(...)` / `new Map(...)` (command-class tables are not argv).
 */
function argvOf(node: ts.ArrayLiteralExpression): string[] | null {
  const first = node.elements[0];
  if (first === undefined || literalText(first) === null || ts.isTemplateExpression(first)) return null;
  let p: ts.Node = node.parent;
  while (ts.isAsExpression(p) || ts.isParenthesizedExpression(p) || ts.isSatisfiesExpression(p)) p = p.parent;
  if (ts.isNewExpression(p) && ts.isIdentifier(p.expression) && SET_LIKE.has(p.expression.text)) return null;
  return node.elements.map((e) => literalText(e) ?? '');
}

function insideFetchArgv(node: ts.Node): boolean {
  const arr = node.parent;
  if (arr === undefined || !ts.isArrayLiteralExpression(arr)) return false;
  const argv = argvOf(arr);
  return argv !== null && argv[0] === 'fetch';
}

const PERMISSION_FORBIDDEN: ReadonlySet<string> = new Set(['allow', 'ask']);

export function lintSource(file: string, text: string): LintFinding[] {
  const f = normalizeFile(file);
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: LintFinding[] = [];
  const report = (rule: string, node: ts.Node, message: string): void => {
    if (allowed(rule, f)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    out.push({ rule, file: f, line, message });
  };

  const visit = (node: ts.Node): void => {
    // L-PORTS / L-NET: module loads (import, export-from, import-equals, require, dynamic import).
    const mod = loadedModule(node);
    if (mod !== null) {
      if (CHILD_PROCESS.has(mod)) report('L-PORTS', node, `child_process loaded outside src/git/runner.ts`);
      if (isNetModule(mod)) report('L-NET', node, `network module "${mod}" loaded (no network egress, INV-EGRESS)`);
    }
    if (ts.isCallExpression(node)) {
      const arg0 = node.arguments[0];
      const name = calleeName(node.expression);
      // L-GIT-SPAWN: spawn('git', ...) / exec('git ...').
      if (name !== null && SPAWN_FNS.has(name) && arg0 !== undefined) {
        const t = literalText(arg0);
        if (t !== null && (t === 'git' || t.startsWith('git ') || /(^|[\\/])git(\.exe)?$/i.test(t))) {
          report('L-GIT-SPAWN', node, `git spawned outside createGitRunner().run()`);
        }
      }
      // L-CLOCK: Date.now() / performance.now().
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'now'
        && ts.isIdentifier(node.expression.expression)
        && (node.expression.expression.text === 'Date' || node.expression.expression.text === 'performance')) {
        report('L-CLOCK', node, `${node.expression.expression.text}.now() outside the Clock port`);
      }
      // L-CRASHPOINTS: crashpoint() must name its point with a string literal.
      if (name === 'crashpoint' && (arg0 === undefined || !ts.isStringLiteral(arg0))) {
        report('L-CRASHPOINTS', node, `crashpoint() argument must be a string literal`);
      }
    }
    // L-CLOCK: new Date(...).
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Date') {
      report('L-CLOCK', node, `new Date() outside the Clock port`);
    }
    // L-RANDOM: Math.random, randomBytes, randomUUID (any reference).
    if (ts.isPropertyAccessExpression(node)) {
      const n = node.name.text;
      if (n === 'random' && ts.isIdentifier(node.expression) && node.expression.text === 'Math') {
        report('L-RANDOM', node, `Math.random outside the Random port`);
      }
      if (n === 'randomBytes' || n === 'randomUUID') report('L-RANDOM', node, `${n} outside the Random port`);
    }
    if (ts.isImportSpecifier(node)) {
      const imported = (node.propertyName ?? node.name).text;
      if (imported === 'randomBytes' || imported === 'randomUUID') report('L-RANDOM', node, `${imported} imported outside the Random port`);
    }
    // L-TOKEN: the messaging token as an identifier (process.env.X, destructured or object key).
    if (ts.isIdentifier(node) && node.text === MESSAGING_TOKEN) {
      report('L-TOKEN', node, `${MESSAGING_TOKEN} referenced outside src/entry/mcp.ts`);
    }
    // L-PERMISSION: permissionDecision "allow" / "ask".
    if ((ts.isPropertyAssignment(node) || ts.isPropertySignature(node) || ts.isPropertyDeclaration(node))
      && propName(node.name) === 'permissionDecision') {
      const values: (ts.Node | undefined)[] = ts.isPropertyAssignment(node) ? [node.initializer]
        : ts.isPropertyDeclaration(node) ? [node.type, node.initializer] : [node.type];
      if (values.some((v) => v !== undefined && containsLiteral(v, PERMISSION_FORBIDDEN))) {
        report('L-PERMISSION', node, `permissionDecision "allow"/"ask" is forbidden (only "deny" is emitted)`);
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const l = node.left;
      const target = ts.isPropertyAccessExpression(l) ? l.name.text
        : ts.isElementAccessExpression(l) ? literalText(l.argumentExpression) : null;
      if (target === 'permissionDecision' && containsLiteral(node.right, PERMISSION_FORBIDDEN)) {
        report('L-PERMISSION', node, `permissionDecision "allow"/"ask" is forbidden (only "deny" is emitted)`);
      }
    }
    // String literals and templates: L-REFS, L-MERGE-OPTS, L-TOKEN, L-GIT-ATOMIC.
    const lit = literalText(node);
    if (lit !== null) {
      if (lit.includes('refs/worktree/')) report('L-REFS', node, `refs/worktree/ is never used (common namespace only)`);
      if (lit === '--force') report('L-REFS', node, `--force is forbidden (use --force-with-lease)`);
      if (lit.startsWith('+') && lit.includes('refs/') && !insideFetchArgv(node)) {
        report('L-REFS', node, `"+" (forced) refspec is forbidden outside a fetch argv`);
      }
      if (lit.startsWith(':refs/') && !lit.startsWith(':refs/cowork/probe-') && !lit.startsWith(':refs/heads/cowork/probe-')) {
        report('L-REFS', node, `deletion refspec other than the probe ref`);
      }
      const tokens = lit.split(/\s+/);
      if (tokens.some((t) => t.startsWith('-X') || t.startsWith('--strategy-option'))
        || tokens.includes('--union') || lit.includes('merge=union')) {
        report('L-MERGE-OPTS', node, `-X / --strategy-option / --union / merge=union are forbidden (glossary §18)`);
      }
      if (lit.includes(MESSAGING_TOKEN)) report('L-TOKEN', node, `${MESSAGING_TOKEN} referenced outside src/entry/mcp.ts`);
      if (tokens.includes('--atomic')) report('L-GIT-ATOMIC', node, `--atomic is never used (glossary §26.2 item 1)`);
    }
    // Argv-shaped arrays: L-MERGE-BASE, L-MERGE-OPTS (merge-file), L-HASH-STDIN.
    if (ts.isArrayLiteralExpression(node)) {
      const argv = argvOf(node);
      if (argv !== null) {
        const sub = argv[0];
        if (sub === 'merge-base') report('L-MERGE-BASE', node, `git merge-base is forbidden (explicit bases only)`);
        if (sub === 'merge-tree' && !argv.some((a) => a === '--merge-base' || a.startsWith('--merge-base='))) {
          report('L-MERGE-BASE', node, `merge-tree without --merge-base`);
        }
        if (sub === 'merge-file' && !argv.includes('--object-id')) {
          report('L-MERGE-OPTS', node, `merge-file without --object-id`);
        }
        if (sub === 'hash-object' && argv.includes('--stdin') && !argv.includes('--no-filters')
          && !argv.some((a) => a === '--path' || a.startsWith('--path='))) {
          report('L-HASH-STDIN', node, `hash-object --stdin without --path`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export function lintCrashpoints(callSites: string[], catalogue: string[]): LintFinding[] {
  const known = new Set(catalogue);
  const out: LintFinding[] = [];
  for (const name of [...new Set(callSites)].sort()) {
    if (!known.has(name)) {
      out.push({ rule: 'L-CRASHPOINTS', file: 'test/crashpoints.json', line: 1, message: `crashpoint "${name}" is called but not in test/crashpoints.json` });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the rule tests to verify they pass**

Run: `npx tsx --test test/unit/lint.rules.test.ts`
Expected: PASS — 28 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add tools/lint/rules.ts test/unit/lint.rules.test.ts
git commit -m "feat(lint): AST rules L-GIT-SPAWN, L-PORTS, L-NET, L-CLOCK, L-RANDOM, L-PERMISSION, L-REFS, L-MERGE-BASE, L-MERGE-OPTS, L-HASH-STDIN, L-TOKEN, L-GIT-ATOMIC, L-CRASHPOINTS" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Write the failing CLI test**

The CLI is run as a real process (`node --import tsx`, Node ≥ 20.6) against a temp tree under `makeTempRoot()`, so the path with spaces and non-ASCII characters (Review Focus 1) is exercised too. The second test pins exit code 2 for a bad catalogue: every case also contains a `Date.now()` finding, so a CLI that ignored the catalogue error would exit 1, not 2.

`test/integration/lint.cli.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempRoot } from '../helpers/tmp.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const LINT = fileURLToPath(new URL('../../tools/lint/lint.ts', import.meta.url));

function runLint(root: string): { code: number | null; stdout: string; stderr: string } {
  // cwd = repo root so `--import tsx` resolves from this repo's node_modules.
  const r = spawnSync(process.execPath, ['--import', 'tsx', LINT, '--root', root], { cwd: REPO, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

async function put(root: string, rel: string, text: string): Promise<void> {
  const full = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, Buffer.from(text, 'utf8'));
}

test('lint CLI exits 0 on a clean tree and 1 with rule ids on a dirty one', async () => {
  const { root, cleanup } = await makeTempRoot('lint-cli');
  try {
    await put(root, 'test/crashpoints.json', JSON.stringify(['apply.intent']) + '\n');
    await put(root, 'src/ports/clock.ts', 'export const now = (): number => Date.now();\n');
    await put(root, 'src/engine/apply.ts', "import { crashpoint } from '../ports/crashpoint.js';\ncrashpoint('apply.intent');\n");
    const clean = runLint(root);
    assert.equal(clean.code, 0, clean.stderr);
    assert.match(clean.stdout, /lint: 2 files, 0 findings/);

    await put(root, 'src/engine/bad.ts', "const t = Date.now();\ncrashpoint('apply.bogus');\n");
    const dirty = runLint(root);
    assert.equal(dirty.code, 1);
    assert.match(dirty.stderr, /^L-CLOCK src\/engine\/bad\.ts:1 /m);
    assert.match(dirty.stderr, /^L-CRASHPOINTS test\/crashpoints\.json:1 .*apply\.bogus/m);
  } finally {
    await cleanup();
  }
});

test('lint CLI exits 2 when test/crashpoints.json is missing, unreadable, not JSON or not a string array', async () => {
  const cases: { label: string; setup: (root: string) => Promise<void>; why: RegExp }[] = [
    { label: 'missing', setup: async () => {}, why: /cannot read \(ENOENT\)/ },
    { label: 'a directory', setup: async (root) => { await mkdir(path.join(root, 'test', 'crashpoints.json'), { recursive: true }); }, why: /cannot read \(EISDIR\)/ },
    { label: 'not JSON', setup: (root) => put(root, 'test/crashpoints.json', 'apply.intent\n'), why: /not valid JSON/ },
    { label: 'object form', setup: (root) => put(root, 'test/crashpoints.json', JSON.stringify({ crashpoints: ['apply.intent'] }) + '\n'), why: /expected a JSON array of strings/ },
    { label: 'non-string entry', setup: (root) => put(root, 'test/crashpoints.json', JSON.stringify(['apply.intent', 1]) + '\n'), why: /expected a JSON array of strings/ },
  ];
  for (const [i, c] of cases.entries()) {
    const { root, cleanup } = await makeTempRoot(`lint-cli-cat-${i}`);
    try {
      await c.setup(root);
      await put(root, 'src/engine/bad.ts', 'const t = Date.now();\n');
      const r = runLint(root);
      assert.equal(r.code, 2, `${c.label}: ${r.stderr}`);
      assert.match(r.stderr, /^lint: test\/crashpoints\.json: /m, c.label);
      assert.match(r.stderr, c.why, c.label);
      assert.doesNotMatch(r.stdout, /files, \d+ findings/, c.label);
    } finally {
      await cleanup();
    }
  }
});
```

- [ ] **Step 7: Run the CLI test to verify it fails**

Run: `npx tsx --test test/integration/lint.cli.test.ts`
Expected: FAIL — 2 tests, 2 failures: node exits 1 with `ERR_MODULE_NOT_FOUND` for `tools/lint/lint.ts`, so the first test fails on `clean.code` (`1 !== 0`) and the second on its first case (`missing: …`, `1 !== 2`).

- [ ] **Step 8: Write the CLI**

The catalogue is exactly Task 6's format, a JSON array of strings. Anything else is a catalogue error with exit 2: a missing file (Task 6 always ships it, so its absence is a broken checkout, not an empty catalogue), an unreadable path, invalid JSON, or any other JSON shape. The catalogue is read before any source file is linted, so a catalogue error never mixes with findings.

`tools/lint/lint.ts`:

```ts
// CLI: lint every src/**/*.ts under --root (default: the current directory).
// Exit 0 with no findings, 1 with findings, 2 on a usage or catalogue error.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { lintCrashpoints, lintSource, type LintFinding } from './rules.js';

const CRASHPOINT_PORT = 'src/ports/crashpoint.ts';
const CATALOGUE = 'test/crashpoints.json';

async function listTs(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listTs(full)));
    else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function crashpointNames(file: string, text: string): string[] {
  if (file === CRASHPOINT_PORT) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      const arg0 = node.arguments[0];
      if (name === 'crashpoint' && arg0 !== undefined && ts.isStringLiteral(arg0)) names.push(arg0.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/** Task 6 format only: a JSON array of strings. Every other outcome throws (exit 2). */
async function readCatalogue(root: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path.join(root, ...CATALOGUE.split('/')), 'utf8');
  } catch (e) {
    throw new Error(`${CATALOGUE}: cannot read (${(e as NodeJS.ErrnoException).code ?? String(e)})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`${CATALOGUE}: not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!Array.isArray(json) || !json.every((x: unknown) => typeof x === 'string')) {
    throw new Error(`${CATALOGUE}: expected a JSON array of strings (Task 6 format)`);
  }
  return json as string[];
}

async function main(argv: string[]): Promise<number> {
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1] !== undefined) root = path.resolve(argv[++i] as string);
    else { process.stderr.write(`lint: unknown argument ${argv[i]}\n`); return 2; }
  }
  const catalogue = await readCatalogue(root);
  const files = await listTs(path.join(root, 'src'));
  const findings: LintFinding[] = [];
  const callSites: string[] = [];
  for (const full of files) {
    const rel = path.relative(root, full).split(path.sep).join('/');
    const text = await readFile(full, 'utf8');
    findings.push(...lintSource(rel, text));
    callSites.push(...crashpointNames(rel, text));
  }
  findings.push(...lintCrashpoints(callSites, catalogue));
  for (const f of findings) process.stderr.write(`${f.rule} ${f.file}:${f.line} ${f.message}\n`);
  process.stdout.write(`lint: ${files.length} files, ${findings.length} findings\n`);
  return findings.length === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e: unknown) => { process.stderr.write(`lint: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 2; },
);
```

- [ ] **Step 9: Run the CLI test to verify it passes**

Run: `npx tsx --test test/integration/lint.cli.test.ts`
Expected: PASS — 2 tests, 0 failures.

- [ ] **Step 10: Wire `npm run lint` and lint the real tree**

Run:

```bash
npm pkg set scripts.lint="tsx tools/lint/lint.ts"
npm run lint
```

Expected: exit 0 and `lint: <n> files, 0 findings` (n = the number of `src/**/*.ts` files from Tasks 1–10). In particular `src/git/env.ts` drops the messaging token through its `CLAUDE_` never-list prefix, never by name, so L-TOKEN stays silent; `src/git/flags.ts` keeps its command tables in `new Set([...])`, so the argv rules stay silent. A finding here is either a real port bypass in Tasks 1–10 (fix that code) or a false positive of the argv heuristic (for example a plain array table whose first element is `'merge-tree'` or `'merge-file'`): fix the rule, add the case as a should-pass test in `test/unit/lint.rules.test.ts`, and rerun Steps 4, 9 and 10. Never add a file to `ALLOW` to silence a finding.

- [ ] **Step 11: Commit**

```bash
git add tools/lint/lint.ts test/integration/lint.cli.test.ts package.json
git commit -m "feat(lint): lint CLI over src/**/*.ts with strict crashpoint catalogue (exit 2 on catalogue error); npm run lint" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: SIM smoke CLI, CI workflow and `npm run ci`

**Files:**
- Create: `tools/sim/smoke.ts` (CLI behind `npm run sim:smoke`)
- Create: `.github/workflows/ci.yml`
- Modify: `package.json` with `npm pkg set` only: add `scripts.sim:smoke` = `tsx tools/sim/smoke.ts`; set `scripts.ci` = `npm run lint && npm run typecheck && npm run build && npm test && npm run sim:smoke` (Task 1's value plus the smoke gate). Nothing else in `package.json` changes (`engines.node` stays `>=20.6` from Task 1, `scripts.lint` stays `tsx tools/lint/lint.ts` from Task 14).
- Test: `test/integration/sim.smoke.cli.test.ts`
- Test: `test/unit/ci-config.test.ts`

**Interfaces:**
- Consumes:
  - `runSim(t: SeedTuple, makeEngine: EngineFactory, oracles: Oracle[]): Promise<SimResult>`, `type SeedTuple`, `type SimResult` (fields `ok`, `failure?: { oracle, message, step }`, `opLog`, `remoteRefs`, `artifactsDir?`) (Task 13, `test/sim/harness.ts`). A failed run keeps its temp root `<mkdtemp base>/공 백 dir` with `artifactsDir` = `<root>/artifacts`, and the caller deletes the `cowork-sim-*` base.
  - `naiveEngine(opts?: { forcePush?: boolean }): EngineFactory`; its op-log entries `{ kind: 'push', detail: 'ok <oid>' | 'rejected <oid> code=<n> <git output, paths masked>' }`, one per push attempt (a rejected push is retried within the same step), and the ref it publishes, `refs/cowork/main/code` (Task 13, `test/sim/naiveEngine.ts`). Only the `ok ` / `rejected ` prefix is matched. The words after `code=<n>` come from git and are not a contract.
  - `oracleFF(refPrefix: string): Oracle` (name `'INV-FF'`, message `… not a first-parent fast-forward` for a forced overwrite), `oracleOID(allowedDeletePrefixes: string[]): Oracle` (name `'INV-OID'`) (Task 13, `test/sim/oracles.ts`, signatures as in 00-header.md)
  - The mutant SeedTuple `{ seed: 'naive-mutant', peers: 3, ops: 12 }` that Task 13's `sim.naive.test.ts` proves is killed by INV-FF. If Task 13 had to pick another seed (its Step 14), use that seed here too.
  - npm scripts: `lint` → `tsx tools/lint/lint.ts` (Task 14); `typecheck` → `tsc -p tsconfig.json`, `build` → `node tools/build/build.mjs`, `test` → `node tools/test/run-tests.mjs test/unit test/integration` (Task 1); `package-lock.json` committed by Task 1 (required by `npm ci`); `engines.node` = `>=20.6` (Task 1); `.gitattributes` `* text=auto eol=lf` and `*.json -diff` (already present).
- Produces:
  - CLI `tools/sim/smoke.ts [--seeds <n>] [--peers <n>] [--ops <n>] [--seed <s>]... [--force-push-mutant]`, run by `npm run sim:smoke`. Defaults: 10 seeds named `smoke-0 … smoke-9`, 3 peers, 20 ops, `naiveEngine()`, oracles `[oracleFF('refs/cowork/'), oracleOID(['refs/cowork/probe-'])]`. Seeds run one after another. A seed passes when `runSim` returns `ok: true`, every one of the `ops` steps has landed, and `refs/cowork/main/code` exists on the remote. A step has landed when any of its push attempts logged detail `ok <oid>`, so a single rejection that the engine's retry absorbed does not fail the seed. The liveness failure names the first step that did not land: `LIVENESS at step <s>: <k> of <ops> steps landed a push`. Per passing seed, stdout gets `sim:smoke ok <seed> peers=<p> ops=<o> code=<oid> <ms>ms`. A passing seed that has `rejected` push attempts also writes, to stderr only, `sim:smoke note <seed>: <k> rejected push attempt(s) retried, every step landed` and then one `  #<step> <peer> push <detail>` line per rejected attempt, so a rejection seen only in CI can still be diagnosed. Per failing seed, stderr gets `sim:smoke FAIL <seed> <ORACLE|LIVENESS> at step <n>: <message>` (or `sim:smoke FAIL <seed> ERROR: <stack>` when `runSim` throws), then `  rerun: npm run sim:smoke -- --seed <seed> --peers <p> --ops <o>[ --force-push-mutant]`, then `  artifacts: <dir>` when `runSim` kept the run's artifacts (`SimResult.artifactsDir`; the CLI never deletes them, and the kept temp root is `dirname(dirname(<dir>))`), and the last 6 op-log entries as `  #<step> <peer> <kind> <detail>`. The last stdout line is `sim:smoke: <n> seeds, <k> failures`. Exit 0 when every seed passes, 1 when any seed fails, 2 on a usage error (stderr `sim:smoke: <reason>`) or an unexpected internal error. `--seed` (repeatable) replaces the `smoke-<i>` list; `--force-push-mutant` runs `naiveEngine({ forcePush: true })` so the gate can be shown to go red.
  - `.github/workflows/ci.yml`: job `test`, matrix `os: [windows-latest, macos-latest, ubuntu-latest]` × `node: ['20.x', '24.x']` (6 legs, `fail-fast: false`, 20-minute budget per leg, 11-testing §3.11). `20.x` resolves to the newest Node 20 release, which satisfies the `>=20.6` dev-tooling floor. Steps: `core.autocrlf=true` on Windows **before** checkout (TST-13 Windows profile), checkout, setup-node with npm cache, print tool versions, `npm ci`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`, `npm run sim:smoke`.
  - `npm run ci` = `npm run lint && npm run typecheck && npm run build && npm test && npm run sim:smoke`: the same five gates as the hosted legs, in the same order (pinned by a test), so `tsc` and the SIM smoke run both on a PC and on every hosted leg.

Plan 1 runs a 10-seed SIM smoke per leg with the harness self-test engine (11-testing §3.11; the 100-seed-per-leg and 200-seed-per-OS budgets of glossary §20 start with Plan 2's real engine). The seeds are fixed, so a red leg is reproduced locally with the `rerun:` line it prints. Plan 1 runs whatever git each hosted runner ships (Git for Windows on windows-latest). The floor-git (2.43.x) legs and the `de_DE`/`ko_KR` L10N leg of 11-testing §3.11 need a pinned git install per OS and arrive with the plan that adds the classifier and quoting tests; `meetsFloor` (Task 7) already rejects older versions in code.

- [ ] **Step 1: Write the failing smoke CLI test**

The CLI runs as a real process (`node --import tsx`, Node ≥ 20.6), like the lint CLI test of Task 14. Three cases: a small passing run, the force-push mutant going red with a rerun line and an `artifacts:` line, and usage errors. The mutant run keeps its temp root (Task 13), so the test deletes it in `finally`, but only if it is a `cowork-sim-*` directory. Otherwise every `npm test` would leave one `cowork-sim-*` directory (a bare remote and three clones) in the OS temp directory.

`test/integration/sim.smoke.cli.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SMOKE = fileURLToPath(new URL('../../tools/sim/smoke.ts', import.meta.url));

function runSmoke(args: string[]): { code: number | null; stdout: string; stderr: string } {
  // cwd = repo root so `--import tsx` resolves from this repo's node_modules (Node >= 20.6).
  const r = spawnSync(process.execPath, ['--import', 'tsx', SMOKE, ...args], { cwd: REPO, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('sim:smoke passes a small NaiveEngine run and prints one line per seed', () => {
  const r = runSmoke(['--seeds', '2', '--peers', '2', '--ops', '3']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^sim:smoke ok smoke-0 peers=2 ops=3 code=[0-9a-f]{40,64} \d+ms$/m);
  assert.match(r.stdout, /^sim:smoke ok smoke-1 peers=2 ops=3 code=[0-9a-f]{40,64} \d+ms$/m);
  assert.match(r.stdout, /^sim:smoke: 2 seeds, 0 failures$/m);
});

test('sim:smoke goes red on the force-push mutant and prints a rerun line and the kept artifacts', () => {
  // The SeedTuple Task 13's sim.naive.test.ts proves INV-FF kills.
  const r = runSmoke(['--seed', 'naive-mutant', '--peers', '3', '--ops', '12', '--force-push-mutant']);
  // runSim keeps the temp root of a failed run (Task 13); artifacts is <mkdtemp base>/공 백 dir/artifacts.
  const kept = /^ {2}artifacts: (.+)$/m.exec(r.stderr)?.[1];
  try {
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /^sim:smoke FAIL naive-mutant INV-FF at step \d+: .*not a first-parent fast-forward$/m);
    assert.match(r.stderr, /^ {2}rerun: npm run sim:smoke -- --seed naive-mutant --peers 3 --ops 12 --force-push-mutant\n {2}artifacts: .+[\\/]공 백 dir[\\/]artifacts$/m);
    assert.ok(kept !== undefined && existsSync(join(kept, 'op-log.jsonl')), r.stderr);
    assert.match(r.stderr, /^ {2}#\d+ p\d push ok [0-9a-f]{40,64}$/m);
    assert.match(r.stdout, /^sim:smoke: 1 seeds, 1 failures$/m);
  } finally {
    // Remove the kept root, but only if it is a SIM temp root (makeTempRoot('sim'), Task 9).
    const root = kept === undefined ? undefined : dirname(dirname(kept));
    if (root !== undefined && basename(root).startsWith('cowork-sim-')) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('sim:smoke rejects bad arguments with exit 2', () => {
  for (const args of [['--bogus'], ['--seeds', '0'], ['--peers', 'x'], ['--ops'], ['--seed']]) {
    const r = runSmoke(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^sim:smoke: /m, args.join(' '));
  }
});
```

- [ ] **Step 2: Run the smoke CLI test to verify it fails**

Run: `npx tsx --test test/integration/sim.smoke.cli.test.ts`
Expected: FAIL — `tests 3`, `pass 0`, `fail 3`. Node cannot load `tools/sim/smoke.ts` (`ERR_MODULE_NOT_FOUND` on stderr, exit 1), so the passing-run test fails on `code` (1, not 0), the mutant test fails on the `sim:smoke FAIL naive-mutant INV-FF` stderr match, and the usage test fails on `code` (1, not 2).

- [ ] **Step 3: Write the smoke CLI**

`tools/sim/smoke.ts`:

```ts
// SIM smoke gate (11-testing §3.3 harness, §3.11 CI; Plan 1 budget: 10 seeds per leg).
// Runs runSim() with the NaiveEngine and the INV-FF / INV-OID oracles over fixed seeds
// smoke-0 … smoke-<n-1>, one after another, and fails when any seed fails.
//
// Usage: tsx tools/sim/smoke.ts [--seeds <n>] [--peers <n>] [--ops <n>] [--seed <s>]... [--force-push-mutant]
//   defaults: --seeds 10 --peers 3 --ops 20; --seed (repeatable) replaces the smoke-<i> list;
//   --force-push-mutant runs naiveEngine({ forcePush: true }) to show the gate going red.
// Exit: 0 every seed passed, 1 a seed failed (oracle, liveness or thrown error),
//       2 usage error or unexpected internal error.
// tools/ is outside src/, so the L-CLOCK lint does not apply to performance.now() here.
import { runSim, type SeedTuple, type SimResult } from '../../test/sim/harness.js';
import { naiveEngine } from '../../test/sim/naiveEngine.js';
import { oracleFF, oracleOID } from '../../test/sim/oracles.js';

const CODE_REF = 'refs/cowork/main/code';
const DEFAULT_SEEDS = 10;
const DEFAULT_PEERS = 3;
const DEFAULT_OPS = 20;
const OPLOG_TAIL = 6;

class UsageError extends Error {}

interface SmokeArgs { seeds: string[]; peers: number; ops: number; forcePush: boolean; }

const out = (line: string): void => { process.stdout.write(`${line}\n`); };
const err = (line: string): void => { process.stderr.write(`${line}\n`); };

function positiveInt(flag: string, v: string | undefined): number {
  if (v === undefined || !/^[1-9][0-9]*$/.test(v)) throw new UsageError(`${flag} needs a positive integer, got ${v ?? '(nothing)'}`);
  return Number(v);
}

function parseArgs(argv: readonly string[]): SmokeArgs {
  let count = DEFAULT_SEEDS;
  let peers = DEFAULT_PEERS;
  let ops = DEFAULT_OPS;
  let forcePush = false;
  const only: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seeds') count = positiveInt(a, argv[++i]);
    else if (a === '--peers') peers = positiveInt(a, argv[++i]);
    else if (a === '--ops') ops = positiveInt(a, argv[++i]);
    else if (a === '--seed') {
      const s = argv[++i];
      if (s === undefined || s === '' || s.startsWith('--')) throw new UsageError('--seed needs a value');
      only.push(s);
    } else if (a === '--force-push-mutant') forcePush = true;
    else throw new UsageError(`unknown argument ${a}`);
  }
  const seeds = only.length > 0 ? only : Array.from({ length: count }, (_, i) => `smoke-${i}`);
  return { seeds, peers, ops, forcePush };
}

function rerunHint(seed: string, a: SmokeArgs): string {
  return `npm run sim:smoke -- --seed ${seed} --peers ${a.peers} --ops ${a.ops}${a.forcePush ? ' --force-push-mutant' : ''}`;
}

/** null when the seed passed; otherwise "<ORACLE|LIVENESS> at step <n>: <message>". */
function verdict(r: SimResult, ops: number): string | null {
  if (!r.ok) {
    const f = r.failure;
    return f === undefined ? 'UNKNOWN at step ?: runSim returned ok=false without a failure' : `${f.oracle} at step ${f.step}: ${f.message}`;
  }
  // Liveness: an engine whose pushes silently stop landing would pass both oracles trivially.
  // A step has landed when any of its push attempts did (the engine retries a rejected push).
  const landed = new Set(r.opLog.filter((e) => e.kind === 'push' && e.detail.startsWith('ok ')).map((e) => e.step));
  if (landed.size !== ops) {
    let miss = 0;
    while (landed.has(miss)) miss++;
    return `LIVENESS at step ${miss}: ${landed.size} of ${ops} steps landed a push`;
  }
  if (r.remoteRefs[CODE_REF] === undefined) return `LIVENESS at step ${ops}: ${CODE_REF} is missing on the remote`;
  return null;
}

async function main(argv: readonly string[]): Promise<number> {
  let args: SmokeArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) { err(`sim:smoke: ${e.message}`); return 2; }
    throw e;
  }
  let failures = 0;
  for (const seed of args.seeds) {
    const t: SeedTuple = { seed, peers: args.peers, ops: args.ops };
    const started = performance.now();
    let result: SimResult | undefined;
    let problem: string | null;
    try {
      result = await runSim(t, naiveEngine({ forcePush: args.forcePush }), [oracleFF('refs/cowork/'), oracleOID(['refs/cowork/probe-'])]);
      problem = verdict(result, args.ops);
    } catch (e) {
      problem = `ERROR: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`;
    }
    const ms = Math.round(performance.now() - started);
    if (problem === null && result !== undefined) {
      out(`sim:smoke ok ${seed} peers=${t.peers} ops=${t.ops} code=${result.remoteRefs[CODE_REF]} ${ms}ms`);
      // A rejection the engine's retry absorbed does not fail the seed; name it on stderr so a
      // CI-only rejection can still be diagnosed.
      const retried = result.opLog.filter((e) => e.kind === 'push' && e.detail.startsWith('rejected '));
      if (retried.length > 0) err(`sim:smoke note ${seed}: ${retried.length} rejected push attempt(s) retried, every step landed`);
      for (const e of retried) err(`  #${e.step} ${e.peer} ${e.kind} ${e.detail}`);
      continue;
    }
    failures++;
    err(`sim:smoke FAIL ${seed} ${problem ?? 'ERROR: no result'}`);
    err(`  rerun: ${rerunHint(seed, args)}`);
    // runSim keeps the temp root of a failed run; whoever reads this deletes dirname(dirname(<dir>)).
    if (result?.artifactsDir !== undefined) err(`  artifacts: ${result.artifactsDir}`);
    for (const e of result?.opLog.slice(-OPLOG_TAIL) ?? []) err(`  #${e.step} ${e.peer} ${e.kind} ${e.detail}`);
  }
  out(`sim:smoke: ${args.seeds.length} seeds, ${failures} failures`);
  return failures === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e: unknown) => { err(`sim:smoke: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`); process.exitCode = 2; },
);
```

- [ ] **Step 4: Run the smoke CLI test to verify it passes**

Run: `npx tsx --test test/integration/sim.smoke.cli.test.ts`
Expected: PASS — 3 tests, 0 failures, and no new `cowork-sim-*` directory in the OS temp directory. If the mutant test fails on `code` 0 with `sim:smoke ok naive-mutant`, the SeedTuple no longer lets another peer publish between two steps of one peer: use the seed Task 13's mutant test uses (it was chosen for exactly this), do not weaken INV-FF.

- [ ] **Step 5: Wire `npm run sim:smoke` and run the real smoke**

Run (Git Bash or PowerShell, same commands):

```bash
npm pkg set "scripts.sim:smoke=tsx tools/sim/smoke.ts"
npm run sim:smoke
```

Expected: ten stdout lines `sim:smoke ok smoke-<i> peers=3 ops=20 code=<oid> <ms>ms` for `i = 0 … 9`, then `sim:smoke: 10 seeds, 0 failures`, exit code 0 (`echo $?` in Git Bash, `$LASTEXITCODE` in PowerShell). Note the total of the `<ms>` values: on the Windows legs it must fit, together with `npm test`, inside the 20-minute per-leg budget. A `FAIL` line here is a defect in Tasks 11–13 (fixtures, harness or NaiveEngine); reproduce it with the printed `rerun:` line and fix it there. A `sim:smoke note` on stderr is not a failure: a push was rejected and the engine's retry landed the step. If notes show up on every run, find out why pushes to the local remote get rejected instead of relying on the retry.

- [ ] **Step 6: Commit**

```bash
git add tools/sim/smoke.ts test/integration/sim.smoke.cli.test.ts package.json
git commit -m "test(sim): npm run sim:smoke, NaiveEngine over 10 fixed seeds x 3 peers x 20 ops with INV-FF/INV-OID" -m "Liveness: a seed passes only when every step has a push attempt that landed; rejections the engine retried are named on stderr. A failing seed prints where runSim kept its artifacts, and the mutant CLI test deletes that temp root." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Write the failing CI configuration test**

The test reads the workflow as text (no YAML dependency) and checks the matrix, the step order and the scripts. The scripts test pins `ci` (it must include `npm run typecheck` and `npm run sim:smoke`), `typecheck`, `lint` and `sim:smoke`, so dropping a gate later turns it red. The last test pins that the hosted legs run exactly the gates of `npm run ci`, in the same order.

`test/unit/ci-config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = new URL('../../', import.meta.url);
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, REPO)), 'utf8');
const scripts = (): Record<string, string> =>
  (JSON.parse(read('package.json')) as { scripts?: Record<string, string> }).scripts ?? {};

const CI_GATES = 'npm run lint && npm run typecheck && npm run build && npm test && npm run sim:smoke';

test('ci.yml runs the os x node matrix', () => {
  const y = read('.github/workflows/ci.yml');
  assert.match(y, /^\s+os: \[windows-latest, macos-latest, ubuntu-latest\]$/m);
  assert.match(y, /^\s+node: \['20\.x', '24\.x'\]$/m);
  assert.match(y, /^\s+fail-fast: false$/m);
  assert.match(y, /^\s+node-version: \$\{\{ matrix\.node \}\}$/m);
});

test('ci.yml sets core.autocrlf=true on Windows before checkout, then npm ci, lint, typecheck, build, test, sim:smoke in order', () => {
  const y = read('.github/workflows/ci.yml');
  const order = [
    "if: runner.os == 'Windows'",
    'run: git config --global core.autocrlf true',
    'uses: actions/checkout@',
    'uses: actions/setup-node@',
    'run: npm ci',
    'run: npm run lint',
    'run: npm run typecheck',
    'run: npm run build',
    'run: npm test',
    'run: npm run sim:smoke',
  ].map((s) => {
    const i = y.indexOf(s);
    assert.notEqual(i, -1, `missing: ${s}`);
    return i;
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('ci.yml is LF-only and tab-free', () => {
  const y = read('.github/workflows/ci.yml');
  assert.equal(y.includes('\r'), false);
  assert.equal(y.includes('\t'), false);
});

test('npm run ci includes typecheck and sim:smoke; lint and sim:smoke run their CLIs', () => {
  const s = scripts();
  assert.equal(s['ci'], CI_GATES);
  assert.equal(s['typecheck'], 'tsc -p tsconfig.json');
  assert.equal(s['lint'], 'tsx tools/lint/lint.ts');
  assert.equal(s['sim:smoke'], 'tsx tools/sim/smoke.ts');
});

test('ci.yml runs exactly the gates of npm run ci, in the same order', () => {
  const y = read('.github/workflows/ci.yml');
  const steps = [...y.matchAll(/^\s+(?:- )?run: (npm (?:test|run [\w:-]+))$/gm)].map((m) => m[1]);
  assert.deepEqual(steps, (scripts()['ci'] ?? '').split(' && '));
});
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `npx tsx --test test/unit/ci-config.test.ts`
Expected: FAIL — `tests 5`, `pass 0`, `fail 5`. The four tests that read the workflow throw `ENOENT: no such file or directory, open '...\.github\workflows\ci.yml'` (forward slashes on macOS/Linux). The scripts test fails on `scripts.ci`: actual `'npm run lint && npm run typecheck && npm run build && npm test'` (Task 1's value), expected `'npm run lint && npm run typecheck && npm run build && npm test && npm run sim:smoke'`.

- [ ] **Step 9: Add the smoke gate to `npm run ci`**

Run (Git Bash or PowerShell, same commands):

```bash
npm pkg set "scripts.ci=npm run lint && npm run typecheck && npm run build && npm test && npm run sim:smoke"
npm pkg get scripts.ci scripts.lint scripts.typecheck scripts.sim:smoke
```

Expected:

```
{
  "scripts.ci": "npm run lint && npm run typecheck && npm run build && npm test && npm run sim:smoke",
  "scripts.lint": "tsx tools/lint/lint.ts",
  "scripts.typecheck": "tsc -p tsconfig.json",
  "scripts.sim:smoke": "tsx tools/sim/smoke.ts"
}
```

`git diff --text package.json` shows exactly one changed line, the `"ci"` script (`.gitattributes` marks `*.json -diff`, so a plain `git diff` only says `Binary files ... differ`). If `scripts.lint` or `scripts.typecheck` differs, Task 14 or Task 1 did not finish: fix it there, not here.

- [ ] **Step 10: Write the workflow**

`.github/workflows/ci.yml`:

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    name: ${{ matrix.os }} / node ${{ matrix.node }}
    runs-on: ${{ matrix.os }}
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, macos-latest, ubuntu-latest]
        # 20.x = newest Node 20, which meets the >=20.6 dev-tooling floor (package.json engines).
        node: ['20.x', '24.x']
    steps:
      # Windows legs use the Git for Windows checkout profile (11-testing TST-13); set it before checkout.
      - name: core.autocrlf=true (Windows)
        if: runner.os == 'Windows'
        run: git config --global core.autocrlf true
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - name: Tool versions
        run: |
          git --version
          node --version
          npm --version
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run build
      - run: npm test
      # Plan 1 budget (11-testing §3.11): 10 fixed seeds x 3 peers x 20 ops with the NaiveEngine.
      - name: SIM smoke (NaiveEngine, 10 seeds)
        run: npm run sim:smoke
```

The workflow sets no git identity on purpose: every fixture and engine commit passes its identity through `GitCallOptions` (Review Focus 4), so a fixture that silently depends on the runner's global `user.name` fails here instead of on a teammate's PC.

- [ ] **Step 11: Run the test to verify it passes**

Run: `npx tsx --test test/unit/ci-config.test.ts`
Expected: PASS — 5 tests, 0 failures.

- [ ] **Step 12: Verify `npm run ci` locally**

Run: `npm run ci`
Expected: exit code 0, with in order: `lint: <n> files, 0 findings`; `tsc -p tsconfig.json` finishing with no diagnostics (no output); the Task 1 build writing the six `dist/*.js` entry points; `npm test` reporting every unit and integration test of Tasks 1–15 passing and `fail 0`; `sim:smoke ok smoke-0 …` through `smoke-9` and `sim:smoke: 10 seeds, 0 failures`. Afterwards no `cowork-sim-*` directory is left in the OS temp directory. Confirm the exit code (`echo $?` in Git Bash, `$LASTEXITCODE` in PowerShell) is `0`. Any failure is fixed in the task that owns the failing file before committing.

- [ ] **Step 13: Commit**

```bash
git add .github/workflows/ci.yml test/unit/ci-config.test.ts package.json
git commit -m "ci: GitHub Actions matrix (windows/macos/ubuntu x node 20.x/24.x) with typecheck and SIM smoke; npm run ci runs the same five gates" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 14: Confirm the hosted run (after the branch is pushed)**

When the branch is pushed to GitHub, open the repository's Actions tab and check the `ci` run: six legs named `<os> / node <20.x|24.x>`, each green, with `npm run typecheck` between `npm run lint` and `npm run build`, `SIM smoke (NaiveEngine, 10 seeds)` last and printing `sim:smoke: 10 seeds, 0 failures`, and on the two Windows legs the `core.autocrlf=true (Windows)` step before `actions/checkout`. The `Tool versions` step of the Node 20 legs must print `v20.6.0` or newer. A leg that is red only on one OS is a real cross-platform defect (paths, CRLF, process-tree kill): reproduce a smoke failure locally with its `rerun:` line and fix it in the owning task's code; never mark the leg `continue-on-error`.
