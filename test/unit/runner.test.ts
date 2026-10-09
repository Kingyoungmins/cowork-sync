import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WATCHDOG, watchdogMs } from '../../src/git/runner.js';

test('WATCHDOG holds the glossary §18 values', () => {
  assert.deepEqual(WATCHDOG, { fetch: 45_000, push: 90_000, readHash: 120_000 });
});

test('fetch and push get their own watchdogs', () => {
  assert.equal(watchdogMs(['fetch', '--no-tags', 'origin'], 'network'), 45_000);
  assert.equal(watchdogMs(['push', '--porcelain', 'origin', 'HEAD:refs/x'], 'network'), 90_000);
});

test('other network-class commands use the fetch watchdog', () => {
  assert.equal(watchdogMs(['ls-remote', '--exit-code', 'file:///r.git'], 'network'), 45_000);
  assert.equal(watchdogMs(['clone', '-q', 'file:///r.git', 'd'], 'network'), 45_000);
});

test('read/hash commands get 120 s; cat-file only with --filters', () => {
  assert.equal(watchdogMs(['add', '--', 'a.txt'], 'attr'), 120_000);
  assert.equal(watchdogMs(['hash-object', '--path=a.txt', '--stdin'], 'attr'), 120_000);
  assert.equal(watchdogMs(['cat-file', '--filters', 'HEAD:a.txt'], 'attr'), 120_000);
  assert.equal(watchdogMs(['cat-file', '-p', 'HEAD:a.txt'], 'local'), null);
});

test('ref-updating plumbing is never killed', () => {
  for (const sub of ['update-ref', 'update-index', 'commit-tree', 'read-tree']) {
    assert.equal(watchdogMs([sub, 'x'], 'refupdate'), null, sub);
    assert.equal(watchdogMs([sub, 'x'], 'network'), null, sub);
  }
});

test('everything else has no watchdog', () => {
  assert.equal(watchdogMs(['rev-parse', 'HEAD'], 'local'), null);
  assert.equal(watchdogMs(['status', '--porcelain=v2', '-z'], 'local'), null);
  assert.equal(watchdogMs([], 'local'), null);
});

test('leading global options are skipped when finding the subcommand', () => {
  assert.equal(watchdogMs(['-c', 'core.x=y', '-C', 'dir', 'fetch'], 'network'), 45_000);
  assert.equal(watchdogMs(['--no-pager', 'update-ref', 'refs/x', 'y'], 'refupdate'), null);
});
