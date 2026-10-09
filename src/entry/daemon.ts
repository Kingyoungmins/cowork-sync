// Entry point for dist/daemon.js (glossary §6): the daemon (Plan 2 Task 17; src/daemon/run.ts), in a terminal or started in
// the background by `cowork start`; `run` also stops on <gitdir>/cowork/stop-request (`cowork stop`).
//   node dist/daemon.js run --repo <path> --branch <b> [--publish=all|none] [--name <display>] [--remote <name>]
//   node dist/daemon.js recover --repo <path> --branch <b> [--confirm=<id>]
//   node dist/daemon.js resume --repo <path> --branch <b>
//   node dist/daemon.js --version
// No arguments at all is a no-op with the usage on stderr (Plan 1's bundle check runs every entry point without any).
import { DAEMON_USAGE, parseDaemonArgs, runDaemon, type DaemonIo } from '../daemon/run.js';
import { PLUGIN_VERSION } from '../version.js';

// `cowork start` (src/cli) reads the start line through pipes and then closes them, while the daemon runs on in the
// background: a later write to a closed pipe (EPIPE) must never end the daemon. Its log and status.json keep the record.
process.stdout.on('error', () => undefined);
process.stderr.on('error', () => undefined);

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write(`cowork-sync daemon ${PLUGIN_VERSION}\n`);
} else if (argv.length === 0) {
  process.stderr.write(`${DAEMON_USAGE}\n`);
} else {
  const parsed = parseDaemonArgs(argv);
  if ('usage' in parsed) {
    (parsed.exitCode === 0 ? process.stdout : process.stderr).write(`${parsed.usage}\n`);
    process.exitCode = parsed.exitCode;
  } else {
    const io: DaemonIo = {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
      onStop: (cb) => {
        process.once('SIGINT', cb);
        process.once('SIGTERM', cb);
      },
    };
    // Exit once stdout and stderr have flushed (a pipe may still hold the last printed lines, which process.exit would
    // drop), so a refusal's code and next command always reach the caller; runDaemon has flushed the daemon log.
    const exit = (code: number): void => {
      process.exitCode = code;
      process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
    };
    runDaemon(parsed, process.env, io).then(exit, (e: unknown) => {
      process.stderr.write(`DAEMON_INTERNAL_ERROR ${e instanceof Error ? e.name : 'unknown'}\n`);
      exit(2);
    });
  }
}
