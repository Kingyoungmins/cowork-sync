// Plan 5 Task 4: the local worktree refusal (06 §3.10, CCI-29, R1-712, R2-A2; A4-7, A4-12): agentDefRoots and worktreeDenied over real temp files
// copied from test/fixtures/agents/ (the loader-level cells are test/integration/loader.worktree.test.ts).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentDefRoots, worktreeDenied } from '../../src/claude/client/worktree.js';
import { realFs } from '../../src/ports/fs.js';
import { FaultFs } from '../sim/faultfs.js';
import { makeTempRoot } from '../helpers/tmp.js';

const AGENTS = fileURLToPath(new URL('../fixtures/agents/', import.meta.url));
let tmp: { root: string; cleanup: () => Promise<void> };
before(async () => {
  tmp = await makeTempRoot('claude-worktree');
});
after(() => tmp?.cleanup());

const put = (dir: string, name: string, from = name): void => {
  mkdirSync(dir, { recursive: true });
  cpSync(join(AGENTS, from), join(dir, name));
};
const settings = (file: string, enabled: Record<string, boolean>): void => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ enabledPlugins: enabled }));
};

test('agentDefRoots: the repo, user and enabled plugins\' agents directories, the newest plugin version by semver', async () => {
  const home = join(tmp.root, 'roots', 'home');
  const repo = join(tmp.root, 'roots', 'repo');
  const cache = join(home, '.claude', 'plugins', 'cache');
  for (const v of ['1.2.0', '1.10.0-rc.1', '1.10.0', '1.9.9', 'latest']) mkdirSync(join(cache, 'mkt', 'tools', v, 'agents'), { recursive: true });
  mkdirSync(join(cache, 'mkt', 'off', '1.0.0', 'agents'), { recursive: true });
  mkdirSync(join(cache, 'other', 'local', '0.1.0', 'agents'), { recursive: true });
  settings(join(home, '.claude', 'settings.json'), { 'tools@mkt': true, 'off@mkt': false });
  settings(join(repo, '.claude', 'settings.local.json'), { 'local@other': true, '../evil@mkt': true });
  const roots = await agentDefRoots(repo, home, realFs, {}, process.platform);
  assert.equal(roots.user, join(home, '.claude', 'agents'));
  assert.equal(roots.repo, join(repo, '.claude', 'agents'));
  assert.deepEqual([...roots.plugins].sort(), [join(cache, 'mkt', 'tools', '1.10.0', 'agents'), join(cache, 'other', 'local', '0.1.0', 'agents')].sort(),
    'enabled plugins only, their newest release by semver (a prerelease below its release), no path outside the cache');
  const none = await agentDefRoots(join(tmp.root, 'roots', 'nothing'), join(tmp.root, 'roots', 'nohome'), realFs, {}, process.platform);
  assert.deepEqual(none.plugins, [], 'no settings: no plugin roots');
});

test('agentDefRoots: CLAUDE_CONFIG_DIR (set and absolute) is the config directory for the user agents, the user settings and the plugin cache (P5-T4-3)', async () => {
  const home = join(tmp.root, 'cfg', 'home');
  const repo = join(tmp.root, 'cfg', 'repo');
  const cfg = join(tmp.root, 'cfg', 'config');
  mkdirSync(join(cfg, 'plugins', 'cache', 'mkt', 'tools', '2.0.0', 'agents'), { recursive: true });
  mkdirSync(join(cfg, 'plugins', 'cache', 'mkt', 'projectonly', '1.0.0', 'agents'), { recursive: true });
  mkdirSync(join(home, '.claude', 'plugins', 'cache', 'mkt', 'tools', '1.0.0', 'agents'), { recursive: true });
  mkdirSync(join(home, '.claude', 'plugins', 'cache', 'mkt', 'homeonly', '1.0.0', 'agents'), { recursive: true });
  settings(join(cfg, 'settings.json'), { 'tools@mkt': true });
  settings(join(home, '.claude', 'settings.json'), { 'homeonly@mkt': true });
  settings(join(repo, '.claude', 'settings.json'), { 'projectonly@mkt': true });
  const fs = new FaultFs(realFs);
  const roots = await agentDefRoots(repo, home, fs, { CLAUDE_CONFIG_DIR: cfg }, process.platform);
  assert.deepEqual({ ...roots, plugins: [...roots.plugins].sort() }, {
    user: join(cfg, 'agents'), repo: join(repo, '.claude', 'agents'),
    plugins: [join(cfg, 'plugins', 'cache', 'mkt', 'projectonly', '1.0.0', 'agents'), join(cfg, 'plugins', 'cache', 'mkt', 'tools', '2.0.0', 'agents')].sort(),
  }, 'the user settings and every enabled plugin\'s cache come from the config directory');
  assert.ok(fs.calls.every((c) => !c.includes(join(home, '.claude'))), `nothing under <home>/.claude is read: ${fs.calls.join(', ')}`);
  // Unset, empty or relative: <home>/.claude.
  for (const env of [{}, { CLAUDE_CONFIG_DIR: '' }, { CLAUDE_CONFIG_DIR: join('relative', 'config') }]) {
    const r = await agentDefRoots(repo, home, realFs, env, process.platform);
    assert.equal(r.user, join(home, '.claude', 'agents'), JSON.stringify(env));
    assert.deepEqual([...r.plugins].sort(), [join(home, '.claude', 'plugins', 'cache', 'mkt', 'homeonly', '1.0.0', 'agents')], JSON.stringify(env));
  }
  if (process.platform === 'win32') {
    const lower = await agentDefRoots(repo, home, realFs, { claude_config_dir: cfg }, 'win32');
    assert.equal(lower.user, join(cfg, 'agents'), 'win32 spells the variable name in any case');
  }
});

