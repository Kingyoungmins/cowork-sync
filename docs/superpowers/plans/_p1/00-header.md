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
