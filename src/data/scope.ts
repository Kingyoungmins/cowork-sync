// Sync scope (03-data §3.6, §3.7): Algorithm D5 (tracked paths), D6 step 2 (new paths), D7 (portability),
// the built-in name lists of glossary §16 and the gitignore-style matcher the configuration uses.
// Ruling R-06: D5 rows 1, 1a, 2-8 and 10 (and 9 from ScopeInputs), D6 step 2; D6 step 3's content scan is Plan 7.
import { validPathSyntax } from '../sec/validators.js';
import type { FileMode } from '../git/repo.js';
import type { AttrSnapshot } from './attrs.js';
import type { TeamConfig } from './config.js';

export type ScopeClass = 'LIVE' | 'SAVE_ONLY' | 'UNMANAGED' | 'QUARANTINED' | 'NOT_ADMITTED' | 'LOCAL_ONLY';
export type NotSharedReason = 'secret-like' | 'secret-scan' | 'temp' | 'too-large' | 'huge' | 'nested-repo' | 'submodule' | 'symlink'
  | 'lfs' | 'generated' | 'excluded-by-config' | 'not-included' | 'save-only' | 'merge-driver' | 'quarantine' | 'portability' | 'filter-failure' | 'ignored';
export interface Scope { cls: ScopeClass; reason: NotSharedReason | null; }
export interface ScopeInputs {
  attrs: AttrSnapshot;
  config: TeamConfig;
  /** Names with merge.<name>.driver configured. */
  mergeDrivers: ReadonlySet<string>;
  /** Non-terminal local_only records (empty in Plan 2). */
  localOnlyPaths: ReadonlySet<string>;
  /** User core.hooksPath as a repo-relative directory (quarantine set). */
  hooksPathDir: string | null;
}

/** Glossary §20: a path whose local or TIP blob is at least 50 MiB is SAVE_ONLY (`huge`). */
export const HUGE_BYTES = 52_428_800;
/** Glossary §20: the new-file cap (and the maximum of `sync.maxNewFileBytes`). */
export const NEW_FILE_CAP = 1_048_576;

/** Glossary §16 (`.vscode/{settings,tasks,launch}.json` expanded); the hooksPath directory is passed to isQuarantined. */
export const QUARANTINE_PATTERNS: readonly string[] = Object.freeze([
  '.claude/**', '.mcp.json', 'CLAUDE.md', 'AGENTS.md', '.husky/**', '.githooks/**', '.gitattributes', '.gitmodules', '.lfsconfig',
  '.cowork/**', '.github/workflows/**', '.gitlab-ci.yml', 'azure-pipelines*.yml', 'bitbucket-pipelines.yml',
  '.vscode/settings.json', '.vscode/tasks.json', '.vscode/launch.json', '.devcontainer/**', '.envrc',
]);

/** D6 step 2.2: editor and OS temp names, matched case-insensitively. */
export const TEMP_PATTERNS: readonly string[] = Object.freeze([
  '*.swp', '*.swo', '4913', '#*#', '.#*', '*~', '*.orig', '*___jb_tmp___', '*___jb_old___', '~$*', '~*.tmp', '.DS_Store', 'Thumbs.db', 'desktop.ini', '.vs/**',
]);

/** Glossary §16 default secret-like new-file names, matched case-insensitively. */
export const SECRET_LIKE_PATTERNS: readonly string[] = Object.freeze([
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*', '*.keystore', '*credentials*', 'secrets.*', '*.kdbx',
  '.npmrc', '.pypirc', '.netrc', '*.tfstate*', 'appsettings.*.json', 'local.settings.json',
]);

// ---- wildmatch -------------------------------------------------------------------------------

/**
 * One step of a compiled glob: a literal code unit, `?` (one), a bracket class (never '/'), `*` (any run without '/'),
 * a whole-segment `**` at the end or as the whole pattern (all: any run), a whole segment `**` followed by '/' (dirs: nothing, or any
 * run ending in '/').
 */
