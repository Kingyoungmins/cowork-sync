// Plan 5 Task 2: the plugin package files (06 §3.2, §3.3; glossary §13 as superseded by §25 F5; 10 §3.3, UX-05; CCI-02, CCI-05).
// The plugin root is plugin/ (ruling P5-EB-3: .claude-plugin/marketplace.json installs plugin/ from the release tag); the command file keeps
// main's allowed-tools line and the ` 2>&1` suffix of its `!` line (ruling P5-EB-4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_REGISTRATIONS, type WireJson } from '../../src/claude/wire/frames.js';
import { canonicalJsonLine } from '../../src/claude/wire/ndjson.js';
import { PLUGIN_VERSION } from '../../src/version.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const at = (rel: string): string => join(repo, ...rel.split('/'));
const bytes = (rel: string): Buffer => readFileSync(at(rel));
const PLUGIN_ROOT_VAR = '${CLAUDE_PLUGIN_ROOT}';

/** UTF-8 (round-trips), no BOM, LF only (CCI-05, R1-151). */
function assertUtf8Lf(rel: string): string {
  const b = bytes(rel);
  assert.ok(!(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf), `${rel} starts with a BOM`);
  const text = b.toString('utf8');
  assert.ok(Buffer.from(text, 'utf8').equals(b), `${rel} is not valid UTF-8`);
  assert.ok(!text.includes('\r'), `${rel} holds a CR`);
  return text;
}

/** The glossary §13 document, one group per HOOK_REGISTRATIONS row in row order, no matcher key for a null matcher. */
function expectedHooks(): WireJson {
  const hooks: Record<string, WireJson[]> = {};
  for (const r of HOOK_REGISTRATIONS) {
    const handler: WireJson = { type: 'command', command: 'node', args: [`${PLUGIN_ROOT_VAR}/dist/hook.js`, r.event], timeout: r.timeout };
    const group: WireJson = r.matcher === null ? { hooks: [handler] } : { matcher: r.matcher, hooks: [handler] };
    (hooks[r.event] ??= []).push(group);
  }
  return { hooks };
}

test('hooks.json equals glossary §13 with the §25 F5 all-verb UserPromptExpansion matcher byte for byte after JSON normalization; every handler exec-form node …/dist/hook.js <Event> with timeout 10 (SessionEnd 2)', () => {
  const text = assertUtf8Lf('plugin/hooks/hooks.json');
  const doc = JSON.parse(text) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>> };
  assert.equal(canonicalJsonLine(doc as unknown as WireJson), canonicalJsonLine(expectedHooks()));
  // The rows themselves, independently of HOOK_REGISTRATIONS: §25 F5's matcher, three PreToolUse groups, exec form and the timeouts.
  assert.deepEqual(doc.hooks.UserPromptExpansion?.map((g) => g.matcher), ['cowork|cowork-sync:cowork']);
  assert.deepEqual(doc.hooks.PreToolUse?.map((g) => g.matcher), ['^(Edit|Write|MultiEdit|NotebookEdit)$', '^(Bash|PowerShell|Monitor)$', '^(Agent|EnterWorktree)$']);
  for (const [event, groups] of Object.entries(doc.hooks)) {
    for (const g of groups) {
      assert.equal(g.hooks.length, 1, event);
      const h = g.hooks[0] as Record<string, unknown>;
      assert.equal(h.type, 'command', event);
      assert.equal(h.command, 'node', event);
      assert.deepEqual(h.args, [`${PLUGIN_ROOT_VAR}/dist/hook.js`, event]);
      assert.equal(h.timeout, event === 'SessionEnd' ? 2 : 10, event);
    }
  }
  assert.deepEqual(readdirSync(at('plugin/hooks')), ['hooks.json']);
});

test('plugin.json and .mcp.json are the 06 §3.2 documents', () => {
  const manifest = JSON.parse(assertUtf8Lf('plugin/.claude-plugin/plugin.json')) as Record<string, unknown>;
  assert.equal(manifest.name, 'cowork-sync');
  // Plan 7 Task 19's "from then on" branch (X-71): main's v0.1.0-preview manifest already carries version and description.
  assert.equal(manifest.version, PLUGIN_VERSION);
  assert.equal(typeof manifest.description, 'string');
  const d = manifest.description as string;
  assert.ok(d.length > 0 && d.length <= 200, `description is ${d.length} chars`);
  // Fix r1 minor: no component key in the manifest, so hooks, MCP servers, commands, agents and skills come only from the files these tests
  // and L-HOOKS-JSON / L-HUMAN-ONLY pin (an inline "hooks" or "mcpServers" would bypass them).
  for (const k of ['hooks', 'mcpServers', 'commands', 'agents', 'skills', 'outputStyles', 'lspServers']) {
    assert.equal(Object.hasOwn(manifest, k), false, `plugin.json declares "${k}"`);
  }
  const mcp =JSON.parse(assertUtf8Lf('plugin/.mcp.json')) as WireJson;
  assert.equal(canonicalJsonLine(mcp), canonicalJsonLine({ mcpServers: { cowork: { command: 'node', args: [`${PLUGIN_ROOT_VAR}/dist/mcp.js`] } } }));
});

