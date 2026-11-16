// src/claude/client/policy.ts — the CCI-04 install and refusal checks and the SEC-28/SEC-29 static policy read (06 §1.2, §3.2, §3.11.6 item 3; 09 §3.14
// item 2; R1-104, R1-111, R2-B12, R5-49). Pure over the Fs port: settings files are read leniently (a missing file or bad JSON is no hit, never a throw).
// The G1 CC_TOO_OLD path and the SessionStart static_policy_hits are Plan 5's; Plan 7's start and doctor call the rest (X5-28, X-65).
import * as nodePath from 'node:path';
import { C } from '../wire/constants.js';
import type { PolicyHit } from '../wire/frames.js';
import type { Params } from '../../i18n/render.js';
import { sameRoot, type RepoLocation } from '../../data/canonRoot.js';
import { claudeConfigDir, type Env } from '../../data/pluginDataDir.js';
import type { Fs } from '../../ports/fs.js';
import { headBranch } from './spawn.js';

type PathModule = typeof nodePath.posix;
export interface SettingsFile { file: string; scope: PolicyHit['scope'] }

/** The user, project and local settings files (06 §3.2 "the settings layers"); the user layer is <Claude config directory>/settings.json —
 *  CLAUDE_CONFIG_DIR when set and absolute, else <home>/.claude (claudeConfigDir, Ruling P5-T4-3), the file the host itself reads. */
