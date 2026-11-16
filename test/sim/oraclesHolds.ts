// The 05 oracle rows of the SIM (Plan 3 Task 14; 11-testing §3.4, §3.8, §3.9; TST-07; glossary §21; 05-holds §5; rulings R3-49, R3-50,
// R3-63, R3-67, R3-75):
//
//   INV-MASK         every new `mask` event: the test-side MASK (testMask) of S_disk over the registry the event names equals the engine's
//                    S_pub (inspect().sPub, for the peer's last `mask` event of the step) and the event's withheld/partial/conflicted sets;
//                    no QUARANTINED/SAVE_ONLY/UNMANAGED/LOCAL_ONLY or withheld path differs from A in S_pub; re-applying every ON_DISK
//                    ACTIVE PATCH of a partial path to S_pub reproduces what re-applying it to S_disk gives (HLD-19, read as R3-75:
//                    S_disk itself whenever the held change is on disk). Every new `compose` event: P is the test-side MASK of the
//                    newest composable pair (R3-63; an open member with a cs_id and no pair — a restart's recovered CS — does not keep a
//                    ready group from composing, ruling R3-EF4-12, decided test-side from the peer's last journaled CS table and
//                    meta.cs_human_next) covering each path, A elsewhere; no held or class path differs from A in P; an engine group
//                    marked ready that the test side finds held fails.
//   INV-GROUP        every new `apply` event: the universe is test-side — the LIVE paths of the incoming change-sets (Cowork-CS over the
//                    first-parent commits since the apply's LA_C, plus the change-sets of earlier ranges whose commit changed a path still
//                    deferred, the Task 6 closure range per ruling R3-EF4-4 — never by a declared path alone) whose TIP entry differs
//                    from A_before, minus the event's not-applicable paths — and so is `written` (A_after[p] ≠ A_before[p], A_before =
//                    the tree the apply merged against, A_after = the A tree its state transition committed; the event's `written` must
//                    name exactly those, both ways); per closure all or none of the applicable paths are written; the written paths are
//                    on disk in M_disk's stored form; the event's groups are that partition; a not-applicable path has its own INCOMING
//                    record in the peer's registry by its next `iteration` event (or one created after that apply and released SUBSUMED
//                    before that event, once TIP no longer changes the path: ruling R3-EF4-5, HLD-54 — the releasing iteration's TIP, its
//                    apply's or, in an iteration that applied nothing (a frozen one), the live code of the board it fetched, R3-EF4-17);
//                    a closure deferred longer than
//                    62,500 virtual ms (from the apply that first deferred it, or from a restarted engine's first iteration) has exactly
//                    one INCOMING record over its applicable paths in the registry; no two written applies of one peer < 10,000 virtual
//                    ms apart.
//   O-READY          after an apply: every ready pair's A_cap equals A on its paths, and on every path the apply wrote where a pair carries
//                    content (R ≠ A) R follows glossary §3's rebase (ruling R3-EF4-1; HLD-41; kills M20): R = the apply's M_disk passes;
//                    else, for a pair journaled before the apply, a clean plain rebase merge-file(A_new, A_cap, R) must be R, a conflicting
//                    one after a post-capture effect (S_disk ≠ R before the apply) must have withdrawn the capture, and a conflicting one
//                    with S_disk == R before it must have taken M_disk (bullet 1); a pair captured after the apply (not journaled before
//                    it) holds M_disk; before a landed publish: P carries MASK(R).
//   O-AND            a landed ordinary live commit leaves every held whole path at its parent and adds/removes no held row.
//   O-OFFDISK        OFF_DISK records explain no withheld path; no OFF_DISK record ends GONE except a marker companion or a failed
//                    collision-take capture (R3-67). The brief's third clause (testMask with and without the OFF_DISK records agrees)
//                    is dropped until claim-breach exists (controller ruling, Task 14 fix round 1; Plan 4 adds claim-breach and carries
//                    the clause): before that an OFF_DISK record masks nothing in testMask by construction, so the clause could not fail.
//   O-LIVE-RECORD    a landed board names only LIVE paths for non-local_only holds and no held/ subtree for local_only ones; a mirror
//                    rejection reaches status within 2 iterations; the fold agrees with the owner's registry and no two non-terminal
//                    records hold one change — one kind, path set and test-side H1' at the peer's current A, a settle copy exempt
//                    against its parent (INV-HLD-SINGLE; rulings R3-FF3-D1, R3-FF4-A1).
//   (INCOMING)       an INCOMING record masks at no step and never makes its path LOCAL_ONLY (R3-21 as amended by Plan 3 Task 6;
//                    maskStepOf, simScope, O-AND's andClause; ruling R3-FF2-D1).
//   O-ATOMIC-PUB     a landed human-CS commit carries every R ≠ A_cap path of its composable groups except (a) class, (b) step-5 partial
//                    paths and (c) the publish's TAKE_TIP paths; no non-composable group path differs from A in P.
//   INV-NOSILENT     (status half) every hold, deferral, not-converged path and MASS shows in status.json by the peer's second iteration.
//   O-RELEASED-ENDS  (atQuiescence; F1 audit fix #28, the EF3 review's carry) no released PATCH or PIN — ON_DISK, no guard left, not
//                    CONFLICTED, not local_only — is still open at quiescence unless FREEZE, a pause or another reported
//                    not_converged cause keeps one of its paths back (exitOracles appends it after INV-SECRET-HELD).
//
// TST-07 independence: these oracles read only trace events, the peers' git objects (each peer repo holds what it fetched), working
// files, status.json, the holdsView readers and EngineInspection; none calls maskEntries, RebaseCache, writeGroups, HoldRegistry,
// isDurable, ChangeSets or evaluateOnDisk. testRebase and testMask are the test-side operators: file-form `git merge-file -p` on scratch
// files (the runner adds MERGE_FLAGS) and `hash-object --stdin --no-filters` without -w. The oracles run them on their own git runner
// (testRunner), never ctx.git: INV-OID records and judges every ctx.git call (oracles.ts does the same).
//
// Readings (recorded in the Task 14 report): an ABSENT side or a binary side (a NUL in the first 8,000 bytes, DAT-04) runs no merge-file;
// the whole-path rule decides (R3-18: REBASE H1' = H1 when A == H0 or A == H1, else a conflict; MASK step 5 cur == base → other,
// other == base or cur == other → cur, else a conflict) — the contract's "ABSENT = empty file" would make every creation or deletion
// under a record a false difference. A merge-file exit outside 0…127 throws (an operator error, never a conflict). simScope is called
// with size 0 (no SIM blob comes near HUGE_BYTES; testMask passes the real blob size). Every failure message starts with the oracle
// row and the clause tag (`INV-MASK (iv) p0 shared.txt: …`), and one check reports every clause that fails, joined with ' | '.
import { realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canon } from '../../src/data/canon.js';
import type { ScopeClass } from '../../src/data/scope.js';
import { parseCsTrailers } from '../../src/board/boardCommit.js';
import type { Engine, EngineInspection } from '../../src/engine/loop.js';
import { parseMeta } from '../../src/engine/meta.js';
import type { NotConvergedWhy } from '../../src/engine/status.js';
import { ABSENT, parseOid, type Oid, type OidOrAbsent } from '../../src/git/oid.js';
import { GitRepo, type FileMode, type TreeEntry, type TreeMap } from '../../src/git/repo.js';
import type { GitRunner } from '../../src/git/runner.js';
import { serializeRecord, TERMINAL_STATES, type BlobMap, type HoldRecord } from '../../src/holds/record.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { validPathSyntax } from '../../src/sec/validators.js';
import { testRunner } from '../helpers/tmp.js';
import { isRealEngine, realEngineOf } from './engineAdapter.js';
import type { Oracle, SimContext } from './harness.js';
import { boardHolds, readBlob, readRegistry, readStatus, simScope, treeEntries, type RegistrySnapshot } from './holdsView.js';
import type { PeerClone } from './peers.js';
import { TraceRecorder } from './traceRecorder.js';

// ---- shared constants -------------------------------------------------------------------------------------------------

const BRANCH = 'main';
const PATH_CLASSES: ReadonlySet<ScopeClass> = new Set<ScopeClass>(['QUARANTINED', 'SAVE_ONLY', 'UNMANAGED']);
/** 05-holds §2 whole-path guards (by name, without `:<arg>`); every guard of a local_only record withholds its path whole too. */
const WHOLE_PATH_GUARDS: ReadonlySet<string> = new Set(['eol-bom', 'generated?', 'portability', 'markers']);
/** HLD-54 / R3-31: a closure deferred this long (60 s + one loop of 2.5 s) must have its INCOMING record. */
export const DEFERRAL_RECORD_DUE_MS = 62_500;
/** Glossary §20: at most one apply per 10 s per worktree. */
export const APPLY_GAP_MS = 10_000;
/** The guards of a not-applicable path's own INCOMING record (R3-31). */
const NOT_APPLICABLE_GUARDS: ReadonlySet<string> = new Set(['collision', 'unmaterializable', 'quarantine-review']);
/** INV-NOSILENT: a pending deferral younger than this is counted in pending.incoming (R3-30, R3-46). */
const INCOMING_YOUNG_MS = 60_000;
/** DAT-04: binary = a NUL in the first 8,000 bytes. */
const BINARY_PREFIX = 8_000;
/** The SIM's one binary seed file (generators.ts BIN_FILE). */
const BIN_FILE = 'bin.dat';

export type Entry = { mode: string; oid: Oid };
export type EntryMap = ReadonlyMap<string, Entry>;
type HoldEvent = Extract<TraceEvent, { kind: 'hold' }>;
type MaskEvent = Extract<TraceEvent, { kind: 'mask' }>;
type ComposeEvent = Extract<TraceEvent, { kind: 'compose' }>;
type ApplyEvent = Extract<TraceEvent, { kind: 'apply' }>;
type MergeEvent = Extract<TraceEvent, { kind: 'merge' }>;
type StateEvent = Extract<TraceEvent, { kind: 'state' }>;
type PublishEvent = Extract<TraceEvent, { kind: 'publish' }>;
type MirrorEvent = Extract<TraceEvent, { kind: 'mirror' }>;
type FetchEvent = Extract<TraceEvent, { kind: 'fetch' }>;

const byStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const guardNameOf = (full: string): string => {
  const colon = full.indexOf(':');
  return colon < 0 ? full : full.slice(0, colon);
};
const isTerminalState = (state: string): boolean => (TERMINAL_STATES as ReadonlySet<string>).has(state);
const ownSide = (m: BlobMap, p: string): OidOrAbsent | undefined => (Object.prototype.hasOwnProperty.call(m, p) ? m[p] : undefined);
const baseSideOf = (r: HoldRecord): BlobMap => ('h0' in r.blobs ? r.blobs.h0 : r.blobs.s1);
const heldSideOf = (r: HoldRecord): BlobMap => ('h1' in r.blobs ? r.blobs.h1 : r.blobs.s2);
const isBinaryBuf = (b: Buffer): boolean => b.subarray(0, BINARY_PREFIX).includes(0);
const sameEntry = (a: Entry | null | undefined, b: Entry | null | undefined): boolean =>
  (a ?? null) === null ? (b ?? null) === null : (b ?? null) !== null && a!.oid === b!.oid && a!.mode === b!.mode;
const sameOid = (a: Entry | null | undefined, b: Entry | null | undefined): boolean => (a?.oid ?? null) === (b?.oid ?? null);
const show = (e: Entry | null | undefined): string => (e === null || e === undefined ? 'absent' : e.oid);
const sortedJson = (xs: Iterable<string>): string => JSON.stringify([...xs].sort(byStr));

// ---- the test-side operators (TST-07: never an engine function) ------------------------------------------------------------

/** Per runner and repo: blob bytes, merge results and REBASE results (objects never change; scratch files never outlive a call). */
interface OpMemo { bytes: Map<string, Buffer>; merges: Map<string, OidOrAbsent | null>; seq: number; }
const memos = new WeakMap<GitRunner, Map<string, OpMemo>>();
function memoOf(git: GitRunner, repoDir: string): OpMemo {
  let byRepo = memos.get(git);
  if (byRepo === undefined) {
    byRepo = new Map();
    memos.set(git, byRepo);
  }
  let m = byRepo.get(repoDir);
  if (m === undefined) {
    m = { bytes: new Map(), merges: new Map(), seq: 0 };
    byRepo.set(repoDir, m);
  }
  return m;
}

async function runGit(git: GitRunner, cwd: string, args: string[], okCodes: readonly number[] = [0], stdin?: Buffer): Promise<{ code: number; stdout: Buffer }> {
  const r = await git.run(args, { class: 'local', cwd, ...(stdin === undefined ? {} : { stdin }) });
  if (!okCodes.includes(r.code)) throw new Error(`oraclesHolds: git ${args.slice(0, 3).join(' ')} in ${cwd} failed (${r.code}): ${r.stderr.toString('utf8').trim().slice(0, 300)}`);
  return { code: r.code, stdout: r.stdout };
}

/** Blob bytes (test-side cat-file, memoized per repo). */
async function bytesOf(git: GitRunner, repoDir: string, oid: Oid): Promise<Buffer> {
  const m = memoOf(git, repoDir);
  let b = m.bytes.get(oid);
  if (b === undefined) {
    b = await readBlob(git, repoDir, oid);
    m.bytes.set(oid, b);
  }
  return b;
}

/** `hash-object --stdin --no-filters` without -w: the oid the bytes would have (never written). */
async function hashNoWrite(git: GitRunner, repoDir: string, bytes: Buffer): Promise<Oid> {
  const r = await runGit(git, repoDir, ['hash-object', '--stdin', '--no-filters'], [0], bytes);
  return parseOid(r.stdout.toString('utf8').trim());
}

/** Batch sizes of blobs (cat-file --batch-check). */
async function blobSizes(git: GitRunner, repoDir: string, oids: Iterable<Oid>): Promise<Map<Oid, number>> {
  const want = [...new Set(oids)];
  const out = new Map<Oid, number>();
  if (want.length === 0) return out;
  const r = await runGit(git, repoDir, ['cat-file', '--batch-check'], [0], Buffer.from(`${want.join('\n')}\n`, 'utf8'));
  for (const line of r.stdout.toString('utf8').split('\n')) {
    const [oid, type, size] = line.split(' ');
    if (oid !== undefined && type === 'blob' && size !== undefined) out.set(parseOid(oid), Number(size));
  }
  return out;
}

/**
 * The file form of one operator step, `git merge-file -p <cur> <base> <other>` on scratch files: the result's oid (hashed without -w), or
 * null for a conflict (rc 1…127); any other rc throws. An ABSENT or binary side runs no merge-file: the whole-file rule decides (R3-18).
 */
