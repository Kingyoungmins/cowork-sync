// Plan 8a final review, fix Group D (tests-ci #3, Minor: browser-gated items pass when skipped): browserGate, the gate the browser
// suites (browserSmoke.test.ts, demoE2E.test.ts) open with. Without Node >= 22's WebSocket or without Chrome a suite reports SKIPPED
// (12 §7, 11 §3.10), unless COWORK_VIZ_REQUIRE_BROWSER=1 (viz-slow's smoke step), which turns that into a failure; a set
// COWORK_CHROME that names no absolute file is a failure whatever the switch says (a mistyped pin must not pass as a skip).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserGate } from '../../helpers/cdp.js';

const CHROME = process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome';

test('browserGate: Chrome and WebSocket → the suite runs; without either → SKIPPED with the reason', () => {
  assert.deepEqual(browserGate({}, { webSocket: true, chrome: CHROME }), { skip: false, fail: null });
  assert.deepEqual(browserGate({}, { webSocket: true, chrome: null }), { skip: 'no Chrome or Chromium on this runner', fail: null });
  assert.deepEqual(browserGate({}, { webSocket: false, chrome: CHROME }), { skip: 'Node < 22: no built-in WebSocket', fail: null });
  assert.deepEqual(browserGate({}, { webSocket: false, chrome: null }), { skip: 'Node < 22: no built-in WebSocket', fail: null });
  // The switch set to anything but 1 changes nothing; a valid pin is a browser like any other.
  for (const v of ['', '0', 'true', 'yes']) {
    assert.deepEqual(browserGate({ COWORK_VIZ_REQUIRE_BROWSER: v }, { webSocket: true, chrome: null }), { skip: 'no Chrome or Chromium on this runner', fail: null }, v);
  }
  assert.deepEqual(browserGate({ COWORK_CHROME: CHROME }, { webSocket: true, chrome: CHROME }), { skip: false, fail: null });
});

test('browserGate: COWORK_VIZ_REQUIRE_BROWSER=1 fails a suite that would skip, with the reason; it never fails one that runs', () => {
  const require1 = { COWORK_VIZ_REQUIRE_BROWSER: '1' };
  assert.deepEqual(browserGate(require1, { webSocket: true, chrome: CHROME }), { skip: false, fail: null });
  assert.deepEqual(browserGate(require1, { webSocket: true, chrome: null }), {
    skip: false, fail: 'no Chrome or Chromium on this runner, and COWORK_VIZ_REQUIRE_BROWSER=1 requires one',
  });
  assert.deepEqual(browserGate(require1, { webSocket: false, chrome: CHROME }), {
    skip: false, fail: 'Node < 22: no built-in WebSocket, and COWORK_VIZ_REQUIRE_BROWSER=1 requires one',
  });
});

test('browserGate: a set COWORK_CHROME that names no absolute file fails, with or without the switch (findChrome answers null for it)', () => {
  for (const pin of ['C:\\nowhere\\chrome.exe', '/nowhere/chrome', 'chrome', 'google-chrome']) {
    const fail = `COWORK_CHROME is set but names no absolute file: ${JSON.stringify(pin)}`;
    assert.deepEqual(browserGate({ COWORK_CHROME: pin }, { webSocket: true, chrome: null }), { skip: false, fail }, pin);
    assert.deepEqual(browserGate({ COWORK_CHROME: pin, COWORK_VIZ_REQUIRE_BROWSER: '1' }, { webSocket: true, chrome: null }), { skip: false, fail }, pin);
    assert.deepEqual(browserGate({ COWORK_CHROME: pin }, { webSocket: false, chrome: null }), { skip: false, fail }, `${pin} without WebSocket`);
  }
  // An empty pin is no pin.
  assert.deepEqual(browserGate({ COWORK_CHROME: '' }, { webSocket: true, chrome: null }), { skip: 'no Chrome or Chromium on this runner', fail: null });
});
