// The test launcher's choices that depend on the Node version (tools/test/run-tests.mjs, tools/test/open-handles.mjs), as pure functions
// of the version string, so test/unit/ci-config.test.ts checks them for every Node line the CI matrix runs.

/** [major, minor] of a Node version ('20.20.2' or 'v20.20.2' → [20, 20]). */
function majorMinor(version) {
  const [major = 0, minor = 0] = String(version).replace(/^v/, '').split('.').map(Number);
  return [major, minor];
}

/** Node 24 and later: --test-timeout limits each test. */
export const PER_TEST_TIMEOUT_MS = 10 * 60_000;
/** Node 20-23: the runner also cancels each test file's whole run at --test-timeout, so there it is a budget per file. */
export const PER_FILE_TIMEOUT_MS = 60 * 60_000;

/**
 * The --test-timeout run-tests passes, so a hung test fails (and names itself) instead of stalling CI. From Node 24 the runner hands the
 * value to each test file's process as a limit per test (10 min by default). Before 24 (20.11-23.x) the runner passes the flag on to the
 * test file's process too, and also applies it to the file's whole run: at that time the file is cancelled and its later tests go
 * unreported (on the Windows Node 20 leg five files with long tests were cancelled at 10 min). There it is a budget per file, 60 min by
 * default, under the CI test job's 90 min. COWORK_TEST_TIMEOUT_MS overrides either; ms is null when this Node has no such flag (before
 * 20.11, and 21.0-21.1) or the override is not a positive integer.
 */
export function testTimeout(version, env) {
  const [major, minor] = majorMinor(version);
  const has = major > 21 || (major === 21 && minor >= 2) || (major === 20 && minor >= 11);
  const scope = major < 24 ? 'file' : 'test';
  const raw = env.COWORK_TEST_TIMEOUT_MS;
  const ms = raw === undefined ? (scope === 'file' ? PER_FILE_TIMEOUT_MS : PER_TEST_TIMEOUT_MS) : Number(raw);
  return { ms: has && Number.isSafeInteger(ms) && ms > 0 ? ms : null, scope };
}

/** --test-force-exit exists from Node 20.14 and 22 (not on 21). */
export function hasForceExit(version) {
  const [major, minor] = majorMinor(version);
  return major >= 22 || (major === 20 && minor >= 14);
}

/**
 * Whether a test file's process makes its stdout and stderr blocking before its tests run: on POSIX before Node 22.10, where a pipe is
 * written asynchronously and --test-force-exit can end the process before the last results reach the runner (the macOS Node 20 leg lost
 * the last results of three files). Windows pipes are synchronous already.
 */
export function needsBlockingStdio(version, platform) {
  const [major, minor] = majorMinor(version);
  return platform !== 'win32' && (major < 22 || (major === 22 && minor < 10));
}
