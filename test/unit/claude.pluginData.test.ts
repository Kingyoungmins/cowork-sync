// Plan 5 Task 1: the one plugin-data-directory rule (R5-47, R5-56, X-61, A1-12; P5-PF-3, P5-PF-4), user.json (R5-12, A1-10, X-52) and the
// loader's Claude-facing language (glossary §17 loader precedence, X-53).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fc from 'fast-check';
import { claudeConfigDir, pluginDataDir, pluginIdOf, resolveDataDir } from '../../src/data/pluginDataDir.js';
import * as vizDataDir from '../../src/viz/cli/dataDir.js';
import { readUserJson } from '../../src/claude/wire/pluginData.js';
import { loaderLang } from '../../src/claude/text/claudeText.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const POSIX_ROOT = '/home/me/.claude/plugins/cache/test-market/cowork-sync/0.6.0';
const WIN_ROOT = 'C:\\Users\\Me\\.claude\\plugins\\cache\\test.market\\cowork-sync\\0.6.0';
const DEFAULTS = { language: null, wakeTurnEdits: 'allow', wakeEnabled: true, wakeMaxPerSeatPerHour: 4, notificationsOs: true, sinceRecap: true,
  sinceClaudePointer: true, envPassthrough: [] };

test('resolveDataDir: the variable when set and absolute, else the derived plugin id directory, never another location', () => {
  assert.equal(resolveDataDir({ CLAUDE_PLUGIN_DATA: '/d' }, '/home/me', 'linux'), '/d');
  assert.equal(resolveDataDir({ CLAUDE_PLUGIN_DATA: '/d', CLAUDE_PLUGIN_ROOT: '/not/a/plugin' }, '/home/me', 'linux'), '/d', 'the variable needs no plugin id');
  assert.equal(resolveDataDir({ CLAUDE_PLUGIN_ROOT: POSIX_ROOT }, '/home/me', 'linux'), '/home/me/.claude/plugins/data/cowork-sync-test-market');
  assert.equal(resolveDataDir({}, '/home/me', 'linux', POSIX_ROOT), '/home/me/.claude/plugins/data/cowork-sync-test-market', 'the fourth argument');
  assert.equal(resolveDataDir({ CLAUDE_PLUGIN_ROOT: WIN_ROOT }, 'C:\\Users\\Me', 'win32'), 'C:\\Users\\Me\\.claude\\plugins\\data\\cowork-sync-test-market');
  assert.equal(resolveDataDir({ claude_plugin_root: WIN_ROOT }, 'C:\\Users\\Me', 'win32'), 'C:\\Users\\Me\\.claude\\plugins\\data\\cowork-sync-test-market', 'any case on win32');
  assert.equal(resolveDataDir({ CLAUDE_PLUGIN_ROOT: POSIX_ROOT, CLAUDE_CONFIG_DIR: '/cfg' }, '/home/me', 'linux'), '/cfg/plugins/data/cowork-sync-test-market');
  assert.equal(resolveDataDir({ CLAUDE_PLUGIN_ROOT: POSIX_ROOT, CLAUDE_CONFIG_DIR: 'cfg' }, '/home/me', 'linux'), '/home/me/.claude/plugins/data/cowork-sync-test-market');
  // P5-PF-3: a set, non-empty, relative CLAUDE_PLUGIN_DATA fails closed (8a's landed answer); an empty value counts as unset.
  assert.equal(resolveDataDir({ CLAUDE_PLUGIN_DATA: 'd', CLAUDE_PLUGIN_ROOT: POSIX_ROOT }, '/home/me', 'linux'), null);
  assert.equal(resolveDataDir({ CLAUDE_PLUGIN_DATA: '', CLAUDE_PLUGIN_ROOT: POSIX_ROOT }, '/home/me', 'linux'), '/home/me/.claude/plugins/data/cowork-sync-test-market');
  // A plugin root of any other shape: null (fail closed, SEC-20); the argument wins over the variable; an empty variable is unset.
  for (const root of ['/opt/cowork-sync', '/x/plugins/cache/m/p', '/x/plugins/cache/m/p/v/dist', '/x/plugin/cache/m/p/v', '/x/plugins/cached/m/p/v', 'plugins/cache/m/p/v',
    '/x/plugins/cache/../p/v', '/x/plugins/cache/m/./v', '']) {
    assert.equal(resolveDataDir({ CLAUDE_PLUGIN_ROOT: root }, '/home/me', 'linux'), root === '' ? resolveDataDir({}, '/home/me', 'linux') : null, root);
    assert.equal(resolveDataDir({ CLAUDE_PLUGIN_ROOT: POSIX_ROOT }, '/home/me', 'linux', root), null, `argument ${root}`);
    assert.throws(() => pluginDataDir({ CLAUDE_PLUGIN_ROOT: POSIX_ROOT }, '/home/me', 'linux', root), Error, `argument ${root}`);
  }
  // With neither, the running bundle's dist/.. is the plugin root: here src/, which is not a plugin cache folder.
  assert.equal(resolveDataDir({}, '/home/me', 'linux'), null);
  assert.throws(() => pluginDataDir({}, '/home/me', 'linux'), Error);
  // pluginDataDir is resolveDataDir's derived answer whenever CLAUDE_PLUGIN_DATA is unset and the root has the cache shape.
  const name = fc.stringMatching(/^[A-Za-z0-9._@+ -]{1,12}$/).filter((s) => s !== '.' && s !== '..' && s.trim() === s && s !== '');
  fc.assert(fc.property(name, name, name, fc.constantFrom<NodeJS.Platform>('linux', 'darwin', 'win32'), fc.boolean(), (market, plugin, version, platform, cfg) => {
    const sep = platform === 'win32' ? '\\' : '/';
    const home = platform === 'win32' ? 'C:\\Users\\me' : '/home/me';
    const root = [platform === 'win32' ? 'D:' : '', 'cache dir', 'plugins', 'cache', market, plugin, version].join(sep);
    const env = cfg ? { CLAUDE_CONFIG_DIR: platform === 'win32' ? 'E:\\cfg' : '/cfg' } : {};
    const id = pluginIdOf(root);
    assert.equal(id, `${plugin}-${market}`.replace(/[^A-Za-z0-9_-]/g, '-'));
    assert.equal(resolveDataDir(env, home, platform, root), pluginDataDir(env, home, platform, root));
    assert.ok(pluginDataDir(env, home, platform, root).endsWith(`${sep}plugins${sep}data${sep}${id}`));
  }), { numRuns: 200 });
  // One module (X-61): the viewer CLI re-exports the same function objects; it imports only node:*.
  assert.equal(vizDataDir.pluginDataDir, pluginDataDir);
  assert.equal(vizDataDir.resolveDataDir, resolveDataDir);
  const source = readFileSync(join(ROOT, 'src', 'data', 'pluginDataDir.ts'), 'utf8');
  const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'|\bimport\s*\(\s*'([^']+)'\s*\)|^\s*import\s+'([^']+)'/gm)].map((m) => m[1] ?? m[2] ?? m[3]);
  assert.ok(specifiers.length > 0);
  for (const s of specifiers) assert.match(s!, /^node:/, s);
});

