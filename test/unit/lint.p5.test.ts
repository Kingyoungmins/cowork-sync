// Plan 5 Task 2: the Plan 5 lints (06 §3.2 build lints, CCI-03; 11 §3.10 L-HOOKS-JSON, L-PERMISSION, L-HUMAN-ONLY, L-MCP-SCHEMA, L-TOKEN,
// L-PORTS, L-NET; R5-03 L-LOADER, L-HOOK-THIN, L-SPAWN; M26 lint half). Fixtures live under test/fixtures/lint/p5/ (source fixtures end in .txt,
// so the typecheck never reads them); the token's name is never spelled here: every token fixture is composed from TOKEN_ENV (09 test 22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { TOKEN_ENV } from '../../src/claude/client/mcp/doorbell.js';
import { C } from '../../src/claude/wire/constants.js';
import {
  lintCommandFile, lintDistLoader, lintDistPermission, lintHooksJson, lintHookThin, lintMcpSchema, MCP_DESCRIPTION_SENTENCE, walkHookThin,
} from '../../tools/lint/p5rules.js';
import { lintSource, lintTestSource, lintToolSource } from '../../tools/lint/rules.js';
import { makeTempRoot } from '../helpers/tmp.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const at = (rel: string): string => join(REPO, ...rel.split('/'));
const fixture = (name: string): string => readFileSync(at(`test/fixtures/lint/p5/${name}`), 'utf8');
const rules = (file: string, text: string): string[] => lintSource(file, text).map((f) => f.rule).sort();
const only = (findings: ReadonlyArray<{ rule: string }>, rule: string, label: string): void =>
  assert.deepEqual(findings.map((f) => f.rule), [rule], `${label}: ${JSON.stringify(findings)}`);

/** A reader over an in-memory source tree (absent files are absent from the walk). */
const reader = (files: Readonly<Record<string, string>>) => (rel: string): string | null => files[rel] ?? null;