async function mergeStep(git: GitRunner, scratch: string, repoDir: string, cur: OidOrAbsent, base: OidOrAbsent, other: OidOrAbsent): Promise<OidOrAbsent | null> {
  const whole = (): OidOrAbsent | null => (cur === base ? other : other === base || cur === other ? cur : null);
  if (cur === ABSENT || base === ABSENT || other === ABSENT) return whole();
  const memo = memoOf(git, repoDir);
  const key = `${cur}\0${base}\0${other}`;
  if (memo.merges.has(key)) return memo.merges.get(key)!;
  const [c, b, o] = await Promise.all([cur, base, other].map((x) => bytesOf(git, repoDir, x)));
  let out: OidOrAbsent | null;
  if ([c!, b!, o!].some(isBinaryBuf)) {
    out = whole();
  } else {
    await mkdir(scratch, { recursive: true });
    const n = ++memo.seq;
    const files = ['cur', 'base', 'other'].map((s) => join(scratch, `mf-${process.pid}-${n}-${s}`));
    try {
      await Promise.all([c!, b!, o!].map((buf, i) => writeFile(files[i]!, buf)));
      const r = await git.run(['merge-file', '-p', ...files], { class: 'local', cwd: repoDir });
      if (r.code >= 1 && r.code <= 127) out = null;
      else if (r.code !== 0) throw new Error(`oraclesHolds: merge-file exited ${r.code}: ${r.stderr.toString('utf8').trim().slice(0, 300)}`);
      else {
        out = await hashNoWrite(git, repoDir, r.stdout);
        memo.bytes.set(out, r.stdout);   // never written: the next step of a chain reads it from here
      }
    } finally {
      await Promise.all(files.map((f) => rm(f, { force: true })));
    }
  }
  memo.merges.set(key, out);
  return out;
}

/** Whether any present side is binary (DAT-04 on its bytes). */
async function anyBinarySide(git: GitRunner, repoDir: string, sides: readonly OidOrAbsent[]): Promise<boolean> {
  for (const s of new Set(sides)) {
    if (s === ABSENT) continue;
    if (isBinaryBuf(await bytesOf(git, repoDir, s))) return true;
  }
  return false;
}

const nullable = (o: OidOrAbsent): Oid | null => (o === ABSENT ? null : o);

/**
 * Test-side REBASE (05 §3.4 item 1, HLD-13, HLD-14): per path of r, H1'[p] = mf(A[p], H0[p], H1[p]) single-step from the ORIGINAL pair,
 * H0'[p] = A[p]; the whole-path rule with an ABSENT or binary side (R3-18). Any path's conflict → { ok: false }. ABSENT is null.
 */
export async function testRebase(git: GitRunner, scratch: string, repoDir: string, r: HoldRecord, A: EntryMap): Promise<{ ok: true; h0p: Map<string, Oid | null>; h1p: Map<string, Oid | null> } | { ok: false }> {
  const h0p = new Map<string, Oid | null>();
  const h1p = new Map<string, Oid | null>();
  for (const p of r.paths) {
    const a: OidOrAbsent = A.get(p)?.oid ?? ABSENT;
    const h0 = ownSide(baseSideOf(r), p);
    const h1 = ownSide(heldSideOf(r), p);
    if (h0 === undefined || h1 === undefined) return { ok: false };
    let out: OidOrAbsent | null;
    if (a === ABSENT || h0 === ABSENT || h1 === ABSENT || (await anyBinarySide(git, repoDir, [a, h0, h1]))) out = a === h0 || a === h1 ? h1 : null;
    else out = await mergeStep(git, scratch, repoDir, a, h0, h1);
    if (out === null) return { ok: false };
    h0p.set(p, nullable(a));
    h1p.set(p, nullable(out));
  }
  return { ok: true, h0p, h1p };
}

/**
 * The earliest MASK step at which r masks its paths (05 §3.4 item 2 steps 2–5), or null. An INCOMING record masks at no step (final
 * review F5: R3-21 as amended by Plan 3 Task 6 — it holds TIP's bytes, none of the disk's — and the 05 §3.4 item 2 step 2 spec edit).
 */
function maskStepOf(r: HoldRecord): 2 | 3 | 4 | 5 | null {
  if (isTerminalState(r.state) || r.kind === 'INCOMING') return null;
  const names = r.guards.map((g) => guardNameOf(g.name));
  if (r.residence === 'ON_DISK') {
    if (r.local_only) return 2;
    if (names.some((g) => WHOLE_PATH_GUARDS.has(g))) return 2;
    if (r.kind === 'PIN' && names.length > 0) return 3;
    if (r.state === 'CONFLICTED') return 4;
    if (r.kind === 'PATCH' && r.state === 'ACTIVE' && names.length > 0) return 5;
    return null;
  }
  return names.includes('claim-breach') ? 4 : null;   // OFF_DISK: only a claim-breach path pin
}

/** path → the earliest step that masks it, and path → its step-5 records in ULID order. */
function recordIndex(records: readonly HoldRecord[]): { idx: Map<string, 2 | 3 | 4 | 5>; chains: Map<string, HoldRecord[]> } {
  const idx = new Map<string, 2 | 3 | 4 | 5>();
  for (const r of records) {
    const s = maskStepOf(r);
    if (s === null) continue;
    for (const p of r.paths) {
      const had = idx.get(p);
      if (had === undefined || s < had) idx.set(p, s);
    }
  }
  const chains = new Map<string, HoldRecord[]>();
  for (const r of [...records].sort((x, y) => byStr(x.id, y.id))) {
    if (maskStepOf(r) !== 5) continue;
    for (const p of r.paths) if (idx.get(p) === 5) chains.set(p, [...(chains.get(p) ?? []), r]);
  }
  return { idx, chains };
}

export interface TestMaskResult { entries: Map<string, Entry | null>; withheld: Set<string>; partial: Set<string>; conflicted: string[]; }

/**
 * Test-side MASK(X) (05 §3.4 item 2 steps 1–6) over every path of X and A: steps 1–4 and a binary, ABSENT-conflicting or REBASE-
 * conflicting step-5 path take A's entry (null when A lacks p) and join `withheld`; a clean step-5 path takes the reverse merges' result
 * (in X's mode when X has p) and joins `partial`; every other path keeps X's entry. scopeOf gets the larger of X's and A's blob sizes.
 */
export async function testMask(git: GitRunner, scratch: string, repoDir: string, X: EntryMap, A: EntryMap, records: readonly HoldRecord[],
  scopeOf: (path: string, mode: string, size: number) => ScopeClass, binary: (path: string) => boolean): Promise<TestMaskResult> {
  const { idx, chains } = recordIndex(records);
  const sizes = await blobSizes(git, repoDir, [...X.values(), ...A.values()].map((e) => e.oid));
  const entries = new Map<string, Entry | null>();
  const withheld = new Set<string>();
  const partial = new Set<string>();
  const conflicted: string[] = [];
  for (const p of [...new Set([...X.keys(), ...A.keys()])].sort(byStr)) {
    const x = X.get(p);
    const a = A.get(p);
    const whole = (): void => {
      entries.set(p, a === undefined ? null : { mode: a.mode, oid: a.oid });
      withheld.add(p);
    };
    const size = Math.max(x === undefined ? 0 : (sizes.get(x.oid) ?? 0), a === undefined ? 0 : (sizes.get(a.oid) ?? 0));
    if (PATH_CLASSES.has(scopeOf(p, (x ?? a)!.mode, size))) {
      whole();
      continue;
    }
    const step = idx.get(p);
    if (step === undefined) {
      entries.set(p, x === undefined ? null : { mode: x.mode, oid: x.oid });
      continue;
    }
    if (step !== 5) {
      whole();
      continue;
    }
    const chain = chains.get(p)!;
    const sides: OidOrAbsent[] = [x?.oid ?? ABSENT, a?.oid ?? ABSENT];
    for (const r of chain) sides.push(ownSide(baseSideOf(r), p) ?? ABSENT, ownSide(heldSideOf(r), p) ?? ABSENT);
    if (binary(p) || (await anyBinarySide(git, repoDir, sides))) {
      whole();
      continue;
    }
    let cur: OidOrAbsent = x?.oid ?? ABSENT;
    let failed: string | null = null;
    for (const r of chain) {
      const rb = await testRebase(git, scratch, repoDir, { ...r, paths: [p] }, A);
      if (!rb.ok) {
        failed = r.id;
        break;
      }
      const h0p: OidOrAbsent = rb.h0p.get(p) ?? ABSENT;
      const h1p: OidOrAbsent = rb.h1p.get(p) ?? ABSENT;
      const next = await mergeStep(git, scratch, repoDir, cur, h1p, h0p);
      if (next === null) {
        failed = r.id;
        break;
      }
      cur = next;
    }
    if (failed !== null) {
      whole();
      if (!conflicted.includes(failed)) conflicted.push(failed);
      continue;
    }
    entries.set(p, cur === ABSENT ? null : { mode: x?.mode ?? a?.mode ?? '100644', oid: cur });
    partial.add(p);
  }
  return { entries, withheld, partial, conflicted };
}

/**
 * EF2 D1, INV-PUSHED-IS-MERGE's MASK step-5 clause (oracles.ts checkPublish; 05 §3.4 item 2 step 5, HLD-42): for each of `paths`, the
 * earliest MASK step at which a record of the publisher's registry commit `registry` (the compose event's; null = no records) masks it,
 * and testMask's entry for it over X (the journal's composition) and A — at step 5 the chain x := mf(x, H1'[p], A[p]) over the path's
 * ON_DISK ACTIVE guarded PATCHes in ULID order from X[p], or A[p] whole for a binary, ABSENT-conflicting or REBASE-conflicting chain
 * (HLD-15). Test-side operators only (TST-07).
 */
export async function publishMaskOf(ctx: SimContext, peer: PeerClone, registry: string | null, epochBase: string, X: ReadonlyMap<string, Entry>,
  A: ReadonlyMap<string, Entry>, paths: readonly string[]): Promise<Map<string, { step: 2 | 3 | 4 | 5 | null; entry: Entry | null }>> {
  const s = sharedOf(ctx);
  const reg = await registryAt(ctx, peer, registry);
  const records = [...reg.records.values()];
  const { idx } = recordIndex(records);
  const scope = await scopeOf(ctx, peer, epochBase, reg);
  const Xs = new Map<string, Entry>();
  const As = new Map<string, Entry>();
  for (const p of paths) {
    const x = X.get(p);
    if (x !== undefined) Xs.set(p, { mode: x.mode, oid: x.oid });
    const a = A.get(p);
    if (a !== undefined) As.set(p, { mode: a.mode, oid: a.oid });
  }
  for (const e of As.values()) await bytesOf(s.git, peer.dir, e.oid).catch(() => undefined);
  const m = await testMask(s.git, s.scratch, peer.dir, Xs, As, records, scope, binaryOf(ctx, peer, As));
  return new Map(paths.map((p) => [p, { step: idx.get(p) ?? null, entry: m.entries.get(p) ?? null }]));
}

/** Re-applies `chain` to y in reverse ULID order (mf(y, H0', H1')); null on any conflict. */
async function reapplyChain(git: GitRunner, scratch: string, repoDir: string, y: OidOrAbsent, chain: readonly HoldRecord[], p: string, A: EntryMap): Promise<OidOrAbsent | null> {
  let cur = y;
  for (const r of [...chain].reverse()) {
    const rb = await testRebase(git, scratch, repoDir, { ...r, paths: [p] }, A);
    if (!rb.ok) return null;
    const next = await mergeStep(git, scratch, repoDir, cur, rb.h0p.get(p) ?? ABSENT, rb.h1p.get(p) ?? ABSENT);
    if (next === null) return null;
    cur = next;
  }
  return cur;
}

/** The rows a `git diff -U0 a b` of two blobs adds and removes (non-blank rows, trailing CR dropped). */
async function diffRows(git: GitRunner, repoDir: string, a: Oid | null, b: Oid | null): Promise<{ added: string[]; removed: string[] }> {
  const read = async (o: Oid | null): Promise<string[]> => (o === null ? [] : (await bytesOf(git, repoDir, o)).toString('latin1').split('\n'));
  if (a === b) return { added: [], removed: [] };
  if (a === null || b === null) {
    const rows = (await read(a ?? b)).map((r) => r.replace(/\r$/, '')).filter((r) => r.trim().length > 0);
    return a === null ? { added: rows, removed: [] } : { added: [], removed: rows };
  }
  const r = await runGit(git, repoDir, ['diff', '--no-ext-diff', '--no-color', '--no-textconv', '-U0', a, b], [0, 1]);
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of r.stdout.toString('latin1').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const body = line.slice(1).replace(/\r$/, '');
    if (body.trim().length === 0) continue;
    if (line.startsWith('+')) added.push(body);
    else if (line.startsWith('-')) removed.push(body);
  }
  return { added, removed };
}

// ---- per-run shared readers ------------------------------------------------------------------------------------------------

interface Shared {
  git: GitRunner;
  scratch: string;
  repos: Map<string, GitRepo>;
  trees: Map<string, Promise<Map<string, Entry>>>;
  registries: Map<string, Promise<RegistrySnapshot>>;
  scopes: Map<string, Promise<(path: string, mode: string, size: number) => ScopeClass>>;
  masks: Map<string, Promise<TestMaskResult>>;
  inspections: Map<string, Promise<EngineInspection | null>>;
  boards: Map<string, Promise<Awaited<ReturnType<typeof boardHolds>>>>;
  epochBase: Map<string, Oid>;
}
const shared = new WeakMap<SimContext, Shared>();

/**
 * One run's readers: its own oracle git runner (never ctx.git), so the operators' memo of blob bytes and merge results (keyed by runner)
 * goes with the run's context — a seed runner's process folds many runs and keeps none of them.
 */
function sharedOf(ctx: SimContext): Shared {
  let s = shared.get(ctx);
  if (s === undefined) {
    s = {
      git: testRunner(), scratch: join(ctx.root, 'oracle-holds'), repos: new Map(), trees: new Map(), registries: new Map(), scopes: new Map(),
      masks: new Map(), inspections: new Map(), boards: new Map(), epochBase: new Map(),
    };
    shared.set(ctx, s);
  }
  return s;
}

/** The harness peer index of a trace event's peer id, or -1. */
function peerIndex(ctx: SimContext, peerId: string): number {
  const name = ctx.trace.names.get(peerId) ?? peerId;
  return ctx.peers.findIndex((p) => p.name === name);
}
function peerAt(ctx: SimContext, peerId: string): { i: number; peer: PeerClone } {
  const i = peerIndex(ctx, peerId);
  if (i < 0) throw new Error(`oraclesHolds: no harness peer for peer id ${peerId}`);
  return { i, peer: ctx.peers[i]! };
}
const nameOf = (ctx: SimContext, peerId: string): string => ctx.trace.names.get(peerId) ?? peerId;

/** The peer's clone as a GitRepo on the oracle runner (the engine's own layout: realpath work tree). */
function repoOf(ctx: SimContext, peer: PeerClone): GitRepo {
  const s = sharedOf(ctx);
  let r = s.repos.get(peer.name);
  if (r === undefined) {
    const workTree = realpathSync.native(peer.dir);
    r = new GitRepo(s.git, { workTree, gitDir: join(workTree, '.git'), coworkDir: join(workTree, '.git', 'cowork') }, () => ({
      attrTree: null, filterDrivers: [], identity: { name: 'cowork-oracle', email: 'oracle@cowork.invalid' }, wallMs: () => 1_700_000_000_000,
    }));
    s.repos.set(peer.name, r);
  }
  return r;
}

/** ls-tree of a tree or commit in the peer's repo (memoized). */
function treeOf(ctx: SimContext, peer: PeerClone, treeish: string): Promise<Map<string, Entry>> {
  const s = sharedOf(ctx);
  const key = `${peer.name}\0${treeish}`;
  let t = s.trees.get(key);
  if (t === undefined) {
    t = treeEntries(s.git, peer.dir, treeish);
    s.trees.set(key, t);
  }
  return t;
}