type GlobTok =
  | { k: 'lit'; c: string }
  | { k: 'one' }
  | { k: 'cls'; neg: boolean; ranges: ReadonlyArray<readonly [number, number]> }
  | { k: 'star' }
  | { k: 'all' }
  | { k: 'dirs' };

const globCache = new Map<string, GlobTok[]>();

/**
 * gitignore/wildmatch glob to its steps over '/'-separated paths. `**` is special only as a whole segment (followed by '/',
 * `/**` at the end, or the whole pattern); anywhere else it is a plain `*`. `*`, `?` and bracket classes never match '/'.
 * Throws on an unterminated `[`, an out-of-order range, or a POSIX class `[:name:]` inside a bracket expression (final
 * review, ledger Task 4:72: unsupported, and read as a plain character set it would make an exclude match nothing —
 * fail open — so validGlob refuses it and the config is invalid).
 */
function compileGlob(glob: string): GlobTok[] {
  const hit = globCache.get(glob);
  if (hit !== undefined) return hit;
  const toks: GlobTok[] = [];
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === '*') {
      let j = i + 1;
      while (glob.charAt(j) === '*') j++;
      const isStar2 = j - i >= 2;
      const segStart = i === 0 || glob.charAt(i - 1) === '/';
      const segEnd = j >= glob.length || glob.charAt(j) === '/';
      if (isStar2 && segStart && segEnd) {
        if (j >= glob.length) {
          toks.push({ k: 'all' });
        } else {
          toks.push({ k: 'dirs' }); // `**/` matches zero or more directories
          j++; // the slash is part of it
        }
      } else if (toks[toks.length - 1]?.k !== 'star') {
        toks.push({ k: 'star' });
      }
      i = j - 1;
    } else if (ch === '?') {
      toks.push({ k: 'one' });
    } else if (ch === '[') {
      const negated = glob.charAt(i + 1) === '!' || glob.charAt(i + 1) === '^';
      const close = glob.indexOf(']', i + (negated ? 3 : 2));
      if (close < 0) throw new Error(`invalid glob ${JSON.stringify(glob)}: unterminated bracket class`);
      const body = glob.slice(i + (negated ? 2 : 1), close);
      if (body.includes('[:')) throw new Error(`invalid glob ${JSON.stringify(glob)}: POSIX character classes are not supported`);
      const ranges: Array<readonly [number, number]> = [];
      for (let k = 0; k < body.length; k++) {
        const lo = body.charCodeAt(k);
        if (body.charAt(k + 1) === '-' && k + 2 < body.length) {
          const hi = body.charCodeAt(k + 2);
          if (hi < lo) throw new Error(`invalid glob ${JSON.stringify(glob)}: range out of order`);
          ranges.push([lo, hi]);
          k += 2;
        } else {
          ranges.push([lo, lo]);
        }
      }
      toks.push({ k: 'cls', neg: negated, ranges });
      i = close;
    } else if (ch === '\\' && i + 1 < glob.length) {
      i++;
      toks.push({ k: 'lit', c: glob.charAt(i) });
    } else {
      toks.push({ k: 'lit', c: ch });
    }
  }
  globCache.set(glob, toks);
  return toks;
}

/** One code unit `c` against a literal, case-folded on request (both directions, as a case-insensitive regex does). */
function litEq(c: string, want: string, ci: boolean): boolean {
  return c === want || (ci && (c.toLowerCase() === want.toLowerCase() || c.toUpperCase() === want.toUpperCase()));
}

function inClass(t: { neg: boolean; ranges: ReadonlyArray<readonly [number, number]> }, c: string, ci: boolean): boolean {
  const hit = (x: string): boolean => {
    if (x.length !== 1) return false;
    const u = x.charCodeAt(0);
    return t.ranges.some(([lo, hi]) => u >= lo && u <= hi);
  };
  const found = hit(c) || (ci && (hit(c.toLowerCase()) || hit(c.toUpperCase())));
  return found !== t.neg;
}

