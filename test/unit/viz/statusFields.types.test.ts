// V19 (Plan 8a Task 7; 12 §3.3.2): every StatusFields member the viewer reads is assignable from Plan 2's StatusJson member of
// the same name (glossary §14), so a Plan 2 status.json change that the viewer's schema check would refuse fails the build.
// The check is compile-time, run through the TypeScript compiler API over a probe module importing both declarations: a
// static import of src/engine/status.ts would fail `tsc -p tsconfig.json` on a branch that predates Plan 2 Task 17, so the
// probe runs when that file exists and is SKIPPED (with the reason) before gate P brings it. COWORK_STATUS_JSON_TS may name
// another status.ts (an absolute path, e.g. the Plan 2 worktree's) to run the check before the merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STATUS_FIELDS = join(ROOT, 'src', 'viz', 'source', 'status.ts');

/** A module specifier from the probe's directory to a .ts file, as the repo writes them (.js suffix, '/' separators). */
function spec(fromDir: string, file: string): string {
  const r = relative(fromDir, file).replace(/\\/g, '/').replace(/\.ts$/, '.js');
  return r.startsWith('.') ? r : `./${r}`;
}

/** The probe's diagnostics: zero when every member is assignable; one named error per member that is not. */
function probe(statusJsonFile: string, extra = ''): string[] {
  const dir = join(ROOT, 'test', 'unit', 'viz');
  const file = join(dir, '__statusFields.probe.ts');
  const text = [
    `import type { StatusJson } from '${spec(dir, statusJsonFile)}';`,
    `import type { StatusFields } from '${spec(dir, STATUS_FIELDS)}';`,
    'type IsAny<T> = 0 extends 1 & T ? true : false;',
    'export const statusJsonIsReal: IsAny<StatusJson> = false;',
    'export const statusFieldsIsReal: IsAny<StatusFields> = false;',
    '/** The members of StatusFields that StatusJson lacks or types incompatibly. */',
    'type Bad = { [K in keyof StatusFields]: K extends keyof StatusJson ? ([StatusJson[K]] extends [StatusFields[K]] ? never : K) : K }[keyof StatusFields];',
    'export const everyMemberAssignable: [Bad] extends [never] ? true : Bad = true;',
    'export const whole = (s: StatusJson): StatusFields => s;',
    extra,
  ].join('\n');
  const config = ts.getParsedCommandLineOfConfigFile(join(ROOT, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  assert.ok(config !== undefined);
  const options = { ...config.options, noEmit: true };
  const host = ts.createCompilerHost(options);
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) => (norm(name) === norm(file) ? ts.createSourceFile(name, text, lang) : getSourceFile(name, lang, ...rest));
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => norm(name) === norm(file) || fileExists(name);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => (norm(name) === norm(file) ? text : readFile(name));
  const program = ts.createProgram([file], options, host);
  const sf = program.getSourceFile(file);
  assert.ok(sf !== undefined);
  return ts.getPreEmitDiagnostics(program, sf).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

test('every StatusFields member is assignable from Plan 2\'s StatusJson member of the same name', (t) => {
  const statusJson = process.env['COWORK_STATUS_JSON_TS'] ?? join(ROOT, 'src', 'engine', 'status.ts');
  if (!existsSync(statusJson)) {
    t.skip('Plan 2 Task 17 (src/engine/status.ts, StatusJson) is not on this branch yet; gate P brings it');
    return;
  }
  assert.match(readFileSync(statusJson, 'utf8'), /export interface StatusJson\b/);
  // One program: the real checks report nothing, and a control that narrows one member reports exactly that member (the
  // probe is not vacuous: StatusJson resolved, and a member it types differently is caught by name).
  const diags = probe(statusJson, [
    'type Narrow = Omit<StatusFields, \'loop_period_ms\'> & { loop_period_ms: string };',
    'type BadNarrow = { [K in keyof Narrow]: K extends keyof StatusJson ? ([StatusJson[K]] extends [Narrow[K]] ? never : K) : K }[keyof Narrow];',
    'export const controlNarrowed: [BadNarrow] extends [never] ? true : BadNarrow = true;',
  ].join('\n'));
  assert.equal(diags.length, 1, `every StatusFields member is assignable from StatusJson; only the control fails: ${JSON.stringify(diags)}`);
  assert.match(diags[0]!, /loop_period_ms/);
});
