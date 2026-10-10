// Portable test launcher: finds every *.test.ts under the given directories
// (recursively, sorted by code unit) and runs them with `tsx --test`.
// Needed because Node 20's `node --test` does not expand glob patterns and
// npm runs scripts through cmd.exe on Windows, which does not expand them either.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hasForceExit, testTimeout } from './testFlags.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function collect(dir, out) {
  if (!existsSync(dir)) return;
  const names = readdirSync(dir).sort();
  for (const name of names) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (name.endsWith('.test.ts')) out.push(p);
  }
}

function tsxCliPath() {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('tsx/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.tsx;
  return join(dirname(pkgPath), bin);
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  process.stderr.write('usage: node tools/test/run-tests.mjs <dir> [<dir>...]\n');
  process.exit(2);
}
const files = [];
for (const d of dirs) collect(resolve(repoRoot, d), files);
if (files.length === 0) {
  process.stdout.write(`run-tests: no *.test.ts files under ${dirs.join(', ')}\n`);
  process.exit(0);
}
// --test-timeout, so a hung test fails (and names itself) instead of stalling CI (testFlags.mjs testTimeout): on Node 24+ a limit per
// test, 10 min by default; on Node 20-23, where the runner also cancels a test file's whole run at that time, a budget per file, 60 min
// by default. COWORK_TEST_TIMEOUT_MS overrides either (NODE_OPTIONS does not take the flag, so it stays on this command line); a test
// that needs more than 10 min sets its own `{ timeout }` (the 200-apply BOM+CRLF test and the three-peer convergence test do). And
// --test-force-exit, so a timed-out test's leftover handles (a timer, a child process) cannot keep its file running — with a one-line
// warning per file whose handles were still open when it ended (tools/test/open-handles.mjs records them), so a leak stays visible, and
// one per file that exited with test output not yet written (its last results may be missing). On POSIX before Node 22.10, where a pipe
// is written asynchronously, open-handles.mjs makes each file's stdout and stderr blocking first, so a forced exit loses no results.
// The warnings never change the exit code.
// Node releases without the flags (--test-timeout before 20.11, --test-force-exit before 20.14 and on 21) run without.
const timeout = testTimeout(process.versions.node, process.env);
const handlesDir = mkdtempSync(join(tmpdir(), 'cowork-test-handles-'));
const flags = [
  ...(timeout.ms !== null ? [`--test-timeout=${timeout.ms}`] : []),
  ...(hasForceExit(process.versions.node) ? ['--test-force-exit'] : []),
  `--import=${pathToFileURL(join(repoRoot, 'tools', 'test', 'open-handles.mjs')).href}`,
];
const args = [tsxCliPath(), '--test', ...flags, ...files.map((f) => relative(repoRoot, f))];
const r = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: 'inherit', env: { ...process.env, COWORK_TEST_HANDLES_DIR: handlesDir } });
warnOpenHandles(handlesDir);
if (r.error) {
  process.stderr.write(`run-tests: ${r.error.message}\n`);
  process.exit(1);
}
process.exit(r.status ?? 1);

/**
 * One line per test file whose process still had handles open when it ended (force-exited), and one per file that exited with test
 * output not yet written to the runner; then the reports go.
 */
function warnOpenHandles(dir) {
  try {
    const reports = [];
    for (const name of readdirSync(dir)) {
      try {
        const rep = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        if (typeof rep.file === 'string' && Array.isArray(rep.handles)) reports.push(rep);
      } catch {
        // a torn report: skipped
      }
    }
    reports.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    for (const rep of reports) {
      if (rep.handles.length > 0) {
        process.stderr.write(`run-tests: warning: ${relative(repoRoot, rep.file)} still had open handles when its tests ended (force-exited): ${rep.handles.join(', ')}\n`);
      }
      if (Number.isSafeInteger(rep.unflushed) && rep.unflushed > 0) {
        process.stderr.write(`run-tests: warning: ${relative(repoRoot, rep.file)} exited with ${rep.unflushed} bytes of test output not yet written (its last results may be missing from the report)\n`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