/** The registry commit `at` of the peer (null: no registry existed — no records). */
async function registryAt(ctx: SimContext, peer: PeerClone, at: string | null): Promise<RegistrySnapshot> {
  if (at === null) return { head: null, records: new Map(), local: null };
  const s = sharedOf(ctx);
  const key = `${peer.name}\0${at}`;
  let r = s.registries.get(key);
  if (r === undefined) {
    r = readRegistry(s.git, peer.dir, BRANCH, parseOid(at));
    s.registries.set(key, r);
  }
  return r;
}

/** The peer's current registry (its ref head). */
async function registryNow(ctx: SimContext, peer: PeerClone): Promise<RegistrySnapshot> {
  const s = sharedOf(ctx);
  const r = await runGit(s.git, peer.dir, ['rev-parse', '--verify', '--quiet', `refs/cowork-local/${BRANCH}/holds^{commit}`], [0, 1]);
  return registryAt(ctx, peer, r.code === 0 ? r.stdout.toString('utf8').trim() : null);
}

/** simScope at EPOCH_BASE with the registry's local_only records (memoized per peer, EPOCH_BASE and registry). */
function scopeOf(ctx: SimContext, peer: PeerClone, epochBase: string, reg: RegistrySnapshot): Promise<(path: string, mode: string, size: number) => ScopeClass> {
  const s = sharedOf(ctx);
  const key = `${peer.name}\0${epochBase}\0${reg.head ?? '-'}`;
  let f = s.scopes.get(key);
  if (f === undefined) {
    f = simScope(s.git, peer.dir, parseOid(epochBase), [...reg.records.values()]);
    s.scopes.set(key, f);
  }
  return f;
}

/** The live Engine of peer i (a realEngine peer), or null. */
function engineOf(ctx: SimContext, i: number): Engine | null {
  const sim = ctx.engines[i];
  return sim !== undefined && isRealEngine(sim) ? realEngineOf(sim) : null;
}

/** inspect() of peer i's live engine, memoized for one check (keyed by the trace and op-log lengths and the inspect function itself). */
function inspectOf(ctx: SimContext, i: number): Promise<EngineInspection | null> {
  const e = engineOf(ctx, i);
  if (e === null) return Promise.resolve(null);
  const s = sharedOf(ctx);
  const fnId = idOf(e.inspect);
  const key = `${i}\0${ctx.trace.events.length}\0${ctx.opLog.length}\0${idOf(e)}\0${fnId}`;
  let p = s.inspections.get(key);
  if (p === undefined) {
    p = e.inspect().then((ins) => {
      s.epochBase.set(ctx.peers[i]!.name, ins.epochBase);
      return ins;
    });
    s.inspections.set(key, p);
  }
  return p;
}
const ids = new WeakMap<object, number>();
let nextObjId = 0;
function idOf(o: object): number {
  let n = ids.get(o);
  if (n === undefined) {
    n = ++nextObjId;
    ids.set(o, n);
  }
  return n;
}

/** EPOCH_BASE of peer i: the live engine's, else the last seen, else the state ref's meta. */
async function epochBaseOf(ctx: SimContext, i: number): Promise<Oid> {
  const peer = ctx.peers[i]!;
  const ins = await inspectOf(ctx, i).catch(() => null);
  if (ins !== null) return ins.epochBase;
  const s = sharedOf(ctx);
  const known = s.epochBase.get(peer.name);
  if (known !== undefined) return known;
  const meta = await runGit(s.git, peer.dir, ['cat-file', 'blob', `refs/cowork-local/${BRANCH}/state:meta`]);
  const base = parseMeta(meta.stdout).EPOCH_BASE as Oid;
  s.epochBase.set(peer.name, base);
  return base;
}

/** binary(p) of a peer (DAT-04): bin.dat, or A's blob of p has a NUL in its first 8,000 bytes. */
function binaryOf(ctx: SimContext, peer: PeerClone, A: EntryMap): (path: string) => boolean {
  const s = sharedOf(ctx);
  const memo = memoOf(s.git, peer.dir);
  return (p) => {
    if (p === BIN_FILE) return true;
    const a = A.get(p);
    const b = a === undefined ? undefined : memo.bytes.get(a.oid);
    return b !== undefined && isBinaryBuf(b);
  };
}

/** testMask of (X, A, registry) on a peer, memoized per run. */
function maskOf(ctx: SimContext, peer: PeerClone, X: string, A: string, registry: string | null, epochBase: string): Promise<TestMaskResult> {
  const s = sharedOf(ctx);
  const key = `${peer.name}\0${X}\0${A}\0${registry ?? '-'}\0${epochBase}`;
  let m = s.masks.get(key);
  if (m === undefined) {
    m = (async () => {
      const reg = await registryAt(ctx, peer, registry);
      const scope = await scopeOf(ctx, peer, epochBase, reg);
      const [xm, am] = await Promise.all([treeOf(ctx, peer, X), treeOf(ctx, peer, A)]);
      for (const e of am.values()) await bytesOf(s.git, peer.dir, e.oid).catch(() => undefined);
      return testMask(s.git, s.scratch, peer.dir, xm, am, [...reg.records.values()], scope, binaryOf(ctx, peer, am));
    })();
    s.masks.set(key, m);
  }
  return m;
}

/** The trace index of the first `kind` event of peer `peerId` at or after `from` matching `pred`, or -1. */
function findAfter<K extends TraceEvent['kind']>(ctx: SimContext, from: number, kind: K, peerId: string, pred: (e: Extract<TraceEvent, { kind: K }>) => boolean = () => true): number {
  const ev = ctx.trace.events;
  for (let i = from; i < ev.length; i++) {
    const e = ev[i]!;
    if (e.kind === kind && (e as { peer?: string }).peer === peerId && pred(e as Extract<TraceEvent, { kind: K }>)) return i;
  }
  return -1;
}

/** The `iteration` events of peer `peerId` after index `from`. */
function iterationsAfter(ctx: SimContext, from: number, peerId: string): number[] {
  const out: number[] = [];
  const ev = ctx.trace.events;
  for (let i = from + 1; i < ev.length; i++) if (ev[i]!.kind === 'iteration' && (ev[i] as { peer: string }).peer === peerId) out.push(i);
  return out;
}

/** Landed: a later `push` event of the peer for this Bnew with outcome 'landed'. */
function landedAfter(ctx: SimContext, index: number, peerId: string, bnew: string): boolean {
  return findAfter(ctx, index + 1, 'push', peerId, (p) => p.bnew === bnew && p.outcome === 'landed') >= 0;
}

/** A restart of a peer seen between two checks: its live Engine object changed (or vanished). Per oracle instance. */
class Restarts {
  private readonly last = new Map<number, Engine | null>();
  /** True when peer i's engine is not the one seen at the previous call (null counts as a change: killed). */
  changed(ctx: SimContext, i: number): boolean {
    const now = engineOf(ctx, i);
    const had = this.last.has(i) ? this.last.get(i)! : undefined;
    this.last.set(i, now);
    return had !== undefined && had !== now;
  }
}

/** Collects every failing clause of one check; the message starts with the row tag. */
class Failures {
  private readonly list: string[] = [];
  constructor(private readonly row: string) {}
  add(clause: string, peer: string, detail: string): void {
    if (this.list.length < 12) this.list.push(`${this.row} (${clause}) ${peer} ${detail}`);
  }
  result(): string | null {
    return this.list.length === 0 ? null : this.list.join(' | ');
  }
}

// ---- held PINs, composability (R3-63) ---------------------------------------------------------------------------------

/** The test-side held PINs of a registry: non-terminal ON_DISK PINs with a non-empty guard set (HLD-38). */
function heldPins(records: Iterable<HoldRecord>): HoldRecord[] {
  return [...records].filter((r) => !isTerminalState(r.state) && r.residence === 'ON_DISK' && r.kind === 'PIN' && r.guards.length > 0);
}

/** Union-find over path sets: the component id of every path. */
function components(sets: ReadonlyArray<readonly string[]>): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let y = x;
    while (parent.get(y) !== r) {
      const n = parent.get(y)!;
      parent.set(y, r);
      y = n;
    }
    return r;
  };
  for (const s of sets) for (const p of s) if (!parent.has(p)) parent.set(p, p);
  for (const s of sets) for (let k = 1; k < s.length; k++) {
    const a = find(s[0]!);
    const b = find(s[k]!);
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  }
  const out = new Map<string, string>();
  for (const p of parent.keys()) out.set(p, find(p));
  return out;
}

interface Composability { composable: Set<string>; heldReady: string[]; }

/** n of the compose peer's own human-class cs_id `<peer>/human/<n>` (HLD-33), else null. */
function humanN(csId: string, peer: string): number | null {
  const m = /^([0-9a-f]{32})\/human\/([1-9][0-9]*)$/.exec(csId);
  return m === null || m[1] !== peer ? null : Number(m[2]);
}

/**
 * Ruling R3-EF4-12 (amends R3-63 (1); HLD-39 rev 2.4, HLD-36): the csIds of a compose event's groups that have no pair among the event's
 * pairs and are OPEN members, decided test-side from the peer's last `state` event before the compose — its journal/keep/cs/table.json
 * and meta.cs_human_next (R3-40, R3-69), read with the oracle's own git and plain JSON, never ChangeSets: a csId that table lists `open`,
 * or one it does not list that is the peer's own human-class id at or above that state's meta.cs_human_next — a `recovered` CS a
 * restart's restore created after that update (a human CS gets its id at its first capture, which journals the table and the counter in
 * one update, so no other human-class id is unlisted). A pair-less csId the table lists CLOSED, an unlisted one below the counter and any
 * other unlisted id (a seat-form id: no seats in the SIM, a Plan 4 carry) are not open: they keep their group from composing (HLD-34: a
 * closed CS always has a ready pair; HLD-52: a group never publishes its older pairs without a closed member's capture).
 */
async function openMembers(ctx: SimContext, ev: ComposeEvent): Promise<Set<string>> {
  const pairIds = new Set(ev.pairs.map((p) => p.csId));
  const missing = [...new Set(ev.groups.flatMap((g) => g.csIds))].filter((id) => !pairIds.has(id));
  const out = new Set<string>();
  if (missing.length === 0) return out;
  const events = ctx.trace.events;
  const at = events.lastIndexOf(ev);
  let state: string | null = null;
  for (let q = (at < 0 ? events.length : at) - 1; q >= 0 && state === null; q--) {
    const e = events[q]!;
    if (e.kind === 'state' && e.peer === ev.peer) state = e.next;
  }
  if (state === null) return out;
  const s = sharedOf(ctx);
  const { peer } = peerAt(ctx, ev.peer);
  const t = await runGit(s.git, peer.dir, ['cat-file', 'blob', `${state}:journal/keep/cs/table.json`], [0, 128]);
  const listed = new Map<string, string>();
  if (t.code === 0) {
    const doc = JSON.parse(t.stdout.toString('utf8')) as { cs?: Array<{ cs_id?: unknown; state?: unknown }> };
    for (const e of doc.cs ?? []) if (typeof e.cs_id === 'string' && typeof e.state === 'string') listed.set(e.cs_id, e.state);
  }
  const next = Number((parseMeta((await runGit(s.git, peer.dir, ['cat-file', 'blob', `${state}:meta`])).stdout) as { cs_human_next?: unknown }).cs_human_next);
  for (const id of missing) {
    const st = listed.get(id);
    const n = humanN(id, ev.peer);
    if (st === 'open') out.add(id);
    else if (st === undefined && n !== null && Number.isSafeInteger(next) && n >= next) out.add(id);
  }
  return out;
}

/**
 * R3-63 as amended by R3-EF4-12: a compose event's group is composable when the event marks it ready, no test-side held PIN shares a
 * path with its closure (the path closure of the event's groups and the held PINs), and every csId of the group is among the event's
 * pairs or is an open member (`open`, from openMembers: HLD-39 rev 2.4 — a member's file effect after the passing capture does not
 * withdraw it, so an open member without a pair, like the open human CS that has no csId yet, never keeps a ready group from composing;
 * its bytes are in no pair's R); `heldReady` lists the groups the engine marked ready although the test side finds them held.
 */
function composability(ev: ComposeEvent, records: Iterable<HoldRecord>, open: ReadonlySet<string> = new Set()): Composability {
  const pins = heldPins(records);
  const comp = components([...ev.groups.map((g) => g.paths), ...pins.map((p) => p.paths), ...ev.pairs.map((p) => p.paths)]);
  const heldRoots = new Set<string>();
  for (const pin of pins) for (const p of pin.paths) heldRoots.add(comp.get(p)!);
  const pairIds = new Set(ev.pairs.map((p) => p.csId));
  const composable = new Set<string>();
  const heldReady: string[] = [];
  for (const g of ev.groups) {
    if (!g.ready) continue;
    const pairPaths = ev.pairs.filter((p) => g.csIds.includes(p.csId)).flatMap((p) => p.paths);
    const held = [...g.paths, ...pairPaths].some((p) => heldRoots.has(comp.get(p) ?? p));
    if (held) {
      heldReady.push(g.key);
      continue;
    }
    if (g.csIds.every((id) => pairIds.has(id) || open.has(id))) composable.add(g.key);
  }
  return { composable, heldReady };
}

/** The composable pairs of a compose event, oldest first (newest wins per path). */
function composablePairs(ev: ComposeEvent, c: Composability): ComposeEvent['pairs'] {
  const keys = new Set(ev.groups.filter((g) => c.composable.has(g.key)).flatMap((g) => g.csIds));
  return [...ev.pairs].filter((p) => keys.has(p.csId)).sort((x, y) => x.order - y.order || byStr(x.csId, y.csId));
}

/** P_expected of a compose event: testMask of the newest composable pair's R per covered path, A elsewhere; with the covered set. */
async function expectedP(ctx: SimContext, peer: PeerClone, ev: ComposeEvent, records: readonly HoldRecord[], epochBase: string, c: Composability): Promise<{ P: Map<string, Entry | null>; covered: Map<string, ComposeEvent['pairs'][number]>; mask: TestMaskResult }> {
  const s = sharedOf(ctx);
  const A = await treeOf(ctx, peer, ev.aTree);
  const covered = new Map<string, ComposeEvent['pairs'][number]>();
  for (const pair of composablePairs(ev, c)) for (const p of pair.paths) covered.set(p, pair);
  const X = new Map<string, Entry>();
  const Asub = new Map<string, Entry>();
  for (const [p, pair] of covered) {
    const R = await treeOf(ctx, peer, pair.R);
    const r = R.get(p);
    if (r !== undefined) X.set(p, r);
    const a = A.get(p);
    if (a !== undefined) Asub.set(p, a);
  }
  const reg = await registryAt(ctx, peer, ev.registry);
  const scope = await scopeOf(ctx, peer, epochBase, reg);
  for (const e of Asub.values()) await bytesOf(s.git, peer.dir, e.oid).catch(() => undefined);
  const mask = await testMask(s.git, s.scratch, peer.dir, X, Asub, records, scope, binaryOf(ctx, peer, A));
  const P = new Map<string, Entry | null>();
  for (const [p, e] of A) P.set(p, e);
  for (const [p, e] of mask.entries) P.set(p, e);
  for (const p of covered.keys()) if (!mask.entries.has(p)) P.set(p, null);
  return { P, covered, mask };
}

/** Paths a record set withholds whole at MASK steps 2–4, and the class check, for "no held/class path differs from A". */
function wholeHeld(records: readonly HoldRecord[]): Set<string> {
  const { idx } = recordIndex(records);
  return new Set([...idx].filter(([, s]) => s !== 5).map(([p]) => p));
}

// ---- INV-MASK -----------------------------------------------------------------------------------------------------------