test('each CCI-03 fixture fails the build', () => {
  // (1)–(4) hooks.json: shell form, the four other handler types, a WorktreeCreate key, the timeouts.
  for (const name of ['hooks.shell-form.json', 'hooks.type-mcp_tool.json', 'hooks.type-http.json', 'hooks.type-prompt.json', 'hooks.type-agent.json',
    'hooks.worktree-create.json', 'hooks.pretooluse-timeout-11.json', 'hooks.sessionend-timeout-10.json']) {
    only(lintHooksJson('plugin/hooks/hooks.json', fixture(name)), 'L-HOOKS-JSON', name);
  }
  assert.deepEqual(lintHooksJson('plugin/hooks/hooks.json', readFileSync(at('plugin/hooks/hooks.json'), 'utf8')), [], 'the real hooks.json');

  // (5) permissionDecision in src/claude/client/output.ts (any value, also "defer") and in a dist/x.js text.
  only(lintSource('src/claude/client/output.ts', fixture('permission.output.ts.txt')), 'L-PERMISSION', 'output.ts defer');
  for (const v of ['deny', 'allow', 'ask', 'defer']) {
    assert.deepEqual(rules('src/claude/client/output.ts', `const out = { hookSpecificOutput: { permissionDecision: '${v}' } };`), ['L-PERMISSION'], v);
  }
  only(lintDistPermission(new Map([['dist/x.js', fixture('permission.dist.js.txt')]])), 'L-PERMISSION', 'dist/x.js');
  assert.deepEqual(lintDistPermission(new Map([['dist/x.js', 'export const decision = "block";\n']])), []);

  // (6) a command file without disable-model-invocation: true, or with false; (7) npx and git push in a command body.
  for (const name of ['command.no-dmi.md', 'command.dmi-false.md', 'command.npx.md', 'command.git-push.md']) {
    only(lintCommandFile(`plugin/commands/${name}`, fixture(name)), 'L-HUMAN-ONLY', name);
  }
  assert.deepEqual(lintCommandFile('plugin/commands/cowork.md', readFileSync(at('plugin/commands/cowork.md'), 'utf8')), [], 'the real command file');

  // (8) the dist half of L-LOADER: 151 lines, loads other than node:* and import("./core.js").
  const lines = (n: number): string => '// x\n'.repeat(n);
  only(lintDistLoader(lines(C.LOADER_MAX_LINES + 1)), 'L-LOADER', '151 lines');
  assert.deepEqual(lintDistLoader(lines(C.LOADER_MAX_LINES)), [], '150 lines');
  for (const name of ['loader.dist.import-x.js.txt', 'loader.dist.require-x.js.txt', 'loader.dist.esbuild.js.txt']) only(lintDistLoader(fixture(name)), 'L-LOADER', name);
  assert.deepEqual(lintDistLoader(fixture('loader.dist.ok.js.txt')), [], 'node:fs and import("./core.js")');

  // (9) the token's name as a literal, an identifier key or a template part, outside the doorbell (composed from TOKEN_ENV).
  const tokenForms = [
    `const t = process.env.${TOKEN_ENV};`,
    `const t = process.env['${TOKEN_ENV}'];`,
    `const { ${TOKEN_ENV}: tok } = process.env;`,
    `const env = { ${TOKEN_ENV}: 'x' };`,
    'const k = `${prefix}' + TOKEN_ENV + '`;',
  ];
  for (const file of ['src/entry/core.ts', 'src/claude/daemon/x.ts', 'src/entry/hook.ts', 'test/unit/x.test.ts', 'tools/x.ts']) {
    for (const text of tokenForms) assert.deepEqual(rules(file, text), ['L-TOKEN'], `${file}: ${text}`);
    assert.deepEqual(rules('src/claude/client/mcp/doorbell.ts', tokenForms[0] as string), []);
  }
  for (const text of tokenForms) {
    assert.deepEqual(lintTestSource('test/unit/x.test.ts', text).map((f) => f.rule), ['L-TOKEN'], `test scan: ${text}`);
    assert.deepEqual(lintToolSource('tools/x.ts', text).map((f) => f.rule), ['L-TOKEN'], `tools scan: ${text}`);
    assert.deepEqual(rules('src/claude/client/mcp/doorbell.ts', text), [], `doorbell: ${text}`);
  }
  assert.deepEqual(rules('src/entry/hook.ts', 'const s = process.env.CLAUDE_CODE_MESSAGING_SOCKET;'), []);

  // (10) the inbox poster loaded outside the MCP tier.
  only(lintSource('src/claude/daemon/ring.ts', fixture('inbox.ring.ts.txt')), 'L-TOKEN', 'ring.ts');
  assert.deepEqual(rules('src/claude/client/mcp/doorbell.ts', `import { realInbox } from '../../../ports/inbox.js';\nexport const p = realInbox;`), []);
  assert.deepEqual(rules('src/entry/mcp.ts', `import { realInbox } from '../ports/inbox.js';\nexport const p = realInbox;`), []);

  // (11) child_process outside the allow-list (OQ-14 (r2)).
  only(lintSource('src/claude/daemon/x.ts', fixture('ports.child-process.ts.txt')), 'L-PORTS', 'daemon x.ts');
  for (const f of ['src/claude/client/spawn.ts', 'src/sec/winAcl.ts']) assert.deepEqual(rules(f, fixture('ports.child-process.ts.txt')), [], f);

  // (12) L-SPAWN: a daemon.js path passed to a call outside spawn.ts; spawnDaemon in the MCP server; child_process in the MCP tier.
  for (const name of ['spawn.dist-daemon-js.ts.txt', 'spawn.daemon-js.ts.txt']) {
    only(lintSource('src/claude/daemon/x.ts', fixture(name)), 'L-SPAWN', name);
    assert.deepEqual(rules('src/claude/client/spawn.ts', fixture(name)), [], `${name} in spawn.ts`);
  }
  only(lintSource('src/claude/client/mcp/server.ts', fixture('spawn.mcp-import.ts.txt')), 'L-SPAWN', 'server.ts imports spawnDaemon');
  assert.deepEqual(rules('src/claude/client/mcp/server.ts', fixture('ports.child-process.ts.txt')), ['L-PORTS', 'L-SPAWN']);
  assert.deepEqual(rules('src/claude/client/mcp/tools.ts', `const cp = await import('node:child_process');`), ['L-PORTS', 'L-SPAWN']);
  // Rendered text naming the daemon is not a spawn: usage lines and advice templates (src/daemon/run.ts's shape).
  assert.deepEqual(rules('src/daemon/x.ts', "const USAGE = ['usage: node dist/daemon.js run --repo <path>'].join('\\n');\nconst f = (c: string) => `node dist/daemon.js ${c} --repo x`;\nsay(f('recover'));"), []);

  // (13) L-HOOK-THIN: the client tier reaches none of the engine-side directories, directly or through another client file.
  const viaHookCore = (spec: string, kind = 'import { x }'): Record<string, string> => ({
    'src/entry/core.ts': "import { main } from '../claude/client/hookCore.js';\nvoid main;\n",
    'src/claude/client/hookCore.ts': `${kind} from '${spec}';\n`,
  });
  const forbidden: Array<[string, string]> = [
    ['../../engine/core.js', 'src/engine/core.ts'], ['../../holds/x.js', 'src/holds/x.ts'], ['../../board/x.js', 'src/board/x.ts'],
    ['../../data/x.js', 'src/data/x.ts'], ['../../git/x.js', 'src/git/x.ts'], ['../../regions/x.js', 'src/regions/x.ts'], ['../daemon/x.js', 'src/claude/daemon/x.ts'],
  ];
  for (const [spec, target] of forbidden) {
    const f = lintHookThin(reader(viaHookCore(spec)));
    only(f, 'L-HOOK-THIN', spec);
    assert.ok((f[0] as { message: string }).message.includes(`src/entry/core.ts → src/claude/client/hookCore.ts → ${target}`), (f[0] as { message: string }).message);
  }
  const typeOnly = lintHookThin(reader(viaHookCore('../../engine/status.js', 'import type { StatusJson }')));
  only(typeOnly, 'L-HOOK-THIN', 'type-only import');
  const through = lintHookThin(reader({
    ...viaHookCore('./output.js'),
    'src/claude/client/output.ts': "import type { StatusJson } from '../../engine/status.js';\nexport type S = StatusJson;\n",
  }));
  only(through, 'L-HOOK-THIN', 'through output.ts');
  assert.ok((through[0] as { message: string }).message.includes('src/entry/core.ts → src/claude/client/hookCore.ts → src/claude/client/output.ts → src/engine/status.ts'));
  const mcp = lintHookThin(reader({
    'src/entry/mcp.ts': "import { runMcpServer } from '../claude/client/mcp/server.js';\nvoid runMcpServer;\n",
    'src/claude/client/mcp/server.ts': "export * from '../../../holds/registry.js';\n",
  }));
  only(mcp, 'L-HOOK-THIN', 'mcp root');
  for (const spec of ['../../sec/handshake.js', '../../sec/sddl.js', '../../ports/ipc.js', '../wire/frames.js', '../../data/pluginDataDir.js', '../../data/canonRoot.js', '../../git/env.js']) {
    assert.deepEqual(lintHookThin(reader(viaHookCore(spec))), [], spec);
  }

  // (14) the source half of L-LOADER: src/entry/hook.ts loads only node:* and ./core.js through import().
  for (const name of ['loader.src.fs-bare.ts.txt', 'loader.src.core-static.ts.txt', 'loader.src.canonroot.ts.txt']) {
    only(lintSource('src/entry/hook.ts', fixture(name)), 'L-LOADER', name);
  }
  assert.deepEqual(rules('src/entry/hook.ts', fixture('loader.src.ok.ts.txt')), []);
  assert.deepEqual(rules('src/entry/core.ts', fixture('loader.src.core-static.ts.txt')), [], 'only the loader is held to node:*');

  // (15) Plan 1's L-GIT-SPAWN still fires inside an L-PORTS-allowed file.
  only(lintSource('src/sec/winAcl.ts', fixture('winacl.git.ts.txt')), 'L-GIT-SPAWN', 'winAcl.ts');
});