/** 10 §3.3's command-file block: the fenced text after "has this body after its frontmatter:", with its final LF. */
function specCommandBlock(): string {
  const spec = readFileSync(at('docs/spec/10-product.md'), 'utf8');
  const head = spec.indexOf('### 3.3 Output modes and the command file');
  assert.ok(head >= 0, '10 §3.3 heading');
  const intro = spec.indexOf('has this body after its frontmatter:', head);
  assert.ok(intro >= 0, '10 §3.3 command-file sentence');
  const open = spec.indexOf('```\n', intro);
  const close = spec.indexOf('\n```', open + 4);
  assert.ok(open >= 0 && close > open, '10 §3.3 fenced block');
  return spec.slice(open + 4, close + 1);
}

test('commands/cowork.md has one ! line running node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" $ARGUMENTS followed by 10 §3.3\'s block verbatim', () => {
  const md = assertUtf8Lf('plugin/commands/cowork.md');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(md);
  assert.ok(fm !== null, 'front matter');
  const lines = (fm[1] as string).split('\n');
  const keys = lines.map((l) => l.slice(0, l.indexOf(':')));
  assert.deepEqual([...keys].sort(), ['allowed-tools', 'argument-hint', 'description', 'disable-model-invocation']);
  const value = (k: string): string => {
    const l = lines.find((x) => x.startsWith(`${k}:`)) as string;
    return l.slice(k.length + 1).trim();
  };
  assert.ok(value('description').length > 0, 'description');
  assert.equal(value('argument-hint'), '"<verb> [args]"');
  assert.equal(value('disable-model-invocation'), 'true');
  assert.equal(value('allowed-tools'), `Bash(node "${PLUGIN_ROOT_VAR}/dist/cli.js":*)`);

  // The body: one blank line, then 10 §3.3's block with ` 2>&1` before the `!` line's closing backtick (P5-EB-4).
  const block = specCommandBlock();
  const [bang, ...rest] = block.split('\n');
  assert.equal(bang, `!\`node "${PLUGIN_ROOT_VAR}/dist/cli.js" $ARGUMENTS\``, 'the spec block starts with the ! line');
  const expectedBody = [`${(bang as string).slice(0, -1)} 2>&1\``, ...rest].join('\n');
  assert.equal(md.slice(fm[0].length), `\n${expectedBody}`);
  assert.ok(expectedBody.endsWith('the user types those.\n'));
  // $ARGUMENTS unquoted (X-60, X-71): view and its flags, and every multi-argument verb, reach cli.js as separate words.
  const bangLines = md.split('\n').filter((l) => l.startsWith('!'));
  assert.deepEqual(bangLines, [`!\`node "${PLUGIN_ROOT_VAR}/dist/cli.js" $ARGUMENTS 2>&1\``]);
  assert.ok(!md.includes('"$ARGUMENTS"'));
  assert.deepEqual(readdirSync(at('plugin/commands')), ['cowork.md']);
});

/** Every file under a directory, recursively (none when it does not exist); links are not followed (fix r1). */
function filesUnder(rel: string): string[] {
  if (!existsSync(at(rel))) return [];
  const out: string[] = [];
  for (const e of readdirSync(at(rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...filesUnder(child));
    else if (e.isFile()) out.push(child);
  }
  return out;
}

test('the plugin root ships no skills/, no npx, no dependency list and no publish script', () => {
  assert.equal(existsSync(at('plugin/skills')), false, 'plugin/skills/');
  assert.equal(existsSync(at('skills')), false, 'skills/');
  const scanned = [
    ...filesUnder('plugin'),
    ...filesUnder('.claude-plugin'),
    ...readdirSync(repo).filter((n) => n.startsWith('README')).sort(),
  ];
  for (const must of ['plugin/hooks/hooks.json', 'plugin/commands/cowork.md', 'plugin/.claude-plugin/plugin.json', 'plugin/.mcp.json', '.claude-plugin/marketplace.json', 'README.md']) {
    assert.ok(scanned.includes(must), must);
  }
  for (const rel of scanned) assert.doesNotMatch(readFileSync(at(rel), 'utf8'), /\bnpx\b/, rel);

  const pkg = JSON.parse(readFileSync(at('package.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.private, true);
  for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies', 'postinstall', 'prepare']) {
    assert.equal(pkg[k], undefined, k);
  }
  assert.equal(typeof pkg.license, 'string');
  const scripts = pkg.scripts as Record<string, string>;
  assert.equal(typeof scripts, 'object');
  for (const k of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack']) {
    assert.equal(scripts[k], undefined, `scripts.${k}`);
  }
  for (const [name, body] of Object.entries(scripts)) {
    for (const bad of ['publish', 'npm pack', 'gh release']) {
      assert.ok(!name.includes(bad) && !body.includes(bad), `script ${name}: ${body}`);
    }
  }
});
