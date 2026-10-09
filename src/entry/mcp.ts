// Stub entry point for dist/mcp.js (glossary §6). Plan 1 only proves the
// bundle builds and runs: `--version` prints the version, anything else is a no-op.
import { PLUGIN_VERSION } from '../version.js';

if (process.argv.slice(2).includes('--version')) {
  process.stdout.write(`cowork-sync mcp ${PLUGIN_VERSION}\n`);
}
