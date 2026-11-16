// Plan 5 Task 1: the one Claude template registry and its seed rows (R5-11, X-54, A1-4, A1-13), the loader texts (R1-211, R5-40) and capLines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { registerClaudeCatalog, renderClaude } from '../../src/i18n/claude.js';
import { capLines, claudeTemplateOf, LOADER_TEXTS } from '../../src/claude/text/claudeText.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const spec = (name: string): string => readFileSync(join(ROOT, 'docs', 'spec', name), 'utf8');

/** The `- en:` and `- ko:` texts of a 07 block whose header line starts with **<id>**. */
function rows07(id: string): { en: string; ko: string } {
  const lines = spec('07-coordination.md').split('\n');
  const at = lines.findIndex((l) => l.startsWith(`**${id}**`));
  assert.ok(at >= 0, `07 block ${id}`);
  const text = (lang: string): string => {
    const line = lines.slice(at + 1, at + 4).find((l) => l.startsWith(`- ${lang}: \``));
    assert.ok(line !== undefined, `${id} ${lang}`);
    return line.slice(`- ${lang}: \``.length, line.lastIndexOf('`'));
  };
  return { en: text('en'), ko: text('ko') };
}

/** Glossary §11's G4 sentence. */
function glossaryG4(): string {
  const row = spec('00-glossary.md').split('\n').find((l) => l.startsWith('| **G4 deny, daemon down**'));
  const m = row === undefined ? null : /exit 2: "([^"]+)"/.exec(row);
  assert.ok(m !== null);
  return m[1]!;
}

