// The revert detector (05-holds §3.6 Algorithm D2, HLD-18, HLD-26…HLD-29; INV-HLD-NOREVERT; rulings R3-36, R3-37) and the one
// -U0 applier taintOnlyH1 (HLD-18, L-HOLD-STORES).
//
// revertDetector: per unobserved delta (prev → next, the caller has dropped observed ones, HLD-26) the hunks of
// `git diff -U0` (a text delta; options that no user diff.* config overrides), or one hunk of every row of the other side (an
// ABSENT side, no git call), or one hunk of the rows Myers leaves unmatched (a binary-attributed path without a NUL, no git call);
// bytes with a NUL compare no rows: the journal keeps whole-blob summaries for them (provenance.ts, PROV_PATH_HASH_CAP), and every
// delta is first checked whole against those summaries (wholeTaint). A hunk is tainted when it removes a non-trivial
// row the provenance journal lists as added by a writer other than this peer, or adds one another writer removed, within the
// 14-day retention (bidirectional, HLD-27); a removed and an added row that are byte-identical after deleting every whitespace
// character are a ws-equal pair, paired greedily inside one hunk, and exempt (format-only); a tainted hunk is exempt when a
// RESOLVED_PUBLISH record on the path rebases cleanly onto A and every tainted row of the hunk is one that record's own
// H0[p] → H1[p] change removes (a removed row) or adds (an added row) (HLD-29). Rows are taken from the blobs themselves (the
// diff output gives only the hunk headers), so the hashes are those of the stored-form rows the journal hashes.
//
// taintOnlyH1: A[p] with only the -U0 hunks of diff(A[p], S_disk[p]) that contain a tainted row applied (bytes from the two
// blobs, BOM and CR of every row kept), hashed by route (c) -w; its output is only ever a record's h1 (HLD-18).
//
// holdReverts (HLD-28): per tainted path a PATCH (H0 = A[p], H1 = taintOnlyH1) or, for a binary path or a deletion, a PIN
// (H1 = S_disk[p], ABSENT for a deletion), guard `revert`, ON_DISK ACTIVE, origin 'human'; HLD-07 attaches a repeat to the
// same record. This module reads no claim state (HLD-06) and writes no object but a record's h1.
import type { PeerId } from '../board/ids.js';
import { isBinaryBytes, rows, stripEnding } from '../data/rows.js';
import { ABSENT, type Oid, type OidOrAbsent } from '../git/oid.js';
import type { GitRepo, TreeMap } from '../git/repo.js';
import { KilledAt } from '../ports/crashpoint.js';
import { blobHash, isNonTrivial, lineHash, unmatchedRows, type ProvenanceJournal } from './provenance.js';
import { HoldOperatorError, type RebaseCache } from './rebase.js';
import { blobAt, heldSide, setBlob, type BlobMap, type HoldRecord } from './record.js';
import type { HoldRegistry } from './registry.js';

export interface DetectorDelta { path: string; prev: OidOrAbsent; next: OidOrAbsent; binary: boolean; }   // observed deltas already removed by the caller
export interface TaintedPath { path: string; pin: boolean; }                                             // pin: binary or deletion → PIN

/** One -U0 hunk as row ranges: rows [oFrom, oTo) of the before blob are replaced by rows [nFrom, nTo) of the after blob (0-based). */
interface Hunk { oFrom: number; oTo: number; nFrom: number; nTo: number; }
/** The tainted rows of one hunk, as line hashes. */
interface HunkTaint { removed: string[]; added: string[]; }

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The options of both `git diff -U0` calls after the subcommand: hunks that no user or repository diff.* setting merges or moves
 * (Task 8 fix round 1, finding 7) — diff.interHunkContext would join a tainted hunk and an untainted edit a few rows away into one
 * hunk that taintOnlyH1 applies whole; diff.algorithm and diff.indentHeuristic would place the hunk boundaries per user. Argv
 * options win over config, like Plan 2's forced flags; GIT_DIFF_OPTS never reaches git (env allowlist).
 */
const U0_OPTIONS: readonly string[] = ['-U0', '--inter-hunk-context=0', '--diff-algorithm=myers', '--no-indent-heuristic', '--no-color', '--no-ext-diff', '--no-textconv', '--text'];

