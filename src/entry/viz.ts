// Entry point for dist/viz.js, the viewer process of 12-visualizer (§3.2, §3.13): `--version` prints the version, no argument is
// a no-op, and `serve …` runs the viewer (src/viz/main.ts: one ready line on stdout, then the server until a VizExit).
import { PLUGIN_VERSION } from '../version.js';
import { VIZ_ASSETS } from '../viz/assets.js';
import { main } from '../viz/main.js';

const argv = process.argv.slice(2);
if (argv[0] === 'serve') {
  await main(argv, VIZ_ASSETS);
} else if (argv.includes('--version')) {
  process.stdout.write(`cowork-sync viz ${PLUGIN_VERSION}\n`);
}
