// Entry point for dist/cli.js (glossary §6). `view …` runs the read-only viewer verb (12-visualizer §3.2, Plan 8a Task 11);
// `since …` the catch-up summary (10-product §3.9a, F04-a); `--version` prints the version; start, stop, status and help are the
// v0.1.0-preview verbs (src/cli/verbs.ts). Without arguments it prints nothing on stdout: the help on stderr in a terminal or a
// slash command, nothing at all in pipe mode.
import { realCoworkEnv } from '../cli/realEnv.js';
import { runCowork } from '../cli/verbs.js';
import { runSince } from '../since/cli.js';
import { PLUGIN_VERSION } from '../version.js';
import { realCliEnv, runView } from '../viz/cli/view.js';

const argv = process.argv.slice(2);
if (argv[0] === 'view') {
  process.exitCode = await runView(argv.slice(1), realCliEnv());
} else if (argv[0] === 'since') {
  process.exitCode = await runSince(argv.slice(1), realCliEnv());
} else if (argv.includes('--version')) {
  process.stdout.write(`cowork-sync cli ${PLUGIN_VERSION}\n`);
} else {
  process.exitCode = await runCowork(argv, realCoworkEnv());
}