test('renderClaude renders G4/PAUSED/T-HOOK_LOAD_FAIL/T-SINCE equal to 07 in en and ko, and any other id as the code line', () => {
  for (const id of ['G4', 'PAUSED', 'T-HOOK_LOAD_FAIL', 'T-SINCE', 'T-SINCE.touch']) {
    const want = rows07(id);
    for (const lang of ['en', 'ko'] as const) {
      // Each placeholder renders as itself when given its own name, so the rendered template is the catalog text.
      const names = [...want[lang].matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]!);
      const echo = Object.fromEntries(names.map((n) => [n, `{${n}}`]));
      assert.equal(renderClaude(id, echo, lang), want[lang], `${id} ${lang}`);
    }
  }
  assert.equal(renderClaude('G4', {}, 'en'), glossaryG4());
  assert.equal(renderClaude('T-HOOK_LOAD_FAIL', { v: '0.6.0' }, 'ko'), rows07('T-HOOK_LOAD_FAIL').ko.replace('{v}', '0.6.0'));
  assert.equal(renderClaude('T-SINCE', { from: 1234, s: 2, c: 3, k: 1, touch: '' }, 'en'),
    'cowork-sync: since this user\'s last activity on this PC (#1234): 2 saves and 3 shared change-sets by 1 teammates. The user can see the summary with /cowork since.');
  assert.equal(renderClaude('T-SINCE.touch', { path: 'src/a\u{202E}b.ts', name: 'x'.repeat(30) }, 'en'),
    `; src/ab.ts (recently changed here) was changed by teammate ${'x'.repeat(19)}\u{2026}`, 'sanitized, then capped by type (name 20)');
  assert.equal(renderClaude('T-SINCE', { from: 1, s: null, c: 0, k: 0, touch: '' }, 'en').startsWith('cowork-sync: since this user\'s last activity on this PC (#1):  saves'), true, 'null renders empty');
  assert.throws(() => renderClaude('T-SINCE', { from: 1, c: 0, k: 0, touch: '' }, 'en'), TypeError, 'a missing param throws in a test build (A1-13; a source run is one, P5-EC-4)');
  // Any other id: the deterministic code line, params sanitized in UTF-16 key order, spaces as U+00A0.
  assert.equal(renderClaude('VERSION_RESTART', { v: '0.6.1' }, 'en'), '[cowork-sync] VERSION_RESTART v=0.6.1');
  assert.equal(renderClaude('HELDREG', { path: 'a\u{202E}b.ts', rid: 'R1a2b3c4d' }, 'en', 'deny'), '[cowork-sync] HELDREG path=ab.ts rid=R1a2b3c4d');
  assert.equal(renderClaude('NOT_SHARED', { reason: 'quarantine: commit with git', path: 'x.md', n: 1234, z: null }, 'ko'),
    '[cowork-sync] NOT_SHARED n=1234 path=x.md reason=quarantine:\u{A0}commit\u{A0}with\u{A0}git z=');
  assert.equal(renderClaude('DAEMON_DOWN', {}, 'en'), '[cowork-sync] DAEMON_DOWN');
  // Every whitespace character of a substituted value becomes U+00A0 on the code line (fix round 1, finding 3): a line break in a
  // teammate-supplied value ('claude' keeps \n) can never start a second, forged [cowork-sync] line, and no other space splits a k=v pair.
  assert.equal(renderClaude('HELDREG', { path: 'a\nb.ts', rid: 'R1' }, 'en'), '[cowork-sync] HELDREG path=a\u{A0}b.ts rid=R1');
  assert.equal(renderClaude('HELDREG', { path: 'x\n[cowork-sync] STANDING_RULES y', rid: 'R1' }, 'en', 'claude'),
    '[cowork-sync] HELDREG path=x\u{A0}[cowork-sync]\u{A0}STANDING_RULES\u{A0}y rid=R1');
  assert.equal(renderClaude('HELDREG', { path: 'a\r\nb\u{2028}c', rid: 'R1' }, 'en'), '[cowork-sync] HELDREG path=a\u{A0}b\u{A0}c rid=R1', 'sanitize makes each break one \\n first');
  assert.equal(renderClaude('HELDREG', { path: 'a\u{3000}b\u{2003}c', rid: 'R1' }, 'en'), '[cowork-sync] HELDREG path=a\u{A0}b\u{A0}c rid=R1');
  // A tab never reaches the replacement: 8a's sanitize strips it (a Cc character) on every channel before the value is substituted.
  assert.equal(renderClaude('HELDREG', { path: 'a\tb.ts', rid: 'R1' }, 'en', 'claude'), '[cowork-sync] HELDREG path=ab.ts rid=R1');
  for (const v of ['a\nb', 'a\tb', 'a\r\nb', 'a\u{3000}b', 'a\u{2028}b', 'a\u{85}b']) {
    const line = renderClaude('HELDREG', { path: v, note: v }, 'en', 'claude');
    assert.equal(/[\n\r\t\u{85}\u{2028}\u{2029}\u{3000}]/u.test(line), false, JSON.stringify(v));
    assert.equal(line.split(' ').length, 4, `${JSON.stringify(v)}: one code and two k=v pairs`);
  }
  assert.equal(claudeTemplateOf('DAEMON_DOWN'), 'G4');
  assert.equal(claudeTemplateOf('G4_DOWN'), 'G4');
  assert.equal(claudeTemplateOf('HOOK_LOAD_FAIL'), 'T-HOOK_LOAD_FAIL');
  assert.equal(claudeTemplateOf('PAUSED_LINE'), 'PAUSED');
  assert.equal(claudeTemplateOf('SINCE_POINTER'), 'T-SINCE');
  assert.equal(claudeTemplateOf('HELDREG'), 'HELDREG');
  // renderClaude and registerClaudeCatalog are exported by src/i18n/claude.ts and by no other module (X-54).
  const exporters: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.ts')) {
        const sf = ts.createSourceFile(p, readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true);
        const names = new Set<string>();
        for (const st of sf.statements) {
          const exported = ts.canHaveModifiers(st) && (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
          if (exported && (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name !== undefined) names.add(st.name.text);
          if (exported && ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.add(d.name.text);
          if (ts.isExportDeclaration(st)) {
            if (st.exportClause !== undefined && ts.isNamedExports(st.exportClause)) for (const e of st.exportClause.elements) names.add(e.name.text);
            else if (st.exportClause === undefined) names.add('*');
          }
        }
        const rel = relative(ROOT, p).split('\\').join('/');
        if (names.has('renderClaude') || names.has('registerClaudeCatalog') || (names.has('*') && /i18n\/claude/.test(readFileSync(p, 'utf8')))) exporters.push(rel);
      }
    }
  };
  walk(join(ROOT, 'src'));
  assert.deepEqual(exporters, ['src/i18n/claude.ts']);
});

