// cli.js verbs (v0.1.0-preview): argument parsing and the daemon argv it builds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daemonRunArgv, parseCoworkArgs } from '../../../src/cli/args.js';

const START = { verb: 'start', branch: null, publish: null, remote: null, name: null } as const;

test('verbs: help without arguments and with help/-h/--help; stop and status take no options', () => {
  assert.deepEqual(parseCoworkArgs([]), { verb: 'help' });
  for (const h of ['help', '-h', '--help']) assert.deepEqual(parseCoworkArgs([h]), { verb: 'help' });
  assert.deepEqual(parseCoworkArgs(['stop']), { verb: 'stop' });
  assert.deepEqual(parseCoworkArgs(['status']), { verb: 'status' });
  assert.deepEqual(parseCoworkArgs(['status', '--help']), { verb: 'help' });
  assert.ok('usage' in parseCoworkArgs(['status', '--json']));
  assert.ok('usage' in parseCoworkArgs(['stop', 'now']));
  assert.ok('usage' in parseCoworkArgs(['help', 'start']));
  assert.match((parseCoworkArgs(['bogus']) as { usage: string }).usage, /unknown command "bogus"/);
});

test('start: --branch, --publish, --remote and --name, as --key value or --key=value', () => {
  assert.deepEqual(parseCoworkArgs(['start']), START);
  assert.deepEqual(parseCoworkArgs(['start', '--branch', 'feat/x']), { ...START, branch: 'feat/x' });
  assert.deepEqual(parseCoworkArgs(['start', '--branch=main', '--publish=all']), { ...START, branch: 'main', publish: 'all' });
  assert.deepEqual(parseCoworkArgs(['start', '--publish', 'none', '--remote', 'up', '--name', 'Ann Lee']),
    { ...START, publish: 'none', remote: 'up', name: 'Ann Lee' });
  assert.deepEqual(parseCoworkArgs(['start', '-h']), { verb: 'help' });
});

test('start refuses what the daemon would refuse as a usage error', () => {
  const why = (argv: string[]): string => (parseCoworkArgs(argv) as { usage: string }).usage;
  assert.match(why(['start', '--branch']), /--branch needs a value/);
  assert.match(why(['start', '--branch', '--publish=all']), /--branch needs a value/);
  assert.match(why(['start', '--branch=']), /--branch needs a value/);
  assert.match(why(['start', '--branch', 'a..b']), /not a branch name/);
  assert.match(why(['start', '--branch', 'x', '--branch', 'y']), /given twice/);
  assert.match(why(['start', '--publish=some']), /all or none/);
  assert.match(why(['start', '--name', 'a\u0007b']), /--name/);
  assert.match(why(['start', '--remote', '-x']), /not a remote name/);
  assert.match(why(['start', '--repo', '/x']), /--repo is not an option of start/);
  assert.match(why(['start', 'main']), /unexpected argument "main"/);
});

test('daemonRunArgv: run --repo --branch, then the options given', () => {
  assert.deepEqual(daemonRunArgv('/r', 'main', START), ['run', '--repo', '/r', '--branch', 'main']);
  assert.deepEqual(daemonRunArgv('/r', 'b', { branch: 'b', publish: 'none', remote: 'up', name: 'Ann' }),
    ['run', '--repo', '/r', '--branch', 'b', '--publish=none', '--remote', 'up', '--name', 'Ann']);
});