/** INV-MASK (11-testing §3.4; HLD-15, HLD-19, HLD-42; R3-49: recomputed only for new `mask` and `compose` events). */
export function oracleMask(): Oracle {
  const cursors = new WeakMap<SimContext, number>();
  return {
    name: 'INV-MASK',
    async afterEveryOp(ctx) {
      const from = cursors.get(ctx) ?? 0;
      const slice = ctx.trace.since(from);
      cursors.set(ctx, from + slice.length);
      const f = new Failures('INV-MASK');
      // The last mask event of each peer in this step: the one inspect().sPub belongs to.
      const lastMask = new Map<string, number>();
      slice.forEach((e, k) => { if (e.kind === 'mask') lastMask.set(e.peer, from + k); });
      for (let k = 0; k < slice.length; k++) {
        const ev = slice[k]!;
        const index = from + k;
        if (ev.kind === 'mask') await checkMask(ctx, ev, index === lastMask.get(ev.peer), f);
        else if (ev.kind === 'compose') await checkCompose(ctx, ev, f);
      }
      return f.result();
    },
  };
}

async function checkMask(ctx: SimContext, ev: MaskEvent, last: boolean, f: Failures): Promise<void> {
  const s = sharedOf(ctx);
  const { i, peer } = peerAt(ctx, ev.peer);
  const name = peer.name;
  const epochBase = await epochBaseOf(ctx, i);
  const want = await maskOf(ctx, peer, ev.sDisk, ev.aTree, ev.registry, epochBase);
  // (ii) the event's sets
  if (sortedJson(ev.withheld) !== sortedJson(want.withheld)) f.add('ii', name, `withheld: event ${sortedJson(ev.withheld)} test ${sortedJson(want.withheld)}`);
  if (sortedJson(ev.partial) !== sortedJson(want.partial)) f.add('ii', name, `partial: event ${sortedJson(ev.partial)} test ${sortedJson(want.partial)}`);
  if (sortedJson(ev.conflicted) !== sortedJson(want.conflicted)) f.add('ii', name, `conflicted: event ${sortedJson(ev.conflicted)} test ${sortedJson(want.conflicted)}`);
  if (!last) return;
  const ins = await inspectOf(ctx, i);
  if (ins === null || ins.sPub === null) return;
  const sPub = ins.sPub as TreeMap;
  const A = await treeOf(ctx, peer, ev.aTree);
  const sDisk = await treeOf(ctx, peer, ev.sDisk);
  // (i) every path's entry
  for (const p of [...new Set([...want.entries.keys(), ...sPub.keys()])].sort(byStr)) {
    const e = sPub.get(p);
    const w = want.entries.get(p) ?? null;
    if (!sameOid(e === undefined ? null : e, w)) f.add('i', name, `${p}: engine ${show(e)} test ${show(w)}`);
  }
  // (iii) class, LOCAL_ONLY or withheld paths keep A in S_pub
  const reg = await registryAt(ctx, peer, ev.registry);
  const scope = await scopeOf(ctx, peer, epochBase, reg);
  for (const p of [...new Set([...sPub.keys(), ...A.keys()])].sort(byStr)) {
    const e = sPub.get(p);
    const a = A.get(p);
    if (sameOid(e, a)) continue;
    const cls = scope(p, (e ?? a)!.mode, 0);
    if (PATH_CLASSES.has(cls) || cls === 'LOCAL_ONLY' || want.withheld.has(p) || ev.withheld.includes(p)) f.add('iii', name, `${p} (${cls}${want.withheld.has(p) ? ', withheld' : ''}): S_pub ${show(e)} != A ${show(a)}`);
  }
  // (iv) re-application on partial paths (HLD-19, read as R3-75: reapply(S_pub) == reapply(S_disk))
  const { chains } = recordIndex([...reg.records.values()]);
  for (const p of [...want.partial].sort(byStr)) {
    const chain = chains.get(p);
    if (chain === undefined) continue;
    const y = sPub.get(p)?.oid ?? ABSENT;
    const d = sDisk.get(p)?.oid ?? ABSENT;
    const fromPub = await reapplyChain(s.git, s.scratch, peer.dir, y, chain, p, A);
    const fromDisk = await reapplyChain(s.git, s.scratch, peer.dir, d, chain, p, A);
    if (fromPub === null || fromPub !== fromDisk) f.add('iv', name, `${p}: re-applying ${chain.map((r) => r.id).join(',')} to S_pub ${y} gives ${fromPub ?? 'a conflict'}, to S_disk ${d} gives ${fromDisk ?? 'a conflict'}`);
  }
}

async function checkCompose(ctx: SimContext, ev: ComposeEvent, f: Failures): Promise<void> {
  const { i, peer } = peerAt(ctx, ev.peer);
  const name = peer.name;
  const epochBase = await epochBaseOf(ctx, i);
  const reg = await registryAt(ctx, peer, ev.registry);
  const records = [...reg.records.values()];
  const c = composability(ev, records, await openMembers(ctx, ev));
  for (const key of c.heldReady) f.add('compose-ready', name, `group ${key} is marked ready but a held PIN shares its closure (registry ${ev.registry ?? '-'})`);
  const { P } = await expectedP(ctx, peer, ev, records, epochBase, c);
  const pTree = await treeOf(ctx, peer, ev.pTree);
  const A = await treeOf(ctx, peer, ev.aTree);
  for (const p of [...new Set([...P.keys(), ...pTree.keys()])].sort(byStr)) {
    const e = pTree.get(p) ?? null;
    const w = P.get(p) ?? null;
    if (!sameOid(e, w)) f.add('compose-P', name, `${p}: P ${show(e)} expected ${show(w)} (compose tip ${ev.tip})`);
  }
  const scope = await scopeOf(ctx, peer, epochBase, reg);
  const whole = wholeHeld(records);
  for (const p of [...new Set([...pTree.keys(), ...A.keys()])].sort(byStr)) {
    const e = pTree.get(p);
    const a = A.get(p);
    if (sameOid(e, a)) continue;
    const cls = scope(p, (e ?? a)!.mode, 0);
    if (PATH_CLASSES.has(cls) || cls === 'LOCAL_ONLY' || whole.has(p)) f.add('compose-held', name, `${p} (${cls}${whole.has(p) ? ', held whole' : ''}): P ${show(e)} != A ${show(a)}`);
  }
}

// ---- INV-GROUP ----------------------------------------------------------------------------------------------------------

/**
 * One incoming change-set: its declared paths (HLD-37; they link closures inside a range) and the paths its commit changed against its
 * first parent (diff-tree, read only when asked — the carry to the next apply is decided by them, ruling R3-EF4-4).
 */
interface IncomingCsT { csId: string; paths: string[]; changed: () => Promise<readonly string[]>; }

/** The incoming change-sets of the first-parent commits in (from, tip] of the peer's repo (HLD-37: a commit without trailers is one CS). */
async function incomingCss(ctx: SimContext, peer: PeerClone, from: string | null, tip: string): Promise<IncomingCsT[]> {
  const s = sharedOf(ctx);
  if (from === tip) return [];
  const range = from === null ? [tip] : [tip, `^${from}`];
  const r = await runGit(s.git, peer.dir, ['rev-list', '--first-parent', '--no-commit-header', '--format=%x00%H%n%P%n%B', ...range]);
  const repo = repoOf(ctx, peer);
  const out: IncomingCsT[] = [];
  for (const rec of r.stdout.toString('utf8').split('\0').slice(1)) {
    const nl1 = rec.indexOf('\n');
    const nl2 = rec.indexOf('\n', nl1 + 1);
    const commit = rec.slice(0, nl1);
    const parent = rec.slice(nl1 + 1, nl2).split(' ').filter((x) => x.length > 0)[0] ?? null;
    const info = await repo.readCommit(parseOid(commit));
    const { cs, paths } = parseCsTrailers(info.trailers);
    let whole: string[] | null = null;
    const changed = async (): Promise<string[]> => {
      if (whole !== null) return whole;
      const args = parent === null ? ['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--no-commit-id', '--root', commit] : ['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--no-commit-id', parent, commit];
      whole = (await runGit(s.git, peer.dir, args)).stdout.toString('utf8').split('\0').filter((x) => x.length > 0);
      return whole;
    };
    if (cs.length === 0) out.push({ csId: `commit:${commit}`, paths: await changed(), changed });
    else for (const c of cs) out.push({ csId: c.csId, paths: paths.get(c.csId) ?? (await changed()), changed });
  }
  return out;
}

/** Canonical form of a partition: each group sorted, groups ordered by their first path. */
const partitionKey = (groups: ReadonlyArray<readonly string[]>): string =>
  JSON.stringify(groups.filter((g) => g.length > 0).map((g) => [...g].sort(byStr)).sort((a, b) => byStr(a[0]!, b[0]!)));

/** The paths a `write_during_apply` op of the current step wrote (its op-log detail names the path before ` variant=`). */
function writeDuringApplyPaths(ctx: SimContext): Set<string> {
  const out = new Set<string>();
  const last = ctx.opLog[ctx.opLog.length - 1]?.step;
  for (const e of ctx.opLog) {
    if (e.step !== last || e.kind !== 'write_during_apply') continue;
    const m = /^dt=\d+ (.*?) variant=/.exec(e.detail);
    if (m !== null) out.add(m[1]!);
  }
  return out;
}

interface GroupPeer {
  carry: IncomingCsT[];
  lastWrittenMono: number | null;
  /** Deferred closures by partition key: their applicable paths, the virtual mono their deferral age counts from and that event's index. */
  deferred: Map<string, { paths: string[]; since: number; at: number }>;
  /** Not-applicable obligations: the path and the trace index of the apply that named it. */
  obligations: Array<{ path: string; at: number }>;
}

/** Regular-file modes a path keeps LIVE with; a symlink or gitlink entry on any side makes it UNMANAGED (D5, DAT-36/37). */
const SPECIAL_MODES: ReadonlySet<string> = new Set(['120000', '160000']);

/**
 * INV-GROUP and INV-HLD-RECEIVE (11-testing §3.4; HLD-53, HLD-54, glossary §20; R3-30, R3-31, R3-50: kills M38 and M39). Fix round 1
 * (findings 1–3): the closure universe and `written` are computed test-side from git objects (never from the event's own groups or
 * written list, which are cross-checked against them); the deferral age restarts at a restarted engine's first iteration (never the
 * engine's own pendingAgeMs); records are matched in the peer's registry when an obligation or a deferral comes due.
 */
export function oracleGroup(): Oracle {
  const runs = new WeakMap<SimContext, { cursor: number; peers: Map<number, GroupPeer>; restarts: Restarts; holds: Map<string, HoldEvent> }>();
  return {
    name: 'INV-GROUP',
    async afterEveryOp(ctx) {
      let st = runs.get(ctx);
      if (st === undefined) {
        st = { cursor: 0, peers: new Map(), restarts: new Restarts(), holds: new Map() };
        runs.set(ctx, st);
      }
      const from = st.cursor;
      const slice = ctx.trace.since(from);
      st.cursor = from + slice.length;
      const f = new Failures('INV-GROUP');
      const wda = writeDuringApplyPaths(ctx);
      const peerState = (i: number): GroupPeer => {
        let g = st!.peers.get(i);
        if (g === undefined) {
          g = { carry: [], lastWrittenMono: null, deferred: new Map(), obligations: [] };
          st!.peers.set(i, g);
        }
        return g;
      };
      const lastApplyOf = new Map<string, number>();
      slice.forEach((e, k) => { if (e.kind === 'apply' && e.written.length > 0) lastApplyOf.set(e.peer, from + k); });
      const applied = new Map<number, string>();   // peer index → its peer id, for the peers with an apply event in this slice
      for (let k = 0; k < slice.length; k++) {
        const ev = slice[k]!;
        const index = from + k;
        if (ev.kind === 'hold') st.holds.set(`${ev.peer}\0${ev.id}`, ev);
        if (ev.kind === 'iteration') {
          const i = peerIndex(ctx, ev.peer);
          if (i < 0) continue;
          const g = peerState(i);
          // An Engine numbers its iterations from 1, so n = 1 is a (re)started engine's first iteration. Every timer restarts at daemon
          // start (R3-30) and the engine's own deferral clock starts at that iteration's end: each deferral's age counts from here.
          if (ev.n === 1) {
            for (const d of g.deferred.values()) {
              d.since = ctx.trace.monoAt(index) ?? d.since;
              d.at = index;
            }
          }
          await settleObligations(ctx, st.holds, g, ev.peer, index, f);
          continue;
        }
        if (ev.kind !== 'apply') continue;
        const { i, peer } = peerAt(ctx, ev.peer);
        applied.set(i, ev.peer);
        await checkApply(ctx, ev, index, i, peer, peerState(i), wda, index === lastApplyOf.get(ev.peer), f);
      }
      // (i) the A trees the oracle reads per apply (each state transition's committed `base`) are the engine's: at this check a live
      // engine's inspect().aTree is the base of the peer's latest state transition (the consecutive-inspection leg of `written`).
      for (const [i, peerId] of applied) {
        const ins = await inspectOf(ctx, i).catch(() => null);
        if (ins === null) continue;
        const latest = lastStateOf(ctx, peerId);
        if (latest !== null && latest.base !== ins.aTree) f.add('i', ctx.peers[i]!.name, `inspect().aTree ${ins.aTree} is not the A tree ${latest.base} of the peer's last state transition (state ${latest.next})`);
      }
      // (v) deferred closures older than 62,500 virtual ms — judged at the peer's first `iteration` event that old (a peer the harness does
      // not step creates nothing meanwhile) against the peer's registry; a restart re-anchors them at its first iteration (above).
      for (let i = 0; i < ctx.peers.length; i++) {
        const g = peerState(i);
        const peer = ctx.peers[i]!;
        // (vi) never compares two applies a restart separates: the engine object changed since the previous check (killed or restarted)
        if (st.restarts.changed(ctx, i)) g.lastWrittenMono = null;
        const peerId = [...ctx.trace.names].find(([, n]) => n === peer.name)?.[0];
        if (peerId === undefined || g.deferred.size === 0) continue;
        let reg: RegistrySnapshot | null = null;
        for (const d of g.deferred.values()) {
          const old = iterationsAfter(ctx, d.at, peerId).map((k) => (ctx.trace.monoAt(k) ?? 0) - d.since).filter((age) => age > DEFERRAL_RECORD_DUE_MS);
          if (old.length === 0) continue;
          reg ??= await registryNow(ctx, peer);
          const want = sortedJson(d.paths);
          const covering = [...reg.records.values()].filter((r) => r.kind === 'INCOMING' && !isTerminalState(r.state) && sortedJson(r.paths) === want);
          if (covering.length !== 1) f.add('v', peer.name, `closure ${want} deferred ${Math.max(...old)} virtual ms has ${covering.length} non-terminal INCOMING record(s) over exactly its applicable paths in its registry ${reg.head ?? '(none)'}`);
        }
      }
      return f.result();
    },
  };
}

/** The peer's latest `state` event in the trace, or null. */
function lastStateOf(ctx: SimContext, peerId: string): StateEvent | null {
  const ev = ctx.trace.events;
  for (let k = ev.length - 1; k >= 0; k--) {
    const e = ev[k]!;
    if (e.kind === 'state' && e.peer === peerId) return e;
  }
  return null;
}

type OwnRecord = (kind: string, state: string, paths: readonly string[], guards: readonly string[], p: string) => boolean;

