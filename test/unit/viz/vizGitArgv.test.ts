import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { isOid } from '../../../src/git/oid.js';
import { VIZ_GIT_SUBCOMMANDS, vizGitArgvOk } from '../../../src/viz/source/vizGitArgv.js';

const OID40 = '0123456789abcdef0123456789abcdef01234567';
const OID64 = '0123456789abcdef'.repeat(4);
const REF = 'refs/cowork-remote/main/board';
const FORMAT = '--format=%(objectname) %(refname)';
const P = '<non-literal>';

/** Every allowed form with a real oid and ref (Global Constraints, "Viewer git"). */
const ALLOWED: readonly (readonly string[])[] = [
  ['version'],
  ['rev-parse', '--verify', '-q', REF],
  ['rev-parse', '--verify', '-q', 'refs/cowork-remote/feat%2Fx/board'],
  ['rev-parse', '--verify', '-q', 'refs/cowork-remote/a/b/board'],
  ['for-each-ref', FORMAT, 'refs/cowork-remote/'],
  ['rev-list', '--first-parent', '--count', OID40],
  ['rev-list', '--first-parent', '--count', OID64],
  ['rev-list', '--first-parent', '--max-count=1281', OID40],
  ['rev-list', '--first-parent', '--max-count=0', OID64],
  ['rev-list', '--first-parent', '--skip=0', '--max-count=1', OID40],
  ['rev-list', '--first-parent', '--skip=1279', '--max-count=1280', OID64],
  ['rev-list', '--first-parent', '--skip=9999999999', '--max-count=9999999999', OID40],
  ['cat-file', '--batch-check'],
  ['cat-file', '--batch'],
];

test('vizGitArgvOk accepts exactly the Global Constraints forms', () => {
  for (const a of ALLOWED) assert.equal(vizGitArgvOk(a), true, JSON.stringify(a));

  const refused: (readonly string[])[] = [
    // S22
    ['rev-list', '--first-parent', '--all'],
    ['rev-parse', '--verify', '-q', 'refs/cowork-local/x'],
    ['rev-list', '--first-parent', 'HEAD'],
    ['rev-list', '--first-parent', '--max-count=01', OID40],
    ['rev-list', '--first-parent', '--skip=-1', '--max-count=1', OID40],
    ['cat-file', '-p', OID40],
    // an extra trailing argument on every allowed form
    ...ALLOWED.map((a) => [...a, 'extra']),
    ...ALLOWED.map((a) => [...a, '']),
    // every form missing its last argument
    ...ALLOWED.filter((a) => a.length > 1).map((a) => a.slice(0, -1)),
    // near misses
    [],
    ['VERSION'],
    ['version', '--build-options'],
    ['-c', 'protocol.allow=never', 'version'],
    ['--git-dir=/x', 'version'],
    ['rev-parse', '--verify', REF],
    ['rev-parse', '-q', '--verify', REF],
    ['rev-parse', '--verify', '-q', 'refs/cowork-remote/board'],
    ['rev-parse', '--verify', '-q', 'refs/cowork-remote//board'],
    ['rev-parse', '--verify', '-q', 'refs/cowork-remote/a b/board'],
    ['rev-parse', '--verify', '-q', `${REF}\n`],
    ['rev-parse', '--verify', '-q', 'refs/heads/main'],
    ['rev-parse', '--verify', '-q', 'refs/cowork-remote/main/board^{tree}'],
    ['rev-parse', '--verify', '-q', OID40],
    ['for-each-ref', 'refs/heads/'],
    ['for-each-ref', FORMAT, 'refs/cowork-local/'],
    ['for-each-ref', FORMAT, 'refs/'],
    ['for-each-ref', '-z', FORMAT, 'refs/cowork-remote/'],
    ['for-each-ref', '--format=%(objectname)', 'refs/cowork-remote/'],
    ['rev-list', '--first-parent', '--count', 'HEAD'],
    ['rev-list', '--first-parent', '--count', OID40.toUpperCase()],
    ['rev-list', '--first-parent', '--count', OID40.slice(1)],
    ['rev-list', '--count', '--first-parent', OID40],
    ['rev-list', '--first-parent', '--count', '--all'],
    ['rev-list', '--first-parent', '--max-count=12345678901', OID40],
    ['rev-list', '--first-parent', '--max-count=', OID40],
    ['rev-list', '--first-parent', '--max-count=+1', OID40],
    ['rev-list', '--first-parent', '--max-count=1e3', OID40],
    ['rev-list', '--first-parent', '--max-count=1 ', OID40],
    ['rev-list', '--first-parent', '--max-count', '1', OID40],
    ['rev-list', '--first-parent', '-n', '1', OID40],
    ['rev-list', '--first-parent', '--max-count=1', '--skip=1', OID40],
    ['rev-list', '--first-parent', '--skip=1', OID40],
    ['rev-list', '--first-parent', '--skip=1', '--skip=1', OID40],
    ['rev-list', '--first-parent', '--max-count=1', OID40, OID40],
    ['rev-list', '--first-parent', '--max-count=1', '--', OID40],
    ['rev-list', '--max-count=1', OID40],
    ['cat-file', '--batch-check=%(objectname)'],
    ['cat-file', '--batch', '--follow-symlinks'],
    ['cat-file', '--batch-all-objects'],
    ['cat-file', '--batch-command'],
    ['cat-file', 'blob', OID40],
    ['log'],
    ['show', OID40],
    ['fetch'],
    ['push'],
    ['update-ref', REF, OID40],
    ['gc'],
    ['checkout', 'main'],
    ['status'],
  ];
  for (const a of refused) assert.equal(vizGitArgvOk(a), false, JSON.stringify(a));
  oidAgreesWithIsOid();
});

