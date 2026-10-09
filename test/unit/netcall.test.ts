import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRefName } from '../../src/git/netcall.js';
import { REF_NAME_TABLE } from '../helpers/refNameTable.js';

test("checkRefName follows git check-ref-format: a component starting with '.', a '.lock' component anywhere and a trailing '.' are refused", () => {
  const wrong: string[] = [];
  for (const [ref, valid] of REF_NAME_TABLE) {
    let ok = true;
    try {
      checkRefName('t', ref);
    } catch (e) {
      assert.match((e as Error).message, /^t: invalid ref /, ref);
      ok = false;
    }
    if (ok !== valid) wrong.push(`${JSON.stringify(ref)}: checkRefName says ${ok ? 'valid' : 'invalid'}, git says ${valid ? 'valid' : 'invalid'}`);
  }
  assert.deepEqual(wrong, []);
  // Not under refs/ at all, or not a string: refused whatever git would say.
  for (const bad of ['heads/main', 'HEAD', '', 'refs', '+refs/heads/main', 7 as unknown as string]) {
    assert.throws(() => checkRefName('t', bad), /^Error: t: invalid ref /, String(bad));
  }
});
