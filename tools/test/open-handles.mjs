// Loaded into every test file's process by run-tests.mjs (`--import`): when that process exits, it records the handles
// that were still keeping its event loop alive — the ones `--test-force-exit` cut off — so run-tests.mjs can print one
// warning line per leaking file. It never changes a test's outcome or the exit code.
//
// The handle types alive when this module loads (the runner's own IPC and stdio pipes) are the baseline; in-flight
// requests (FSReqCallback, a pending write, …) are not handles and are ignored.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  const baseline = handles();
  process.on('exit', () => {
    const left = [];
    for (const [t, n] of handles()) {
      const extra = n - (baseline.get(t) ?? 0);
      if (extra > 0) left.push(extra === 1 ? t : `${t} x${extra}`);
    }
    if (left.length === 0) return;
    try {
      writeFileSync(join(dir, `${process.pid}.json`), `${JSON.stringify({ file, handles: left.sort() })}\n`);
    } catch {
      // a report that cannot be written is no test failure
    }
  });
}
