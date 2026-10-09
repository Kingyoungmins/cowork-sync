// The bundle of side-effect ports every daemon, worker, CLI and MCP component
// receives (11-testing §3.2). Production binds the real implementations; SIM
// binds VirtualClock, seededRandom, VirtualScheduler, FaultFs and the same
// real git runner (git is never mocked).
import type { Clock } from './clock.js';
import type { Random } from './random.js';
import type { Scheduler } from './scheduler.js';
import type { Fs } from './fs.js';
import type { GitRunner } from '../git/runner.js';

export interface Ports {
  clock: Clock;
  random: Random;
  scheduler: Scheduler;
  fs: Fs;
  git: GitRunner;
}
