// Test-side readers of hold state (Plan 3 Task 13; the inputs of Tasks 14–16's oracles, X-03 inspection; TST-07 independence).
// Everything here reads git objects and files with its own git calls: the registry ref and its record blobs (parseRecord, the
// glossary §9 schema), the board's hold fold (Plan 2's Folder over that repo's objects) and its held/ subtrees, tree entries,
// blobs, status.json, and the D5 rows of the sync scope the SIM can reach. Nothing here is HoldRegistry, maskEntries, isDurable or
// an engine step, so an oracle built on these readers judges the engine instead of repeating it.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readHeldAll, type HeldBlob } from '../../src/board/boardCommit.js';
import { Folder, type FoldedHold } from '../../src/board/fold.js';
import { HUGE_BYTES, isQuarantined, wildmatch, type ScopeClass } from '../../src/data/scope.js';
import { PLAN2_REGION_SPEC } from '../../src/engine/deps.js';
import type { StatusJson } from '../../src/engine/status.js';
import { enc } from '../../src/git/enc.js';
import { parseOid, type Oid } from '../../src/git/oid.js';
import { GitRepo } from '../../src/git/repo.js';
import type { GitRunner } from '../../src/git/runner.js';
import { isTerminal, parseRecord, type HoldRecord } from '../../src/holds/record.js';
import type { RegistryLocal } from '../../src/holds/registry.js';
import { validPathSyntax } from '../../src/sec/validators.js';

/** One registry commit as written: its records (newest rev each, by id) and its local.json (R3-13), null when the tree has none. */
export interface RegistrySnapshot { head: Oid | null; records: ReadonlyMap<string, HoldRecord>; local: Readonly<RegistryLocal> | null; }

const RECORDS = 'records/';
const RECORD_SUFFIX = '.json';
const LOCAL_JSON = 'local.json';

async function git(g: GitRunner, cwd: string, args: string[], okCodes: readonly number[] = [0], stdin?: Buffer): Promise<{ code: number; stdout: Buffer }> {
  const r = await g.run(args, { class: 'local', cwd, ...(stdin === undefined ? {} : { stdin }) });
  if (!okCodes.includes(r.code)) throw new Error(`holdsView: git ${args.slice(0, 3).join(' ')} in ${cwd} failed (${r.code}): ${r.stderr.toString('utf8').trim().slice(0, 300)}`);
  return { code: r.code, stdout: r.stdout };
}

/** `ls-tree -r -z <treeish>`: every leaf by repo path (blob, symlink or gitlink entries alike). */
export async function treeEntries(g: GitRunner, repoDir: string, treeish: string): Promise<Map<string, { mode: string; oid: Oid }>> {
  const out = (await git(g, repoDir, ['ls-tree', '-r', '-z', treeish])).stdout.toString('utf8');
  const map = new Map<string, { mode: string; oid: Oid }>();
  for (const rec of out.split('\0')) {
    if (rec.length === 0) continue;
    const tab = rec.indexOf('\t');
    const [mode = '', , oid = ''] = rec.slice(0, tab).split(' ');
    map.set(rec.slice(tab + 1), { mode, oid: parseOid(oid) });
  }
  return map;
}

/** `cat-file blob <oid>` (test-side; not GitRepo.readBlob). */
export async function readBlob(g: GitRunner, repoDir: string, oid: Oid): Promise<Buffer> {
  return (await git(g, repoDir, ['cat-file', 'blob', parseOid(oid)])).stdout;
}

