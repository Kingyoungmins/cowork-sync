// The Claude Code plugin packaging (v0.1.0-preview, RELEASING.md): plugin/ is the plugin root the marketplace entry installs from
// the release tag; .claude-plugin/marketplace.json at the repository root is the catalog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SLASH_COMMAND } from '../../src/cli/verbs.js';
import { PLUGIN_VERSION } from '../../src/version.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const json = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(`${repo}${rel}`, 'utf8')) as Record<string, unknown>;
const URL_REPO = 'https://github.com/Kingyoungmins/cowork-sync';

test('plugin/.claude-plugin/plugin.json: name, the package version, author, licence and links', () => {
  const m = json('plugin/.claude-plugin/plugin.json');
  assert.equal(m.name, 'cowork-sync');
  assert.equal(m.version, PLUGIN_VERSION);
  assert.deepEqual(m.author, { name: 'Youngmin Seo' });
  assert.equal(m.license, 'FSL-1.1-ALv2');
  assert.equal(m.homepage, URL_REPO);
  assert.equal(m.repository, URL_REPO);
  assert.equal(typeof m.description, 'string');
});

test('plugin/package.json makes node read dist/*.js as ES modules and declares no dependency; plugin/ holds no lockfile', () => {
  const p = json('plugin/package.json');
  assert.equal(p.type, 'module');
  assert.equal(p.private, true);
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'scripts']) assert.equal(p[k], undefined, k);
  for (const lock of ['package-lock.json', 'npm-shrinkwrap.json', 'bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml']) {
    assert.equal(existsSync(`${repo}plugin/${lock}`), false, lock);
  }
});

test('the marketplace catalog installs plugin/ from the release tag of this version', () => {
  const m = json('.claude-plugin/marketplace.json');
  assert.equal(m.name, 'cowork-sync');
  assert.deepEqual(m.owner, { name: 'Youngmin Seo' });
  const plugins = m.plugins as Array<Record<string, unknown>>;
  assert.equal(plugins.length, 1);
  const [entry] = plugins as [Record<string, unknown>];
  assert.equal(entry.name, 'cowork-sync');
  assert.equal(entry.version, undefined, 'plugin.json carries the version');
  assert.deepEqual(entry.source, { source: 'git-subdir', url: `${URL_REPO}.git`, path: 'plugin', ref: `v${PLUGIN_VERSION}` });
});

test('the descriptions users see in /plugin name the slash command Claude Code resolves, never the bare /cowork', () => {
  const manifest = json('plugin/.claude-plugin/plugin.json');
  const [entry] = json('.claude-plugin/marketplace.json').plugins as [Record<string, unknown>];
  for (const [where, d] of [['plugin.json', manifest.description], ['marketplace.json', entry.description]] as const) {
    assert.equal(typeof d, 'string', where);
    assert.ok((d as string).includes(`${SLASH_COMMAND} start`), `${where}: ${String(d)}`);
    assert.doesNotMatch(d as string, /\/cowork(?![-\w:])/, `${where} names the bare /cowork, which Claude Code does not resolve`);
  }
});

test('commands/cowork.md runs cli.js through `!`, pre-approves only that call, and is the CLI\'s slash command', () => {
  const md = readFileSync(`${repo}plugin/commands/cowork.md`, 'utf8');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(md);
  assert.ok(fm !== null, 'front matter');
  const lines = fm[1]!.split('\n');
  assert.ok(lines.includes('disable-model-invocation: true'));
  assert.ok(lines.includes('allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js":*)'));
  assert.ok(md.includes('\n!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" $ARGUMENTS 2>&1`\n'));
  assert.equal(SLASH_COMMAND, `/${json('plugin/.claude-plugin/plugin.json').name as string}:cowork`);
});
