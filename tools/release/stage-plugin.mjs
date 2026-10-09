// Fills plugin/ (the folder the marketplace entry installs, see RELEASING.md) with what a release commit carries besides the
// files kept on main: the bundles (tools/build/build.mjs --outdir plugin/dist) and copies of LICENSE.md and README.md.
// All three are ignored on main (.gitignore); the release commit adds them with `git add -f`.
// Checks after the copy: plugin.json, plugin/package.json and package.json carry one version; plugin/ holds no lockfile, so
// Claude Code never runs a dependency install for the plugin.
//
// Usage: node tools/release/stage-plugin.mjs
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const plugin = join(repoRoot, 'plugin');

function fail(message) {
  process.stderr.write(`stage-plugin: ${message}\n`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'));
const pluginPkg = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) fail(`plugin.json version ${manifest.version} is not package.json's ${pkg.version}`);
if (pluginPkg.type !== 'module') fail('plugin/package.json must say "type": "module"');
for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  if (pluginPkg[key] !== undefined) fail(`plugin/package.json must not declare ${key}`);
}
for (const lock of ['package-lock.json', 'npm-shrinkwrap.json', 'bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml']) {
  if (existsSync(join(plugin, lock))) fail(`plugin/${lock} must not exist (it would make Claude Code install dependencies)`);
}

const b = spawnSync(process.execPath, [join(repoRoot, 'tools', 'build', 'build.mjs'), '--outdir', join(plugin, 'dist')], { cwd: repoRoot, stdio: 'inherit' });
if (b.status !== 0) fail(`the build failed (exit ${b.status})`);
for (const f of ['LICENSE.md', 'README.md']) copyFileSync(join(repoRoot, f), join(plugin, f));

const v = spawnSync(process.execPath, [join(plugin, 'dist', 'cli.js'), '--version'], { encoding: 'utf8' });
if (v.status !== 0 || v.stdout !== `cowork-sync cli ${pkg.version}\n`) fail(`plugin/dist/cli.js --version printed ${JSON.stringify(v.stdout)} (exit ${v.status})`);
process.stdout.write(`stage-plugin: plugin/ holds cowork-sync ${pkg.version} (dist/, LICENSE.md, README.md)\n`);
