import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EncTooLongError } from '../../src/git/enc.js';
import { parseOid } from '../../src/git/oid.js';
import { RELEASE_NAMESPACE, refNames, testNamespace } from '../../src/engine/refs.js';

const PEER = '0123456789abcdef0123456789abcdef';
const OID = parseOid('89abcdef0123456789abcdef0123456789abcdef');

test('refNames for main, feature/x, a Korean branch and a test namespace; over 150 bytes throws EncTooLongError', () => {
  assert.equal(RELEASE_NAMESPACE.remotePrefix, 'refs/cowork/');

  const main = refNames('main', RELEASE_NAMESPACE);
  assert.equal(main.branch, 'main');
  assert.equal(main.e, 'main');
  assert.equal(main.remoteBoard, 'refs/cowork/main/board');
  assert.equal(main.remoteCode, 'refs/cowork/main/code');
  assert.equal(main.remoteBranch, 'refs/heads/main');
  assert.equal(main.localBoard, 'refs/cowork-remote/main/board');
  assert.equal(main.localCode, 'refs/cowork-remote/main/code');
  assert.equal(main.localBranch, 'refs/cowork-remote/main/branch');
  assert.equal(main.state, 'refs/cowork-local/main/state');
  assert.equal(main.holds, 'refs/cowork-local/main/holds');
  assert.equal(main.displacedPrefix, 'refs/cowork/main/displaced/');
  assert.equal(main.displaced(OID), 'refs/cowork/main/displaced/89abcdef0123');
  assert.equal(main.incident(1), 'refs/cowork-local/main/incident-1');
  assert.equal(main.incident(12), 'refs/cowork-local/main/incident-12');
  assert.equal(main.incidentOwn(3), 'refs/cowork-local/main/incident-3-own');
  assert.equal(main.probe(PEER), `refs/cowork/probe-${PEER}`);

  // A '/' in the branch is encoded in every cowork ref; refs/heads keeps the real name.
  const fx = refNames('feature/x', RELEASE_NAMESPACE);
  assert.equal(fx.e, 'feature%2Fx');
  assert.equal(fx.remoteBoard, 'refs/cowork/feature%2Fx/board');
  assert.equal(fx.remoteCode, 'refs/cowork/feature%2Fx/code');
  assert.equal(fx.remoteBranch, 'refs/heads/feature/x');
  assert.equal(fx.localBoard, 'refs/cowork-remote/feature%2Fx/board');
  assert.equal(fx.localBranch, 'refs/cowork-remote/feature%2Fx/branch');
  assert.equal(fx.state, 'refs/cowork-local/feature%2Fx/state');
  assert.equal(fx.holds, 'refs/cowork-local/feature%2Fx/holds');
  assert.equal(fx.displacedPrefix, 'refs/cowork/feature%2Fx/displaced/');

  // "기능/로그인" (Korean): every UTF-8 byte outside [A-Za-z0-9_-] is %XX.
  const korean = '\u{AE30}\u{B2A5}/\u{B85C}\u{ADF8}\u{C778}';
  const k = refNames(korean, RELEASE_NAMESPACE);
  const ke = '%EA%B8%B0%EB%8A%A5%2F%EB%A1%9C%EA%B7%B8%EC%9D%B8';
  assert.equal(k.e, ke);
  assert.equal(k.remoteBoard, `refs/cowork/${ke}/board`);
  assert.equal(k.remoteBranch, `refs/heads/${korean}`);
  assert.equal(k.localCode, `refs/cowork-remote/${ke}/code`);
  assert.equal(k.state, `refs/cowork-local/${ke}/state`);
  assert.match(k.state, /^[\x21-\x7e]+$/, 'every cowork ref is printable ASCII');

  // Test namespace (glossary §4, ruling R-34): only the remote prefix changes; local refs do not.
  const ns = testNamespace('run_42-a');
  assert.equal(ns.remotePrefix, 'refs/cowork-ci/run_42-a/');
  const t = refNames('ci/run_42-a/main', ns);
  assert.equal(t.e, 'ci%2Frun_42-a%2Fmain');
  assert.equal(t.remoteBoard, 'refs/cowork-ci/run_42-a/ci%2Frun_42-a%2Fmain/board');
  assert.equal(t.remoteCode, 'refs/cowork-ci/run_42-a/ci%2Frun_42-a%2Fmain/code');
  assert.equal(t.remoteBranch, 'refs/heads/ci/run_42-a/main');
  assert.equal(t.localBoard, 'refs/cowork-remote/ci%2Frun_42-a%2Fmain/board');
  assert.equal(t.state, 'refs/cowork-local/ci%2Frun_42-a%2Fmain/state');
  assert.equal(t.displaced(OID), 'refs/cowork-ci/run_42-a/ci%2Frun_42-a%2Fmain/displaced/89abcdef0123');
  assert.equal(t.probe(PEER), `refs/cowork-ci/run_42-a/probe-${PEER}`);
  for (const bad of ['', 'a/b', 'a.b', 'x'.repeat(41), 'a b', '..']) {
    assert.throws(() => testNamespace(bad), Error, `run id ${JSON.stringify(bad)}`);
  }
  // A namespace that is neither the release prefix nor a test prefix is refused.
  assert.throws(() => refNames('main', { remotePrefix: 'refs/heads/' }));
  assert.throws(() => refNames('main', { remotePrefix: 'refs/cowork-ci/x' }));

  // Over 150 encoded bytes: refused with EncTooLongError (17 Hangul syllables = 153 encoded bytes).
  assert.equal(refNames('a'.repeat(150), RELEASE_NAMESPACE).e, 'a'.repeat(150));
  assert.throws(() => refNames('a'.repeat(151), RELEASE_NAMESPACE), EncTooLongError);
  assert.throws(() => refNames('\u{AE30}'.repeat(17), RELEASE_NAMESPACE), EncTooLongError);

  // Bad arguments of the ref builders throw instead of naming a malformed ref.
  assert.throws(() => main.probe('not-a-peer'));
  assert.throws(() => main.incident(0));
  assert.throws(() => main.incident(1.5));
  assert.throws(() => main.incidentOwn(-1));
  assert.throws(() => main.displaced('abc' as never));
  // A branch git itself could not name is refused.
  for (const bad of ['', 'a..b', 'a b', 'x~1', 'a:b', '-x', 'a/', 'a.lock', 'a//b', 'a@{1}']) {
    assert.throws(() => refNames(bad, RELEASE_NAMESPACE), Error, `branch ${JSON.stringify(bad)}`);
  }
});