test('L-HUMAN-ONLY: no MCP tool outside glossary §15 and no v2 verb in ACTING_VERBS', () => {
  only(lintSource('src/claude/client/mcp/tools.ts', fixture('human-only.tools.ts.txt')), 'L-HUMAN-ONLY', 'cowork_override');
  const eight = fixture('human-only.tools.ts.txt').replace(", 'cowork_override'", '');
  assert.deepEqual(rules('src/claude/client/mcp/tools.ts', eight), [], 'the eight tools of glossary §15');
  for (const v of ['undo', 'adopt', 'override']) only(lintSource('src/claude/wire/frames.ts', fixture(`human-only.frames-${v}.ts.txt`)), 'L-HUMAN-ONLY', v);
  for (const v of ['end', 'gc', 'eol', 'protocol', 'blame', 'where', 'holds']) {
    assert.deepEqual(rules('src/claude/wire/frames.ts', `export const ACTING_VERBS = ['start', '${v}'];`), ['L-HUMAN-ONLY'], v);
  }
  assert.deepEqual(lintSource('src/claude/wire/frames.ts', readFileSync(at('src/claude/wire/frames.ts'), 'utf8')), [], 'the real frames.ts');
});

/** A tool schema whose serialized {name, description, inputSchema} is exactly `chars` long (description padded). */
function toolOf(name: string, chars: number, sentence = true): { name: string; description: string; inputSchema: unknown } {
  const inputSchema = { type: 'object', properties: {} };
  const base = sentence ? `Tool ${name}: ${MCP_DESCRIPTION_SENTENCE}` : `Tool ${name}.`;
  const size = (d: string): number => JSON.stringify({ name, description: d, inputSchema }).length;
  const pad = chars - size(base);
  assert.ok(pad >= 0, `${name} needs ${size(base)} chars at least`);
  const description = base + ' '.repeat(pad);
  assert.equal(size(description), chars);
  return { name, description, inputSchema };
}
const EIGHT = ['cowork_status', 'cowork_show', 'cowork_request', 'cowork_respond', 'cowork_note', 'cowork_release', 'cowork_checkpoint', 'cowork_resolve'];