/**
 * Clause (iv) at the peer's iteration event `index`: every not-applicable obligation named before it needs its own INCOMING record, found
 * in the peer's registry (a KilledAt right after the registry CAS leaves a durable record whose `hold` event was never emitted) or as a
 * non-terminal record's latest `hold` event. Ruling R3-EF4-5 (HLD-54: a record is released SUBSUMED once TIP no longer changes its
 * paths): a record created after the obligation's apply and ended SUBSUMED before `index` settles it too, but only when the path no longer
 * differs at `index` (releasedInWindow) — e.g. a join's first apply names the path and the team's fix lands before the first iteration,
 * applied there or fetched by a frozen first iteration that applies nothing (R3-EF4-17: TIP from the fetched board).
 * Still refused: no record at all; a record released SUBSUMED while TIP still changes the path; one that ended any other way; one
 * created before the obligation's apply that ended in the window.
 */
async function settleObligations(ctx: SimContext, holds: ReadonlyMap<string, HoldEvent>, g: GroupPeer, peerId: string, index: number, f: Failures): Promise<void> {
  const due = g.obligations.filter((o) => o.at < index);
  g.obligations = g.obligations.filter((o) => o.at >= index);
  if (due.length === 0) return;
  const { peer } = peerAt(ctx, peerId);
  const reg = await registryNow(ctx, peer);
  const own: OwnRecord = (kind, state, paths, guards, p) =>
    kind === 'INCOMING' && !isTerminalState(state) && paths.length === 1 && paths[0] === p && guards.some((x) => NOT_APPLICABLE_GUARDS.has(guardNameOf(x)));
  for (const o of due) {
    const inRegistry = [...reg.records.values()].some((r) => own(r.kind, r.state, r.paths, r.guards.map((x) => x.name), o.path));
    const inHistory = [...holds.values()].some((h) => h.peer === peerId && own(h.holdKind, h.state, h.paths, h.guards, o.path));
    if (inRegistry || inHistory || (await releasedInWindow(ctx, peer, peerId, o, index, own))) continue;
    f.add('iv', nameOf(ctx, peerId), `not-applicable ${o.path} (apply event ${o.at}) has no non-terminal INCOMING record over exactly [${o.path}] with guard collision, unmaterializable or quarantine-review by the iteration event ${index} (registry ${reg.head ?? '(none)'})`);
  }
}

/**
 * R3-EF4-5: whether a record over exactly [o.path] with a not-applicable guard was created in the trace window (o.at, index) — its first
 * `hold` event lies there and is non-terminal — and its last `hold` event before `index` is SUBSUMED, while o.path no longer differs at
 * that iteration: the peer's A (the base of its last `state` event before `index`) and the releasing iteration's TIP (releasingTip) hold
 * the same entry (both absent included).
 */
async function releasedInWindow(ctx: SimContext, peer: PeerClone, peerId: string, o: { path: string; at: number }, index: number, own: OwnRecord): Promise<boolean> {
  const ev = ctx.trace.events;
  const earlier = new Set<string>();
  for (let k = 0; k <= o.at; k++) {
    const e = ev[k]!;
    if (e.kind === 'hold' && e.peer === peerId) earlier.add(e.id);
  }
  const first = new Map<string, HoldEvent>();
  const latest = new Map<string, number>();
  for (let k = o.at + 1; k < index; k++) {
    const e = ev[k]!;
    if (e.kind !== 'hold' || e.peer !== peerId || earlier.has(e.id)) continue;
    if (!first.has(e.id)) first.set(e.id, e);
    latest.set(e.id, k);
  }
  const releases = [...first].filter(([id, h]) => own(h.holdKind, h.state, h.paths, h.guards, o.path) && (ev[latest.get(id)!] as HoldEvent).state === 'SUBSUMED')
    .map(([id]) => latest.get(id)!);
  if (releases.length === 0) return false;
  let state: StateEvent | null = null;
  for (let k = index - 1; k >= 0 && state === null; k--) {
    const e = ev[k]!;
    if (e.peer === peerId && e.kind === 'state') state = e;
  }
  if (state === null) return false;
  const A = await treeOf(ctx, peer, state.base);
  for (const at of releases) {
    const tip = await releasingTip(ctx, peer, peerId, at);
    if (tip !== null && sameEntry(A.get(o.path), (await treeOf(ctx, peer, tip)).get(o.path))) return true;
  }
  return false;
}

/**
 * Ruling R3-EF4-17 (HLD-54 as written, applied or not): the TIP the iteration whose record step released at trace index `at` judged by.
 * Its board is the newest ok `fetch` event of the peer before the release (step 1; a publish's refetch comes after the record step, so
 * never counts). When an `apply` event of the peer lies between that fetch and the release, the iteration applied: its tip (R3-EF4-5 as
 * before). Otherwise — a frozen iteration applies nothing (apply.ts emptyReport('frozen')) yet its record step releases on the fetched
 * TIP — the live code of that board, test-side: the board commit's last parent, read in the peer's repo (it holds what it fetched). With
 * no fetch event at all, the peer's newest apply event before the release. Null when none can be had (the release is then refused).
 */
async function releasingTip(ctx: SimContext, peer: PeerClone, peerId: string, at: number): Promise<string | null> {
  const ev = ctx.trace.events;
  let fetchAt = -1;
  for (let k = at - 1; k >= 0 && fetchAt < 0; k--) {
    const e = ev[k]!;
    if (e.kind === 'fetch' && e.peer === peerId && e.ok && e.board !== null) fetchAt = k;
  }
  for (let k = at - 1; k > fetchAt; k--) {
    const e = ev[k]!;
    if (e.kind === 'apply' && e.peer === peerId) return e.tip;
  }
  if (fetchAt < 0) return null;
  const board = (ev[fetchAt] as FetchEvent).board!;
  const r = await runGit(sharedOf(ctx).git, peer.dir, ['rev-list', '--no-walk', '--parents', '-n', '1', board], [0, 128]);
  const parents = r.code === 0 ? r.stdout.toString('utf8').trim().split(' ') : [];
  return parents.length < 2 ? null : parents[parents.length - 1]!;
}

/** Whether the peer's working file of p holds e's stored form (canon of its bytes equals the blob). */
async function diskHolds(ctx: SimContext, peer: PeerClone, p: string, e: Entry): Promise<boolean> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(repoOf(ctx, peer).paths.workTree, ...p.split('/')));
  } catch {
    return false;
  }
  const stored = await bytesOf(sharedOf(ctx).git, peer.dir, e.oid);
  const c = canon(bytes, stored, false);
  return c.ok && c.out.equals(stored);
}

async function checkApply(ctx: SimContext, ev: ApplyEvent, index: number, i: number, peer: PeerClone, g: GroupPeer, wda: ReadonlySet<string>, lastWriting: boolean, f: Failures): Promise<void> {
  const name = peer.name;
  const events = ctx.trace.events;
  // The apply's own `merge` event names the A tree it merged against (A_before), S_disk (`ours`) and the LA_C before it; its state
  // transition — the last `state` event between the two whose LA_C is this TIP (the update commits before the `apply` event is emitted;
  // none for a no-op apply) — names the A tree it committed (A_after).
  let mergeAt = -1;
  for (let k = index - 1; k >= 0 && mergeAt < 0; k--) {
    const e = events[k]!;
    if (e.kind === 'merge' && e.peer === ev.peer && e.use === 'apply' && e.tip === ev.tip) mergeAt = k;
  }
  if (mergeAt < 0) {
    f.add('i', name, `apply ${ev.tip}: no 'merge' event of this apply before it (its A_before, S_disk and LA_C)`);
    return;
  }
  const me = events[mergeAt] as MergeEvent;
  let aAfter = me.aTree;
  for (let k = mergeAt + 1; k < index; k++) {
    const e = events[k]!;
    if (e.kind === 'state' && e.peer === ev.peer && e.laC === ev.tip) aAfter = e.base;
  }
  const [A0, A1, TIP, S] = await Promise.all([treeOf(ctx, peer, me.aTree), treeOf(ctx, peer, aAfter), treeOf(ctx, peer, ev.tip), treeOf(ctx, peer, me.ours)]);
  const epochBase = await epochBaseOf(ctx, i);
  const scope = await scopeOf(ctx, peer, epochBase, { head: null, records: new Map(), local: null });
  // LIVE by simScope at EPOCH_BASE with the path's own mode: a special mode on any side is UNMANAGED (carried by scope class, HLD-53)
  const live = (p: string): boolean => {
    const sides = [A0.get(p), S.get(p), TIP.get(p)].filter((e): e is Entry => e !== undefined);
    if (sides.some((e) => SPECIAL_MODES.has(e.mode))) return false;
    return scope(p, sides[0]?.mode ?? '100644', 0) === 'LIVE';
  };
  const na = new Set(ev.notApplicable.map((x) => x.path));
  const written = new Set(ev.written);
  const inGroups = new Set(ev.groups.flatMap((x) => x.paths));
  const css = [...g.carry, ...(await incomingCss(ctx, peer, me.laC, ev.tip))];
  // The universe, test-side: the LIVE paths of the incoming change-sets whose TIP entry differs from A_before, minus the not-applicable.
  const universe = [...new Set(css.flatMap((c) => c.paths))].filter((p) => !na.has(p) && !sameEntry(TIP.get(p), A0.get(p)) && live(p)).sort(byStr);
  const moved = (p: string): boolean => !sameEntry(A1.get(p), A0.get(p));
  // A path whose disk already holds the incoming change is applied with no write (disk_equal, ENG-36): "all M_disk or all unchanged" holds
  // for it either way. Test-side: the clean merge (A_before, S_disk, TIP) keeps S_disk; or a creation (no S_disk, no A) whose A moved
  // without a write and in no write group, whose working file holds TIP's bytes (R3-33).
  const free = new Set<string>();
  const s0 = sharedOf(ctx);
  for (const p of universe) {
    const s = S.get(p);
    const a = A0.get(p);
    const t = TIP.get(p);
    if (sameEntry(s, t)) {
      free.add(p);
      continue;
    }
    if (s === undefined && a === undefined) {
      if (t !== undefined && moved(p) && !written.has(p) && !inGroups.has(p) && (await diskHolds(ctx, peer, p, t))) free.add(p);
      continue;
    }
    // the whole-path rule (an absent side) keeps S_disk only when S_disk == TIP, handled above
    if (s === undefined || a === undefined || t === undefined || s.mode !== a.mode || a.mode !== t.mode) continue;
    if ((await mergeStep(s0.git, s0.scratch, peer.dir, s.oid, a.oid, t.oid)) === s.oid) free.add(p);
  }
  // The closures: the change-sets link the universe's paths that need a write or a deferral (a free path the engine put in a write group,
  // deferred for another reason, too); a free path in no group links nothing (as in the engine's writeGroups).
  const closureU = new Set(universe.filter((p) => !free.has(p) || inGroups.has(p)));
  const linked = css.map((c) => c.paths.filter((p) => closureU.has(p)));
  const comp = components([...linked, ...[...closureU].map((p) => [p])]);
  const byRoot = new Map<string, string[]>();
  for (const p of closureU) byRoot.set(comp.get(p)!, [...(byRoot.get(comp.get(p)!) ?? []), p]);
  const groups = [...byRoot.values()].map((x) => x.sort(byStr));
  // (iii) the event's partition is the oracle's (INV-HLD-RECEIVE: a deferral never blocks another closure), compared on the closures'
  // paths (an event path outside the universe — a SAVE_ONLY path, a local path displaced from beneath a TIP file — is not judged here)
  const eventPartition = ev.groups.map((x) => x.paths.filter((p) => closureU.has(p)));
  if (partitionKey(eventPartition) !== partitionKey(groups)) f.add('iii', name, `apply ${ev.tip}: event groups ${partitionKey(eventPartition)} != closures ${partitionKey(groups)}`);
  // (i) all or nothing per closure: written = A_after[p] ≠ A_before[p] (a free path is unconstrained; a write_during_apply path is exempt)
  for (const grp of groups) {
    const applicable = grp.filter((p) => !free.has(p) && !wda.has(p));
    const w = applicable.filter(moved);
    if (w.length > 0 && w.length < applicable.length) f.add('i', name, `apply ${ev.tip}: closure ${sortedJson(applicable)} wrote ${sortedJson(w)} only`);
  }
  // (i) the event's written list is the test-side one, both ways
  for (const p of universe) {
    if (wda.has(p)) continue;
    if (written.has(p) && !moved(p)) f.add('i', name, `apply ${ev.tip}: ${p} is in the event's written list but A[${p}] did not move (A_before ${show(A0.get(p))}, A_after ${show(A1.get(p))})`);
    if (!written.has(p) && moved(p) && !free.has(p)) f.add('i', name, `apply ${ev.tip}: A[${p}] moved (${show(A0.get(p))} -> ${show(A1.get(p))}) but ${p} is not in the event's written list and its disk did not hold the incoming change`);
  }
  // (ii) the written paths' stored form on disk is M_disk's (only for the peer's last writing apply of the step)
  if (lastWriting && ev.mDisk !== null) {
    const bad = await diskDiffers(ctx, peer, ev.mDisk, [...written].filter((p) => !wda.has(p)));
    for (const b of bad) f.add('ii', name, `apply ${ev.tip}: ${b}`);
  }
  // (iv) obligations for not-applicable paths that pass validPathSyntax
  for (const x of ev.notApplicable) if (validPathSyntax(x.path)) g.obligations.push({ path: x.path, at: index });
  // (v) deferred closures, test-side (a path still at A_before ≠ TIP after the apply): their age counts from the apply that first deferred them
  const mono = ctx.trace.monoAt(index) ?? ctx.clocks.get(name)?.monoMs() ?? 0;
  const deferredNow = new Map<string, { paths: string[]; since: number; at: number }>();
  for (const grp of groups) {
    if (!grp.some((p) => !sameEntry(A1.get(p), TIP.get(p)))) continue;
    const key = sortedJson(grp);
    const had = g.deferred.get(key);
    deferredNow.set(key, { paths: grp, since: had?.since ?? mono, at: had?.at ?? index });
  }
  g.deferred = deferredNow;
  // The closure range of the next apply (Task 6 ruling; ruling R3-EF4-4): (LA_C, TIP] plus the CSs of the commits that changed a
  // still-deferred path since the commit that gave it its A blob — so an earlier range's CS is carried only when its commit changed a path
  // still deferred after this apply, never for a path it merely declared (a start/join capture CS declares R ∪ A, every live path). Still
  // refused: an engine that links closures through a CS whose commit changed no still-deferred path (iii), or splits a closure a carried
  // CS links (its declared paths still link inside the next apply, HLD-37).
  const pendingPaths = new Set([...deferredNow.values()].flatMap((d) => d.paths));
  const carry: IncomingCsT[] = [];
  if (pendingPaths.size > 0) for (const c of css) if ((await c.changed()).some((p) => pendingPaths.has(p))) carry.push(c);
  g.carry = carry;
  // (vi) at most one written apply per 10 s per worktree (restarts reset it, see the caller)
  if (ev.written.length > 0) {
    if (g.lastWrittenMono !== null && mono - g.lastWrittenMono < APPLY_GAP_MS) f.add('vi', name, `written applies ${mono - g.lastWrittenMono} virtual ms apart (< ${APPLY_GAP_MS})`);
    g.lastWrittenMono = mono;
  }
}

/**
 * Written paths whose working file's stored form is not M_disk's: a scratch index read from M_disk, update-index --refresh and
 * diff-files -z name the candidates (oracleConverge's technique), each compared through canon with the stored blob; a deleted path
 * must be gone.
 */
