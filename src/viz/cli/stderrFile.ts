// The viewer's stderr file name (Task 15 fix round 2 ruling; Plan 8a final review, fix Group D): an import-free leaf, so the data
// directory check (dataDir.ts, which viz.js bundles too) can name the file without importing spawn.ts and its node:child_process.

/**
 * <data dir>/log/viz-stderr.txt: the file the CLI hands the viewer as its stderr (spawn.ts openViewerStderr). It is one of the
 * viewer's own files, so a data directory the CLI repairs may hold it (dataDir.ts onlyViewerFiles: a regular file inside log/).
 */
export const VIEWER_STDERR_FILE = 'viz-stderr.txt';