test('L-MCP-SCHEMA counts the F05 reserve and the description sentence', () => {
  const live = (total: number): Array<{ name: string; description: string; inputSchema: unknown }> =>
    EIGHT.map((n, i) => toolOf(n, Math.floor(total / 8) + (i < total % 8 ? 1 : 0)));
  assert.equal(C.CAPS.SCHEMA_LIVE - C.CAPS.F05_CLAUSE_RESERVE, 2_920);
  assert.deepEqual(lintMcpSchema(live(2_920), 'live'), []);
  only(lintMcpSchema(live(2_921), 'live'), 'L-MCP-SCHEMA', '2,921 + 80 > 3,000');
  for (const mode of ['nonlive', 'too_old'] as const) {
    only(lintMcpSchema([toolOf('cowork_status', 401)], mode), 'L-MCP-SCHEMA', `${mode} 401`);
    assert.deepEqual(lintMcpSchema([toolOf('cowork_status', 400)], mode), [], `${mode} 400`);
    only(lintMcpSchema([toolOf('cowork_status', 200), toolOf('cowork_show', 200)], mode), 'L-MCP-SCHEMA', `${mode} two tools`);
  }
  const noSentence = live(2_000);
  noSentence[3] = toolOf('cowork_respond', 250, false);
  only(lintMcpSchema(noSentence, 'live'), 'L-MCP-SCHEMA', 'a description without the sentence');
  only(lintMcpSchema([toolOf('cowork_status', 300, false)], 'nonlive'), 'L-MCP-SCHEMA', 'nonlive description without the sentence');
});