/**
 * Final review minor (ledger Task 4:71): the glob runs as a set of step positions over the subject's code units (a
 * Thompson simulation), O(|subject| × |steps|) whatever the glob — the regular expression it replaced backtracked
 * (1.1 s / 24.8 s on 120 characters, more with more stars), so one committed config glob could stall every peer.
 */
function globMatch(toks: readonly GlobTok[], s: string, ci: boolean): boolean {
  const m = toks.length;
  let cur = new Uint8Array(m + 1);
  let next = new Uint8Array(m + 1);
  const close = (set: Uint8Array): boolean => {
    let any = false;
    for (let i = 0; i <= m; i++) {
      if (set[i] === 0) continue;
      any = true;
      const t = toks[i];
      if (t !== undefined && (t.k === 'star' || t.k === 'all' || t.k === 'dirs')) set[i + 1] = 1; // each may be empty
    }
    return any;
  };
  cur[0] = 1;
  close(cur);
  for (let x = 0; x < s.length; x++) {
    const c = s.charAt(x);
    next.fill(0);
    for (let i = 0; i < m; i++) {
      if (cur[i] === 0) continue;
      const t = toks[i]!;
      switch (t.k) {
        case 'lit':
          if (litEq(c, t.c, ci)) next[i + 1] = 1;
          break;
        case 'one':
          if (c !== '/') next[i + 1] = 1;
          break;
        case 'cls':
          if (c !== '/' && inClass(t, c, ci)) next[i + 1] = 1;
          break;
        case 'star':
          if (c !== '/') next[i] = 1;
          break;
        case 'all':
          next[i] = 1;
          break;
        case 'dirs':
          next[i] = 1;
          if (c === '/') next[i + 1] = 1;
          break;
      }
    }
    if (!close(next)) return false;
    [cur, next] = [next, cur];
  }
  return cur[m] === 1;
}

/** True when the pattern compiles (an unterminated `[`, an out-of-order range or a POSIX class does not). */
export function validGlob(pattern: string): boolean {
  const glob = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
  const body = glob.startsWith('/') ? glob.slice(1) : glob;
  if (body.length === 0) return true; // matches nothing: ignored, not invalid
  try {
    compileGlob(body);
    return true;
  } catch {
    return false;
  }
}

function matchOne(pattern: string, path: string, caseInsensitive: boolean): boolean {
  const anchored = pattern.includes('/');
  const glob = pattern.startsWith('/') ? pattern.slice(1) : pattern;
  if (glob.length === 0) return false;
  const subject = anchored ? path : path.slice(path.lastIndexOf('/') + 1);
  return globMatch(compileGlob(glob), subject, caseInsensitive);
}

/**
 * Gitignore-style matching without negation (03-data §3.6): a pattern without `/` matches the
 * basename at any depth, a pattern with `/` matches the repo-relative path from the root (a leading
 * `/` is allowed), `**` crosses directories, a trailing `/` matches everything below such a directory.
 * Case-sensitive unless asked (the built-in lists are case-insensitive).
 */
export function wildmatch(pattern: string, path: string, caseInsensitive = false): boolean {
  if (pattern.endsWith('/')) {
    const dir = pattern.slice(0, -1);
    let slash = path.indexOf('/');
    while (slash >= 0) {
      if (matchOne(dir, path.slice(0, slash), caseInsensitive)) return true;
      slash = path.indexOf('/', slash + 1);
    }
    return false;
  }
  return matchOne(pattern, path, caseInsensitive);
}

