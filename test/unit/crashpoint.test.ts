import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { crashpoint, setCrashHandler, KilledAt } from '../../src/ports/crashpoint.js';

afterEach(() => {
  setCrashHandler(null);
});

test('without a handler crashpoint is a no-op', () => {
  assert.equal(crashpoint('apply.intent'), undefined);
  assert.doesNotThrow(() => crashpoint('x'));
});

test('with a killing handler crashpoint("x") throws KilledAt("x")', () => {
  setCrashHandler((name) => {
    throw new KilledAt(name);
  });
  assert.throws(
    () => crashpoint('x'),
    (err: unknown) => {
      assert.ok(err instanceof KilledAt);
      assert.ok(err instanceof Error);
      assert.equal(err.point, 'x');
      assert.equal(err.name, 'KilledAt');
      assert.match(err.message, /\bx\b/);
      return true;
    },
  );
});

test('an observing handler sees every name in order and does not kill', () => {
  const seen: string[] = [];
  setCrashHandler((name) => {
    seen.push(name);
  });
  crashpoint('apply.intent');
  crashpoint('apply.group.phase1');
  crashpoint('apply.intent');
  assert.deepEqual(seen, ['apply.intent', 'apply.group.phase1', 'apply.intent']);
});

test('a selective handler kills only at the armed point and hit', () => {
  let hits = 0;
  setCrashHandler((name) => {
    if (name === 'publish.sent' && ++hits === 2) throw new KilledAt(name);
  });
  crashpoint('publish.out_built');
  crashpoint('publish.sent');
  assert.throws(() => crashpoint('publish.sent'), KilledAt);
});

test('setCrashHandler(null) restores the no-op', () => {
  setCrashHandler((name) => {
    throw new KilledAt(name);
  });
  setCrashHandler(null);
  assert.doesNotThrow(() => crashpoint('stop.flushed'));
});

test('setCrashHandler returns the handler it replaced, so a harness can put the caller\'s back', () => {
  const caller = (_name: string): void => {};
  const harness = (_name: string): void => {};
  assert.equal(setCrashHandler(caller), null);
  assert.equal(setCrashHandler(harness), caller);
  assert.equal(setCrashHandler(caller), harness);
  assert.equal(setCrashHandler(null), caller);
});

test('KilledAt is constructible on its own', () => {
  const k = new KilledAt('registry.cas');
  assert.equal(k.point, 'registry.cas');
  assert.equal(k.name, 'KilledAt');
  assert.ok(typeof k.stack === 'string');
});
