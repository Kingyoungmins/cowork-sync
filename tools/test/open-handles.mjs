// Loaded into every test file's process by run-tests.mjs (`--import`): when that process exits, it records the handles
// that were still keeping its event loop alive — the ones `--test-force-exit` cut off — so run-tests.mjs can print one
// warning line per leaking file. It never changes a test's outcome or the exit code.
//
// The handle types alive when this module loads (the runner's own IPC and stdio pipes) are the baseline; in-flight
// requests (FSReqCallback, a pending write, …) are not handles and are ignored.
//
// On POSIX before Node 22.10 it also makes the file's stdout and stderr blocking before any test runs (testFlags.mjs
// needsBlockingStdio): there a pipe is written asynchronously, and --test-force-exit ends the process as soon as the
// reporter closes, so results still queued for the runner were lost (the macOS Node 20 leg missed the last results of
// three files). Blocking writes land before the exit. Output still queued at exit is reported (`unflushed`), as a warning.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { needsBlockingStdio } from './testFlags.mjs';

const dir = process.env.COWORK_TEST_HANDLES_DIR;
const file = process.argv[1] ?? '';

/** Handle type → count, requests left out. */
function handles() {
  const out = new Map();
  for (const t of process.getActiveResourcesInfo()) {
    if (/Req|^(ConnectWrap|WriteWrap|ShutdownWrap)$/.test(t)) continue;
    out.set(t, (out.get(t) ?? 0) + 1);
  }
  return out;
}

if (dir !== undefined && dir.length > 0 && file.endsWith('.test.ts')) {
  if (needsBlockingStdio(process.versions.node, process.platform)) {
    for (const s of [process.stdout, process.stderr]) s._handle?.setBlocking?.(true);
  }
  const baseline = handles();
  process.on('exit', () => {
    const left = [];
    for (const [t, n] of handles()) {
      const extra = n - (baseline.get(t) ?? 0);
      if (extra > 0) left.push(extra === 1 ? t : `${t} x${extra}`);
    }
    const unflushed = (process.stdout.writableLength ?? 0) + (process.stderr.writableLength ?? 0);
    if (left.length === 0 && unflushed === 0) return;
    try {
      writeFileSync(join(dir, `${process.pid}.json`), `${JSON.stringify({ file, handles: left.sort(), unflushed })}\n`);
    } catch {
      // a report that cannot be written is no test failure
    }
  });
}
