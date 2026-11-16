// The plugin data directory (12-visualizer section 3.2 item 2, VIZ-02; SEC-20; R-V11; X-61, F-8a-2): where it is. Moved unchanged from
// src/viz/cli/dataDir.ts, which re-exports pluginDataDir and resolveDataDir; imports only node:* (a leaf every plan may import, R5-03).
// Plan 5 Task 1 (R5-47, R5-56, A1-12; rulings P5-PF-3, P5-PF-4): the derived directory is named by the plugin id <plugin>-<marketplace>
// (pluginIdOf) of the plugin root — the pluginRoot argument, else CLAUDE_PLUGIN_ROOT, else the running bundle's dist/.. — and no plugin id
// means no directory (fail closed, SEC-20: no other location is ever tried).
import { dirname, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * A1-12: for …/plugins/cache/<marketplace>/<plugin>/<version> (either separator, a trailing one allowed) → `<plugin>-<marketplace>` with every
 * character outside [A-Za-z0-9_-] replaced by '-' (one per code point; the plugin id <plugin>@<marketplace> in Claude Code's data-directory
 * form); any other shape (a relative path, a component '.' or '..', `plugins`/`cache` spelled otherwise) → null. Task 4's host check
 * (R5-47, A4-10) records the real directory name; a ledger ruling amends this rule if they differ.
 */
export function pluginIdOf(pluginRoot: string): string | null {
  if (!/^(?:[\\/]|[A-Za-z]:[\\/])/.test(pluginRoot)) return null;
  const parts = pluginRoot.split(/[\\/]+/).filter((c) => c !== '');
  if (parts.length < 5) return null;
  const [plugins, cache, marketplace, plugin, version] = parts.slice(-5) as [string, string, string, string, string];
  if (plugins !== 'plugins' || cache !== 'cache') return null;
  if ([marketplace, plugin, version].some((c) => c === '.' || c === '..')) return null;
  return `${plugin}-${marketplace}`.replace(/[^A-Za-z0-9_-]/gu, '-');
}

/** The running bundle's plugin root: dist/.. of this module's own file (dist/cli.js → <plugin root>); null when it has no file URL. */
function bundlePluginRoot(): string | null {
  try {
    return dirname(dirname(fileURLToPath(import.meta.url)));
  } catch {
    return null;
  }
}

/** The plugin root: the argument when given, else CLAUDE_PLUGIN_ROOT (set and non-empty; any case on win32), else the running bundle's. */
function effectivePluginRoot(env: Env, platform: NodeJS.Platform, pluginRoot: string | undefined): string | null {
  if (pluginRoot !== undefined) return pluginRoot;
  const fromEnv = envValue(env, 'CLAUDE_PLUGIN_ROOT', platform);
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : bundlePluginRoot();
}

/** The Claude config directory (R5-56, SE5-21; Ruling P5-T4-3): CLAUDE_CONFIG_DIR when set and absolute (any case on win32; neither UNC nor a
 *  device path), else <home>/.claude. Every reader of Claude Code's own files takes it from here: the derived data directory below, the user
 *  settings layer and the user agents and plugin cache of src/claude/client/policy.ts and worktree.ts. */
export function claudeConfigDir(env: Env, home: string, platform: NodeJS.Platform): string {
  const config = envValue(env, 'CLAUDE_CONFIG_DIR', platform);
  return config !== undefined && absolutePath(config, platform) ? config : pathOf(platform).join(home, '.claude');
}

/** <claudeConfigDir>/plugins/data/<pluginIdOf(plugin root)>. Throws when no plugin id is derivable from the plugin root (its precondition: it never
 *  invents a location; resolveDataDir checks pluginIdOf first and answers null). */
export function pluginDataDir(env: Env, home: string, platform: NodeJS.Platform, pluginRoot?: string): string {
  const root = effectivePluginRoot(env, platform, pluginRoot);
  const id = root === null ? null : pluginIdOf(root);
  if (id === null) throw new Error('pluginDataDir: no plugin id is derivable from the plugin root');
  return pathOf(platform).join(claudeConfigDir(env, home, platform), 'plugins', 'data', id);
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
 * not an absolute local path (a relative home), when CLAUDE_PLUGIN_DATA is relative or names a UNC or device path, and when no plugin id is
 * derivable from the plugin root (refused, never replaced by another location: SEC-20, fail closed). Every Plan 5 caller (core, MCP server,
 * CLI, spawner, tests) uses this one; null takes the outcomes the deleted PluginDataUnresolved had (X-61).
 */
export function resolveDataDir(env: Env, home: string, platform: NodeJS.Platform, pluginRoot?: string): string | null {
  const given = envValue(env, 'CLAUDE_PLUGIN_DATA', platform);
  if (given !== undefined && given !== '' && !absolutePath(given, platform)) return null;
  if (given === undefined || given === '') {
    const root = effectivePluginRoot(env, platform, pluginRoot);
    if (root === null || pluginIdOf(root) === null) return null;
  }
  const dir = canonicalDir(given !== undefined && given !== '' ? given : pluginDataDir(env, home, platform, pluginRoot), platform);
  return absolutePath(dir, platform) ? dir : null;
}
