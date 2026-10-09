// The CLI's path checks for --repo and --demo (12-visualizer section 3.2 item 2, VIZ-02; R-V54; Review Focus 5).
// An import-free leaf: cli.js bundles it, and src/viz/source/rooms.ts relies on the CLI having applied it ("already absolute and
// checked by the CLI", 12 section 3.3.1), so nothing here may pull another module into either bundle.

const SEPARATORS = '\\/';
const WIN_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const WIN_DRIVE = /^[A-Za-z]:/;

/**
 * A UNC or device-namespace path: two leading separators of either kind (\\server\share, //host/x, \\.\x, \\?\C:\x and their mixed
 * spellings), or /dev and anything under it. Such a path is refused on every platform, before and after it is made absolute.
 */
export function isUncOrDevice(p: string): boolean {
  if (p.length >= 2 && SEPARATORS.includes(p[0] as string) && SEPARATORS.includes(p[1] as string)) return true;
  return p === '/dev' || p.startsWith('/dev/');
}

/** Resolves '.' and '..' and drops empty segments; '..' never climbs above the root. */
function resolveSegments(segments: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of segments) {
    if (s === '' || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return out;
}

/** A cwd an input may be resolved against: absolute for the platform (win32: a drive path), and neither UNC nor a device path. */
function usableCwd(cwd: string, win: boolean): boolean {
  return !isUncOrDevice(cwd) && (win ? WIN_DRIVE_ABSOLUTE.test(cwd) : cwd.startsWith('/'));
}

function absolutizeWin32(p: string, cwd: string): string | null {
  const path = p.split('/').join('\\');
  const base = cwd.split('/').join('\\');
  let joined: string;
  if (WIN_DRIVE_ABSOLUTE.test(path)) joined = path;          // absolute: the cwd plays no part
  else if (WIN_DRIVE.test(path)) return null;                // C:relative depends on a per-drive cwd the CLI does not know
  else if (!usableCwd(base, true)) return null;              // relative or rooted against a UNC, device, relative or drive-relative cwd
  else if (path.startsWith('\\')) joined = base.slice(0, 2) + path;   // rooted: on the cwd's drive
  else joined = `${base}\\${path}`;
  const drive = joined.slice(0, 2);
  return `${drive}\\${resolveSegments(joined.slice(3).split('\\')).join('\\')}`;
}

function absolutizePosix(p: string, cwd: string): string | null {
  if (!p.startsWith('/') && !usableCwd(cwd, false)) return null;   // only a relative input needs the cwd
  const joined = p.startsWith('/') ? p : `${cwd}/${p}`;
  return `/${resolveSegments(joined.split('/')).join('/')}`;
}

/**
 * `p` made absolute against the CLI's cwd and normalized ('.', '..' and repeated separators resolved; on win32 '/' becomes '\'), or
 * null for an empty path, a NUL, a UNC or device path (before or after resolution), a drive-relative win32 path, or a relative (win32:
 * or rooted) input when the cwd is not absolute or is a UNC or device path. An absolute input never depends on the cwd. Spaces and
 * non-ASCII characters are kept as they are.
 */
export function absolutize(p: string, cwd: string, platform: NodeJS.Platform): string | null {
  if (p === '' || p.includes('\0') || isUncOrDevice(p)) return null;
  const abs = platform === 'win32' ? absolutizeWin32(p, cwd) : absolutizePosix(p, cwd);
  return abs === null || isUncOrDevice(abs) ? null : abs;
}