test('fetchSpecs are exactly the three glossary §4 refspecs', () => {
  const r = refNames('feature/x', RELEASE_NAMESPACE);
  assert.deepEqual(
    r.fetchSpecs.map((s) => ({ ...s })),
    [
      { remote: 'refs/cowork/feature%2Fx/board', local: 'refs/cowork-remote/feature%2Fx/board' },
      { remote: 'refs/cowork/feature%2Fx/code', local: 'refs/cowork-remote/feature%2Fx/code' },
      { remote: 'refs/heads/feature/x', local: 'refs/cowork-remote/feature%2Fx/branch' },
    ],
  );
  // The '+' belongs to the fetch argv (Task 12), never to the spec.
  for (const s of r.fetchSpecs) {
    assert.ok(!s.remote.startsWith('+') && !s.remote.includes(':') && !s.local.includes(':'));
    assert.deepEqual(Object.keys(s).sort(), ['local', 'remote']);
  }
  assert.ok(Object.isFrozen(r.fetchSpecs));

  const t = refNames('main', testNamespace('r1'));
  assert.deepEqual(
    t.fetchSpecs.map((s) => ({ ...s })),
    [
      { remote: 'refs/cowork-ci/r1/main/board', local: 'refs/cowork-remote/main/board' },
      { remote: 'refs/cowork-ci/r1/main/code', local: 'refs/cowork-remote/main/code' },
      { remote: 'refs/heads/main', local: 'refs/cowork-remote/main/branch' },
    ],
  );
});