test('L-PERMISSION\'s widened form still passes Plan 1\'s should-pass cases', () => {
  // Plan 1's rows that flagged "allow"/"ask" still flag (in src/** and outside it).
  for (const file of ['src/daemon/example.ts', 'test/fixtures/lint/p5/permission.ts', 'tools/x.ts']) {
    assert.deepEqual(rules(file, `const out = { hookSpecificOutput: { permissionDecision: 'allow' } };`), ['L-PERMISSION'], file);
    assert.deepEqual(rules(file, `const out = { permissionDecision: denied ? 'deny' : 'ask' };`), ['L-PERMISSION'], file);
    assert.deepEqual(rules(file, `o.permissionDecision = "allow";`), ['L-PERMISSION'], file);
    assert.deepEqual(rules(file, `interface Out { permissionDecision: 'deny' | 'ask'; }`), ['L-PERMISSION'], file);
  }
  // Plan 1's should-pass rows hold outside src/: the widened rule scans src/** code and string tokens (and dist/), never comments.
  const outside = 'test/fixtures/lint/p5/permission.ts';
  assert.deepEqual(rules(outside, `const out = { hookSpecificOutput: { permissionDecision: 'deny' } };`), []);
  assert.deepEqual(rules(outside, `interface Out { permissionDecision: 'deny'; }\nconst mode = 'allow';`), []);
  // In src/** any mention in code or a string is a finding, a comment is not.
  assert.deepEqual(rules('src/claude/client/output.ts', `const out = { hookSpecificOutput: { permissionDecision: 'deny' } };`), ['L-PERMISSION']);
  assert.deepEqual(rules('src/claude/client/output.ts', `const k = 'permissionDecision';`), ['L-PERMISSION']);
  assert.deepEqual(rules('src/claude/client/output.ts', `const v = o['permissionDecision'] ?? o.permissionDecision;`), ['L-PERMISSION', 'L-PERMISSION']);
  assert.deepEqual(rules('src/claude/client/output.ts', `// no hook output carries permissionDecision (CCI-11)\nconst mode = 'allow';`), []);
});

/** Every file under a repository directory, recursively (forward-slash paths); links are not followed, node_modules is skipped (fix r1). */
function filesUnder(rel: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(at(rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory() && e.name !== 'node_modules') out.push(...filesUnder(child));
    else if (e.isFile()) out.push(child);
  }
  return out;
}

const P5_RULES = ['L-HOOKS-JSON', 'L-PERMISSION', 'L-HUMAN-ONLY', 'L-TOKEN', 'L-LOADER', 'L-HOOK-THIN', 'L-SPAWN', 'L-PORTS', 'L-NET'];

test('the repository itself is clean under every Plan 5 rule', () => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', at('tools/lint/lint.ts')], { cwd: REPO, encoding: 'utf8' });
  assert.match(r.stdout, /^lint: \d+ files, \d+ findings$/m, `${r.stdout}\n${r.stderr}`);
  const hits = r.stderr.split('\n').filter((l) => P5_RULES.includes(l.split(' ')[0] as string));
  assert.deepEqual(hits, []);
  // The three files that spelled the token's name before this task: the rule's own name comes from doorbell.ts, the tests compose it.
  assert.deepEqual(lintToolSource('tools/lint/rules.ts', readFileSync(at('tools/lint/rules.ts'), 'utf8')), []);
  assert.deepEqual(lintToolSource('tools/lint/p5rules.ts', readFileSync(at('tools/lint/p5rules.ts'), 'utf8')), []);
  for (const f of ['test/unit/lint.rules.test.ts', 'test/unit/env.test.ts']) assert.deepEqual(lintTestSource(f, readFileSync(at(f), 'utf8')), [], f);
  assert.match(readFileSync(at('tools/lint/p5rules.ts'), 'utf8'), /import \{ TOKEN_ENV \} from '\.\.\/\.\.\/src\/claude\/client\/mcp\/doorbell\.js';/);
  // P5-EB-7: the name is spelled in exactly one file of src/, test/ and tools/.
  const spelled = ['src', 'test', 'tools'].flatMap(filesUnder).filter((f) => readFileSync(at(f)).includes(TOKEN_ENV));
  assert.deepEqual(spelled, ['src/claude/client/mcp/doorbell.ts']);
});