export function settingsLayers(repoRoot: string, home: string, env: Env, platform: NodeJS.Platform): SettingsFile[] {
  const P: PathModule = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  return [
    { file: P.join(claudeConfigDir(env, home, platform), 'settings.json'), scope: 'user' },
    { file: P.join(repoRoot, '.claude', 'settings.json'), scope: 'project' },
    { file: P.join(repoRoot, '.claude', 'settings.local.json'), scope: 'local' },
  ];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One settings file as a JSON object (a UTF-8 BOM ignored); null when it is missing, unreadable, not JSON or not an object. */
export async function readSettings(fs: Fs, file: string): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = JSON.parse((await fs.readFile(file)).toString('utf8').replace(/^\u{FEFF}/u, ''));
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

/** The `<plugin>@<marketplace>` ids set true in enabledPlugins of any of the given layers, in layer order, each once. */
export async function enabledPluginIds(layers: readonly SettingsFile[], fs: Fs): Promise<string[]> {
  const out = new Set<string>();
  for (const l of layers) {
    const ep = (await readSettings(fs, l.file))?.['enabledPlugins'];
    if (isRecord(ep)) for (const [id, on] of Object.entries(ep)) if (on === true) out.add(id);
  }
  return [...out];
}

const isCoworkSync = (id: string): boolean => id.startsWith('cowork-sync@');

/** The managed-settings.json of a platform (09 §3.14 item 2); its managed-settings.d/ is beside it. */
function managedFile(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  return platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json';
}

/** The settings the static read reports, in report order within a file (SEC-28, SEC-29; strictKnownMarketplaces is the strict marketplace key;
 *  enabledPlugins only for an entry disabling cowork-sync; statusLine only in managed settings). */
const REPORTED = ['disableAllHooks', 'allowManagedHooksOnly', 'deniedMcpServers', 'allowManagedMcpServersOnly', 'crossSessionInbound', 'strictKnownMarketplaces',
  'enabledPlugins', 'statusLine'] as const;

/** PolicyHit.value: the JSON scalar as text, 'set' for an array or object. */
const valueText = (v: unknown): string => (typeof v === 'object' && v !== null ? 'set' : String(v));

function hitsOf(o: Record<string, unknown>, file: string, scope: PolicyHit['scope']): PolicyHit[] {
  const out: PolicyHit[] = [];
  for (const setting of REPORTED) {
    if (!Object.prototype.hasOwnProperty.call(o, setting)) continue;
    const v = o[setting];
    if (setting === 'statusLine' && scope !== 'managed') continue;
    if (setting === 'enabledPlugins') {
      if (isRecord(v)) for (const [id, on] of Object.entries(v)) if (isCoworkSync(id) && on === false) out.push({ setting, file, scope, value: 'false' });
      continue;
    }
    out.push({ setting, file, scope, value: valueText(v) });
  }
  return out;
}

/** Reads only the documented managed-settings files (C:\Program Files\ClaudeCode\managed-settings.json, /Library/Application
 *  Support/ClaudeCode/managed-settings.json, /etc/claude-code/managed-settings.json — the platform's — and the *.json files of its managed-settings.d/,
 *  by name) and the user, project and local settings; reports disableAllHooks, allowManagedHooksOnly, deniedMcpServers, allowManagedMcpServersOnly,
 *  crossSessionInbound, strict marketplace keys, enabledPlugins entries disabling cowork-sync and a managed statusLine, each by setting name and file.
 *  `env` locates the user layer (CLAUDE_CONFIG_DIR, P5-T4-3). */
export async function staticPolicyCheck(repoRoot: string, d: { fs: Fs; platform: NodeJS.Platform; home: string; env: Env }): Promise<PolicyHit[]> {
  const P: PathModule = d.platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const managed = managedFile(d.platform);
  const dropIns = P.join(P.dirname(managed), 'managed-settings.d');
  const names = (await d.fs.readdir(dropIns).catch(() => [] as string[])).filter((n) => n.endsWith('.json')).sort();
  const files: SettingsFile[] = [
    { file: managed, scope: 'managed' }, ...names.map((n): SettingsFile => ({ file: P.join(dropIns, n), scope: 'managed' })),
    ...settingsLayers(repoRoot, d.home, d.env, d.platform),
  ];
  const out: PolicyHit[] = [];
  for (const f of files) {
    const o = await readSettings(d.fs, f.file);
    if (o !== null) out.push(...hitsOf(o, f.file, f.scope));
  }
  return out;
}

/** 06 §3.2 "Install scope": cowork-sync enabled in user settings → 'ok'; enabled only in project or local settings → 'REFUSE_PROJECT_SCOPE'. The user
 *  settings are the Claude config directory's (`env`, `platform`: CLAUDE_CONFIG_DIR, P5-T4-3). */
export async function checkInstallScope(repoRoot: string, d: { fs: Fs; home: string; env: Env; platform: NodeJS.Platform }): Promise<'ok' | 'REFUSE_PROJECT_SCOPE'> {
  const [user, ...project] = settingsLayers(repoRoot, d.home, d.env, d.platform);
  if ((await enabledPluginIds([user as SettingsFile], d.fs)).some(isCoworkSync)) return 'ok';
  return (await enabledPluginIds(project, d.fs)).some(isCoworkSync) ? 'REFUSE_PROJECT_SCOPE' : 'ok';
}

/** x.y.z as three numbers (a prerelease suffix ignored); null otherwise. */
function version3(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** The 06 §3.2 floors: Node ≥ C.NODE_FLOOR_MAJOR → else REFUSE_NODE_VERSION {have, need}; a known Claude Code version (MCP clientInfo.version) below
 *  C.CC_FLOOR → REFUSE_CC_VERSION {have, need}; an unknown (null or unparseable) version is no refusal. fromTerminal does not change the answer here
 *  (08 §3 start step 1: from a terminal the version is usually unknown and Plan 7's start skips the check with a WARN). */
export function hostFloorRefusal(i: { ccVersion: string | null; nodeMajor: number; fromTerminal: boolean }):
{ code: 'REFUSE_CC_VERSION' | 'REFUSE_NODE_VERSION'; params: Params } | null {
  if (i.nodeMajor < C.NODE_FLOOR_MAJOR) return { code: 'REFUSE_NODE_VERSION', params: { have: i.nodeMajor, need: C.NODE_FLOOR_MAJOR } };
  const have = i.ccVersion === null ? null : version3(i.ccVersion);
  const need = version3(C.CC_FLOOR) as [number, number, number];
  if (have === null) return null;
  const below = have[0] !== need[0] ? have[0] < need[0] : have[1] !== need[1] ? have[1] < need[1] : have[2] < need[2];
  return below ? { code: 'REFUSE_CC_VERSION', params: { have: i.ccVersion as string, need: C.CC_FLOOR } } : null;
}

/** CCI-04 / 06 §1.2: CLAUDE_PLUGIN_DATA/repos.json lists the gitdirs of this user's checkouts; one whose live marker names another root, whose HEAD is
 *  the same branch and whose repo identity (glossary §18, through repoIdentity) equals this checkout's → REFUSE_SECOND_CHECKOUT naming the first
 *  checkout (the root its marker names). A missing or bad repos.json, a missing marker or a null identity → null. */
export async function checkSecondCheckout(repoRoot: string, branch: string, d: { fs: Fs; dataDir: string; repoIdentity: (gitdir: string) => Promise<string | null> }):
Promise<{ code: 'REFUSE_SECOND_CHECKOUT'; params: { first: string } } | null> {
  let listed: unknown;
  try {
    listed = JSON.parse((await d.fs.readFile(nodePath.join(d.dataDir, 'repos.json'))).toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(listed)) return null;
  const mine = await d.repoIdentity(nodePath.join(repoRoot, '.git'));
  if (mine === null) return null;
  for (const gitdir of listed) {
    if (typeof gitdir !== 'string') continue;
    const marker = await d.fs.readFile(nodePath.join(gitdir, 'cowork', 'live')).then((b) => b.toString('utf8'), () => null);
    const first = marker === null ? '' : (marker.split(/\r?\n/)[0] ?? '');
    if (first === '' || sameRoot(first, repoRoot, process.platform)) continue;
    if ((await headBranch(gitdir, d.fs)) !== branch) continue;
    if ((await d.repoIdentity(gitdir)) === mine) return { code: 'REFUSE_SECOND_CHECKOUT', params: { first } };
  }
  return null;
}

/** 06 §1.2: a `.git` file (linked worktree, nested .claude/worktrees/** checkout, submodule) → REFUSE_WORKTREE. */
export function checkWorktreeShape(loc: RepoLocation): 'ok' | 'REFUSE_WORKTREE' {
  return loc.kind === 'file' ? 'REFUSE_WORKTREE' : 'ok';
}