async function diskDiffers(ctx: SimContext, peer: PeerClone, mDisk: string, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const repo = repoOf(ctx, peer);
  const s = sharedOf(ctx);
  const M = await treeOf(ctx, peer, mDisk);
  await mkdir(s.scratch, { recursive: true });
  const index = join(s.scratch, `group-${peer.name}.index`);
  await rm(index, { force: true });
  const out: string[] = [];
  try {
    // Only the written paths' entries (never read-tree of the whole M_disk: git for Windows refuses a carried `a:b.txt` in any index).
    await repo.run(['read-tree', '--empty'], { class: 'refupdate', indexFile: index });
    const entries = paths.flatMap((p) => {
      const e = M.get(p);
      return e === undefined ? [] : [{ path: p, mode: e.mode as FileMode, oid: e.oid }];
    });
    await repo.editIndex(index, entries);
    await repo.run(['update-index', '--refresh'], { class: 'refupdate', indexFile: index, okCodes: [0, 1] });
    const dirty = new Set((await repo.run(['diff-files', '-z', '--name-only'], { indexFile: index })).stdout.toString('utf8').split('\0').filter((p) => p.length > 0));
    for (const p of [...paths].sort(byStr)) {
      const e = M.get(p);
      const file = join(repo.paths.workTree, ...p.split('/'));
      if (e === undefined) {
        if ((await lstat(file).catch(() => null)) !== null) out.push(`${p} was deleted by M_disk but is on disk`);
        continue;
      }
      if (!dirty.has(p)) continue;
      let bytes: Buffer;
      try {
        bytes = await readFile(file);
      } catch {
        out.push(`${p} is missing on disk, M_disk has ${e.oid}`);
        continue;
      }
      const stored = await bytesOf(s.git, peer.dir, e.oid);
      const c = canon(bytes, stored, false);
      if (!(c.ok && c.out.equals(stored))) out.push(`${p} on disk is not M_disk's ${e.oid} (not even through canon)`);
    }
  } finally {
    await rm(index, { force: true });
  }
  return out;
}

// ---- O-READY ------------------------------------------------------------------------------------------------------------

/**
 * The ready pair `csId` on p as journaled before the apply at trace index `at` (glossary §4 `journal/ready/<base64url(cs_id)>/{R,A}` in
 * the state commit of the peer's last `state` event before that apply's `merge` event) and S_disk[p] before the apply (the merge event's
 * `ours`); null when no such pair was journaled then (a pair captured after the apply, from the disk it wrote) or no merge event precedes
 * the apply. Ruling R3-EF4-1.
 */
async function pairBeforeApply(ctx: SimContext, peer: PeerClone, at: number, csId: string, p: string): Promise<{ r: OidOrAbsent; acap: OidOrAbsent; sDisk: OidOrAbsent } | null> {
  const ev = ctx.trace.events;
  const apply = ev[at] as ApplyEvent;
  let mi = -1;
  for (let j = at - 1; j >= 0 && mi < 0; j--) {
    const e = ev[j]!;
    if (e.kind === 'merge' && e.peer === apply.peer && e.use === 'apply' && e.tip === apply.tip) mi = j;
  }
  if (mi < 0) return null;
  let state: StateEvent | null = null;
  for (let j = mi - 1; j >= 0 && state === null; j--) {
    const e = ev[j]!;
    if (e.kind === 'state' && e.peer === apply.peer) state = e;
  }
  if (state === null) return null;
  const key = Buffer.from(csId, 'utf8').toString('base64url');
  const s = sharedOf(ctx);
  const has = await runGit(s.git, peer.dir, ['rev-parse', '--verify', '--quiet', `${state.next}:journal/ready/${key}/R`], [0, 1, 128]);
  if (has.code !== 0) return null;
  const [R, Acap, sDisk] = await Promise.all([
    treeOf(ctx, peer, `${state.next}:journal/ready/${key}/R`), treeOf(ctx, peer, `${state.next}:journal/ready/${key}/A`), treeOf(ctx, peer, (ev[mi] as MergeEvent).ours),
  ]);
  return { r: R.get(p)?.oid ?? ABSENT, acap: Acap.get(p)?.oid ?? ABSENT, sDisk: sDisk.get(p)?.oid ?? ABSENT };
}

/**
 * O-READY (11-testing §3.4; INV-HLD-READY, HLD-41; kills M20 at the apply). The after-apply rebase clause (ruling R3-EF4-1, glossary §3
 * "ready pair": R[p] := merge-file(A_new, A_cap, R); HLD-41's M_disk rule decides only a rebase CONFLICT, and only with S_disk[p] == R[p]
 * before the apply; HLD-39: a later member effect does not withdraw a passing capture, HLD-35: it opens the next human CS) still refuses:
 * R ≠ the clean plain rebase (unless R is the apply's M_disk); a pair kept after a conflicting rebase that a post-capture effect makes a
 * withdrawal (unless R is M_disk); R ≠ M_disk after a conflict with no post-capture effect (bullet 1); R ≠ M_disk for a pair not journaled
 * before the apply (captured after it from the written disk). R == M_disk always passes: a withdrawn closed CS re-captures at once from
 * the written disk under the same cs_id, which no trace event tells from a kept pair.
 */
export function oracleReady(): Oracle {
  const cursors = new WeakMap<SimContext, number>();
  return {
    name: 'O-READY',
    async afterEveryOp(ctx) {
      const from = cursors.get(ctx) ?? 0;
      const slice = ctx.trace.since(from);
      cursors.set(ctx, from + slice.length);
      const f = new Failures('O-READY');
      const wda = writeDuringApplyPaths(ctx);
      // Per peer: each path's newest writing apply of this step (its M_disk and trace index) — a pair ready after it was either captured
      // before the apply and rebased by glossary §3's rule (judged against its journaled pre-apply pair), or captured after it from the
      // disk the apply wrote (it holds that M_disk blob).
      const lastWrite = new Map<number, Map<string, string>>();
      const applyAt = new Map<string, number>();   // `${i}\0${p}` → the trace index of that newest writing apply
      for (let k = 0; k < slice.length; k++) {
        const ev = slice[k]!;
        if (ev.kind !== 'apply' || ev.mDisk === null) continue;
        const i = peerIndex(ctx, ev.peer);
        const m = lastWrite.get(i) ?? new Map<string, string>();
        for (const p of ev.written) {
          if (wda.has(p)) continue;
          m.set(p, ev.mDisk);
          applyAt.set(`${i}\0${p}`, from + k);
        }
        lastWrite.set(i, m);
      }
      for (const [i, written] of lastWrite) {
        const peer = ctx.peers[i]!;
        const ins = await inspectOf(ctx, i).catch(() => null);
        if (ins === null) continue;
        const A = await treeOf(ctx, peer, ins.aTree);
        for (const pair of ins.ready) {
          const Acap = await treeOf(ctx, peer, pair.A);
          for (const p of pair.paths) if (!sameOid(Acap.get(p), A.get(p))) f.add('a-cap', peer.name, `pair ${pair.csId}: A_cap[${p}] ${show(Acap.get(p))} != A ${show(A.get(p))} after the apply`);
          const R = await treeOf(ctx, peer, pair.R);
          for (const p of pair.paths) {
            const mDisk = written.get(p);
            // Only where the pair carries ready content on p (R[p] ≠ A[p]): a pair whose R keeps A on p (a path its capture took at A,
            // e.g. under a held PIN) publishes nothing there, and its rebase onto A_new is A_new whatever else the disk held.
            if (mDisk === undefined || sameOid(R.get(p), A.get(p))) continue;
            const M = await treeOf(ctx, peer, mDisk);
            if (sameOid(R.get(p), M.get(p))) continue;
            // Ruling R3-EF4-1: a pair journaled before the apply is judged by glossary §3's plain rebase onto A_new = A[p] now.
            const b = await pairBeforeApply(ctx, peer, applyAt.get(`${i}\0${p}`)!, pair.csId, p);
            if (b !== null) {
              const s = sharedOf(ctx);
              const plain = await mergeStep(s.git, s.scratch, peer.dir, A.get(p)?.oid ?? ABSENT, b.acap, b.r);
              if (plain !== null) {
                if ((R.get(p)?.oid ?? ABSENT) !== plain) f.add('rebase', peer.name, `pair ${pair.csId}: R[${p}] ${show(R.get(p))} != merge-file(A_new, A_cap, R) ${plain} (HLD-41)`);
                continue;
              }
              if (b.r !== b.sDisk) {
                f.add('rebase', peer.name, `pair ${pair.csId}: R[${p}] ${show(R.get(p))} kept after a rebase conflict with a post-capture effect on ${p} (HLD-41: the capture is withdrawn)`);
                continue;
              }
              // a conflict with S_disk[p] == R[p] before the apply: HLD-41's bullet 1, R[p] := the apply's M_disk[p] (below)
            }
            f.add('rebase', peer.name, `pair ${pair.csId}: R[${p}] ${show(R.get(p))} != the apply's M_disk ${show(M.get(p))} (HLD-41)`);
          }
        }
      }
      // Before a landed publish: the composition's pairs are current and P carries MASK(R) on every published ready path.
      for (let k = 0; k < slice.length; k++) {
        const ev = slice[k]!;
        if (ev.kind !== 'compose') continue;
        const index = from + k;
        const pub = findAfter(ctx, index + 1, 'publish', ev.peer);
        if (pub < 0) continue;
        const pe = ctx.trace.events[pub] as PublishEvent;
        if (findAfter(ctx, index + 1, 'compose', ev.peer) !== -1 && findAfter(ctx, index + 1, 'compose', ev.peer) < pub) continue;   // a later composition is the one pushed
        if (!landedAfter(ctx, pub, ev.peer, pe.bnew)) continue;
        const { i, peer } = peerAt(ctx, ev.peer);
        const A = await treeOf(ctx, peer, ev.aTree);
        for (const pair of ev.pairs) {
          const Acap = await treeOf(ctx, peer, pair.A);
          for (const p of pair.paths) if (!sameOid(Acap.get(p), A.get(p))) f.add('publish-a-cap', peer.name, `published pair ${pair.csId}: A_cap[${p}] ${show(Acap.get(p))} != A ${show(A.get(p))}`);
        }
        const reg = await registryAt(ctx, peer, ev.registry);
        const records = [...reg.records.values()];
        const c = composability(ev, records, await openMembers(ctx, ev));
        const { P, covered } = await expectedP(ctx, peer, ev, records, await epochBaseOf(ctx, i), c);
        const pTree = await treeOf(ctx, peer, ev.pTree);
        for (const p of covered.keys()) if (!sameOid(pTree.get(p), P.get(p))) f.add('publish-P', peer.name, `${p}: P ${show(pTree.get(p))} != MASK(R) ${show(P.get(p))}`);
      }
      return f.result();
    },
  };
}

// ---- O-AND --------------------------------------------------------------------------------------------------------------

/** One landed ordinary live commit of a peer: its publish event, the compose event before it, and the commit and its parent. */
interface Landed { index: number; pub: PublishEvent; compose: ComposeEvent | null; c: string; parent: string; }

/** The landed ordinary (one-parent) live commits of the slice (publish event with c, a landed push of its Bnew). */
async function landedCommits(ctx: SimContext, from: number, slice: readonly TraceEvent[]): Promise<Landed[]> {
  const out: Landed[] = [];
  for (let k = 0; k < slice.length; k++) {
    const ev = slice[k]!;
    if (ev.kind !== 'publish' || ev.c === null) continue;
    const index = from + k;
    if (!landedAfter(ctx, index, ev.peer, ev.bnew)) continue;
    const { peer } = peerAt(ctx, ev.peer);
    const info = await repoOf(ctx, peer).readCommit(parseOid(ev.c));
    if (info.parents.length !== 1) continue;   // base-move commits are branch merges
    let compose: ComposeEvent | null = null;
    for (let j = index - 1; j >= 0; j--) {
      const e = ctx.trace.events[j]!;
      if (e.kind === 'compose' && e.peer === ev.peer) {
        compose = e;
        break;
      }
      if (e.kind === 'publish' && e.peer === ev.peer) break;
    }
    out.push({ index, pub: ev, compose, c: ev.c, parent: info.parents[0]! });
  }
  return out;
}

/**
 * What O-AND checks for record r of the compose event's registry: 'whole' — r withholds its paths whole (a landed commit must leave
 * each at its parent); 'rows' — an ON_DISK ACTIVE guarded PATCH whose held rows must not be published; null — r holds nothing back
 * (terminal, OFF_DISK, guard-less, INCOMING, or any other shape). An INCOMING record masks at no step, local_only or not (final review
 * F5: R3-21 as amended by Plan 3 Task 6, as maskStepOf; integration I-1, ruling R3-FF2-D1) — it holds TIP's bytes, none of the disk's,
 * and HLD-54 (05 §3.6 "INCOMING records are evaluated by HLD-54") gives it no MASK step; its path's local version publishes as any other.
 */
export function andClause(r: HoldRecord): 'whole' | 'rows' | null {
  if (isTerminalState(r.state) || r.residence !== 'ON_DISK' || r.guards.length === 0 || r.kind === 'INCOMING') return null;
  const names = r.guards.map((g) => guardNameOf(g.name));
  if (r.kind === 'PIN' || r.state === 'CONFLICTED' || r.local_only || names.some((g) => WHOLE_PATH_GUARDS.has(g))) return 'whole';
  return r.kind === 'PATCH' && r.state === 'ACTIVE' ? 'rows' : null;
}

/** O-AND (11-testing §3.4; INV-HLD-AND: no published line carries an unreleased guard). */
export function oracleAnd(): Oracle {
  const cursors = new WeakMap<SimContext, number>();
  return {
    name: 'O-AND',
    async afterEveryOp(ctx) {
      const from = cursors.get(ctx) ?? 0;
      const slice = ctx.trace.since(from);
      cursors.set(ctx, from + slice.length);
      const f = new Failures('O-AND');
      const s = sharedOf(ctx);
      for (const l of await landedCommits(ctx, from, slice)) {
        if (l.compose === null) continue;
        const { peer } = peerAt(ctx, l.pub.peer);
        const reg = await registryAt(ctx, peer, l.compose.registry);
        const A = await treeOf(ctx, peer, l.compose.aTree);
        const C = await treeOf(ctx, peer, l.c);
        const parent = await treeOf(ctx, peer, l.parent);
        for (const r of reg.records.values()) {
          const clause = andClause(r);
          if (clause === null) continue;
          const names = r.guards.map((g) => guardNameOf(g.name));
          for (const p of r.paths) {
            if (clause === 'whole') {
              if (!sameOid(C.get(p), parent.get(p))) f.add('whole', peer.name, `commit ${l.c} changes ${p} held whole by ${r.id} [${names.join(',')}]: ${show(parent.get(p))} -> ${show(C.get(p))}`);
              continue;
            }
            const rb = await testRebase(s.git, s.scratch, peer.dir, { ...r, paths: [p] }, A);
            if (!rb.ok) {
              if (!sameOid(C.get(p), parent.get(p))) f.add('whole', peer.name, `commit ${l.c} changes ${p} of ${r.id}, whose REBASE conflicts (MASK withholds it whole)`);
              continue;
            }
            const held = await diffRows(s.git, peer.dir, rb.h0p.get(p) ?? null, rb.h1p.get(p) ?? null);
            const pushed = await diffRows(s.git, peer.dir, parent.get(p)?.oid ?? null, C.get(p)?.oid ?? null);
            const addedRows = new Set(pushed.added);
            const removedRows = new Set(pushed.removed);
            const leakA = held.added.filter((x) => addedRows.has(x));
            const leakR = held.removed.filter((x) => removedRows.has(x));
            if (leakA.length > 0 || leakR.length > 0) f.add('rows', peer.name, `commit ${l.c} on ${p} carries ${r.id}'s held rows: added ${JSON.stringify(leakA)} removed ${JSON.stringify(leakR)}`);
          }
        }
      }
      return f.result();
    },
  };
}

