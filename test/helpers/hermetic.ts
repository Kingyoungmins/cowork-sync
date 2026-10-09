// Test helper: a GitRepo over the fixture's clone whose git sees a private HOME, XDG_CONFIG_HOME and
// global config and no system config, so results never depend on the developer's own git setup.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitRepo } from '../../src/git/repo.js';
import type { GitRunner } from '../../src/git/runner.js';
import { fixtureContext, type RepoFixture } from './repoFixture.js';

export interface HermeticRepo { repo: GitRepo; home: string; xdg: string; }

export function hermeticRepo(f: RepoFixture, drivers: string[] = [], extraEnv: Record<string, string> = {}): HermeticRepo {
  const home = join(f.root, 'hermetic home');
  const xdg = join(home, 'xdg config');
  mkdirSync(join(xdg, 'git'), { recursive: true });
  const globalConfig = join(home, 'gitconfig');
  writeFileSync(globalConfig, '');
  const env: Record<string, string> = {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', ...extraEnv,
  };
  const runner: GitRunner = { run: (args, opts) => f.runner.run(args, { ...opts, extraEnv: { ...(opts.extraEnv ?? {}), ...env } }) };
  return { repo: new GitRepo(runner, f.paths, () => ({ ...fixtureContext(), filterDrivers: drivers })), home, xdg };
}
