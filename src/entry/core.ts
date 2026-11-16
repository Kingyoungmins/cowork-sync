// Entry point for dist/core.js (glossary §6): the hook core the loader imports at run time (06 §3.4.1 step 9, A2-1). Plan 1's `--version` line and
// no-argument no-op run only when this file is the process entry (`node dist/core.js …`), never when the loader imports it.
import { pathToFileURL } from 'node:url';
import { PLUGIN_VERSION } from '../version.js';

export { main } from '../claude/client/hookCore.js';

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href && process.argv.slice(2).includes('--version')) {
  process.stdout.write(`cowork-sync core ${PLUGIN_VERSION}\n`);
}