// ---- O-OFFDISK ----------------------------------------------------------------------------------------------------------

/** O-OFFDISK (11-testing §3.4; INV-HLD-OFFDISK; R3-21, R3-67). */
export function oracleOffDisk(): Oracle {
  const runs = new WeakMap<SimContext, { cursor: number; holds: Map<string, HoldEvent> }>();
  return {
    name: 'O-OFFDISK',
    async afterEveryOp(ctx) {
      let st = runs.get(ctx);
      if (st === undefined) {
        st = { cursor: 0, holds: new Map() };
        runs.set(ctx, st);
      }
      const from = st.cursor;
      const slice = ctx.trace.since(from);
      st.cursor = from + slice.length;
      const f = new Failures('O-OFFDISK');
      for (let k = 0; k < slice.length; k++) {
        const ev = slice[k]!;
        if (ev.kind === 'mask') await checkOffDiskMask(ctx, ev, f);
        if (ev.kind !== 'hold') continue;
        const key = `${ev.peer}\0${ev.id}`;
        const prev = st.holds.get(key);
        st.holds.set(key, ev);
        if (ev.state !== 'GONE' || prev === undefined || prev.residence !== 'OFF_DISK') continue;
        if (await exemptGone(ctx, ev)) continue;
        f.add('gone', nameOf(ctx, ev.peer), `record ${ev.id} [${prev.guards.join(',')}] went GONE from OFF_DISK ${prev.state} (rev ${prev.rev} -> ${ev.rev}); only a marker companion or a failed collision-take capture may`);
      }
      return f.result();
    },
  };
}

/**
 * Every withheld/partial path is explained by an ON_DISK record or a scope class. (The brief's "OFF_DISK records change no MASK result" —
 * testMask with and without them — is dropped until claim-breach exists, controller ruling on fix round 1 finding 4: before Plan 4 no
 * OFF_DISK record masks anything in testMask, so it compared a test-side function with itself; Plan 4 carries it.)
 */
async function checkOffDiskMask(ctx: SimContext, ev: MaskEvent, f: Failures): Promise<void> {
  const { i, peer } = peerAt(ctx, ev.peer);
  const epochBase = await epochBaseOf(ctx, i);
  const reg = await registryAt(ctx, peer, ev.registry);
  const scope = await scopeOf(ctx, peer, epochBase, reg);
  const sDisk = await treeOf(ctx, peer, ev.sDisk);
  const A = await treeOf(ctx, peer, ev.aTree);
  const onDisk = new Set<string>();
  for (const r of reg.records.values()) if (!isTerminalState(r.state) && r.residence === 'ON_DISK') for (const p of r.paths) onDisk.add(p);
  for (const p of [...new Set([...ev.withheld, ...ev.partial])].sort(byStr)) {
    const e = sDisk.get(p) ?? A.get(p);
    const cls = e === undefined ? 'LIVE' : scope(p, e.mode, 0);
    if (!onDisk.has(p) && !PATH_CLASSES.has(cls)) f.add('explain', peer.name, `${p} is ${ev.withheld.includes(p) ? 'withheld' : 'partial'} with no ON_DISK record and class ${cls} (registry ${ev.registry ?? '-'})`);
  }
}

/**
 * The two OFF_DISK → GONE endings O-OFFDISK allows: a marker companion (local.companions of the current registry) and a failed
 * collision-take capture (R3-67, test-side: a guard-less OFF_DISK PARKED PATCH with h0 ABSENT whose path had a non-terminal
 * `collision` record when it was created).
 */
async function exemptGone(ctx: SimContext, ev: HoldEvent): Promise<boolean> {
  const { peer } = peerAt(ctx, ev.peer);
  const reg = await registryNow(ctx, peer);
  if (reg.local !== null && Object.prototype.hasOwnProperty.call(reg.local.companions, ev.id)) return true;
  const rec = reg.records.get(ev.id);
  const created = ctx.trace.events.findIndex((e) => e.kind === 'hold' && e.peer === ev.peer && e.id === ev.id);
  if (created < 0) return false;
  const birth = ctx.trace.events[created] as HoldEvent;
  if (birth.holdKind !== 'PATCH' || birth.guards.length > 0 || birth.residence !== 'OFF_DISK' || birth.state !== 'PARKED') return false;
  if (rec === undefined || !('h0' in rec.blobs) || !rec.paths.every((p) => ownSide((rec.blobs as { h0: BlobMap }).h0, p) === ABSENT)) return false;
  // the registry as the trace showed it just before the capture's creation
  const atBirth = new Map<string, HoldEvent>();
  for (let k = 0; k < created; k++) {
    const e = ctx.trace.events[k]!;
    if (e.kind === 'hold' && e.peer === ev.peer) atBirth.set(e.id, e);
  }
  return birth.paths.every((p) => [...atBirth.values()].some((h) => !isTerminalState(h.state) && h.paths.includes(p) && h.guards.some((g) => guardNameOf(g) === 'collision')));
}

// ---- O-LIVE-RECORD ------------------------------------------------------------------------------------------------------

interface LiveRecordPeer { rejected: Map<string, number>; landed: Map<string, { rev: number; bnew: string }>; }

/** O-LIVE-RECORD and INV-HLD-SINGLE (11-testing §3.4; HLD-03, HLD-10, PRO-21, R3-24, R3-27). */
export function oracleLiveRecord(): Oracle {
  const runs = new WeakMap<SimContext, { cursor: number; peers: Map<number, LiveRecordPeer>; restarts: Restarts }>();
  return {
    name: 'O-LIVE-RECORD',
    async afterEveryOp(ctx) {
      let st = runs.get(ctx);
      if (st === undefined) {
        st = { cursor: 0, peers: new Map(), restarts: new Restarts() };
        runs.set(ctx, st);
      }
      const from = st.cursor;
      const slice = ctx.trace.since(from);
      st.cursor = from + slice.length;
      const f = new Failures('O-LIVE-RECORD');
      const s = sharedOf(ctx);
      const peerState = (i: number): LiveRecordPeer => {
        let p = st!.peers.get(i);
        if (p === undefined) {
          p = { rejected: new Map(), landed: new Map() };
          st!.peers.set(i, p);
        }
        return p;
      };
      for (let k = 0; k < slice.length; k++) {
        const ev = slice[k]!;
        if (ev.kind !== 'mirror') continue;
        const index = from + k;
        if (!landedAfter(ctx, index, ev.peer, ev.bnew)) continue;
        const { i, peer } = peerAt(ctx, ev.peer);
        for (const h of ev.holds) peerState(i).landed.set(h.id, { rev: h.rev, bnew: ev.bnew });
        await checkBoard(ctx, peer, i, ev.bnew, f);
      }
      for (let i = 0; i < ctx.peers.length; i++) {
        const peer = ctx.peers[i]!;
        const ps = peerState(i);
        const peerId = [...ctx.trace.names].find(([, n]) => n === peer.name)?.[0];
        if (st.restarts.changed(ctx, i)) for (const id of ps.rejected.keys()) ps.rejected.set(id, ctx.trace.events.length - 1);
        const ins = await inspectOf(ctx, i).catch(() => null);
        // rejected mirrors reach status.json within 2 iterations
        if (ins !== null && peerId !== undefined) {
          for (const [id, m] of Object.entries(ins.mirror)) {
            if (m.rejected === null) {
              ps.rejected.delete(id);
              continue;
            }
            if (!ps.rejected.has(id)) ps.rejected.set(id, ctx.trace.events.length - 1);
          }
          if (ps.rejected.size > 0) {
            const status = await readStatus(peer.dir);
            for (const [id, at] of [...ps.rejected]) {
              const shown = status !== null && ((status.message_code === 'HOLD_MIRROR_REJECTED' && status.message_params['hold_id'] === id) || status.state !== 'ok');
              if (shown) {
                ps.rejected.set(id, Number.MAX_SAFE_INTEGER);   // shown once: satisfied
                continue;
              }
              if (at === Number.MAX_SAFE_INTEGER) continue;
              if (iterationsAfter(ctx, at, peerId).length >= 2) f.add('rejected', peer.name, `mirror of ${id} rejected (${rejectedReason(ins, id)}) but status.json shows ${status?.state ?? 'none'} ${status?.message_code ?? 'null'} after 2 iterations`);
            }
          }
        }
        // INV-HLD-SINGLE: the owner's registry against the landed fold; no two non-terminal records of one change
        const reg = await registryNow(ctx, peer);
        for (const r of reg.records.values()) {
          const l = ps.landed.get(r.id);
          if (l === undefined || l.rev !== r.rev) continue;
          let board = s.boards.get(`${peer.name}\0${l.bnew}`);
          if (board === undefined) {
            board = boardHolds(s.git, peer.dir, parseOid(l.bnew));
            s.boards.set(`${peer.name}\0${l.bnew}`, board);
          }
          const folded = (await board).holds[r.id];
          if (folded === undefined) {
            f.add('single', peer.name, `record ${r.id} rev ${r.rev} landed in ${l.bnew} but the fold has no entry`);
            continue;
          }
          const mine = { state: r.state, residence: r.residence, offer: r.offer, guards: r.guards.map((g) => g.name), paths: r.paths, cs_ids: r.cs_ids, local_only: r.local_only };
          const theirs = { state: folded.state, residence: folded.residence, offer: folded.offer, guards: folded.guards.map((g) => g.name), paths: folded.paths, cs_ids: folded.cs_ids, local_only: folded.local_only };
          if (JSON.stringify(mine) !== JSON.stringify(theirs)) f.add('single', peer.name, `record ${r.id} rev ${r.rev}: registry ${JSON.stringify(mine)} != fold of ${l.bnew} ${JSON.stringify(theirs)}`);
        }
        const A = await currentAOf(ctx, i);
        for (const x of await singleCollisions(s.git, s.scratch, peer.dir, [...reg.records.values()], A, reg.local?.settleCopies ?? {})) f.add('single', peer.name, x);
      }
      return f.result();
    },
  };
}

/**
 * INV-HLD-SINGLE's "at most one non-terminal record per change" (HLD-07: one change is a path set and an H1 that equals, or
 * REBASE-converges to, a record's CURRENT H1'), as failure details: every pair of non-terminal records of one kind and path set whose
 * test-side REBASE at A (testRebase, single-step from the original pair) gives the same H1' on every path (ruling R3-FF3-D1; the stored
 * held side is no key — final review r2 D-1 makes two records with one stored h1 over different bases, two changes). A record whose
 * REBASE conflicts at A has no H1' and collides with nothing; with no A (no state) nothing is keyed. Exempt: a restart's safety copy
 * against the record whose park it settled (local.json settleCopies, copy → parent; ruling R3-FF4-A1 — a deliberate duplicate of r's
 * change: an ON_DISK r and its OFF_DISK copy share H1'); any other pair, the copy's included, still counts. Only path sets two records
 * share run a REBASE.
 */
export async function singleCollisions(git: GitRunner, scratch: string, repoDir: string, records: readonly HoldRecord[], A: EntryMap | null,
  settleCopies: Readonly<Record<string, string>>): Promise<string[]> {
  if (A === null) return [];
  const out: string[] = [];
  const bySet = new Map<string, HoldRecord[]>();
  for (const r of records) {
    if (isTerminalState(r.state)) continue;
    const set = JSON.stringify([r.kind, r.paths]);
    bySet.set(set, [...(bySet.get(set) ?? []), r]);
  }
  const exempt = (a: string, b: string): boolean => settleCopies[a] === b || settleCopies[b] === a;
  for (const [set, group] of bySet) {
    if (group.length < 2) continue;
    const keyed: Array<{ id: string; key: string }> = [];
    for (const r of group) {
      const rb = await testRebase(git, scratch, repoDir, r, A);
      if (!rb.ok) continue;
      keyed.push({ id: r.id, key: JSON.stringify(r.paths.map((p) => rb.h1p.get(p) ?? null)) });
    }
    for (let x = 0; x < keyed.length; x++) {
      for (let y = x + 1; y < keyed.length; y++) {
        const a = keyed[x]!;
        const b = keyed[y]!;
        if (a.key === b.key && !exempt(a.id, b.id)) out.push(`records ${a.id} and ${b.id} hold one change: ${set} with H1' ${a.key} at the current A`);
      }
    }
  }
  return out;
}

/** Peer i's current A: the live engine's tree(A), else the `base` tree of its state ref (a killed peer); null when it has no state. */
async function currentAOf(ctx: SimContext, i: number): Promise<Map<string, Entry> | null> {
  const peer = ctx.peers[i]!;
  const ins = await inspectOf(ctx, i).catch(() => null);
  if (ins !== null) return treeOf(ctx, peer, ins.aTree);
  const s = sharedOf(ctx);
  const r = await runGit(s.git, peer.dir, ['rev-parse', '--verify', '--quiet', `refs/cowork-local/${BRANCH}/state:base`], [0, 1]);
  return r.code === 0 ? treeOf(ctx, peer, r.stdout.toString('utf8').trim()) : null;
}
const rejectedReason = (ins: EngineInspection, id: string): string => ins.mirror[id]?.rejected ?? '-';

/** A landed board: non-local_only holds name only LIVE paths (and held/ only those); local_only holds have no held/ subtree. */
async function checkBoard(ctx: SimContext, peer: PeerClone, i: number, bnew: string, f: Failures): Promise<void> {
  const s = sharedOf(ctx);
  let board = s.boards.get(`${peer.name}\0${bnew}`);
  if (board === undefined) {
    board = boardHolds(s.git, peer.dir, parseOid(bnew));
    s.boards.set(`${peer.name}\0${bnew}`, board);
  }
  const { holds, held } = await board;
  const scope = await scopeOf(ctx, peer, await epochBaseOf(ctx, i), { head: null, records: new Map(), local: null });
  for (const [id, h] of Object.entries(holds).sort(([a], [b]) => byStr(a, b))) {
    const entries = held.get(id) ?? [];
    if (h.local_only) {
      if (entries.length > 0) f.add('stub', peer.name, `local_only hold ${id} has a held/ subtree in ${bnew} (${entries.map((e) => `${e.stage}/${e.path}`).join(', ')})`);
      continue;
    }
    for (const p of h.paths) {
      const cls = scope(p, '100644', 0);
      if (cls !== 'LIVE') f.add('live', peer.name, `hold ${id} (local_only false) names ${p}, class ${cls}, in ${bnew}`);
    }
    for (const e of entries) if (!h.paths.includes(e.path) || scope(e.path, '100644', 0) !== 'LIVE') f.add('live', peer.name, `held/${id}/${e.stage}/${e.path} in ${bnew} is not a LIVE path of the hold`);
  }
}

// ---- O-ATOMIC-PUB -------------------------------------------------------------------------------------------------------

