// The plugin data directory (12-visualizer section 3.2 item 2, VIZ-02; SEC-20; R-V11; X-61, F-8a-2): where it is. Moved unchanged from
// src/viz/cli/dataDir.ts, which re-exports pluginDataDir and resolveDataDir; imports only node:* (a leaf every plan may import, R5-03).
import { posix, win32 } from 'node:path';

export type Env = Readonly<Record<string, string | undefined>>;

export const pathOf = (platform: NodeJS.Platform): typeof posix => (platform === 'win32' ? win32 : posix);

/** A UNC path (two leading separators, either spelling) or /dev and anything under it (the same rule as src/viz/cli/paths.ts isUncOrDevice). */
function isUncOrDevice(p: string): boolean {
  const sep = (c: string | undefined): boolean => c === '/' || c === '\\';
  if (p.length >= 2 && sep(p[0]) && sep(p[1])) return true;
  return p === '/dev' || p.startsWith('/dev/');
}

/** An environment value; on win32 the name is matched in any case (Windows spells names freely). */
function envValue(env: Env, name: string, platform: NodeJS.Platform): string | undefined {
  if (env[name] !== undefined || platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** Absolute for this platform (win32: a drive path), and neither UNC nor a device path. */
function absolutePath(p: string, platform: NodeJS.Platform): boolean {
  if (p === '' || isUncOrDevice(p)) return false;
  return platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith('/');
}

/** <CLAUDE_CONFIG_DIR (when absolute) or <home>/.claude>/plugins/data/cowork-sync. */
export function pluginDataDir(env: Env, home: string, platform: NodeJS.Platform): string {
  const P = pathOf(platform);
  const config = envValue(env, 'CLAUDE_CONFIG_DIR', platform);
  const base = config !== undefined && absolutePath(config, platform) ? config : P.join(home, '.claude');
  return P.join(base, 'plugins', 'data', 'cowork-sync');
}

/**
 * `p` without trailing separators, except a root's own ('/', 'C:\'): lstat of `<symlink>/` follows the link, so a trailing separator
 * would let a symlinked data directory pass for a directory.
 */
export function withoutTrailingSeparator(p: string, platform: NodeJS.Platform): string {
  const min = platform === 'win32' && /^[A-Za-z]:[\\/]/.test(p) ? 3 : 1;
  let end = p.length;
  while (end > min && (p[end - 1] === '/' || (platform === 'win32' && p[end - 1] === '\\'))) end -= 1;
  return p.slice(0, end);
}

/** `p` normalized ('.', '..' and repeated separators resolved) and without a trailing separator. */
function canonicalDir(p: string, platform: NodeJS.Platform): string {
  return withoutTrailingSeparator(pathOf(platform).normalize(p), platform);
}

/**
 * CLAUDE_PLUGIN_DATA if absolute, else (unset or empty) pluginDataDir, normalized without a trailing separator; null when the result is
 * not an absolute local path (a relative home), and when CLAUDE_PLUGIN_DATA is relative or names a UNC or device path (refused, never
 * replaced by another location: SEC-20, fail closed).
 */
export function resolveDataDir(env: Env, home: string, platform: NodeJS.Platform): string | null {
  const given = envValue(env, 'CLAUDE_PLUGIN_DATA', platform);
  if (given !== undefined && given !== '' && !absolutePath(given, platform)) return null;
  const dir = canonicalDir(given !== undefined && given !== '' ? given : pluginDataDir(env, home, platform), platform);
  return absolutePath(dir, platform) ? dir : null;
}