function matchesAny(patterns: readonly string[], path: string, caseInsensitive = false): boolean {
  return patterns.some((p) => wildmatch(p, path, caseInsensitive));
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Case-insensitive; a name pattern with a `/` (`.vs/**`) matches at any depth: Visual Studio keeps `.vs` next to the solution. */
function isTemp(path: string): boolean {
  return TEMP_PATTERNS.some((p) => wildmatch(p, path, true) || (p.includes('/') && wildmatch(`**/${p}`, path, true)));
}

function isSecretLike(path: string): boolean {
  return matchesAny(SECRET_LIKE_PATTERNS, path, true);
}

/**
 * Glossary §16 quarantine set (case-insensitive: on a case-folding disk `.Claude/` is `.claude/`, and
 * a wider match can only withhold more) plus the user's `core.hooksPath` directory and below.
 * New symlinks and submodules are decided by the callers from the entry mode.
 */
export function isQuarantined(path: string, hooksPathDir: string | null): boolean {
  if (matchesAny(QUARANTINE_PATTERNS, path, true)) return true;
  if (hooksPathDir !== null && hooksPathDir.length > 0) {
    const dir = hooksPathDir.replace(/\/+$/, '').toLowerCase();
    const lower = path.toLowerCase();
    if (dir.length > 0 && (lower === dir || lower.startsWith(`${dir}/`))) return true;
  }
  return false;
}

// ---- D7 portability --------------------------------------------------------------------------

export type PortRule = 1 | 2 | 3 | 4;

const FORBIDDEN_CHARS = /[<>:"|?*\\\u0000-\u001f]/;
const RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL',
  ...['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '¹', '²', '³'].flatMap((d) => [`COM${d}`, `LPT${d}`])]);

/** HFS+ ignores these code points when it compares names (git's is_hfs_dotgit list), so `.g<U+200C>it` is `.git` there. */
const HFS_IGNORABLE = /[\u{200c}-\u{200f}\u{202a}-\u{202e}\u{206a}-\u{206f}\u{feff}]/gu;

/**
 * Ruling P2-DOTGIT (CVE-2019-1353 class): a path component that some file system resolves to the repository's `.git`
 * directory, on EVERY platform (A is shared with Windows and macOS peers): `.git` in any case (HFS+ ignorable code
 * points removed), `.git` followed only by dots or spaces (Windows strips them), the NTFS 8.3 name `git~<digits>`
 * (same trailing rule), and any component holding ':' (an NTFS stream, `.git::$INDEX_ALLOCATION`). Never admitted
 * (componentOk), always carried, never lstat'd, read, staged or written.
 */
export function isDotGitAlias(component: string): boolean {
  if (component.includes(':')) return true;
  const k = component.replace(HFS_IGNORABLE, '').toUpperCase().toLowerCase().replace(/[. ]+$/, '');
  return k === '.git' || /^git~[0-9]+$/.test(k);
}

function componentOk(c: string): boolean {
  if (c.length === 0 || c === '.' || c === '..') return false;
  if (isDotGitAlias(c)) return false;
  if (FORBIDDEN_CHARS.test(c)) return false;
  if (c.endsWith('.') || c.endsWith(' ')) return false;
  const dot = c.indexOf('.');
  const stem = (dot < 0 ? c : c.slice(0, dot)).replace(/ +$/, '').toUpperCase();
  if (RESERVED.has(stem)) return false;
  return Buffer.byteLength(c, 'utf8') <= 255;
}

const collisionKey = (x: string): string => x.normalize('NFC').toUpperCase().toLowerCase();

/** The path and every directory prefix of it. */
function nameAndPrefixes(path: string): string[] {
  const out: string[] = [];
  let slash = path.indexOf('/');
  while (slash >= 0) {
    out.push(path.slice(0, slash));
    slash = path.indexOf('/', slash + 1);
  }
  out.push(path);
  return out;
}

/**
 * Algorithm D7. `others` = the live-set paths not deleted in this snapshot plus the other new paths of
 * it. A case-only rename is allowed because its old spelling is deleted in the same snapshot and so is
 * not in `others`.
 */
export function portable(path: string, others: ReadonlySet<string>): { ok: true } | { ok: false; rule: PortRule } {
  if (path !== path.normalize('NFC')) return { ok: false, rule: 1 };
  if (!path.split('/').every(componentOk)) return { ok: false, rule: 2 };
  if (path.length > 200) return { ok: false, rule: 3 };
  const mine = nameAndPrefixes(path);
  const keys = new Map<string, string>();
  for (const x of mine) keys.set(collisionKey(x), x);
  for (const other of others) {
    for (const y of nameAndPrefixes(other)) {
      const mineWithKey = keys.get(collisionKey(y));
      if (mineWithKey !== undefined && mineWithKey !== y) return { ok: false, rule: 4 };
    }
  }
  return { ok: true };
}

// ---- D5 and D6 -------------------------------------------------------------------------------

const LIVE_SCOPE: Scope = { cls: 'LIVE', reason: null };
const scope = (cls: ScopeClass, reason: NotSharedReason | null): Scope => ({ cls, reason });

/** D5 for a path in A or TIP; first match wins. `size` = max(local lstat size, TIP blob size). */
export function scopeOfTracked(path: string, mode: FileMode, size: number, inp: ScopeInputs): Scope {
  if (isQuarantined(path, inp.hooksPathDir)) return scope('QUARANTINED', 'quarantine'); // 1
  if (!validPathSyntax(path)) return scope('UNMANAGED', 'portability'); // 1a
  if (mode === '160000') return scope('UNMANAGED', 'submodule'); // 2
  if (mode === '120000') return scope('UNMANAGED', 'symlink');
  const a = inp.attrs.get(path);
  if (a.filter === 'lfs') return scope('UNMANAGED', 'lfs'); // 3
  if (a.generated || a.coworkOff) return scope('UNMANAGED', 'generated'); // 4
  if (matchesAny(inp.config.sync.exclude, path)) return scope('UNMANAGED', 'excluded-by-config'); // 5
  if (basename(path) === '.gitignore') return scope('SAVE_ONLY', 'save-only'); // 6
  if (a.merge !== null && inp.mergeDrivers.has(a.merge)) return scope('SAVE_ONLY', 'merge-driver'); // 7
  if (size >= HUGE_BYTES) return scope('SAVE_ONLY', 'huge'); // 8
  if (inp.localOnlyPaths.has(path)) return scope('LOCAL_ONLY', 'secret-like'); // 9: the record's guard is not known here
  return LIVE_SCOPE; // 10: tracked-in-live paths are exempt from the new-file cap
}

/** D6 step 2 for one `ls-files -o` entry (a trailing `/` marks a directory); LIVE when admitted. First match wins. */
export function admitNew(entry: string, lstatSize: number, isSymlink: boolean, others: ReadonlySet<string>, inp: ScopeInputs): Scope {
  const no = (reason: NotSharedReason): Scope => scope('NOT_ADMITTED', reason);
  if (entry.endsWith('/') || entry.startsWith('.claude/worktrees/')) return no('nested-repo'); // 2.1
  if (isTemp(entry)) return no('temp'); // 2.2
  if (isSecretLike(entry) && !inp.config.sync.allowSecretLike.includes(entry)) return no('secret-like'); // 2.3
  if (isSymlink || isQuarantined(entry, inp.hooksPathDir)) return no('quarantine'); // 2.4
  const a = inp.attrs.get(entry); // 2.5
  if (a.filter === 'lfs') return no('lfs');
  if (a.generated || a.coworkOff) return no('generated');
  if (matchesAny(inp.config.sync.exclude, entry)) return no('excluded-by-config');
  if (inp.config.sync.include.length > 0 && !matchesAny(inp.config.sync.include, entry)) return no('not-included');
  if (basename(entry) === '.gitignore') return no('save-only');
  if (a.merge !== null && inp.mergeDrivers.has(a.merge)) return no('merge-driver');
  if (!portable(entry, others).ok) return no('portability'); // 2.6
  if (lstatSize > inp.config.sync.maxNewFileBytes) return no('too-large'); // 2.7
  return LIVE_SCOPE;
}
