// The incoming form check (03-data §3.2 "Algorithm D2", §3.10 `formCheckIncoming`; DAT-11; ruling R3-32). Called
// formCheckIncoming everywhere (Global Constraints "Names"): the 05-holds revert detector is another algorithm.
//
// Decided per path on (A, TIP), not per commit (R3-32): a text, unfiltered path present in A and in TIP violates iff form(TIP[p]) is
// neither form(A[p]) nor the form of p in the second parent X of a base-move commit on the first-parent chain that changed p on its
// way from A[p] to TIP[p]. The per-commit reading would re-flag the commit that restores the form (I-DAT-13 must release); a
// violation fixed inside one LA_C..TIP span is applied (its net form conforms). `commit` names the newest commit up to TIP that set
// TIP[p], which lies in (LA_C, TIP] whenever a commit there changed p.
//
// The chain of p is not cut at LA_C: an apply moves LA_C to TIP while a deferred path keeps A[p] (R-05), so the next apply re-checks
// the same (A, TIP) pair with LA_C == TIP; the commits that matter are those that changed p after the commit that gave p A's blob.
// The apply reads the same chains for HLD-53's CS membership of a path deferred by an earlier apply (apply.ts incomingBase; the range
// (LA_C, TIP] plus each deferred path's chain back to its A blob, bounded by CHAIN_WINDOW — controller ruling, Task 6 fix round 1).
// pathChains computes the chains of many paths in ONE walk (one `git log --raw` limited to those paths) and caches it by (TIP, the
// window's bound, the (path, A blob) pairs), so a deferral that lasts hours costs no git process per path and per apply.
// At the window's edge the check fails CLOSED: a path whose chain the window cuts off still violates when its forms differ (the
// eol-form hold stays; it is released by its condition, never by the bound).
//
// Bytes only (form() reads endings and the BOM, DAT-03): a binary side (a NUL in its first 8,000 bytes, DAT-04), a path the
// caller's `textUnfiltered` rejects (EPOCH_BASE binary/-text/merge=binary attributes, a filter), a path absent on either side, a
// symlink or gitlink entry and an unchanged blob are never checked. Git runs only for paths whose forms differ: one walk (cached),
// the window's bound (cached), the tree entry of each base-move second parent on the way, and for a path the window cut off the
// newest commit that set TIP[p].
import { parseOid, type Oid } from '../git/oid.js';
import { isRegularEntry, type FileMode, type GitRepo, type TreeEntry, type TreeMap } from '../git/repo.js';
import { form, isBinaryBytes, type Form } from './rows.js';

export interface FormViolation { path: string; commit: Oid; }

const sameForm = (a: Form, b: Form): boolean => a.bom === b.bom && a.eol === b.eol;
/**
 * The window of a chain: the walk covers at most this many first-parent commits below LA_C (plus (LA_C, TIP]), so a path-limited
 * walk never scans the whole history of a rarely changed path for its stop (a deferral older than the window reaches back to the
 * window's end).
 */
export const CHAIN_WINDOW = 1_000;
let chainWindow = CHAIN_WINDOW;

/** Test hook (like setCrashHandler): the window every chain walk uses from now on; null restores CHAIN_WINDOW. */
export function setChainWindow(n: number | null): void {
  if (n !== null && !(Number.isSafeInteger(n) && n > 0)) throw new RangeError(`setChainWindow: a positive integer, got ${n}`);
  chainWindow = n ?? CHAIN_WINDOW;
}

const NUL = String.fromCharCode(0);

/** The entry of `path` in `commit` (one ls-tree with a literal pathspec), or null when the commit has none there. */
async function entryAt(repo: GitRepo, commit: Oid, path: string): Promise<TreeEntry | null> {
  const out = (await repo.run(['ls-tree', '-z', commit, '--', path], { literalPathspecs: true })).stdout.toString('utf8');
  for (const rec of out.split(NUL)) {
    const tab = rec.indexOf('\t');
    if (tab < 0 || rec.slice(tab + 1) !== path) continue;
    const [mode, type, oid] = rec.slice(0, tab).split(' ');
    return type === 'blob' && oid !== undefined ? { path, mode: mode as FileMode, oid: parseOid(oid) } : null;
  }
  return null;
}

/** Per repo: the bound of LA_C's window by (LA_C, window) — an immutable answer. */
const bounds = new WeakMap<GitRepo, Map<string, Oid | null>>();