/** The hunk headers of `git diff -U0` output (content lines start with '-', '+', ' ' or '\', so a line starting "@@ " is a header). */
function parseHunks(out: Buffer): Hunk[] {
  const hunks: Hunk[] = [];
  for (const line of out.toString('latin1').split('\n')) {
    if (!line.startsWith('@@ ')) continue;
    const m = HUNK_HEADER.exec(line);
    if (m === null) throw new Error(`revert detector: unexpected hunk header ${JSON.stringify(line.slice(0, 80))}`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? 1 : Number(m[2]);
    const c = Number(m[3]);
    const d = m[4] === undefined ? 1 : Number(m[4]);
    // A zero count names the row the change follows ("-20,0": an insertion after row 20).
    const oFrom = b === 0 ? a : a - 1;
    const nFrom = d === 0 ? c : c - 1;
    hunks.push({ oFrom, oTo: oFrom + b, nFrom, nTo: nFrom + d });
  }
  return hunks;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** A row's ws-equal key: the row without its ending and without every whitespace character (Unicode whitespace for UTF-8, else ASCII). */
function wsKey(row: Buffer): string {
  const line = stripEnding(row);
  try {
    return `u${UTF8.decode(line).replace(/\s/gu, '')}`;
  } catch {
    return `b${line.toString('latin1').replace(/[\t\n\v\f\r ]/g, '')}`;
  }
}

/** HLD-27 for one hunk: the removed rows another writer added and the added rows another writer removed, ws-equal pairs dropped first. */
function hunkTaint(before: readonly Buffer[], after: readonly Buffer[], prov: ProvenanceJournal, self: PeerId, pairWs: boolean): HunkTaint {
  const pairedAfter = new Set<number>();
  const pairedBefore = new Set<number>();
  if (pairWs) {
    const keys = after.map(wsKey);
    before.forEach((r, i) => {
      const k = wsKey(r);
      const j = keys.findIndex((x, jj) => x === k && !pairedAfter.has(jj));
      if (j >= 0) {
        pairedAfter.add(j);
        pairedBefore.add(i);
      }
    });
  }
  const other = (writers: readonly string[]): boolean => writers.some((w) => w !== self);
  const removed: string[] = [];
  before.forEach((r, i) => {
    const line = stripEnding(r);
    if (pairedBefore.has(i) || !isNonTrivial(line)) return;
    const h = lineHash(line);
    if (other(prov.addedBy(h))) removed.push(h);
  });
  const added: string[] = [];
  after.forEach((r, j) => {
    const line = stripEnding(r);
    if (pairedAfter.has(j) || !isNonTrivial(line)) return;
    const h = lineHash(line);
    if (other(prov.deletedBy(h))) added.push(h);
  });
  return { removed, added };
}

/**
 * HLD-27 over the journal's whole-blob summaries (a binary path, an over-cap text path; provenance.ts PROV_PATH_HASH_CAP): the removed
 * side is a whole version another writer wrote (checked for a binary path and for a deletion only — a text edit of an over-cap
 * version is no revert of it), or the added side is a whole version another writer replaced (a stale copy, a /rewind restore).
 */
function wholeTaint(prev: Buffer | null, next: Buffer | null, binary: boolean, prov: ProvenanceJournal, self: PeerId): HunkTaint {
  const other = (writers: readonly string[]): boolean => writers.some((w) => w !== self);
  const removed = prev !== null && (binary || next === null) && other(prov.addedBy(blobHash(prev))) ? [blobHash(prev)] : [];
  const added = next !== null && other(prov.deletedBy(blobHash(next))) ? [blobHash(next)] : [];
  return { removed, added };
}

/** The line hashes a record's own change H0[p] → H1[p] removes and adds (s1 → s2 for a stage record), plus each side's whole-blob hash. */
async function ownChange(repo: GitRepo, r: HoldRecord, path: string): Promise<{ removed: Set<string>; added: Set<string> }> {
  const base: BlobMap = 'h0' in r.blobs ? r.blobs.h0 : r.blobs.s1;
  const h0 = blobAt(base, path) ?? ABSENT;
  const h1 = blobAt(heldSide(r), path) ?? ABSENT;
  const [b0, b1] = await readSides(repo, h0, h1);
  const binary = (b0 !== null && isBinaryBytes(b0)) || (b1 !== null && isBinaryBytes(b1));
  const u = binary ? { removed: [], added: [] }
    : b0 === null ? { removed: [], added: b1 === null ? [] : rows(b1) } : b1 === null ? { removed: rows(b0), added: [] } : unmatchedRows(b0, b1);
  const hashes = (rs: readonly Buffer[]): Set<string> => new Set(rs.map((x) => lineHash(stripEnding(x))));
  const removed = hashes(u.removed);
  const added = hashes(u.added);
  if (b0 !== null) removed.add(blobHash(b0));
  if (b1 !== null) added.add(blobHash(b1));
  return { removed, added };
}

/** The two sides' bytes (null for ABSENT), in one cat-file --batch. */
async function readSides(repo: GitRepo, a: OidOrAbsent, b: OidOrAbsent): Promise<[Buffer | null, Buffer | null]> {
  const want = [a, b].filter((o): o is Oid => o !== ABSENT);
  const bufs = await repo.readBlobs([...new Set(want)]);
  const byOid = new Map<string, Buffer>();
  [...new Set(want)].forEach((o, i) => byOid.set(o, bufs[i]!));
  return [a === ABSENT ? null : byOid.get(a)!, b === ABSENT ? null : byOid.get(b)!];
}

/** HLD-29: a RESOLVED_PUBLISH record on the path that rebases cleanly onto A and whose own change removes / adds every tainted row of the hunk. */
async function exempt(t: HunkTaint, path: string, records: readonly HoldRecord[], repo: GitRepo, cache: RebaseCache, A: TreeMap,
  own: Map<string, { removed: Set<string>; added: Set<string> } | null>): Promise<boolean> {
  for (const r of records) {
    let change = own.get(r.id);
    if (change === undefined) {
      try {
        change = (await cache.rebase(r, A)).ok ? await ownChange(repo, r, path) : null;
      } catch (e) {
        if (e instanceof KilledAt || !(e instanceof HoldOperatorError)) throw e;
        change = null;   // an operator error is never an exemption
      }
      own.set(r.id, change);
    }
    if (change !== null && t.removed.every((h) => change!.removed.has(h)) && t.added.every((h) => change!.added.has(h))) return true;
  }
  return false;
}

/** revertDetector: diff -U0 (prev, next) per delta; tainted when a removed non-trivial line was added, or an added one deleted, by another writer within retention; ws-equal pairs and hunks REBASE-matching a RESOLVED_PUBLISH record on p exempt; writes no object. */
export async function revertDetector(repo: GitRepo, deltas: readonly DetectorDelta[], prov: ProvenanceJournal, self: PeerId, resolved: readonly HoldRecord[], cache: RebaseCache, A: TreeMap): Promise<TaintedPath[]> {
  const out: TaintedPath[] = [];
  for (const d of deltas) {
    if (d.prev === d.next) continue;
    const [prev, next] = await readSides(repo, d.prev, d.next);
    // Binary bytes: the journal holds only whole-blob summaries for them (provenance.ts), so no row is compared.
    const binaryBytes = (prev !== null && isBinaryBytes(prev)) || (next !== null && isBinaryBytes(next));
    const binary = d.binary || binaryBytes;
    const before = prev === null || binaryBytes ? [] : rows(prev);
    const after = next === null || binaryBytes ? [] : rows(next);
    let hunks: Array<{ before: Buffer[]; after: Buffer[] }>;
    if (binaryBytes) {
      hunks = [];
    } else if (prev === null || next === null) {
      hunks = [{ before, after }];   // an ABSENT side: every row of the other side, no git call
    } else if (binary) {
      const u = unmatchedRows(prev, next);   // a binary-attributed path without a NUL: rows split at LF, as the journal hashes them
      hunks = [{ before: u.removed, after: u.added }];
    } else {
      const r = await repo.run(['diff', ...U0_OPTIONS, d.prev as Oid, d.next as Oid]);
      hunks = parseHunks(r.stdout).map((h) => ({ before: before.slice(h.oFrom, h.oTo), after: after.slice(h.nFrom, h.nTo) }));
    }
    const records = resolved.filter((r) => r.state === 'RESOLVED_PUBLISH' && r.paths.includes(d.path));
    const own = new Map<string, { removed: Set<string>; added: Set<string> } | null>();
    // The whole-blob summary taint first, then each hunk's rows.
    const taints = [wholeTaint(prev, next, binary, prov, self), ...hunks.map((h) => hunkTaint(h.before, h.after, prov, self, !binary))];
    let tainted = false;
    for (const t of taints) {
      if (t.removed.length === 0 && t.added.length === 0) continue;
      if (await exempt(t, d.path, records, repo, cache, A, own)) continue;
      tainted = true;
      break;
    }
    if (tainted) out.push({ path: d.path, pin: binary || d.next === ABSENT });
  }
  return out;
}

/** HLD-18, the single -U0 applier: A[p] plus only the -U0 hunks of diff(A[p], S_disk[p]) that contain a tainted line; output only a record's h1 (route (c) -w). */
export async function taintOnlyH1(repo: GitRepo, path: string, a: OidOrAbsent, sDisk: OidOrAbsent, prov: ProvenanceJournal, self: PeerId): Promise<Oid> {
  const [aBuf, sBuf] = await readSides(repo, a, sDisk);
  // S_disk is a whole version another writer replaced (an over-cap summary, provenance.ts): every hunk is the revert.
  if (sBuf !== null && wholeTaint(null, sBuf, false, prov, self).added.length > 0) return repo.hashBytes(sBuf, true);
  const aRows = aBuf === null ? [] : rows(aBuf);
  const sRows = sBuf === null ? [] : rows(sBuf);
  let hunks: Hunk[];
  if (aBuf === null || sBuf === null) {
    hunks = [{ oFrom: 0, oTo: aRows.length, nFrom: 0, nTo: sRows.length }];
  } else {
    const r = await repo.run(['diff', ...U0_OPTIONS, a as Oid, sDisk as Oid]);
    hunks = parseHunks(r.stdout);
  }
  const out: Buffer[] = [];
  let cursor = 0;
  for (const h of hunks) {
    const t = hunkTaint(aRows.slice(h.oFrom, h.oTo), sRows.slice(h.nFrom, h.nTo), prov, self, true);
    if (t.removed.length === 0 && t.added.length === 0) continue;
    out.push(...aRows.slice(cursor, h.oFrom), ...sRows.slice(h.nFrom, h.nTo));
    cursor = h.oTo;
  }
  out.push(...aRows.slice(cursor));
  return repo.hashBytes(Buffer.concat(out), true);
}

/** HLD-28: per tainted path a PATCH (H0 = A[p], H1 = taintOnlyH1) or PIN with guard revert, ON_DISK ACTIVE, origin 'human'; HLD-07 attach. */
export async function holdReverts(reg: HoldRegistry, repo: GitRepo, tainted: readonly TaintedPath[], A: TreeMap, sDisk: TreeMap, prov: ProvenanceJournal, self: PeerId): Promise<string[]> {
  const ids: string[] = [];
  for (const t of tainted) {
    const a: OidOrAbsent = A.get(t.path)?.oid ?? ABSENT;
    const s: OidOrAbsent = sDisk.get(t.path)?.oid ?? ABSENT;
    const held: OidOrAbsent = t.pin ? s : await taintOnlyH1(repo, t.path, a, s, prov, self);
    if (held === a) continue;   // no tainted change against A (the delta's taint is already in A): nothing to hold
    const h0: BlobMap = {};
    const h1: BlobMap = {};
    setBlob(h0, t.path, a);
    setBlob(h1, t.path, held);
    const out = await reg.holdOutcome({
      kind: t.pin ? 'PIN' : 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: [t.path], blobs: { h0, h1 },
      guard: 'revert', origin: 'human', cs_ids: [], displaced_by: null,
    });
    ids.push(out.id);
  }
  return ids;
}
