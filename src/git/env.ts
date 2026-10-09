/**
 * DAEMON_ENV builder: 09-security §3.4 is the single allowlist and never-list.
 * Names are compared case-insensitively (Windows spells Path, windir, SystemDrive, ProgramData);
 * the spelling found in the source is kept in the output.
 */

/** Glossary §18 forced values, applied on top of everything (09-security §3.4 item 5). */
export const FORCED_ENV: Readonly<Record<string, string>> = Object.freeze({
  LC_ALL: 'C',
  LANGUAGE: '',
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  SSH_ASKPASS_REQUIRE: 'never',
  GIT_OPTIONAL_LOCKS: '0',
});

// 09-security §3.4 item 1: base allowlist.
const BASE_ALLOW_NAMES = ['PATH', 'SYSTEMROOT', 'COMSPEC', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'TMPDIR', 'LANG'];
const BASE_ALLOW_PREFIXES = ['LC_'];

// 09-security §3.4 item 2: credential and transport set (lower-case proxy forms match case-insensitively).
const TRANSPORT_ALLOW_NAMES = [
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'HOMEDRIVE', 'HOMEPATH', 'PATHEXT', 'WINDIR',
  'SYSTEMDRIVE', 'DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'HTTP_PROXY', 'HTTPS_PROXY',
  'NO_PROXY', 'ALL_PROXY', 'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_SSH_VARIANT', 'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
];
const TRANSPORT_ALLOW_PREFIXES = ['XDG_', 'GCM_'];

// 09-security §3.4 item 4: never-list (always dropped, even if passed through).
const NEVER_NAMES = [
  'NODE_OPTIONS', 'NODE_PATH', 'SSH_ASKPASS', 'GIT_ASKPASS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE',
  'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_EXEC_PATH', 'GIT_EXTERNAL_DIFF', 'GIT_EDITOR',
  'GIT_ATTR_SOURCE', 'GIT_REPLACE_REF_BASE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_SHALLOW_FILE', 'GIT_CONFIG',
  // Ruling P2-GRAFTS: buildGitInvocation sets its own GIT_GRAFT_FILE (a path that never exists).
  'GIT_GRAFT_FILE',
];
const NEVER_PREFIXES = [
  'CLAUDE_', 'ELECTRON_', 'VSCODE_', 'GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_', 'GIT_TRACE', 'GIT_AUTHOR_',
  'GIT_COMMITTER_',
];

const ALLOW_NAMES: ReadonlySet<string> = new Set([...BASE_ALLOW_NAMES, ...TRANSPORT_ALLOW_NAMES]);
const ALLOW_PREFIXES: readonly string[] = [...BASE_ALLOW_PREFIXES, ...TRANSPORT_ALLOW_PREFIXES];
const NEVER: ReadonlySet<string> = new Set(NEVER_NAMES);
const FORCED_UPPER: ReadonlySet<string> = new Set(Object.keys(FORCED_ENV).map((k) => k.toUpperCase()));

function isNever(upper: string): boolean {
  return NEVER.has(upper) || NEVER_PREFIXES.some((p) => upper.startsWith(p));
}

/** True for a never-list name in any spelling; buildGitInvocation drops these from every env it is handed. */
export function isNeverName(name: string): boolean {
  return isNever(name.toUpperCase());
}

function isAllowlisted(upper: string): boolean {
  return ALLOW_NAMES.has(upper) || ALLOW_PREFIXES.some((p) => upper.startsWith(p));
}

function isUsableName(name: string): boolean {
  return name.length > 0 && !name.includes('=') && !name.includes('\0');
}

function sortedCopy(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(env).sort()) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Builds DAEMON_ENV once, at spawn, from the spawning hook's environment (09-security §3.4):
 * allowlist ∪ credential/transport set ∪ passthrough, minus the never-list, with FORCED_ENV on top.
 */
export function buildDaemonEnv(
  source: Record<string, string | undefined>,
  passthrough: string[],
): Record<string, string> {
  const passUpper = new Set(passthrough.map((n) => n.toUpperCase()));
  const out: Record<string, string> = {};
  for (const name of Object.keys(source)) {
    const value = source[name];
    if (value === undefined || value.includes('\0') || !isUsableName(name)) continue;
    const upper = name.toUpperCase();
    if (isNever(upper) || FORCED_UPPER.has(upper)) continue;
    if (!isAllowlisted(upper) && !passUpper.has(upper)) continue;
    out[name] = value;
  }
  for (const [name, value] of Object.entries(FORCED_ENV)) out[name] = value;
  return sortedCopy(out);
}
