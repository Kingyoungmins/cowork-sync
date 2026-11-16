// tools/build/claudeCatalog.ts — X-54, R5-11 (Plan 5 Task 2; Plan 6 extends it): the one writer of <outdir>/i18n/claude.{en,ko}.json, the
// Claude-facing template catalogs of glossary §6 / 06 §3.2, each the canonical JSON line (sorted keys, one line, LF) of src/i18n/claude.ts's
// merged registry for that language, so every row module the registry loads reaches dist with no list kept here.
// tools/build/build.mjs runs it for its own --outdir after emptying it (ruling P5-EB-5) and reads the three loader texts back from these files
// for dist/hook.js; it also runs alone: `node --import tsx tools/build/claudeCatalog.ts --outdir <dir>`. It exits on its own.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WireJson } from '../../src/claude/wire/frames.js';
import { canonicalJsonLine } from '../../src/claude/wire/ndjson.js';
import { claudeCatalogRows, type ClaudeLang } from '../../src/i18n/claude.js';

const LANGS: readonly ClaudeLang[] = ['en', 'ko'];

function outdirOf(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== '--outdir' || (argv[1] ?? '') === '') {
    process.stderr.write('usage: claudeCatalog.ts --outdir <dir>\n');
    process.exit(2);
  }
  return resolve(argv[1] as string);
}

const outdir = outdirOf(process.argv.slice(2));
const dir = join(outdir, 'i18n');
mkdirSync(dir, { recursive: true });
for (const lang of LANGS) {
  writeFileSync(join(dir, `claude.${lang}.json`), `${canonicalJsonLine(claudeCatalogRows(lang) as unknown as WireJson)}\n`);
}