// Fix r1 (R5-03 is an allow-list): the client tier imports only src/claude/{client,wire,text}/**, src/text/**, src/i18n/**,
// src/ports/{ipc,inbox,fs,clock,random}.ts (any other src/ports file for types only), src/sec/{ipcKey,winAcl,endpoint,handshake,sddl}.ts,
// src/data/{pluginDataDir,canonRoot}.ts, src/git/env.ts, node:* — plus src/version.ts (the entries' --version leaf, a reading to ratify).
test('L-HOOK-THIN admits only R5-03\'s client-tier list: any other module reached from src/entry/{core,mcp}.ts is a finding', () => {
  const real = (rel: string): string => readFileSync(at(rel), 'utf8');
  /** In-memory files first, then the real file (so admitted real modules are walked with their real imports). */
  const overlay = (files: Readonly<Record<string, string>>) => (rel: string): string | null => {
    if (rel in files) return files[rel] as string;
    try { return real(rel); } catch { return null; }
  };
  const viaHookCore = (line: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> => ({
    'src/entry/core.ts': "import { PLUGIN_VERSION } from '../version.js';\nimport { main } from '../claude/client/hookCore.js';\nvoid main; void PLUGIN_VERSION;\n",
    'src/claude/client/hookCore.ts': `${line}\n`,
    ...extra,
  });
  const message = (f: ReadonlyArray<{ message: string }>): string => (f[0] as { message: string }).message;

  // The reviewer's probe: the preview daemon launcher — the real src/cli/launch.ts, which spawns dist/daemon.js — reached through hookCore.ts.
  const probe = walkHookThin(reader(viaHookCore("import { launchDaemon } from '../../cli/launch.js';", { 'src/cli/launch.ts': real('src/cli/launch.ts') })));
  only(probe.findings, 'L-HOOK-THIN', 'core → hookCore → cli/launch');
  assert.ok(message(probe.findings).includes('src/entry/core.ts → src/claude/client/hookCore.ts → src/cli/launch.ts'), message(probe.findings));
  assert.equal(probe.visited.has('src/cli/launch.ts'), false, 'a module off the list is reported, not walked');

  // Off the list: every other directory, the src/sec and src/ports files R5-03 does not name (value imports), other entries, packages.
  const offList: Array<[string, string]> = [
    ["import { x } from '../../cli/verbs.js';", 'src/cli/verbs.ts'],
    ["import { x } from '../../daemon/run.js';", 'src/daemon/run.ts'],
    ["import { x } from '../../since/report.js';", 'src/since/report.ts'],
    ["import { x } from '../../viz/cli/view.js';", 'src/viz/cli/view.ts'],
    ["import { x } from '../../coord/x.js';", 'src/coord/x.ts'],
    ["import { x } from '../../lifecycle/x.js';", 'src/lifecycle/x.ts'],
    ["import { x } from '../../claims/x.js';", 'src/claims/x.ts'],
    ["import { x } from '../../product/x.js';", 'src/product/x.ts'],
    ["import { x } from '../../sec/securityLog.js';", 'src/sec/securityLog.ts'],
    ["import { redact } from '../../sec/redact.js';", 'src/sec/redact.ts'],
    ["import { x } from '../../sec/validators.js';", 'src/sec/validators.ts'],
    ["import { crashpoint } from '../../ports/crashpoint.js';", 'src/ports/crashpoint.ts'],
    ["import { noTrace } from '../../ports/trace.js';", 'src/ports/trace.ts'],
    ["import { fileLog, type Log } from '../../ports/log.js';", 'src/ports/log.ts'],
    ["import { logNotifier } from '../../ports/notifier.js';", 'src/ports/notifier.ts'],
    ["import { x } from '../../ports/scheduler.js';", 'src/ports/scheduler.ts'],
    ["import '../../ports/lease.js';", 'src/ports/lease.ts'],
    ["export * from '../../daemon/x.js';", 'src/daemon/x.ts'],
    ["const m = await import('../../cli/launch.js');", 'src/cli/launch.ts'],
    ["import { x } from '../../entry/cli.js';", 'src/entry/cli.ts'],
    ["import { x } from '../../../tools/lint/rules.js';", 'tools/lint/rules.ts'],
    ["import ts from 'typescript';", 'typescript'],
    ["import { readFileSync } from 'fs';", 'fs'],
  ];
  for (const [line, target] of offList) {
    const f = lintHookThin(reader(viaHookCore(line)));
    only(f, 'L-HOOK-THIN', line);
    assert.ok(message(f).includes(`src/entry/core.ts → src/claude/client/hookCore.ts → ${target}`), `${line}: ${message(f)}`);
  }
  // The mcp root's own direct import is held to the list too.
  only(lintHookThin(reader({ 'src/entry/mcp.ts': "import { x } from '../cli/launch.js';\n" })), 'L-HOOK-THIN', 'mcp.ts → cli/launch');

  // Any other src/ports file is admitted for its types (R5-03 "src/ports (types)") — and the walk goes on through it: a type-only edge still
  // couples, so src/ports/index.ts's type import of src/git/runner.ts is a finding.
  for (const line of [
    "import type { KilledAt } from '../../ports/crashpoint.js';",
    "import type { Log } from '../../ports/log.js';",
    "import { type Trace, type TraceEvent } from '../../ports/trace.js';",
    "export type { Notifier } from '../../ports/notifier.js';",
    "export type S = typeof import('../../ports/scheduler.js');",
  ]) {
    assert.deepEqual(lintHookThin(overlay(viaHookCore(line))), [], line);
  }
  const index = lintHookThin(overlay(viaHookCore("import type { Ports } from '../../ports/index.js';")));
  only(index, 'L-HOOK-THIN', 'type import of ports/index.ts');
  assert.ok(message(index).includes('src/claude/client/hookCore.ts → src/ports/index.ts → src/git/runner.ts'), message(index));
  only(lintHookThin(reader(viaHookCore("import type { StatusJson } from '../../engine/status.js';"))), 'L-HOOK-THIN', 'a type-only engine import');

  // On the list (value imports, walked with the real files where they exist): no finding, and the walk reaches them.
  const admitted = [
    '../../ports/ipc.js', '../../ports/inbox.js', '../../ports/fs.js', '../../ports/clock.js', '../../ports/random.js',
    '../../sec/ipcKey.js', '../../sec/winAcl.js', '../../sec/endpoint.js', '../../sec/handshake.js', '../../sec/sddl.js',
    '../../data/pluginDataDir.js', '../../data/canonRoot.js', '../../git/env.js', '../../version.js',
    '../wire/frames.js', '../wire/hookInput.js', '../wire/schema.js', '../wire/pluginData.js', '../text/claudeText.js',
    '../../text/sanitize.js', '../../i18n/claude.js', '../../i18n/locale.js', './mcp/doorbell.js',
  ];
  const all = walkHookThin(overlay(viaHookCore(admitted.map((s, i) => `import * as m${i} from '${s}';`).join('\n'))));
  assert.deepEqual(all.findings, []);
  for (const rel of ['src/version.ts', 'src/i18n/render.ts', 'src/claude/wire/ndjson.ts', 'src/i18n/claude/en/seed.ts']) assert.ok(all.visited.has(rel), rel);
});

test('the client tier\'s one src/git import is src/git/env.ts, and that file imports only node:*', () => {
  const real = (rel: string): string => readFileSync(at(rel), 'utf8');
  const tree: Record<string, string> = {
    'src/entry/core.ts': "import { main } from '../claude/client/hookCore.js';\nvoid main;\n",
    'src/claude/client/hookCore.ts': "import { spawnDaemon } from './spawn.js';\nvoid spawnDaemon;\n",
    'src/claude/client/spawn.ts': "import { buildDaemonEnv } from '../../git/env.js';\nimport { spawn } from 'node:child_process';\nvoid buildDaemonEnv; void spawn;\n",
    'src/git/env.ts': real('src/git/env.ts'),
  };
  const walk = walkHookThin(reader(tree));
  assert.deepEqual(walk.findings, []);
  assert.deepEqual(walk.visited.get('src/git/env.ts'), ['src/entry/core.ts', 'src/claude/client/hookCore.ts', 'src/claude/client/spawn.ts', 'src/git/env.ts']);
  // Any other src/git or src/data file in the graph is a finding, also when reached through the exception.
  for (const [spec, from] of [['../../git/runner.js', 'src/claude/client/spawn.ts'], ['../../data/blobRoutes.js', 'src/claude/client/spawn.ts'], ['./runner.js', 'src/git/env.ts'], ['../data/zone.js', 'src/git/env.ts']] as const) {
    only(lintHookThin(reader({ ...tree, [from]: `${tree[from] as string}import { y } from '${spec}';\n` })), 'L-HOOK-THIN', `${from} → ${spec}`);
  }
  // The node-only leaves import nothing outside node:* (canonRoot.ts's type import of src/ports/fs.ts excepted, and not required) — fix r1
  // adds src/version.ts, the leaf L-HOOK-THIN admits for the entries' --version.
  for (const rel of ['src/git/env.ts', 'src/data/pluginDataDir.ts', 'src/data/canonRoot.ts', 'src/version.ts']) {
    const text = real(rel);
    const specs = ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName).filter((s) => !s.startsWith('node:'));
    if (rel !== 'src/data/canonRoot.ts') {
      assert.deepEqual(specs, [], rel);
      continue;
    }
    assert.ok(specs.every((s) => s === '../ports/fs.js'), `${rel}: ${specs.join(', ')}`);
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === '../ports/fs.js') {
        assert.ok(st.importClause?.isTypeOnly === true, `${rel}: import of ../ports/fs.js is not type-only`);
      }
      if (ts.isExportDeclaration(st) && st.moduleSpecifier !== undefined && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === '../ports/fs.js') {
        assert.ok(st.isTypeOnly, `${rel}: re-export of ../ports/fs.js is not type-only`);
      }
    }
  }
});

