// Helper processes that tests start under git (a heartbeat, a pipe holder) end on their own (final review, exit-1
// flake). Tests never kill them by a pid read back from a file: once such a process has died, the OS may give its pid to
// an unrelated process (another test file's git), which a late SIGKILL then ends with exit 1 and no stderr (lint
// L-PID-KILL).

/** How long a helper may live at most when the test that started it never cleans up (a crash, a hang). */
export const HELPER_MAX_MS = 60_000;

/**
 * The first lines of a CommonJS helper script. The helper moves its working directory out of the temp root (a live
 * process's cwd blocks the removal of that directory on Windows) and exits on its own once `root` is gone (the test's
 * cleanup removes it) or after `maxMs`. The watcher is unref'd: a helper that is done earlier still exits at once.
 */
export function selfExitPrologue(root: string, maxMs: number = HELPER_MAX_MS): string {
  return `process.chdir(require('os').tmpdir());\n`
    + `{\n`
    + `  const born = Date.now();\n`
    + `  const root = ${JSON.stringify(root)};\n`
    + `  setInterval(() => {\n`
    + `    if (!require('fs').existsSync(root) || Date.now() - born > ${maxMs}) process.exit(0);\n`
    + `  }, 50).unref();\n`
    + `}\n`;
}
