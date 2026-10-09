// The process's own CoworkEnv: cli.js lives in <plugin root>/dist/. Read-only git runs through the git runner with the builder
// environment (09-security section 3.4) and an empty hooks path; nothing here runs a hook or writes to git.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processAlive } from '../engine/daemonFiles.js';
import { buildDaemonEnv } from '../git/env.js';
import { createGitRunner } from '../git/runner.js';
import { machineMonoMs, realClock } from '../ports/clock.js';
import { realFs } from '../ports/fs.js';
import { launchDaemon } from './launch.js';
import { START_TIMEOUT_MS, STOP_POLL_MS, STOP_TIMEOUT_MS, type CoworkEnv } from './verbs.js';

export function realCoworkEnv(): CoworkEnv {
  const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const git = createGitRunner({ clock: realClock, hooksPath: join(pluginRoot, 'empty-hooks'), daemonEnv: buildDaemonEnv({ ...process.env }, []) });
  return {
    pluginRoot,
    cwd: process.cwd(),
    env: process.env,
    platform: process.platform,
    isTTY: process.stdout.isTTY === true,
    execPath: process.execPath,
    out: (s) => { process.stdout.write(`${s}\n`); },
    err: (s) => { process.stderr.write(`${s}\n`); },
    fs: realFs,
    clock: realClock,
    git,
    launchDaemon,
    alive: processAlive,
    machineMono: machineMonoMs,
    startTimeoutMs: START_TIMEOUT_MS,
    stopTimeoutMs: STOP_TIMEOUT_MS,
    stopPollMs: STOP_POLL_MS,
  };
}