test('claudeConfigDir: CLAUDE_CONFIG_DIR when set and absolute, else <home>/.claude; the derived data directory sits under it (R5-56, P5-T4-3)', () => {
  assert.equal(claudeConfigDir({}, '/home/me', 'linux'), '/home/me/.claude');
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/etc/claude conf' }, '/home/me', 'darwin'), '/etc/claude conf');
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: 'D:\\conf' }, 'C:\\Users\\me', 'win32'), 'D:\\conf');
  assert.equal(claudeConfigDir({ Claude_Config_Dir: 'D:\\conf' }, 'C:\\Users\\me', 'win32'), 'D:\\conf', 'any case on win32');
  assert.equal(claudeConfigDir({}, 'C:\\Users\\me', 'win32'), 'C:\\Users\\me\\.claude');
  for (const v of ['', 'relative/conf', './conf', '~/conf', '//server/share/conf', '/dev/conf']) {
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: v }, '/home/me', 'linux'), '/home/me/.claude', `ignored: ${JSON.stringify(v)}`);
  }
  for (const v of ['C:conf', '\\rooted\\conf', '\\\\server\\share\\conf', '/posix/conf']) {
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: v }, 'C:\\Users\\me', 'win32'), 'C:\\Users\\me\\.claude', `ignored on win32: ${JSON.stringify(v)}`);
  }
  for (const env of [{}, { CLAUDE_CONFIG_DIR: '/cfg' }, { CLAUDE_CONFIG_DIR: 'cfg' }]) {
    assert.equal(pluginDataDir(env, '/home/me', 'linux', POSIX_ROOT), `${claudeConfigDir(env, '/home/me', 'linux')}/plugins/data/cowork-sync-test-market`, JSON.stringify(env));
  }
});