/** Many blobs in one `cat-file --batch` (the registry's record files): by oid. */
async function readBlobs(g: GitRunner, repoDir: string, oids: readonly Oid[]): Promise<Map<Oid, Buffer>> {
  const out = new Map<Oid, Buffer>();
  const want = [...new Set(oids)];
  if (want.length === 0) return out;
  const buf = (await git(g, repoDir, ['cat-file', '--batch'], [0], Buffer.from(`${want.join('\n')}\n`, 'utf8'))).stdout;
  let at = 0;
  for (const oid of want) {
    const nl = buf.indexOf(0x0a, at);
    const header = buf.subarray(at, nl).toString('utf8').split(' ');
    if (header[0] !== oid || header[1] !== 'blob') throw new Error(`holdsView: cat-file --batch returned ${header.join(' ')} for ${oid}`);
    const size = Number(header[2]);
    out.set(oid, buf.subarray(nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1;
  }
  return out;
}

/**
 * local.json as written (one shape with registry.ts's RegistryLocal; a key the writer left out because it was empty reads as empty;
 * `settleCopies` — final review r2 A-2, the restart's safety copies, copy id → parent — present only when the writer wrote it, as
 * registry.ts leaves the empty map out; INV-HLD-SINGLE's exemption reads it, ruling R3-FF4-A1; `restored` — E16-E, a restore's writes
 * a restart re-seeds — likewise).
 */
export function parseLocal(buf: Buffer): RegistryLocal {
  const v = JSON.parse(buf.toString('utf8')) as Partial<RegistryLocal>;
  return {
    companions: v.companions ?? {}, explicit: v.explicit ?? [], rejected: v.rejected ?? {}, inflight: v.inflight ?? {},
    keepSyncing: v.keepSyncing ?? [], copies: v.copies ?? {},
    ...(v.settleCopies === undefined ? {} : { settleCopies: v.settleCopies }),
    ...(v.restored === undefined ? {} : { restored: v.restored }),
  };
}

/**
 * The registry refs/cowork-local/<enc(branch)>/holds of the clone at `peerDir` (or the registry commit `at`): every records/<id>.json
 * through parseRecord, and local.json. head null (and no records) when the ref does not exist.
 */
export async function readRegistry(g: GitRunner, peerDir: string, branch: string, at?: Oid | null): Promise<RegistrySnapshot> {
  let head: Oid | null;
  if (at !== undefined && at !== null) {
    head = parseOid(at);
  } else {
    const r = await git(g, peerDir, ['rev-parse', '--verify', '--quiet', `refs/cowork-local/${enc(branch)}/holds^{commit}`], [0, 1]);
    head = r.code === 0 ? parseOid(r.stdout.toString('utf8').trim()) : null;
  }
  if (head === null) return { head: null, records: new Map(), local: null };
  const entries = await treeEntries(g, peerDir, head);
  const recordOids: Array<[string, Oid]> = [];
  let localOid: Oid | null = null;
  for (const [path, e] of entries) {
    if (path === LOCAL_JSON) localOid = e.oid;
    else if (path.startsWith(RECORDS) && path.endsWith(RECORD_SUFFIX)) recordOids.push([path.slice(RECORDS.length, -RECORD_SUFFIX.length), e.oid]);
  }
  const blobs = await readBlobs(g, peerDir, [...recordOids.map(([, o]) => o), ...(localOid === null ? [] : [localOid])]);
  const records = new Map<string, HoldRecord>();
  for (const [id, oid] of recordOids.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const r = parseRecord(blobs.get(oid) as Buffer);
    if (r.id !== id) throw new Error(`holdsView: records/${id}.json holds record ${r.id}`);
    records.set(id, r);
  }
  return { head, records, local: localOid === null ? null : parseLocal(blobs.get(localOid) as Buffer) };
}

/** A peer id that is nobody's: the Folder's `self` only labels own rejections, which a test-side fold ignores. */
const READER = '0'.repeat(32);

/** The board commit's hold fold (Plan 2's Folder from genesis, over the repo's objects) and its held/ subtrees by hold id. */
export async function boardHolds(g: GitRunner, repoDir: string, board: Oid): Promise<{ holds: Record<string, FoldedHold>; held: Map<string, HeldBlob[]> }> {
  const repo = new GitRepo(g, { workTree: repoDir, gitDir: join(repoDir, '.git'), coworkDir: join(repoDir, '.git', 'cowork') }, () => ({
    attrTree: null, filterDrivers: [], identity: { name: 'SIM reader', email: 'reader@cowork.invalid' }, wallMs: () => 0,
  }));
  const folded = await new Folder(repo, READER).foldTo(parseOid(board), null, PLAN2_REGION_SPEC);
  return { holds: folded.state.holds, held: await readHeldAll(repo, parseOid(board)) };
}

/** `sync.exclude` of .cowork/config.json at `epochBase`, read leniently: a missing file, bad JSON or a non-string entry gives nothing. */
async function syncExclude(g: GitRunner, repoDir: string, epochBase: Oid): Promise<string[]> {
  const r = await git(g, repoDir, ['cat-file', 'blob', `${parseOid(epochBase)}:.cowork/config.json`], [0, 128]);
  if (r.code !== 0) return [];
  try {
    const v = JSON.parse(r.stdout.toString('utf8')) as { sync?: { exclude?: unknown } };
    const ex = v.sync?.exclude;
    return Array.isArray(ex) ? ex.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  } catch {
    return [];
  }
}

/**
 * The D5 rows the SIM reaches, for a tracked path (03-data §3.6): QUARANTINED (isQuarantined, no hooks path), UNMANAGED (not
 * validPathSyntax; a gitlink or symlink; a `sync.exclude` glob of .cowork/config.json at EPOCH_BASE), SAVE_ONLY (a `.gitignore`;
 * size ≥ HUGE_BYTES), LOCAL_ONLY (a path of a non-terminal ON_DISK local_only record other than an INCOMING one — R3-21 as amended by
 * Plan 3 Task 6, core.ts localOnlyScope: an INCOMING record holds TIP's bytes, none of the disk's; integration I-1, ruling R3-FF2-D1),
 * else LIVE. Throws `unsupported scope
 * input` when EPOCH_BASE holds a .gitattributes or the repo configures a merge driver (no SIM fixture has either), so an oracle
 * never silently diverges from D5's attribute rows.
 */
export async function simScope(g: GitRunner, repoDir: string, epochBase: Oid, records: readonly HoldRecord[]): Promise<(path: string, mode: string, size: number) => ScopeClass> {
  const base = await treeEntries(g, repoDir, parseOid(epochBase));
  const attrs = [...base.keys()].filter((p) => p === '.gitattributes' || p.endsWith('/.gitattributes'));
  if (attrs.length > 0) throw new Error(`unsupported scope input: EPOCH_BASE ${epochBase} holds ${attrs.join(', ')}`);
  const drivers = await git(g, repoDir, ['config', '--get-regexp', '^merge\\..*\\.driver$'], [0, 1]);
  if (drivers.code === 0 && drivers.stdout.length > 0) throw new Error(`unsupported scope input: a merge driver is configured (${drivers.stdout.toString('utf8').trim().split('\n')[0]})`);
  const exclude = await syncExclude(g, repoDir, epochBase);
  const localOnly = new Set<string>();
  for (const r of records) if (!isTerminal(r) && r.residence === 'ON_DISK' && r.local_only && r.kind !== 'INCOMING') for (const p of r.paths) localOnly.add(p);
  return (path: string, mode: string, size: number): ScopeClass => {
    if (isQuarantined(path, null)) return 'QUARANTINED';
    if (!validPathSyntax(path)) return 'UNMANAGED';
    if (mode === '160000' || mode === '120000') return 'UNMANAGED';
    if (exclude.some((x) => wildmatch(x, path))) return 'UNMANAGED';
    if (path === '.gitignore' || path.endsWith('/.gitignore')) return 'SAVE_ONLY';
    if (size >= HUGE_BYTES) return 'SAVE_ONLY';
    if (localOnly.has(path)) return 'LOCAL_ONLY';
    return 'LIVE';
  };
}

/** <peerDir>/.git/cowork/status.json, or null when it does not exist yet. */
export async function readStatus(peerDir: string): Promise<StatusJson | null> {
  try {
    return JSON.parse((await readFile(join(peerDir, '.git', 'cowork', 'status.json'))).toString('utf8')) as StatusJson;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
