// Plan 5 Task 4: worktree refusal (R1-712, R2-A2, CCI-29, A4-7, A4-12; 06 test 23, TC-CCI-15 worktree part). The bundled loader in a live repo, the
// definitions copied from test/fixtures/agents/ into <repo>/.claude/agents/, <home>/.claude/agents/ (the loader's home: USERPROFILE/HOME) or a
// plugin's cache directory; a fakeDaemon on the repo's endpoint counts connections (none: decided locally).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeDaemon, type FakeDaemon } from '../helpers/fakeDaemon.js';
import { buildDist, loaderRepo, preToolJson, runLoader, type LoaderRepo } from '../helpers/loaderRun.js';

const AGENTS = fileURLToPath(new URL('../fixtures/agents/', import.meta.url));
let r: LoaderRepo;
let daemon: FakeDaemon;
let dist = '';
before(async () => {
  r = await loaderRepo({ label: 'loader-worktree', live: true });
  daemon = await fakeDaemon(r.endpoint as string, r.key as Buffer);
  dist = buildDist(join(r.base, 'build'));
});
after(async () => {
  await daemon?.close();
  await r?.cleanup();
});

const DENY = '[cowork-sync] WORKTREE_DENY';
const agent = (input: Record<string, unknown>) => runLoader('PreToolUse', preToolJson('Agent', r.dir, { input }), { dist, cwd: r.dir, env: r.env });
const put = (dir: string, file: string, from = file): void => {
  mkdirSync(dir, { recursive: true });
  cpSync(join(AGENTS, from), join(dir, file));
};

test('EnterWorktree, Agent isolation:worktree and an Agent definition with isolation: worktree → exit 2 WORKTREE_DENY without IPC; Agent without isolation passes', async () => {
  const denied = async (res: Awaited<ReturnType<typeof agent>>, what: string): Promise<void> => {
    assert.deepEqual([res.exit, res.stdout, res.stderr], [2, '', DENY], what);
  };
  await denied(await runLoader('PreToolUse', preToolJson('EnterWorktree', r.dir), { dist, cwd: r.dir, env: r.env }), 'EnterWorktree');
  await denied(await agent({ isolation: 'worktree', prompt: 'x' }), 'Agent {isolation: worktree}');

  const repoAgents = join(r.dir, '.claude', 'agents');
  const userAgents = join(r.home, '.claude', 'agents');
  put(repoAgents, 'builder.md');
  await denied(await agent({ subagent_type: 'builder' }), 'a <repo>/.claude/agents definition');
  rmSync(repoAgents, { recursive: true });
  put(userAgents, 'builder.md');
  await denied(await agent({ subagent_type: 'builder' }), 'only in <home>/.claude/agents');
  rmSync(userAgents, { recursive: true });

  const cache = join(r.home, '.claude', 'plugins', 'cache', 'test-market');
  put(join(cache, 'tools', '1.0.0', 'agents'), 'builder.md');
  put(join(cache, 'other', '1.0.0', 'agents'), 'builder.md');
  const settings = (enabled: Record<string, boolean>): void => {
    mkdirSync(join(r.home, '.claude'), { recursive: true });
    writeFileSync(join(r.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: enabled }));
  };
  settings({ 'tools@test-market': true });
  await denied(await agent({ subagent_type: 'builder' }), 'only in an enabled plugin\'s agents/');
  settings({ 'tools@test-market': false, 'other@test-market': false });
  const disabled = await agent({ subagent_type: 'builder' });
  assert.deepEqual([disabled.exit, disabled.stdout, disabled.stderr], [0, '', ''], 'a definition in a plugin not enabled');

  put(userAgents, 'reviewer.md');
  const reviewer = await agent({ subagent_type: 'reviewer' });
  assert.deepEqual([reviewer.exit, reviewer.stdout, reviewer.stderr], [0, '', ''], 'a definition without isolation');
  assert.equal(daemon.connections(), 0, 'no IPC for any of them');

  r.setLive(false);
  try {
    const nonlive = await runLoader('PreToolUse', preToolJson('EnterWorktree', r.dir), { dist, cwd: r.dir, env: r.env });
    assert.deepEqual([nonlive.exit, nonlive.stdout, nonlive.stderr], [0, '', ''], 'a non-live repo: EnterWorktree passes');
  } finally {
    r.setLive(true);
  }
});

test('CLAUDE_CONFIG_DIR is the Claude config directory: its agents/, its settings and its plugin cache decide, not <home>/.claude (P5-T4-3)', async () => {
  const cfg = join(r.base, 'claude-config');
  const withCfg = (value: string, input: Record<string, unknown>) =>
    runLoader('PreToolUse', preToolJson('Agent', r.dir, { input }), { dist, cwd: r.dir, env: { ...r.env, CLAUDE_CONFIG_DIR: value } });
  const passes = (res: Awaited<ReturnType<typeof agent>>, what: string): void => assert.deepEqual([res.exit, res.stdout, res.stderr], [0, '', ''], what);
  const denies = (res: Awaited<ReturnType<typeof agent>>, what: string): void => assert.deepEqual([res.exit, res.stdout, res.stderr], [2, '', DENY], what);
  const homeAgents = join(r.home, '.claude', 'agents');
  const cleanups: string[] = [cfg, join(r.dir, 'cfg-relative')];
  try {
    // The reviewer's probe: the definition only in <CLAUDE_CONFIG_DIR>/agents.
    put(join(cfg, 'agents'), 'builder.md');
    denies(await withCfg(cfg, { subagent_type: 'builder' }), 'only in <CLAUDE_CONFIG_DIR>/agents');
    rmSync(join(cfg, 'agents'), { recursive: true });
    // With the variable set, <home>/.claude/agents is not the user's directory (the host does not read it either).
    put(homeAgents, 'builder.md');
    cleanups.push(join(homeAgents, 'builder.md'));
    passes(await withCfg(cfg, { subagent_type: 'builder' }), '<home>/.claude/agents is not read when CLAUDE_CONFIG_DIR is set');
    // An enabled plugin: the user settings and the plugin cache are the config directory's.
    put(join(cfg, 'plugins', 'cache', 'test-market', 'cfgtools', '1.0.0', 'agents'), 'reviewer.md');
    put(join(cfg, 'plugins', 'cache', 'test-market', 'cfgtools', '1.0.0', 'agents'), 'quoted.md');
    writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ enabledPlugins: { 'cfgtools@test-market': true } }));
    denies(await withCfg(cfg, { subagent_type: 'quoted' }), 'only in a plugin enabled in <CLAUDE_CONFIG_DIR>/settings.json, under <CLAUDE_CONFIG_DIR>/plugins/cache');
    passes(await withCfg(cfg, { subagent_type: 'reviewer' }), 'the same plugin\'s definition without isolation');
    writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ enabledPlugins: { 'cfgtools@test-market': false } }));
    passes(await withCfg(cfg, { subagent_type: 'quoted' }), 'that plugin disabled in <CLAUDE_CONFIG_DIR>/settings.json');
    // A relative value is ignored (R5-56's rule): <home>/.claude decides, never <cwd>/<value>.
    put(join(r.dir, 'cfg-relative', 'agents'), 'builder.md', 'shared.md');
    denies(await withCfg('cfg-relative', { subagent_type: 'builder' }), 'a relative CLAUDE_CONFIG_DIR: <home>/.claude/agents/builder.md decides');
    assert.equal(daemon.connections(), 0, 'no IPC for any of them');
  } finally {
    for (const p of cleanups) rmSync(p, { recursive: true, force: true });
  }
});