test('pluginIdOf: <plugin>-<marketplace> of a plugin cache folder, either separator', () => {
  assert.equal(pluginIdOf(POSIX_ROOT), 'cowork-sync-test-market');
  assert.equal(pluginIdOf(WIN_ROOT), 'cowork-sync-test-market');
  assert.equal(pluginIdOf('C:/Users/Me/.claude/plugins/cache/test.market/cowork-sync/0.6.0/'), 'cowork-sync-test-market', 'a trailing separator');
  assert.equal(pluginIdOf('/x/plugins/cache/my market@2/cowork_sync+x/1'), 'cowork_sync-x-my-market-2');
  assert.equal(pluginIdOf('/x/plugins/cache/m\u{E9}/p/1'), 'p-m-', 'one - per code point');
  for (const bad of ['', '/', '/x/plugins/cache/m/p', 'cache/m/p/v', 'plugins/cache/m/p/v', 'x\\plugins\\cache\\m\\p\\v', '/x/Plugins/cache/m/p/v', '/x/plugins/CACHE/m/p/v']) assert.equal(pluginIdOf(bad), null, bad);
});

test('readUserJson: missing, bad JSON and mistyped keys give the defaults', () => {
  assert.deepEqual(readUserJson(null), DEFAULTS);
  assert.deepEqual(readUserJson('{bad'), DEFAULTS);
  assert.deepEqual(readUserJson('[1]'), DEFAULTS);
  assert.deepEqual(readUserJson('null'), DEFAULTS);
  assert.deepEqual(readUserJson('{"language":"ko","wake":{"turnEdits":"deny"},"since":{"recap":false,"claudePointer":false},"env":{"passthrough":["HTTPS_PROXY","bad name"]}}'),
    { ...DEFAULTS, language: 'ko', wakeTurnEdits: 'deny', sinceRecap: false, sinceClaudePointer: false, envPassthrough: ['HTTPS_PROXY'] });
  assert.deepEqual(readUserJson('{"since.recap": false}'), { ...DEFAULTS, sinceRecap: false });
  assert.deepEqual(readUserJson('{"wake.turnEdits": "deny", "env.passthrough": ["A_1", "_b", "1x", 5]}'), { ...DEFAULTS, wakeTurnEdits: 'deny', envPassthrough: ['A_1', '_b'] });
  assert.deepEqual(readUserJson('{"language": 5, "wake": {"turnEdits": "maybe"}, "since": {"recap": "no"}}'), DEFAULTS);
  // Nested wins over dotted when both are given.
  assert.deepEqual(readUserJson('{"since": {"recap": true}, "since.recap": false}'), DEFAULTS);
  assert.deepEqual(readUserJson('{"wake": {"turnEdits": "deny"}, "wake.turnEdits": "allow"}'), { ...DEFAULTS, wakeTurnEdits: 'deny' });
  // A BOM, and a prototype key, change nothing else.
  assert.deepEqual(readUserJson('\u{FEFF}{"language":"en"}'), { ...DEFAULTS, language: 'en' });
  assert.deepEqual(readUserJson('{"__proto__": {"language": "ko"}, "wake": {"__proto__": {"turnEdits": "deny"}}}'), DEFAULTS);
  assert.ok(Object.isFrozen(readUserJson(null).envPassthrough));
});

test('loaderLang follows user.json, then the OS locale', () => {
  assert.equal(loaderLang('ko', null), 'ko');
  assert.equal(loaderLang(null, 'ko-KR'), 'ko');
  assert.equal(loaderLang(null, 'ko_KR.UTF-8'), 'ko');
  assert.equal(loaderLang('fr', 'ko-KR'), 'en');
  assert.equal(loaderLang(null, 'de-DE'), 'en');
  assert.equal(loaderLang(null, null), 'en');
  assert.equal(loaderLang('en', 'ko-KR'), 'en');
  assert.equal(loaderLang(null, 'KO'), 'ko');
  assert.equal(loaderLang(null, 'kok-IN'), 'en', 'Konkani is not Korean');
});