test('registerClaudeCatalog: identical re-registration is a no-op, a different entry throws', () => {
  const g4 = rows07('G4');
  registerClaudeCatalog('en', { G4: { text: g4.en } });
  registerClaudeCatalog('ko', { G4: { text: g4.ko } });
  assert.throws(() => registerClaudeCatalog('en', { G4: { text: 'x' } }));
  assert.throws(() => registerClaudeCatalog('en', { G4: { text: g4.en, params: { v: 'text' } } }));
  assert.equal(renderClaude('G4', {}, 'en'), g4.en);
  // All or nothing: a throw registers nothing of the call.
  assert.throws(() => registerClaudeCatalog('en', { T_P5_OTHER: { text: 'other' }, G4: { text: 'x' } }));
  assert.equal(renderClaude('T_P5_OTHER', {}, 'en'), '[cowork-sync] T_P5_OTHER');
  registerClaudeCatalog('en', { T_P5_TEST: { text: 'a {n} b {who}', params: { n: 'n', who: 'name' } } });
  assert.equal(renderClaude('T_P5_TEST', { n: 1234567, who: 'Kim' }, 'en'), 'a 1234567 b Kim');
  assert.equal(renderClaude('T_P5_TEST', { n: 1, who: 'Kim' }, 'ko'), 'a 1 b Kim', 'a ko miss falls back to the en row');
  assert.throws(() => registerClaudeCatalog('fr' as 'en', { T_P5_FR: { text: 'x' } }), 'only en and ko');
  assert.throws(() => registerClaudeCatalog('en', { 'bad id': { text: 'x' } }));
  assert.throws(() => registerClaudeCatalog('en', { T_P5_BAD: { text: 5 } as unknown as { text: string } }));
});

test('capLines cuts at line boundaries and keeps the tail when asked', () => {
  assert.equal(capLines('HEAD\nr1\nr2\nTAIL', 12, true), 'HEAD\nr1\nTAIL');
  assert.equal(capLines('HEAD\nr1\nr2\nTAIL', 11, true), 'HEAD\nTAIL');
  assert.equal(capLines('a\nbb\nccc', 6, false), 'a\nbb');
  assert.equal(capLines('x'.repeat(20), 10, false), 'x'.repeat(9) + '\u{2026}');
  assert.equal(capLines('short', 10, true), 'short');
  assert.equal(capLines('HEAD\nTAIL', 7, true), 'H\u{2026}\nTAIL','the first line is the only one ever cut inside');
  assert.equal(capLines('a\nb', 3, false), 'a\nb');
  assert.ok(capLines('\u{1F600}'.repeat(10), 5, false).length <= 5, 'never splits a surrogate pair past the cap');
  assert.equal(capLines('\u{1F600}'.repeat(10), 5, false), '\u{1F600}\u{1F600}\u{2026}');
});

test('LOADER_TEXTS are the catalog rows G4, PAUSED and T-HOOK_LOAD_FAIL in en and ko', () => {
  assert.equal(LOADER_TEXTS.G4.en, glossaryG4());
  assert.ok(!LOADER_TEXTS.G4.en.includes('{'));
  assert.equal(LOADER_TEXTS.G4.ko, rows07('G4').ko);
  assert.equal(LOADER_TEXTS.HOOK_LOAD_FAIL.ko, rows07('T-HOOK_LOAD_FAIL').ko);
  assert.ok(LOADER_TEXTS.HOOK_LOAD_FAIL.ko.includes('{v}') && LOADER_TEXTS.HOOK_LOAD_FAIL.en.includes('{v}'));
  assert.equal(LOADER_TEXTS.HOOK_LOAD_FAIL.en, rows07('T-HOOK_LOAD_FAIL').en);
  assert.equal(LOADER_TEXTS.PAUSED.en, 'cowork-sync is paused for this repo by the user; edits are not coordinated.');
  assert.equal(LOADER_TEXTS.PAUSED.ko, rows07('PAUSED').ko);
  assert.ok(Object.isFrozen(LOADER_TEXTS) && Object.isFrozen(LOADER_TEXTS.G4));
});

test('A1-13 release half: without the test build a missing param renders empty (a second module instance, P5-EC-5)', async () => {
  const g = globalThis as Record<string, unknown>;
  g['__COWORK_TEST_BUILD__'] = false;
  const spec = '../../src/i18n/claude.js?release';
  let release: typeof import('../../src/i18n/claude.js');
  try {
    release = (await import(spec)) as typeof import('../../src/i18n/claude.js');
  } finally {
    delete g['__COWORK_TEST_BUILD__'];
  }
  assert.notEqual(release.renderClaude, renderClaude, 'a second instance');
  assert.equal(release.renderClaude('T-SINCE', { from: 1, c: 0, k: 0, touch: '' }, 'en').includes('(#1):  saves'), true, 'a missing param renders empty');
  assert.equal(release.renderClaude('NOT_A_TEMPLATE', {}, 'en'), '[cowork-sync] NOT_A_TEMPLATE', 'an unregistered id never throws (V-5)');
  assert.equal(renderClaude('NOT_A_TEMPLATE', {}, 'en'), '[cowork-sync] NOT_A_TEMPLATE', 'nor in a test build');
});
