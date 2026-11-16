// src/claude/client/worktree.ts — 06 §3.10 "Worktrees" (CCI-29, R1-712, R2-A2; A4-7, A4-12): while the repo is live, PreToolUse(EnterWorktree) and
// PreToolUse(Agent) with worktree isolation — tool_input.isolation, or the frontmatter of the agent definition its subagent_type names — are refused
// WORKTREE_DENY. Decided locally from the definition files, without IPC, so these calls never take G4. 06 §8 Q11 default: core reads the definitions.
import { join } from 'node:path';
import type { WireJson } from '../wire/frames.js';
import { claudeConfigDir, type Env } from '../../data/pluginDataDir.js';
import type { Fs } from '../../ports/fs.js';
import { enabledPluginIds, settingsLayers } from './policy.js';

export interface AgentDefRoots { user: string; repo: string; plugins: readonly string[]; }   // <config>/agents, <repo>/.claude/agents, enabled plugins' agents/

/** A release `x.y.z` (or `x.y.z-pre`) as numbers; null for any other directory name. */
function semver(v: string): { n: number[]; pre: string | null } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  return m === null ? null : { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/** a before b by semver: the numbers, then a prerelease before its release (prereleases compared as strings). */
function semverLess(a: string, b: string): boolean {
  const x = semver(a) as { n: number[]; pre: string | null };
  const y = semver(b) as { n: number[]; pre: string | null };
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return (x.n[i] as number) < (y.n[i] as number);
  if (x.pre === y.pre) return false;
  return x.pre !== null && (y.pre === null || x.pre < y.pre);
}

/** A path component as Claude Code's plugin cache spells it: no separator, no '.' or '..'. */
const plainName = (s: string): boolean => s !== '' && s !== '.' && s !== '..' && !/[\\/]/.test(s);

/** A4-12, read with R5-56 by Ruling P5-T4-3 (<config> = the Claude config directory: CLAUDE_CONFIG_DIR when set and absolute, else <home>/.claude —
 *  claudeConfigDir of src/data/pluginDataDir.ts, the directories the host itself reads): user = <config>/agents, repo = <repoRoot>/.claude/agents,
 *  plugins = <config>/plugins/cache/<marketplace>/<plugin>/<version>/agents for every <plugin>@<marketplace> set true in enabledPlugins of the user
 *  (<config>/settings.json), project or local settings (the newest <version> directory by semver). */
export async function agentDefRoots(repoRoot: string, home: string, fs: Fs, env: Env, platform: NodeJS.Platform): Promise<AgentDefRoots> {
  const config = claudeConfigDir(env, home, platform);
  const plugins: string[] = [];
  for (const id of await enabledPluginIds(settingsLayers(repoRoot, home, env, platform), fs)) {
    const at = id.lastIndexOf('@');
    const plugin = id.slice(0, at);
    const marketplace = id.slice(at + 1);
    if (at <= 0 || !plainName(plugin) || !plainName(marketplace)) continue;
    const dir = join(config, 'plugins', 'cache', marketplace, plugin);
    const versions = (await fs.readdir(dir).catch(() => [] as string[])).filter((v) => semver(v) !== null);
    const newest = versions.reduce<string | null>((best, v) => (best === null || semverLess(best, v) ? v : best), null);
    if (newest !== null) plugins.push(join(dir, newest, 'agents'));
  }
  return { user: join(config, 'agents'), repo: join(repoRoot, '.claude', 'agents'), plugins };
}

/** The `isolation` value of a definition's YAML frontmatter (between the opening `---` line and the next `---` line), unquoted, a trailing
 *  ` # comment` dropped; null without frontmatter or key. A small key reader, no YAML dependency. */
function isolationOf(text: string): string | null {
  const lines = text.replace(/^\u{FEFF}/u, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') return null;
    const m = /^isolation[ \t]*:[ \t]*(.*?)[ \t]*$/.exec(line);
    if (m === null) continue;
    const value = (m[1] as string).replace(/[ \t]+#.*$/, '');
    return value.replace(/^(["'])(.*)\1$/, '$2');
  }
  return null;
}

/** The definition of a subagent type: the first <subagent_type>.md found in repo, user, then plugins order (A4-12); for a namespaced
 *  `<plugin>:<name>` the plugin roots are also searched for <name>.md. A type with a path separator names no definition. */
async function definition(type: string, roots: AgentDefRoots, fs: Fs): Promise<string | null> {
  if (!plainName(type)) return null;
  const local = type.includes(':') ? type.slice(type.lastIndexOf(':') + 1) : null;
  const candidates: string[] = [roots.repo, roots.user, ...roots.plugins].map((d) => join(d, `${type}.md`));
  if (local !== null && plainName(local)) candidates.push(...roots.plugins.map((d) => join(d, `${local}.md`)));
  for (const file of candidates) {
    const text = await fs.readFile(file).then((b) => b.toString('utf8'), () => null);
    if (text !== null) return text;
  }
  return null;
}

/** EnterWorktree; Agent with tool_input.isolation === 'worktree'; Agent whose subagent_type names a definition with frontmatter `isolation: worktree`
 *  → true (WORKTREE_DENY, exit 2). Every other call → false. */
export async function worktreeDenied(toolName: string, toolInput: WireJson, roots: AgentDefRoots, fs: Fs): Promise<boolean> {
  if (toolName === 'EnterWorktree') return true;
  if (toolName !== 'Agent' || typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) return false;
  if (toolInput['isolation'] === 'worktree') return true;
  const type = toolInput['subagent_type'];
  if (typeof type !== 'string') return false;
  const text = await definition(type, roots, fs);
  return text !== null && isolationOf(text) === 'worktree';
}