test('vizGitArgvOk: a placeholder stands in for a positional slot or a --skip=/--max-count= value only, never a flag name', () => {
  const ok: string[][] = [
    ['rev-parse', '--verify', '-q', P],
    ['rev-list', '--first-parent', '--count', P],
    ['rev-list', '--first-parent', '--max-count=1281', P],
    ['rev-list', '--first-parent', `--max-count=${P}`, P],
    ['rev-list', '--first-parent', `--skip=${P}`, `--max-count=${P}`, P],
  ];
  for (const a of ok) {
    assert.equal(vizGitArgvOk(a, P), true, JSON.stringify(a));
    // Without the placeholder argument the same text is an ordinary (refused) value.
    assert.equal(vizGitArgvOk(a), false, `no placeholder: ${JSON.stringify(a)}`);
  }
  const refused: string[][] = [
    [P],
    [P, '--batch'],
    ['cat-file', P],
    ['rev-parse', P, '-q', REF],
    ['rev-parse', '--verify', P, REF],
    ['for-each-ref', P, 'refs/cowork-remote/'],
    ['for-each-ref', FORMAT, P],
    ['rev-list', P, '--count', OID40],
    ['rev-list', '--first-parent', P, OID40],
    ['rev-list', '--first-parent', P, P],
    ['rev-list', '--first-parent', P, `--max-count=${P}`, P],
    ['rev-list', '--first-parent', `--max-count=${P}`, P, P],
  ];
  for (const a of refused) assert.equal(vizGitArgvOk(a, P), false, JSON.stringify(a));
  // A placeholder that happens to spell a flag never stands in for that flag.
  assert.equal(vizGitArgvOk(['cat-file', '--batch'], '--batch'), false);
  assert.equal(vizGitArgvOk(['rev-parse', '--verify', '-q', REF], '-q'), false);
  assert.equal(vizGitArgvOk(['version'], 'version'), false);
});

/** Its <oid> test agrees with Plan 1's isOid: the same expression, and the same verdicts over a fast-check corpus. */
function oidAgreesWithIsOid(): void {
  // The same expression as OID_RE in src/git/oid.ts.
  const reOf = (rel: string, name: string): string => {
    const text = readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');
    const m = new RegExp(`const ${name} = (/.*/);`).exec(text);
    assert.ok(m !== null, `${rel} declares ${name}`);
    return m[1] as string;
  };
  assert.equal(reOf('src/viz/source/vizGitArgv.ts', 'OID_RE'), reOf('src/git/oid.ts', 'OID_RE'));

  // Hex strings of the two valid lengths, near misses around them (one foreign character, one character too
  // many or too few), and arbitrary strings, so both verdicts occur often.
  const hexOf = (n: number): fc.Arbitrary<string> =>
    fc.array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: n, maxLength: n }).map((a) => a.join(''));
  const foreign = fc.constantFrom(...'ABCDEFgxz -/\né'.split(''));
  const candidate = fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom(40, 64).chain(hexOf) },
    { weight: 2, arbitrary: fc.constantFrom(39, 41, 63, 65, 0, 1, 20).chain(hexOf) },
    {
      weight: 3,
      arbitrary: fc.tuple(fc.constantFrom(40, 64).chain(hexOf), foreign, fc.nat()).map(([h, c, i]) => {
        const at = i % (h.length + 1);
        return i % 2 === 0 ? h.slice(0, at) + c + h.slice(at + 1) : h.slice(0, at) + c + h.slice(at);
      }),
    },
    { weight: 1, arbitrary: fc.string() },
    { weight: 1, arbitrary: fc.constantFrom(`${OID40}\n`, ` ${OID40}`, `${OID64}\n`, OID40.toUpperCase(), '') },
  );
  let valid = 0;
  let invalid = 0;
  fc.assert(
    fc.property(candidate, (s) => {
      const expected = isOid(s);
      if (expected) valid++;
      else invalid++;
      return vizGitArgvOk(['rev-list', '--first-parent', '--count', s]) === expected
        && vizGitArgvOk(['rev-list', '--first-parent', '--max-count=1', s]) === expected
        && vizGitArgvOk(['rev-list', '--first-parent', '--skip=2', '--max-count=1', s]) === expected;
    }),
    { numRuns: 2_000 },
  );
  assert.ok(valid > 100 && invalid > 100, `corpus covers both verdicts (valid ${valid}, invalid ${invalid})`);
}

test('VIZ_GIT_SUBCOMMANDS names the subcommands that make an array literal a git argv for L-VIZ-GIT', () => {
  assert.deepEqual(
    [...VIZ_GIT_SUBCOMMANDS].sort(),
    ['cat-file', 'checkout', 'fetch', 'for-each-ref', 'gc', 'log', 'push', 'rev-list', 'rev-parse', 'show', 'update-ref', 'version'],
  );
  // Every allowed form starts with one of them.
  for (const a of ALLOWED) assert.ok(VIZ_GIT_SUBCOMMANDS.has(a[0] as string), a[0]);
});
