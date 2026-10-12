// Room discovery (12 §3.3.1, §3.3.2; VIZ-06, VIZ-07; rulings R-V09, R-V46, R-V54; X-63): in 8a only --repo arguments, which
// arrive absolute and checked by the CLI (cli/paths.ts is never imported here, R-V54). The viewer reads <path>/.git with the
// Fs port and never runs git with a cwd inside a worktree; room admission is one for-each-ref under refs/cowork-remote/
// through VizGit. Rooms are keyed by the canonical root of the main worktree (canonRoot, the string the `live` marker of
// Plans 5, 7 and 8b holds): two spellings of one clone are one room, and the root is never served (RoomSpec docs).
import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { base32c } from '../../board/ids.js';
import { canonRoot, type RootProbe } from '../../data/canonRoot.js';
import { enc } from '../../git/enc.js';
import type { Fs } from '../../ports/fs.js';
import type { BoundedReader } from './boundedRead.js';
import type { RoomSpec } from './roomSource.js';
import { readStatus } from './status.js';
import type { VizGit } from './vizGit.js';

export const ROOMS_MAX = 32;
/**
 * The most --repo admissions (each one for-each-ref) at once (Plan 8a final review, fix Group D): every admission runs inside the
 * CLI's ready window (5 s; 15 s on Windows, where a git process start costs most), so 32 of them one after another could outlast it.
 */
export const ADMIT_POOL = 8;
const BOARD_REF = /^refs\/cowork-remote\/([^/]+)\/board$/;
/** enc's alphabet: unreserved bytes and upper-case %XX escapes (glossary §4). */
const ENC_FORM = /^(?:[A-Za-z0-9_-]|%[0-9A-F]{2})+$/;

/** 'r' + base32c(sha256(salt ‖ utf8(canonical)))[0:8]: opaque, salted per viewer, never a path. */
export function roomId(salt: Uint8Array, canonical: string): string {
  const d = createHash('sha256').update(salt).update(Buffer.from(canonical, 'utf8')).digest();
  return `r${base32c(d).slice(0, 8)}`;
}