test('worktreeDenied: EnterWorktree, Agent isolation: worktree and a definition whose frontmatter says so; the first definition found decides', async () => {
  const base = join(tmp.root, 'denied');
  const roots = { repo: join(base, 'repo-agents'), user: join(base, 'user-agents'), plugins: [join(base, 'p1-agents'), join(base, 'p2-agents')] };
  const fs = new FaultFs(realFs);
  assert.equal(await worktreeDenied('EnterWorktree', {}, roots, fs), true);
  assert.equal(await worktreeDenied('Agent', { isolation: 'worktree', subagent_type: 'x' }, roots, fs), true);
  assert.equal(await worktreeDenied('Agent', { subagent_type: 'builder' }, roots, fs), false, 'no definition anywhere');
  put(roots.plugins[1]!, 'builder.md');
  assert.equal(await worktreeDenied('Agent', { subagent_type: 'builder' }, roots, fs), true, 'found in the second plugin');
  put(roots.user, 'builder.md', 'shared.md');
  assert.equal(await worktreeDenied('Agent', { subagent_type: 'builder' }, roots, fs), false, 'the user definition comes first (isolation: none)');
  put(roots.repo, 'builder.md');
  assert.equal(await worktreeDenied('Agent', { subagent_type: 'builder' }, roots, fs), true, 'the repo definition comes first');
  put(roots.user, 'reviewer.md');
  assert.equal(await worktreeDenied('Agent', { subagent_type: 'reviewer' }, roots, fs), false, 'isolation only in the body');
  put(roots.user, 'quoted.md');
  assert.equal(await worktreeDenied('Agent', { subagent_type: 'quoted' }, roots, fs), true, 'a quoted value with a comment');
  writeFileSync(join(roots.user, 'crlf.md'), readFileSync(join(AGENTS, 'quoted.md'), 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(await worktreeDenied('Agent', { subagent_type: 'crlf' }, roots, fs), true, 'CRLF frontmatter');
  put(roots.plugins[0]!, 'builder.md');
  assert.equal(await worktreeDenied('Agent', { subagent_type: 'myplugin:builder' }, { ...roots, repo: join(base, 'none'), user: join(base, 'none') }, fs), true,
    'a namespaced plugin agent is looked up by its name in the plugin roots');
  assert.equal(await worktreeDenied('Agent', { subagent_type: '../repo-agents/builder' }, { ...roots, repo: join(base, 'none'), user: join(base, 'none'), plugins: [] }, fs), false,
    'a subagent_type with a path separator names no definition');
  assert.equal(await worktreeDenied('Agent', { isolation: 'none', subagent_type: 'reviewer' }, roots, fs), false);
  assert.equal(await worktreeDenied('Agent', null, roots, fs), false);
  assert.equal(await worktreeDenied('Edit', { file_path: 'x' }, roots, fs), false, 'not the Agent|EnterWorktree class');
  assert.ok(fs.calls.every((c) => /^readFile /.test(c)), 'definitions are only read');
});