// Fix r1 minors: a BOM or CR in a command file is named as such (not as a missing key), and a quoted duplicate key does not slip past.
test('lintCommandFile names a BOM or CR and counts quoted disable-model-invocation keys', () => {
  const real = readFileSync(at('plugin/commands/cowork.md'), 'utf8');
  const bom = lintCommandFile('plugin/commands/cowork.md', `\u{FEFF}${real}`);
  only(bom, 'L-HUMAN-ONLY', 'BOM');
  assert.match((bom[0] as { message: string }).message, /BOM/);
  const crlf = lintCommandFile('plugin/commands/cowork.md', real.split('\n').join('\r\n'));
  only(crlf, 'L-HUMAN-ONLY', 'CRLF');
  assert.match((crlf[0] as { message: string }).message, /\bCR\b/);
  const dmi = 'disable-model-invocation: true\n';
  assert.ok(real.includes(dmi));
  for (const dup of ['"disable-model-invocation": false\n', "'disable-model-invocation': false\n"]) {
    only(lintCommandFile('plugin/commands/cowork.md', real.replace(dmi, `${dmi}${dup}`)), 'L-HUMAN-ONLY', dup);
  }
  assert.deepEqual(lintCommandFile('plugin/commands/cowork.md', real.replace(dmi, '"disable-model-invocation": true\n')), [], 'a quoted key with true');
});