/** The oldest commit of LA_C's window (the window's size of first-parent commits from LA_C), the exclusive bound of every chain walk; null when the chain is shorter. Cached. */
export async function chainBound(repo: GitRepo, laC: Oid): Promise<Oid | null> {
  let memo = bounds.get(repo);
  if (memo === undefined) bounds.set(repo, (memo = new Map()));
  const key = `${laC} ${chainWindow}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const r = await repo.run(['rev-list', '--first-parent', `--skip=${chainWindow}`, '--max-count=1', parseOid(laC)]);
  const line = r.stdout.toString('utf8').trim();
  const bound = line.length === 0 ? null : parseOid(line);
  if (memo.size >= 16) memo.clear();
  memo.set(key, bound);
  return bound;
}

/** One commit of a path's chain: it changed the path (its first-parent diff names it), its parents as git lists them, the blob it set (null: removed, or not a blob). */
export interface ChainCommit { commit: Oid; parents: Oid[]; blob: Oid | null; }
/**
 * The chain of one path up to the tip: the first-parent commits that changed it after `stop`, newest first; `stop` = the newest commit
 * that set it to the caller's blob (null = absent), or null when none was found above the bound (the window cut it off, or the blob
 * never was on this chain).
 */
export interface PathChain { commits: ChainCommit[]; stop: Oid | null; }
/** pathChains' answer: each wanted path's chain, and every listed commit newest first (a commit's index orders it by age). */
export interface PathChains { chains: ReadonlyMap<string, PathChain>; order: ReadonlyMap<Oid, number>; }

/** Per repo: the last few walks by (tip, bound, the (path, blob) pairs) — commits are immutable, so a hit is exact. */
const walks = new WeakMap<GitRepo, Array<{ key: string; value: PathChains }>>();
const WALK_CACHE = 4;

/**
 * The chains of many paths up to `tip` in ONE walk (controller ruling, Task 6 fix round 1): one `git log --first-parent
 * --diff-merges=first-parent --raw -z` over (bound, tip] limited to the paths (literal pathspecs, read from stdin so thousands of
 * paths never meet the argv limit; a path holding CR or LF goes on argv), which names, per listed commit, each wanted path it
 * changed and the blob it set. `wants` maps each path to the blob whose setting commit ends its chain (null = absent). Cached by
 * (tip, bound, wants).
 */
export async function pathChains(repo: GitRepo, tip: Oid, wants: ReadonlyMap<string, Oid | null>, bound: Oid | null): Promise<PathChains> {
  const paths = [...wants.keys()].sort();
  const key = [tip, bound ?? '', ...paths.map((p) => `${p}${NUL}${wants.get(p) ?? ''}`)].join(NUL);
  let cache = walks.get(repo);
  if (cache === undefined) walks.set(repo, (cache = []));
  const hit = cache.find((c) => c.key === key);
  if (hit !== undefined) return hit.value;

  const entries = new Map<string, ChainCommit[]>(paths.map((p) => [p, []] as const));
  const order = new Map<Oid, number>();
  if (paths.length > 0) {
    const onArgv = paths.filter((p) => /[\r\n]/.test(p));
    const onStdin = paths.filter((p) => !/[\r\n]/.test(p));
    const args = [
      'log', '--no-show-signature', '--no-color', '--first-parent', '--diff-merges=first-parent', '--raw', '-z', '--no-renames', '--no-abbrev',
      '--format=%x00%H %P', parseOid(tip), ...(bound !== null ? [`^${parseOid(bound)}`] : []), '--stdin', ...(onArgv.length > 0 ? ['--', ...onArgv] : []),
    ];
    const r = await repo.run(args, {
      stdin: Buffer.from(`--\n${onStdin.map((p) => `${p}\n`).join('')}`, 'utf8'),
      literalPathspecs: true,
      config: { 'log.showroot': 'true', 'log.follow': 'false' },
    });
    const tokens = r.stdout.toString('utf8').split(NUL);
    let cur: { commit: Oid; parents: Oid[] } | null = null;
    for (let i = 0; i < tokens.length; i++) {
      let head = tokens[i]!;
      if (head.startsWith('\n')) head = head.slice(1);
      if (head.length === 0) continue;
      if (!head.startsWith(':')) {
        // A commit header `<H> <parents…>` (hex: never a raw entry); a raw entry may follow it after a newline in the same token.
        const nl = head.indexOf('\n');
        const ids = (nl < 0 ? head : head.slice(0, nl)).split(' ').filter((x) => x.length > 0);
        cur = { commit: parseOid(ids[0]!), parents: ids.slice(1).map((x) => parseOid(x)) };
        order.set(cur.commit, order.size);
        head = nl < 0 ? '' : head.slice(nl + 1);
        if (!head.startsWith(':')) continue;
      }
      // A raw entry `:<old mode> <new mode> <old oid> <new oid> <status>`, then its path.
      const path = tokens[++i] ?? '';
      const f = head.slice(1).split(' ');
      const list = entries.get(path);
      if (cur === null || list === undefined || f.length < 5) continue;
      const newMode = f[1]!;
      const blob = newMode === '000000' || newMode === '160000' ? null : parseOid(f[3]!);
      list.push({ commit: cur.commit, parents: cur.parents, blob });
    }
  }
  const chains = new Map<string, PathChain>();
  for (const p of paths) {
    const list = entries.get(p)!;
    const a = wants.get(p) ?? null;
    const at = list.findIndex((c) => c.blob === a);
    chains.set(p, at < 0 ? { commits: list, stop: null } : { commits: list.slice(0, at), stop: list[at]!.commit });
  }
  const value: PathChains = { chains, order };
  cache.push({ key, value });
  if (cache.length > WALK_CACHE) cache.shift();
  return value;
}

/** The newest first-parent commit up to `tip` that changed `path` (an unbounded literal walk), or `tip` when none is found. */
async function newestSetting(repo: GitRepo, tip: Oid, path: string): Promise<Oid> {
  const r = await repo.run(['rev-list', '--first-parent', '--max-count=1', parseOid(tip), '--', path], { literalPathspecs: true });
  const line = r.stdout.toString('utf8').trim();
  return line.length === 0 ? tip : parseOid(line);
}

/**
 * formCheckIncoming over LA_C..TIP, decided per path on (A, TIP): a text, unfiltered path present in A and TIP violates iff
 * form(TIP[p]) ∉ {form(A[p])} ∪ {form(X[p]) : X second parent of a base-move commit on the chain that changed p}; commit = the
 * newest commit that set TIP[p]. A path whose chain the window cut off is judged on the commits the window holds and violates
 * unless one of them allows TIP's form (fail closed). Violations in path order.
 */
export async function formCheckIncoming(repo: GitRepo, laC: Oid, tip: Oid, A: TreeMap, tipMap: TreeMap, textUnfiltered: (path: string) => boolean): Promise<FormViolation[]> {
  const candidates: Array<{ path: string; a: Oid; t: Oid }> = [];
  for (const [path, t] of tipMap) {
    const a = A.get(path);
    if (!isRegularEntry(a) || !isRegularEntry(t) || a.oid === t.oid || !textUnfiltered(path)) continue;
    candidates.push({ path, a: a.oid, t: t.oid });
  }
  if (candidates.length === 0) return [];
  const oids = [...new Set(candidates.flatMap((c) => [c.a, c.t]))];
  const read = await repo.readBlobs(oids);
  const bytes = new Map<Oid, Buffer>(oids.map((o, i) => [o, read[i]!] as const));
  const differing = candidates.filter((c) => {
    const a = bytes.get(c.a)!;
    const t = bytes.get(c.t)!;
    return !isBinaryBytes(a) && !isBinaryBytes(t) && !sameForm(form(t), form(a));
  }).sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  if (differing.length === 0) return [];

  const { chains } = await pathChains(repo, tip, new Map(differing.map((c) => [c.path, c.a] as const)), await chainBound(repo, laC));
  const out: FormViolation[] = [];
  const seconds = new Map<string, TreeEntry | null>();
  for (const c of differing) {
    const ft = form(bytes.get(c.t)!);
    const chain = chains.get(c.path)!;
    let allowed = false;
    for (const { parents } of chain.commits) {
      const x = parents[1];
      if (x === undefined) continue;
      const k = `${x}${NUL}${c.path}`;
      let xe = seconds.get(k);
      if (xe === undefined) seconds.set(k, (xe = await entryAt(repo, x, c.path)));
      if (!isRegularEntry(xe ?? undefined)) continue;
      const xb = xe!.oid === c.t ? bytes.get(c.t)! : (await repo.readBlobs([xe!.oid]))[0]!;
      if (!isBinaryBytes(xb) && sameForm(form(xb), ft)) {
        allowed = true;
        break;
      }
    }
    if (allowed) continue;
    // Fail closed (controller ruling): no commit of the window changed p — the window cut its chain off — yet the forms differ.
    out.push({ path: c.path, commit: chain.commits[0]?.commit ?? (await newestSetting(repo, tip, c.path)) });
  }
  return out;
}
