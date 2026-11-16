// Plan 5 Task 1 (A1-9, ruling P5-PF-6): the lint ALLOW entries of Plan 5's files, declared before the files exist so later tasks never edit
// the shared table. Kept out of test/unit/lint.rules.test.ts, which Plans 3 and 4 also extend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN_ENV } from '../../src/claude/client/mcp/doorbell.js';
import { lintSource } from '../../tools/lint/rules.js';

const rules = (file: string, text: string): string[] => lintSource(file, text).map((f) => f.rule);
const F = 'src/claude/daemon/example.ts';

test('A1-9: child_process in spawnDaemon and the SEC ACL runner, net in the IPC and inbox ports, node:fs in the hook loader, the token in the doorbell', () => {
  const cp = `import { spawn } from 'node:child_process';`;
  for (const f of ['src/claude/client/spawn.ts', 'src/sec/winAcl.ts']) assert.deepEqual(rules(f, cp), [], f);
  assert.deepEqual(rules(F, cp), ['L-PORTS']);
  const net = `import net from 'node:net';`;
  for (const f of ['src/ports/ipc.ts', 'src/ports/inbox.ts']) assert.deepEqual(rules(f, net), [], f);
  assert.deepEqual(rules(F, net), ['L-NET']);
  assert.deepEqual(rules('src/claude/client/spawn.ts', net), ['L-NET'], 'each file is allowed only its own rule');
  const fs = `import { readFileSync } from 'node:fs';`;
  assert.deepEqual(rules('src/entry/hook.ts', fs), []);
  assert.deepEqual(rules('src/entry/core.ts', fs), ['L-FS-PORT']);
  const token = `const t = process.env.${TOKEN_ENV};`;
  assert.deepEqual(rules('src/claude/client/mcp/doorbell.ts', token), []);
  for (const f of ['src/entry/mcp.ts', 'src/claude/client/mcp/server.ts', 'src/entry/hook.ts']) assert.deepEqual(rules(f, token), ['L-TOKEN'], f);
});
