// Which programs the CLI may name (12-visualizer section 3.10.8; R-V13, R-V39; INV-NOEXEC, SEC-30). Live sync can put a teammate's
// file into any worktree at any time, and a direnv-style `PATH_add bin` puts a repository folder first on PATH, so a PATH entry or a
// candidate is judged by its realpath against the realpaths of the repositories the CLI knows: the cwd's repository root and each
// --repo worktree. A lexical comparison would miss <repo>//bin, <repo>/x/../bin, a symlinked alias of the repository and direnv's
// logical $PWD; a synced file is user-owned and 0755, so the owner and mode checks alone cannot stop it.
// One implementation serves git resolution (the viewer's --git) and the Linux opener.
import { posix, win32 } from 'node:path';
import type { Fs } from '../../ports/fs.js';
import type { OwnerProbe } from './ownerProbe.js';
import { isUncOrDevice } from './paths.js';

type Env = Readonly<Record<string, string | undefined>>;
interface TrustOptions { fs: Fs; probe: OwnerProbe; platform: NodeJS.Platform; euid: number | null; }

const pathOf = (platform: NodeJS.Platform): typeof posix => (platform === 'win32' ? win32 : posix);
/** win32 and darwin file systems compare names case-insensitively (by default). */
const foldsCase = (platform: NodeJS.Platform): boolean => platform === 'win32' || platform === 'darwin';

