// The verbs of cli.js besides `view` (v0.1.0-preview): start, stop, status and help. Pure: argv in, a verb or a usage refusal out.
//   start [--branch <b>] [--publish=all|none] [--remote <name>] [--name <display>]
//   stop | status | help (also -h, --help)
// A value is given as `--key value` or `--key=value`. The branch and display-name rules are the daemon's own (refNames, validName),
// so a value the daemon would refuse as a usage error is refused here first.
import { EncTooLongError } from '../git/enc.js';
import { RELEASE_NAMESPACE, refNames } from '../engine/refs.js';
import { validName } from '../sec/validators.js';

export interface StartOptions { branch: string | null; publish: 'all' | 'none' | null; remote: string | null; name: string | null; }
export type CoworkCommand = ({ verb: 'start' } & StartOptions) | { verb: 'stop' } | { verb: 'status' } | { verb: 'help' };
/** A usage error: `why` says what was wrong (English, one clause). */
export interface CoworkUsage { usage: string; }

export const VERBS: readonly string[] = Object.freeze(['start', 'stop', 'status', 'view', 'help']);

const START_OPTIONS: ReadonlySet<string> = new Set(['branch', 'publish', 'remote', 'name']);

/** The branch passes refNames' checks (an over-long encoded name is the daemon's START_BRANCH_NAME refusal, not a usage error). */
function branchOk(branch: string): boolean {
  try {
    refNames(branch, RELEASE_NAMESPACE);
    return true;
  } catch (e) {
    return e instanceof EncTooLongError;
  }
}

export function parseCoworkArgs(argv: readonly string[]): CoworkCommand | CoworkUsage {
  const verb = argv[0];
  if (verb === undefined || verb === 'help' || verb === '-h' || verb === '--help') {
    return argv.length <= 1 ? { verb: 'help' } : { usage: 'help takes no options' };
  }
  if (verb === 'stop' || verb === 'status') {
    if (argv.includes('--help') || argv.includes('-h')) return { verb: 'help' };
    return argv.length === 1 ? { verb } : { usage: `${verb} takes no options` };
  }
  if (verb !== 'start') return { usage: `unknown command ${JSON.stringify(verb)}` };
  const opts = new Map<string, string>();
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') return { verb: 'help' };
    const m = /^--([a-z]+)(?:=(.*))?$/s.exec(a);
    if (m === null) return { usage: `unexpected argument ${JSON.stringify(a)}` };
    const key = m[1]!;
    let value = m[2];
    if (!START_OPTIONS.has(key)) return { usage: `--${key} is not an option of start` };
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return { usage: `--${key} needs a value` };
      value = next;
      i++;
    }
    if (opts.has(key)) return { usage: `--${key} given twice` };
    if (value.length === 0 || /[\0\r\n]/.test(value)) return { usage: `--${key} needs a value` };
    opts.set(key, value);
  }
  const branch = opts.get('branch') ?? null;
  if (branch !== null && !branchOk(branch)) return { usage: '--branch: not a branch name git accepts' };
  const publish = opts.get('publish') ?? null;
  if (publish !== null && publish !== 'all' && publish !== 'none') return { usage: '--publish is all or none' };
  const name = opts.get('name') ?? null;
  if (name !== null && !validName(name)) return { usage: "--name: letters, digits, spaces and _ . ' - only, at most 64" };
  const remote = opts.get('remote') ?? null;
  if (remote !== null && remote.startsWith('-')) return { usage: '--remote: not a remote name' };
  return { verb: 'start', branch, publish, remote, name };
}

/** The daemon's `run` argv (after dist/daemon.js) for a start on `repo` and `branch`. */
export function daemonRunArgv(repo: string, branch: string, o: StartOptions): string[] {
  const argv = ['run', '--repo', repo, '--branch', branch];
  if (o.publish !== null) argv.push(`--publish=${o.publish}`);
  if (o.remote !== null) argv.push('--remote', o.remote);
  if (o.name !== null) argv.push('--name', o.name);
  return argv;
}
