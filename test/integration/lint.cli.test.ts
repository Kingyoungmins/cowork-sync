import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempRoot } from '../helpers/tmp.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const LINT = fileURLToPath(new URL('../../tools/lint/lint.ts', import.meta.url));

function runLint(root: string): { code: number | null; stdout: string; stderr: string } {
  // cwd = repo root so `--import tsx` resolves from this repo's node_modules.
  const r = spawnSync(process.execPath, ['--import', 'tsx', LINT, '--root', root], { cwd: REPO, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

async function put(root: string, rel: string, text: string): Promise<void> {
  const full = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, Buffer.from(text, 'utf8'));
}

test('lint CLI exits 0 on a clean tree and 1 with rule ids on a dirty one', async () => {
  const { root, cleanup } = await makeTempRoot('lint-cli');
  try {
    await put(root, 'test/crashpoints.json', JSON.stringify(['apply.intent']) + '\n');
    await put(root, 'src/ports/clock.ts', 'export const now = (): number => Date.now();\n');
    await put(root, 'src/engine/apply.ts', "import { crashpoint } from '../ports/crashpoint.js';\ncrashpoint('apply.intent');\n");
    const clean = runLint(root);
    assert.equal(clean.code, 0, clean.stderr);
    assert.match(clean.stdout, /lint: 2 files, 0 findings/);

    await put(root, 'src/engine/bad.ts', "const t = Date.now();\ncrashpoint('apply.bogus');\n");
    const dirty = runLint(root);
    assert.equal(dirty.code, 1);
    assert.match(dirty.stderr, /^L-CLOCK src\/engine\/bad\.ts:1 /m);
    assert.match(dirty.stderr, /^L-CRASHPOINTS test\/crashpoints\.json:1 .*apply\.bogus/m);
  } finally {
    await cleanup();
  }
});

// Final review (exit-1 flake): L-PID-KILL also binds test code, so the CLI lints test/**/*.ts with that rule only.
test('lint CLI applies L-PID-KILL, and only it, to test/**/*.ts', async () => {
  const { root, cleanup } = await makeTempRoot('lint-cli-test-tree');
  try {
    await put(root, 'test/crashpoints.json', JSON.stringify([]) + '\n');
    await put(root, 'src/engine/ok.ts', 'export const x = 1;\n');
    await put(root, 'test/integration/probe.test.ts',
      "import { spawn } from 'node:child_process';\nconst t = Date.now();\nspawn('git', ['status']);\ntry { process.kill(pid, 0); } catch { /* gone */ }\n");
    const clean = runLint(root);
    assert.equal(clean.code, 0, clean.stderr);
    assert.match(clean.stdout, /lint: 2 files, 0 findings/);

    await put(root, 'test/helpers/reap.ts', "for (const pid of pids) {\n  try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }\n}\n");
    const dirty = runLint(root);
    assert.equal(dirty.code, 1, dirty.stderr);
    assert.match(dirty.stderr, /^L-PID-KILL test\/helpers\/reap\.ts:2 /m);
    assert.deepEqual(dirty.stderr.trim().split('\n').map((l) => l.split(' ')[0]), ['L-PID-KILL'], dirty.stderr);
    assert.match(dirty.stdout, /lint: 3 files, 1 findings/);
  } finally {
    await cleanup();
  }
});

test('lint CLI exits 2 when test/crashpoints.json is missing, unreadable, not JSON or not a string array', async () => {
  const cases: { label: string; setup: (root: string) => Promise<void>; why: RegExp }[] = [
    { label: 'missing', setup: async () => {}, why: /cannot read \(ENOENT\)/ },
    { label: 'a directory', setup: async (root) => { await mkdir(path.join(root, 'test', 'crashpoints.json'), { recursive: true }); }, why: /cannot read \(EISDIR\)/ },
    { label: 'not JSON', setup: (root) => put(root, 'test/crashpoints.json', 'apply.intent\n'), why: /not valid JSON/ },
    { label: 'object form', setup: (root) => put(root, 'test/crashpoints.json', JSON.stringify({ crashpoints: ['apply.intent'] }) + '\n'), why: /expected a JSON array of strings/ },
    { label: 'non-string entry', setup: (root) => put(root, 'test/crashpoints.json', JSON.stringify(['apply.intent', 1]) + '\n'), why: /expected a JSON array of strings/ },
  ];
  for (const [i, c] of cases.entries()) {
    const { root, cleanup } = await makeTempRoot(`lint-cli-cat-${i}`);
    try {
      await c.setup(root);
      await put(root, 'src/engine/bad.ts', 'const t = Date.now();\n');
      const r = runLint(root);
      assert.equal(r.code, 2, `${c.label}: ${r.stderr}`);
      assert.match(r.stderr, /^lint: test\/crashpoints\.json: /m, c.label);
      assert.match(r.stderr, c.why, c.label);
      assert.doesNotMatch(r.stdout, /files, \d+ findings/, c.label);
    } finally {
      await cleanup();
    }
  }
});