async function realpathOrNull(fs: Fs, p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

/** `p` is `root` or lies under it; both are realpaths. */
function inside(p: string, root: string, platform: NodeJS.Platform): boolean {
  const { sep } = pathOf(platform);
  const a = foldsCase(platform) ? p.toLowerCase() : p;
  const r = foldsCase(platform) ? root.toLowerCase() : root;
  return a === r || a.startsWith(r.endsWith(sep) ? r : r + sep);
}

const insideAny = (p: string, roots: readonly string[], platform: NodeJS.Platform): boolean => roots.some((r) => inside(p, r, platform));

/** Per view call: the results of excludedRoots and filterPath over an Fs made by withTrustCache, by their inputs. */
const trustCaches = new WeakMap<Fs, Map<string, Promise<string[]>>>();

/**
 * A wrapper of `fs` for one view call, over which excludedRoots and filterPath compute each distinct input once: the git the CLI
 * resolves, the viewer's PATH and the opener's PATH then come from one reading of the PATH and the repository roots. Every method
 * delegates to `fs` as a method call (no object spread: an Fs that is a class instance keeps its prototype methods, its private fields
 * and its `this`). The cache lives as long as the returned object; any other Fs is never cached.
 */
export function withTrustCache(fs: Fs): Fs {
  const own: Fs = {
    readFile: (p) => fs.readFile(p),
    writeFile: (p, data) => fs.writeFile(p, data),
    rename: (from, to) => fs.rename(from, to),
    link: (existing, newPath) => fs.link(existing, newPath),
    unlink: (p) => fs.unlink(p),
    stat: (p) => fs.stat(p),
    mkdirp: (p, mode) => (mode === undefined ? fs.mkdirp(p) : fs.mkdirp(p, mode)),
    readdir: (p) => fs.readdir(p),
    rmrf: (p) => fs.rmrf(p),
    lstat: (p) => fs.lstat(p),
    writeFileExclusive: (p, data) => fs.writeFileExclusive(p, data),
    rmdir: (p) => fs.rmdir(p),
    appendFile: (p, data) => fs.appendFile(p, data),
    realpath: (p) => fs.realpath(p),
    freeBytes: (dir) => fs.freeBytes(dir),
    chmod: (p, mode) => fs.chmod(p, mode),
  };
  trustCaches.set(own, new Map());
  return own;
}

async function cached(fs: Fs, key: string, compute: () => Promise<string[]>): Promise<string[]> {
  const cache = trustCaches.get(fs);
  if (cache === undefined) return compute();
  let p = cache.get(key);
  if (p === undefined) {
    p = compute();
    cache.set(key, p);
  }
  return [...(await p)];
}

/**
 * Realpaths of the cwd's repository roots, every ancestor of cwd holding .git (a directory, or a linked worktree's .git file), innermost
 * first, so a checkout nested in another excludes both; then of each --repo worktree. An unresolvable root is skipped.
 * The walk stops below the user's home directory (R-V68): ~ and its ancestors are never excluded because of a .git found there (a
 * dotfiles checkout at ~ would otherwise refuse git and every tool installed under ~); ~ is compared as given and by its realpath, against
 * each walked folder as given and, when it holds .git, by its realpath. An explicit --repo root is excluded even when it is ~. Without a
 * home (null), every ancestor is walked.
 */
export function excludedRoots(cwd: string, repos: readonly string[], fs: Fs, platform: NodeJS.Platform, home: string | null = null): Promise<string[]> {
  return cached(fs, JSON.stringify(['roots', platform, cwd, repos, home]), async () => {
    const P = pathOf(platform);
    const out: string[] = [];
    const add = (real: string | null): void => {
      if (real !== null && !out.includes(real)) out.push(real);
    };
    const homes: string[] = [];
    if (home !== null && home !== '' && P.isAbsolute(home)) {
      homes.push(P.normalize(home));
      const real = await realpathOrNull(fs, home);
      if (real !== null) homes.push(real);
    }
    /** `dir` is ~ or one of its ancestors. */
    const homeOrAbove = (dir: string): boolean => homes.some((h) => inside(h, dir, platform));
    for (let dir = cwd; P.isAbsolute(dir) && !homeOrAbove(dir);) {
      let hasGit = false;
      try {
        hasGit = (await fs.lstat(P.join(dir, '.git'))) !== null;
      } catch {
        hasGit = false;
      }
      if (hasGit) {
        const real = await realpathOrNull(fs, dir);
        if (real !== null && !homeOrAbove(real)) add(real);
      }
      const parent = P.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (const r of repos) add(await realpathOrNull(fs, r));
    return out;
  });
}

/** An absolute PATH entry this platform would search: on win32 a drive path (no UNC, no rooted-without-drive); never a device. */
function absoluteEntry(entry: string, platform: NodeJS.Platform): boolean {
  if (entry === '' || entry === '.' || isUncOrDevice(entry)) return false;
  return platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(entry) : entry.startsWith('/');
}

/**
 * The value of the first env key whose upper case is PATH, split by the platform delimiter; drops empty, '.' and relative entries,
 * normalizes the rest, and drops an entry whose Fs.realpath fails or lies inside an excluded root (realpath-compared,
 * case-insensitively on win32 and darwin). Returns the kept entries, normalized, in order.
 */
export function filterPath(env: Env, excluded: readonly string[], platform: NodeJS.Platform, fs: Fs): Promise<string[]> {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  const value = key === undefined ? undefined : env[key];
  if (value === undefined || value === '') return Promise.resolve([]);
  return cached(fs, JSON.stringify(['path', platform, excluded, value]), async () => {
    const P = pathOf(platform);
    const kept: string[] = [];
    for (const entry of value.split(platform === 'win32' ? ';' : ':')) {
      if (!absoluteEntry(entry, platform)) continue;
      const normalized = P.normalize(entry);
      const real = await realpathOrNull(fs, normalized);
      if (real === null || insideAny(real, excluded, platform)) continue;
      kept.push(normalized);
    }
    return kept;
  });
}

/**
 * The candidate's Fs.realpath when it lies outside every excluded root and lstats as a regular file (symlinks followed), and on POSIX is
 * owned by uid 0 or the euid, is not group- or world-writable and has an execute bit (OwnerProbe.posix); else null.
 */
export async function trustedExe(candidate: string, excluded: readonly string[], o: TrustOptions): Promise<string | null> {
  const real = await realpathOrNull(o.fs, candidate);
  if (real === null || insideAny(real, excluded, o.platform)) return null;
  try {
    const st = await o.fs.lstat(real);
    if (st === null || !st.isFile) return null;
    if (o.platform === 'win32') return real;
    const p = await o.probe.posix(real);
    if (p === null || p.isSymlink || p.isDir) return null;
    if (p.uid !== 0 && (o.euid === null || p.uid !== o.euid)) return null;
    if ((p.mode & 0o022) !== 0 || (p.mode & 0o111) === 0) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * A copy of a child environment whose PATH is the given entries, under the PATH key's existing spelling (Windows keeps `Path`; the
 * source environment's spelling when the child has none): one key only, so the child never sees two PATH values.
 */
export function withPath(childEnv: Readonly<Record<string, string>>, source: Env, entries: readonly string[], platform: NodeJS.Platform): Record<string, string> {
  const env: Record<string, string> = { ...childEnv };
  const isPath = (k: string): boolean => k.toUpperCase() === 'PATH';
  const key = Object.keys(env).find(isPath) ?? Object.keys(source).find(isPath) ?? 'PATH';
  for (const k of Object.keys(env)) if (isPath(k) && k !== key) delete env[k];
  env[key] = entries.join(platform === 'win32' ? ';' : ':');
  return env;
}

/** The first git.exe (win32) or git in the filtered PATH that passes trustedExe (its realpath); null → START_TOOL_VERSION. */
export async function resolveGitPath(env: Env, excluded: readonly string[], o: TrustOptions): Promise<string | null> {
  const P = pathOf(o.platform);
  const name = o.platform === 'win32' ? 'git.exe' : 'git';
  for (const dir of await filterPath(env, excluded, o.platform, o.fs)) {
    const git = await trustedExe(P.join(dir, name), excluded, o);
    if (git !== null) return git;
  }
  return null;
}