// Fix r1 minor: the lint CLI's walk of tools/** and test/** scripts skips node_modules directories (a package's own files are not ours).
test('the lint walk of tools/** and test/** scripts skips node_modules', async () => {
  const { root, cleanup } = await makeTempRoot('lint-p5-node-modules');
  try {
    const put = (rel: string, text: string): void => {
      mkdirSync(join(root, ...rel.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(join(root, ...rel.split('/')), text);
    };
    const tokenLine = `const t = process.env.${TOKEN_ENV};\n`;
    put('test/crashpoints.json', '[]\n');
    put('tools/build/node_modules/pkg/index.js', tokenLine);
    put('test/node_modules/pkg/index.mjs', tokenLine);
    const run = () => spawnSync(process.execPath, ['--import', 'tsx', at('tools/lint/lint.ts'), '--root', root], { cwd: REPO, encoding: 'utf8' });
    const clean = run();
    assert.equal(clean.status, 0, `${clean.stdout}\n${clean.stderr}`);
    assert.match(clean.stdout, /^lint: 0 files, 0 findings$/m);
    put('tools/x.mjs', tokenLine);
    const dirty = run();
    assert.equal(dirty.status, 1, `${dirty.stdout}\n${dirty.stderr}`);
    assert.deepEqual(dirty.stderr.trim().split('\n').map((l) => l.split(' ').slice(0, 2).join(' ')), ['L-TOKEN tools/x.mjs:1']);
  } finally {
    await cleanup();
  }
});
