// The canonical root form (glossary §24 default 12; 06 §3.4.1 step 3, CCI-07, SEC-21): one string per filesystem location,
// whatever its spelling. X-63: the one canonRoot of every plan — created by Plan 8a Task 7 at Plan 5's declared signature
// (verify pass V-12); Plan 5 Task 1 adds sameRoot, endpointRoot, findRepo and liveState here in place. Pure over the injected
// probe; a node-only leaf (imports only the RootProbe type and node:*). The `live` marker holds canonRoot(main worktree) + LF
// for Plans 5, 7 and 8b alike, and the viewer's room key is the same string (RoomSpec.canonicalRoot).
import { posix, win32 } from 'node:path';
import type { RootProbe } from '../ports/fs.js';

export type { RootProbe } from '../ports/fs.js';

/** p without trailing separators, a root (`/`, `C:\`, `\\server\share\`) excepted. */
function stripTrailing(p: string, path: typeof posix): string {
  const root = path.parse(p).root;
  let s = p;
  while (s.length > root.length && (s.endsWith('/') || (path === win32 && s.endsWith('\\')))) s = s.slice(0, -1);
  return s;
}

/** Ruling P5-T4-1: the realpath errors of a link lstat finds but cannot be followed — dangling (ENOENT, ENOTDIR) or looping (ELOOP). */
const UNRESOLVABLE: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

/** realpathNative(p) when lstat finds p; null when it does not, or when p is a dangling or looping link (P5-T4-1: such a component counts as
 *  missing). Any other realpath failure throws (fail closed). */
function resolvedOrNull(p: string, probe: RootProbe): string | null {
  if (!probe.exists(p)) return null;
  try {
    return probe.realpathNative(p);
  } catch (e) {
    const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
    if (typeof code === 'string' && UNRESOLVABLE.has(code)) return null;
    throw e;
  }
}

/**
 * realpathSync.native of the nearest ancestor that exists and resolves + the remaining components; lower-case drive letter; '\' → '/'; NFC.
 * A dangling or looping link (lstat finds it, realpath answers ENOENT, ENOTDIR or ELOOP) counts as a missing component, so its name is kept
 * verbatim like that of a file not yet written (P5-T4-1); any other realpath error throws.
 * The path rules follow `platform` (win32: both separators, drive letters), not the running OS, so a fake probe can stand in
 * for another platform. The on-disk case is kept (no case folding: sameRoot compares with the DAT-34 case rule).
 */
export function canonRoot(p: string, probe: RootProbe, platform: NodeJS.Platform): string {
  const path = platform === 'win32' ? win32 : posix;
  let cur = stripTrailing(platform === 'win32' ? p.replace(/\//g, '\\') : p, path);
  const rest: string[] = [];
  let resolved = resolvedOrNull(cur, probe);
  while (resolved === null) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
    resolved = resolvedOrNull(cur, probe);
  }
  const base = resolved ?? cur;
  let out = rest.length === 0 ? base : path.join(base, ...rest);
  if (platform === 'win32') out = out.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
  return out.normalize('NFC');
}

/** The DAT-34 case rule: case-insensitive on win32 and darwin, exact elsewhere. */
const foldsCase = (platform: NodeJS.Platform): boolean => platform === 'win32' || platform === 'darwin';

/** DAT-34 rule: case-insensitive on win32 and darwin, exact elsewhere (String.prototype.toLowerCase: locale-independent). */
export function sameRoot(a: string, b: string, platform: NodeJS.Platform): boolean {
  return foldsCase(platform) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** SEC-21 endpoint input: canonRoot(common gitdir), lower-cased (locale-independent, never toLocaleLowerCase) on win32/darwin. */
export function endpointRoot(commonGitdir: string, probe: RootProbe, platform: NodeJS.Platform): string {
  const c = canonRoot(commonGitdir, probe, platform);
  return foldsCase(platform) ? c.toLowerCase() : c;
}

export type RepoLocation =
  | { kind: 'dir'; root: string; gitdir: string }
  | { kind: 'file'; root: string; commonGitdir: string | null; submodule: boolean };   // linked worktree / .claude/worktrees/** / submodule: never live

/** A gitdir under a `modules` directory is a submodule's (06 §3.4.1 step 3: WT_SUBMODULE). */
const underModules = (gitdir: string): boolean => gitdir.split(/[\\/]+/).includes('modules');

/**
 * Walk up from start to the first `.git` entry; parses `gitdir:` (resolved against the `.git` file's directory) and the gitdir's
 * `commondir` (resolved against the gitdir; absent = the gitdir itself) without git; null when none (exit 0 silently). Paths in the
 * result are canonRoot forms; a `.git` file whose target is missing or unreadable gives commonGitdir null.
 */
export function findRepo(start: string, probe: RootProbe, platform: NodeJS.Platform): RepoLocation | null {
  const path = platform === 'win32' ? win32 : posix;
  const canon = (p: string): string => canonRoot(p, probe, platform);
  let dir = stripTrailing(platform === 'win32' ? start.replace(/\//g, '\\') : start, path);
  for (;;) {
    const dotgit = path.join(dir, '.git');
    if (probe.exists(dotgit)) {
      if (probe.isDir(dotgit)) return { kind: 'dir', root: canon(dir), gitdir: canon(dotgit) };
      const first = (probe.readText(dotgit) ?? '').split(/\r?\n/)[0] ?? '';
      const m = /^gitdir:[ \t]*(.*?)[ \t]*$/.exec(first);
      if (m === null || m[1] === '') return { kind: 'file', root: canon(dir), commonGitdir: null, submodule: false };
      const gitdir = path.resolve(dir, m[1] as string);
      const submodule = underModules(gitdir);
      if (!probe.exists(gitdir)) return { kind: 'file', root: canon(dir), commonGitdir: null, submodule };
      const commondir = (probe.readText(path.join(gitdir, 'commondir')) ?? '').split(/\r?\n/)[0]?.trim() ?? '';
      const common = commondir === '' ? gitdir : path.resolve(gitdir, commondir);
      return { kind: 'file', root: canon(dir), commonGitdir: probe.exists(common) ? canon(common) : null, submodule };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** live iff <gitdir>/cowork/live exists and names this worktree's canonical root (sameRoot); paused iff <gitdir>/cowork/paused also exists. */
export function liveState(loc: Extract<RepoLocation, { kind: 'dir' }>, probe: RootProbe, platform: NodeJS.Platform): 'nonlive' | 'live' | 'paused' {
  const marker = probe.readText(`${loc.gitdir}/cowork/live`);
  if (marker === null) return 'nonlive';
  const named = marker.split(/\r?\n/)[0] ?? '';
  if (!sameRoot(named, loc.root, platform)) return 'nonlive';
  return probe.exists(`${loc.gitdir}/cowork/paused`) ? 'paused' : 'live';
}

export interface LiveRepo { root: string; gitdir: string; coworkDir: string; dataDir: string; endpointRoot: string; }
