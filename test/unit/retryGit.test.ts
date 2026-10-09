import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryGit, RetryGitError } from '../helpers/retryGit.js';

/** A fake git call that returns the scripted results in order and counts its calls. */
function fakeRun(results: Array<{ code: number; stderr: string }>): { run: () => Promise<{ code: number; stderr: Buffer }>; calls: () => number } {
  let n = 0;
  return {
    async run() {
      const r = results[n] ?? assert.fail(`unexpected call ${n + 1}`);
      n++;
      return { code: r.code, stderr: Buffer.from(r.stderr, 'utf8') };
    },
    calls: () => n,
  };
}

test('retryGit: two failures, then success; the remote is checked after each failure', async () => {
  const f = fakeRun([{ code: 1, stderr: '' }, { code: 128, stderr: 'fatal: x' }, { code: 0, stderr: '' }]);
  let checks = 0;
  const r = await retryGit(f.run, { attempts: 3, label: 'push', pauseMs: 0, nothingLanded: async () => { checks++; return true; } });
  assert.equal(r.code, 0);
  assert.equal(f.calls(), 3);
  assert.equal(checks, 2);
});

test('retryGit: a call that always fails throws after the last attempt and lists all three', async () => {
  const f = fakeRun([
    { code: 1, stderr: '' },
    { code: 128, stderr: 'fatal: unable to access\nsecond line\n' },
    { code: 1, stderr: 'error: failed to push some refs\n' },
  ]);
  await assert.rejects(retryGit(f.run, { attempts: 3, label: 'seedRemote: git push', pauseMs: 0 }), (e: unknown) => {
    assert.ok(e instanceof RetryGitError);
    assert.equal(e.message, [
      'seedRemote: git push: failed 3 of 3 attempts',
      '  attempt 1: code=1 stderr: (empty)',
      '  attempt 2: code=128 stderr: fatal: unable to access second line',
      '  attempt 3: code=1 stderr: error: failed to push some refs',
    ].join('\n'));
    assert.deepEqual(e.attempts.map((a) => a.code), [1, 128, 1]);
    return true;
  });
  assert.equal(f.calls(), 3);
});

test('retryGit does not retry when the remote shows that something landed', async () => {
  const f = fakeRun([{ code: 1, stderr: 'error: x' }]);
  await assert.rejects(retryGit(f.run, { attempts: 3, label: 'push', pauseMs: 0, nothingLanded: async () => false }), (e: unknown) => {
    assert.ok(e instanceof RetryGitError);
    assert.equal(e.message, 'push: attempt 1 failed and the remote changed, so it was not retried\n  attempt 1: code=1 stderr: error: x');
    return true;
  });
  assert.equal(f.calls(), 1);
});

test('retryGit returns a first success without asking the remote, and needs a positive attempt count', async () => {
  const f = fakeRun([{ code: 0, stderr: '' }]);
  const r = await retryGit(f.run, { attempts: 3, label: 'fetch', nothingLanded: async () => assert.fail('not asked after a success') });
  assert.equal(r.code, 0);
  for (const attempts of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(retryGit(f.run, { attempts, label: 'x' }), RangeError);
  }
  assert.equal(f.calls(), 1);
});