/** O-ATOMIC-PUB (11-testing §3.4; INV-HLD-ATOMIC-PUB for human CSs, exceptions (a)–(c)). */
export function oracleAtomicPub(): Oracle {
  const cursors = new WeakMap<SimContext, number>();
  return {
    name: 'O-ATOMIC-PUB',
    async afterEveryOp(ctx) {
      const from = cursors.get(ctx) ?? 0;
      const slice = ctx.trace.since(from);
      cursors.set(ctx, from + slice.length);
      const f = new Failures('O-ATOMIC-PUB');
      for (const l of await landedCommits(ctx, from, slice)) {
        if (l.compose === null) continue;
        const { i, peer } = peerAt(ctx, l.pub.peer);
        const info = await repoOf(ctx, peer).readCommit(parseOid(l.c));
        if (parseCsTrailers(info.trailers).cs.length === 0) continue;
        const ev = l.compose;
        const reg = await registryAt(ctx, peer, ev.registry);
        const records = [...reg.records.values()];
        const c = composability(ev, records, await openMembers(ctx, ev));
        const epochBase = await epochBaseOf(ctx, i);
        const scope = await scopeOf(ctx, peer, epochBase, reg);
        const { mask } = await expectedP(ctx, peer, ev, records, epochBase, c);
        const A = await treeOf(ctx, peer, ev.aTree);
        const P = await treeOf(ctx, peer, ev.pTree);
        const C = await treeOf(ctx, peer, l.c);
        const parent = await treeOf(ctx, peer, l.parent);
        const conflicted = new Set(l.pub.conflicted);
        const newest = new Map<string, ComposeEvent['pairs'][number]>();
        for (const pair of composablePairs(ev, c)) for (const p of pair.paths) newest.set(p, pair);
        for (const [p, pair] of [...newest].sort(([a], [b]) => byStr(a, b))) {
          const R = await treeOf(ctx, peer, pair.R);
          const Acap = await treeOf(ctx, peer, pair.A);
          if (sameOid(R.get(p), Acap.get(p))) continue;
          const e = R.get(p) ?? Acap.get(p) ?? A.get(p);
          const cls = e === undefined ? 'LIVE' : scope(p, e.mode, 0);
          if (PATH_CLASSES.has(cls)) continue;   // (a)
          if (mask.partial.has(p)) continue;     // (b)
          if (conflicted.has(p)) continue;       // (c) K4 TAKE_TIP
          if (sameOid(P.get(p), A.get(p))) {
            f.add('split', peer.name, `commit ${l.c}: ${p} of composable ${pair.csId} (R != A_cap) keeps A in P`);
            continue;
          }
          const carried = !sameOid(C.get(p), parent.get(p)) || sameOid(P.get(p), parent.get(p));
          if (!carried) f.add('split', peer.name, `commit ${l.c} leaves ${p} of composable ${pair.csId} at its parent (P ${show(P.get(p))})`);
        }
        for (const g of ev.groups) {
          if (c.composable.has(g.key)) continue;
          for (const p of g.paths) if (!sameOid(P.get(p), A.get(p))) f.add('held-group', peer.name, `commit ${l.c}: ${p} of non-composable group ${g.key} differs from A in P (${show(A.get(p))} -> ${show(P.get(p))})`);
        }
      }
      return f.result();
    },
  };
}

// ---- INV-NOSILENT (status half) -------------------------------------------------------------------------------------------

/** INV-NOSILENT, status half (11-testing §3.4; HLD-24, R3-46): every condition shows in status.json by the peer's 2nd iteration. */
export function oracleNoSilent(): Oracle {
  const runs = new WeakMap<SimContext, { peers: Map<number, Map<string, number>>; restarts: Restarts }>();
  return {
    name: 'INV-NOSILENT',
    async afterEveryOp(ctx) {
      let st = runs.get(ctx);
      if (st === undefined) {
        st = { peers: new Map(), restarts: new Restarts() };
        runs.set(ctx, st);
      }
      const f = new Failures('INV-NOSILENT');
      const now = ctx.trace.events.length - 1;
      for (let i = 0; i < ctx.peers.length; i++) {
        const peer = ctx.peers[i]!;
        const peerId = [...ctx.trace.names].find(([, n]) => n === peer.name)?.[0];
        let seen = st.peers.get(i);
        if (seen === undefined) {
          seen = new Map();
          st.peers.set(i, seen);
        }
        if (st.restarts.changed(ctx, i)) for (const k of seen.keys()) seen.set(k, now);
        const ins = await inspectOf(ctx, i).catch(() => null);
        if (ins === null || peerId === undefined) continue;
        const status = await readStatus(peer.dir);
        const conds = new Map<string, (sj: NonNullable<typeof status>) => boolean>();
        const live = ins.holds.filter((r) => !isTerminalState(r.state));
        const active = live.filter((r) => r.kind !== 'INCOMING');
        conds.set(`holds_active=${active.length}`, (sj) => sj.pending.holds_active === active.length);
        const lo = active.filter((r) => r.local_only).length;
        conds.set(`holds_local_only=${lo}`, (sj) => sj.pending.holds_local_only === lo);
        const incoming = new Set<string>(live.filter((r) => r.kind === 'INCOMING').flatMap((r) => r.paths));
        for (const p of Object.keys(ins.pending)) if ((ins.pendingAgeMs[p] ?? 0) < INCOMING_YOUNG_MS) incoming.add(p);
        conds.set(`incoming=${incoming.size}`, (sj) => sj.pending.incoming === incoming.size);
        const must = new Set<string>([...live.filter((r) => r.residence === 'ON_DISK').flatMap((r) => r.paths), ...Object.keys(ins.pending)]);
        for (const p of must) conds.set(`not_converged ${p}`, (sj) => sj.pending.not_converged.includes(p));
        if (ins.freeze.includes('MASS')) conds.set('freeze MASS', (sj) => sj.freeze_reasons.includes('MASS'));
        for (const k of [...seen.keys()]) if (!conds.has(k)) seen.delete(k);
        for (const [k, ok] of conds) {
          if (status !== null && ok(status)) {
            seen.delete(k);
            continue;
          }
          const since = seen.get(k);
          if (since === undefined) {
            seen.set(k, now);
            continue;
          }
          if (iterationsAfter(ctx, since, peerId).length >= 2) f.add('status', peer.name, `${k} is not in status.json after 2 iterations (status ${status === null ? 'missing' : JSON.stringify({ state: status.state, pending: status.pending, freeze_reasons: status.freeze_reasons })})`);
        }
      }
      return f.result();
    },
  };
}

// ---- O-RELEASED-ENDS (F1 audit fix #28) ------------------------------------------------------------------------------------

/** The own not_converged qualifier of a released PATCH or PIN (holdStatusInputs, EF3): blocked_publish with its kind as the guard. */
function ownRelease(r: HoldRecord, w: NotConvergedWhy): boolean {
  return w.cause === 'blocked_publish' && 'guard' in w && w.guard === r.kind.toLowerCase();
}

/**
 * O-RELEASED-ENDS — the liveness clause the EF3 review carried (Plan 3 ledger :193, "an oracle that fails when a released record never
 * ends"; F1 audit fix #28; 11-testing §3.4; 05-holds HLD-24 "released, waiting for R1", §3.6 R1, R3-17), at quiescence: no peer keeps
 * a released PATCH or PIN open — a non-terminal ON_DISK record with no guard left that is neither CONFLICTED nor `local_only` (MASK
 * withholds those whole). Such a record withholds nothing: its change publishes and R1 then ends it SUBSUMED (H1' == A), GONE
 * (undone on disk) or RESOLVED_PUBLISH (the explicit publish of a CONFLICTED record's restoration). Since EF3 status lists its paths
 * in not_converged until R1 ends it, so INV-CONVERGE skips them and INV-NOSILENT
 * is met: without this clause a record R1 never ends fails no oracle. Exempt, because what holds the path back is reported and judged
 * elsewhere: a peer frozen or publish-paused at quiescence, and a record one of whose paths status reports with any cause but the
 * record's own release qualifier (a FREEZE or pause reason, R3-53's gate, another record's guard, a deferral). INCOMING records are out
 * of scope: they end by HLD-54 (A == TIP), which INV-GROUP judges. Reads only EngineInspection (TST-07); a run without a reached
 * quiescence phase has nothing to judge (INV-CONVERGE reports that), and an engine that cannot be inspected, or whose inspect()
 * throws, FAILS the oracle (F1 G4 review:robust r1: fail closed — an unverifiable verdict is no pass). Real-engine evidence:
 * UNVERIFIED (F2 #157). The TC-TST-02 cross-check (holdsSetup('holds-nl-tst02', {script: []})) creates no released PATCH or PIN, so
 * its green run judged nothing here and is no evidence; no logged run shows this oracle judging a released record. The first holds
 * exit seed holds-x-0 passed in full-suite runs (T5-3b gate runs 4 and 5, base 34fd698, which contains F1), not alone; the oracle stays UNVERIFIED
 * until holds-x-0 passes alone (final-gate).
 */
export function oracleReleasedEnds(): Oracle {
  return {
    name: 'O-RELEASED-ENDS',
    async atQuiescence(ctx) {
      const q = ctx.quiescence;
      if (q === null || !q.reached) return null;
      const f = new Failures('O-RELEASED-ENDS');
      for (const engine of ctx.engines) {
        if (engine.inspect === undefined) return `${engine.peer.name}: the engine cannot be inspected`;
        const ins = await engine.inspect().catch((e: unknown) => ({ __inspectFailed: String(e) }));
        if (!('freeze' in ins) || !('holds' in ins)) return `${engine.peer.name}: inspect() failed: ${(ins as { __inspectFailed?: string }).__inspectFailed ?? 'unknown shape'}`;
        if (ins.freeze.length > 0 || ins.publishPause !== null) continue;
        const why = ins.notConvergedWhy ?? {};
        for (const r of ins.holds) {
          if (r.kind === 'INCOMING' || isTerminalState(r.state) || r.residence !== 'ON_DISK' || r.guards.length > 0 || r.state === 'CONFLICTED' || r.local_only) continue;
          if (r.paths.some((p) => why[p] !== undefined && !ownRelease(r, why[p]!))) continue;
          const shown = r.paths.map((p) => `${p}: ${why[p] === undefined ? 'not in not_converged' : JSON.stringify(why[p])}`).join('; ');
          f.add('ends', engine.peer.name, `${r.kind} ${r.id} (${r.state}, rev ${r.rev}) is released (no guard left) and still open at quiescence: R1 never ended it SUBSUMED, GONE or RESOLVED_PUBLISH (${shown})`);
        }
      }
      return f.result();
    },
  };
}

// ---- plants: the Task 14 tests' synthetic inputs (a plant never touches a running engine) -----------------------------------

/** Peer i's peer id (its trace name), or throws before its first start. */
export function peerIdOf(ctx: SimContext, i: number): string {
  const name = ctx.peers[i]?.name;
  const id = [...ctx.trace.names].find(([, n]) => n === name)?.[0];
  if (id === undefined) throw new Error(`plant: p${i} has no peer id yet`);
  return id;
}

/** A blob written into peer i's object store (hash-object -w). */
export async function plantBlob(ctx: SimContext, i: number, bytes: Buffer): Promise<Oid> {
  const peer = ctx.peers[i]!;
  const oid = await repoOf(ctx, peer).hashBytes(bytes, true);
  memoOf(sharedOf(ctx).git, peer.dir).bytes.set(oid, bytes);
  return oid;
}

/** A tree of peer i's repo: `base` (a tree or commit) with `edits` applied (an oid sets a regular entry, null removes the path). */
export async function plantTree(ctx: SimContext, i: number, base: string, edits: Readonly<Record<string, Oid | null>>): Promise<Oid> {
  const s = sharedOf(ctx);
  await mkdir(s.scratch, { recursive: true });
  const index = join(s.scratch, `plant-${ctx.peers[i]!.name}.index`);
  await rm(index, { force: true });
  try {
    return await repoOf(ctx, ctx.peers[i]!).editTree(parseOid(base), Object.entries(edits).map(([path, oid]) => (oid === null ? { path, remove: true as const } : { path, mode: '100644' as const, oid })), index);
  } finally {
    await rm(index, { force: true });
  }
}

/** A commit of peer i's repo (oracle identity and date). */
export async function plantCommit(ctx: SimContext, i: number, tree: Oid, parents: readonly Oid[], subject: string, trailers: ReadonlyArray<{ key: string; value: string }>): Promise<Oid> {
  return repoOf(ctx, ctx.peers[i]!).commitTree({ tree, parents, subject, trailers });
}

/**
 * A scratch registry commit on peer i's registry ref: the head's tree with record `id` replaced by `edit(record)` (serialized as the
 * registry writes it), parented on the head, the ref moved by a CAS update-ref. Returns the commit. A plant, made after the engine's last
 * step (no engine step may follow it).
 */
export async function plantRegistry(ctx: SimContext, i: number, id: string, edit: (r: HoldRecord) => HoldRecord): Promise<Oid> {
  const peer = ctx.peers[i]!;
  const s = sharedOf(ctx);
  const reg = await registryNow(ctx, peer);
  const r = reg.records.get(id);
  if (reg.head === null || r === undefined) throw new Error(`plantRegistry: p${i} has no record ${id}`);
  const blob = await plantBlob(ctx, i, serializeRecord(edit(structuredClone(r))));
  const repo = repoOf(ctx, peer);
  const tree = await plantTree(ctx, i, reg.head, { [`records/${id}.json`]: blob });
  const commit = await repo.commitTree({ tree, parents: [reg.head], subject: 'planted registry commit', trailers: [] });
  await runGit(s.git, peer.dir, ['update-ref', `refs/cowork-local/${BRANCH}/holds`, commit, reg.head]);
  return commit;
}

/**
 * A scripted human save of peer i's working file (the scenario tests' edits the catalogue has no op for, e.g. deleting one row): the
 * bytes (null deletes the file), mtime = the peer's virtual wall clock (the quiet-period rule compares one clock, TST-03).
 */
export async function saveAs(ctx: SimContext, i: number, path: string, bytes: Buffer | null): Promise<void> {
  const peer = ctx.peers[i]!;
  const file = join(peer.dir, ...path.split('/'));
  if (bytes === null) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, bytes);
  const t = (ctx.clocks.get(peer.name)?.wallMs() ?? 0) / 1_000;
  await utimes(file, t, t);
}

/** Emits a synthetic trace event as peer i's, at its virtual mono time now (or `monoMs`). */
export function emitAs(ctx: SimContext, i: number, ev: TraceEvent, monoMs?: number): void {
  ctx.trace.emitAt(ev, monoMs ?? ctx.clocks.get(ctx.peers[i]!.name)?.monoMs() ?? null);
}

/**
 * A context whose trace is a copy of ctx's (every event with its monoAt, the peer names), the rest shared: a plant emitted into it never
 * reaches the run's trace or another plant's copy, and a fresh oracle judges it with its own readers. No engine may step on it (the
 * engines emit into the run's trace).
 */
export function forkTrace(ctx: SimContext): SimContext {
  const t = new TraceRecorder();
  for (const [id, name] of ctx.trace.names) t.names.set(id, name);
  ctx.trace.events.forEach((e, k) => t.emitAt(e, ctx.trace.monoAt(k)));
  return { ...ctx, trace: t };
}

/** The eight oracles of Task 14 in the brief's order (exitOracles appends them after Plan 2's six in Task 16). */
export function holdsOracles(): Oracle[] {
  return [oracleMask(), oracleGroup(), oracleReady(), oracleAnd(), oracleOffDisk(), oracleLiveRecord(), oracleAtomicPub(), oracleNoSilent()];
}