/** The inverse of enc(): the branch whose enc() is exactly e, else null (anything enc would not produce). */
export function decodeEnc(e: string): string | null {
  if (typeof e !== 'string' || !ENC_FORM.test(e)) return null;
  const bytes: number[] = [];
  for (let i = 0; i < e.length; i++) {
    if (e[i] === '%') {
      bytes.push(parseInt(e.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(e.charCodeAt(i));
    }
  }
  // Buffer decoding keeps a BOM and turns bytes that are not UTF-8 into U+FFFD, which enc() spells differently: refused below.
  const b = Buffer.from(bytes).toString('utf8');
  try {
    return enc(b) === e ? b : null;
  } catch {
    return null;
  }
}

export type Discovery = { rooms: RoomSpec[]; more: number } | { refuse: 'RF_VIZ_REPO_NOT_LIVE' | 'RF_VIZ_NO_ROOMS' };

interface Found { spec: RoomSpec; canonical: string; }

/** UTF-16 code-unit order. */
const byUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One --repo argument's gitdir: lstat <path>/.git (a directory → its realpath; a file, a symlink or nothing → null). No git runs. */
async function gitDirOf(path: string, deps: DiscoverDeps): Promise<string | null> {
  const p = deps.platform === 'win32' ? win32 : posix;
  const dotGit = p.join(path, '.git');
  const l = await deps.fs.lstat(dotGit);
  if (l === null || !l.isDirectory || l.isSymbolicLink) return null;
  return deps.fs.realpath(dotGit);
}

/**
 * One --repo argument with its gitdir (gitDirOf): remoteRefs() keeps the refs/cowork-remote/<e>/board refs whose <e> decodes;
 * one → it; several → the one whose decoded branch equals status.json's branch (one bounded read), else refuse. The label is the
 * basename of the canonical root (the main worktree's realpath), so every spelling of one clone gets the same label.
 */
async function admit(path: string, gitDir: string, deps: DiscoverDeps): Promise<Found | null> {
  const boards: Array<{ ref: string; branch: string }> = [];
  for (const { ref } of await deps.git(gitDir).remoteRefs()) {
    const m = BOARD_REF.exec(ref);
    const branch = m === null ? null : decodeEnc(m[1]!);
    if (branch !== null) boards.push({ ref, branch });
  }
  let pick: { ref: string; branch: string } | undefined;
  if (boards.length === 1) {
    pick = boards[0];
  } else if (boards.length > 1) {
    const s = await readStatus(gitDir, null, { fs: deps.fs, reader: deps.reader });
    const want = s.unreadable ? undefined : s.fields?.branch;
    const matching = boards.filter((b) => b.branch === want);
    if (matching.length === 1) pick = matching[0];
  }
  if (pick === undefined) return null;
  const canonical = canonRoot(path, deps.probe, deps.platform);
  return {
    canonical,
    spec: { id: roomId(deps.salt, canonical), kind: 'git', label: posix.basename(canonical), branch: pick.branch, gitDir, boardRef: pick.ref, canonicalRoot: canonical },
  };
}

export interface DiscoverDeps { fs: Fs; reader: BoundedReader; git: (gitDir: string) => VizGit; salt: Uint8Array; platform: NodeJS.Platform; probe: RootProbe; }

/**
 * f over items, at most `size` calls at once, each result at its item's index; null as soon as one call gives null or throws (no
 * further call starts, and the calls already running are awaited before it returns).
 */
async function inPool<T, R>(items: readonly T[], size: number, f: (item: T) => Promise<R | null>): Promise<R[] | null> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++;
      let r: R | null;
      try {
        r = await f(items[i]!);
      } catch {
        r = null;
      }
      if (r === null) failed = true;
      else out[i] = r;
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => worker()));
  return failed ? null : out;
}

/**
 * --repo only in 8a (paths arrive absolute and checked by the CLI, R-V54): no argument → RF_VIZ_NO_ROOMS. Every argument's gitdir
 * first (gitDirOf, no git); arguments whose gitdir an earlier argument has are dropped before any git runs (the first spelling
 * kept); the rest admitted as above through a pool of ADMIT_POOL, their results kept by argument index. Any failure — an argument
 * without a gitdir, a refused admission, a throw — refuses the run: RF_VIZ_REPO_NOT_LIVE. Then deduplicated by the canonical root
 * (X-63, the first spelling kept); sorted by (label, canonical root) in UTF-16 code units; the first 32 and the count of the rest.
 */
export async function discoverRooms(repos: readonly string[], deps: DiscoverDeps): Promise<Discovery> {
  if (repos.length === 0) return { refuse: 'RF_VIZ_NO_ROOMS' };
  const refuse: Discovery = { refuse: 'RF_VIZ_REPO_NOT_LIVE' };
  const firstOf = new Map<string, number>();   // gitdir → the first argument naming it
  for (let i = 0; i < repos.length; i++) {
    let gitDir: string | null;
    try {
      gitDir = await gitDirOf(repos[i]!, deps);
    } catch {
      gitDir = null;
    }
    if (gitDir === null) return refuse;
    if (!firstOf.has(gitDir)) firstOf.set(gitDir, i);
  }
  const found = await inPool([...firstOf], ADMIT_POOL, ([gitDir, i]) => admit(repos[i]!, gitDir, deps));
  if (found === null) return refuse;
  const byRoot = new Map<string, Found>();
  for (const f of found) if (!byRoot.has(f.canonical)) byRoot.set(f.canonical, f);
  const all = [...byRoot.values()].sort((a, b) => byUnits(a.spec.label, b.spec.label) || byUnits(a.canonical, b.canonical));
  return { rooms: all.slice(0, ROOMS_MAX).map((f) => f.spec), more: Math.max(0, all.length - ROOMS_MAX) };
}
