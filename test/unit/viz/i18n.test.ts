import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  CHANNEL_CAPS, registerCatalog, registerReasonCodes, render, type CatalogEntry, type ParamType, type Params,
} from '../../../src/i18n/render.js';
import { VIZ_CAPS, VIZ_RAW_UNITS } from '../../../src/text/sanitize.js';
import {
  ALL_VIZ_CODES, CHARACTER_BADGES, DEMO_CAPTION_CODES, FREEZE_REASON_CODES, HEALTH_REASON_CODES, PAGE_CODES, PAGE_SUBSET_PREFIXES, PH_CODES,
  PUBLISH_PAUSE_CODES, REASON_CODES, SS_CODES, STATUS_STATES, VIZ_CODES, type CodeGroup,
} from '../../../src/viz/i18n/codes.js';
import { EN_VIZ } from '../../../src/viz/i18n/en.js';

registerCatalog('en', EN_VIZ);
registerReasonCodes(REASON_CODES);

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const specText = (name: string): string => readFileSync(join(ROOT, 'docs', 'spec', name), 'utf8').split('\r\n').join('\n');
/** The text from the line matching `start` to the next line matching `end` (exclusive). */
function section(text: string, start: RegExp, end: RegExp): string {
  const lines = text.split('\n');
  const from = lines.findIndex((l) => start.test(l));
  assert.ok(from >= 0, `section ${start}`);
  const to = lines.findIndex((l, i) => i > from && end.test(l));
  return lines.slice(from, to < 0 ? undefined : to).join('\n');
}
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();
const CODE_RE = /^[A-Z][A-Z0-9_]{2,47}$/;
const FORBIDDEN_PREFIXES = ['UI_', 'RF_', 'SEC_', 'VIZ_', 'PH_', 'SS_', 'START_'];
const SEG = new Intl.Segmenter('en', { granularity: 'grapheme' });
const graphemeCount = (s: string): number => [...SEG.segment(s)].length;
const entryOf = (code: string): CatalogEntry => {
  assert.ok(Object.prototype.hasOwnProperty.call(EN_VIZ, code), `en template for ${code}`);
  return EN_VIZ[code] as CatalogEntry;
};

// glossary section 14 (status.json) and 10-product section 3.14 (peer health and seat states)
const G14 = section(specText('00-glossary.md'), /^## 14\. /, /^## /);
const P314 = section(specText('10-product.md'), /^### 3\.14 /, /^### /);
const PH_SPEC = new Map([...P314.matchAll(/^\| `(PH_[A-Z_]+)` \| ([^|]+?) \|/gm)].map((m) => [m[1] as string, m[2] as string]));
const SS_SPEC = new Map([...P314.matchAll(/`(SS_[A-Z_]+)` "([^"]+)"/g)].map((m) => [m[1] as string, m[2] as string]));
const DUR_SPEC = sorted([...specText('10-product.md').matchAll(/`(UI_DUR_[A-Z]+)`/g)].map((m) => m[1] as string));

test('the closed code sets hold only their registry values and no page-state code', () => {
  const stateLine = /^\s*state: ([^\n]+)/m.exec(G14)?.[1] ?? '';
  assert.deepEqual(sorted(STATUS_STATES), sorted([...stateLine.matchAll(/"([a-z]+)"/g)].map((m) => m[1] as string)));
  assert.equal(STATUS_STATES.size, 8);
  const freeze = /freeze_reasons: \[([^\]]+)\]/.exec(G14)?.[1] ?? '';
  assert.deepEqual(sorted(FREEZE_REASON_CODES), sorted(freeze.split('|').map((s) => s.trim())));
  assert.equal(FREEZE_REASON_CODES.size, 6);
  const pause = /publish_pause: null \| ([^\n]+)/.exec(G14)?.[1] ?? '';
  assert.deepEqual(sorted(PUBLISH_PAUSE_CODES), sorted([...pause.matchAll(/"([A-Z]+)"/g)].map((m) => m[1] as string)));
  assert.equal(PUBLISH_PAUSE_CODES.size, 4);
  assert.deepEqual(sorted(HEALTH_REASON_CODES), ['BOARD_FULL', 'HOST_THROTTLED']);
  assert.deepEqual(sorted(PH_CODES), sorted(PH_SPEC.keys()));
  assert.equal(PH_CODES.size, 8);
  assert.deepEqual(sorted(SS_CODES), sorted(SS_SPEC.keys()));
  assert.equal(SS_CODES.size, 7);
  assert.deepEqual(sorted(REASON_CODES), sorted([...FREEZE_REASON_CODES, ...HEALTH_REASON_CODES, ...PUBLISH_PAUSE_CODES]));
  for (const set of [FREEZE_REASON_CODES, HEALTH_REASON_CODES, PUBLISH_PAUSE_CODES, REASON_CODES]) {
    for (const code of set) {
      assert.match(code, CODE_RE);
      assert.ok(!FORBIDDEN_PREFIXES.some((p) => code.startsWith(p)), `${code} carries a viewer or registry prefix`);
      assert.ok(!ALL_VIZ_CODES.has(code) && !PAGE_SUBSET_PREFIXES.some((p) => code.startsWith(p)), `${code} is a page code`);
      entryOf(code);
    }
  }
  for (const s of STATUS_STATES) assert.match(s, /^[a-z]+$/);
  assert.deepEqual(sorted(CHARACTER_BADGES), ['UI_VIZ_BADGE_CREDIT', 'UI_VIZ_BADGE_HEALTH', 'UI_VIZ_BADGE_RULES', 'UI_VIZ_BADGE_VERSION']);
  for (const b of CHARACTER_BADGES) assert.ok(VIZ_CODES.scene.includes(b), b);
  for (const c of [...PH_CODES, ...SS_CODES]) assert.ok(VIZ_CODES.reused.includes(c), c);
  assert.deepEqual([...PAGE_SUBSET_PREFIXES], ['UI_VIZ_', 'PH_', 'SS_', 'UI_DUR_']);
  const page = [...ALL_VIZ_CODES].filter((c) => PAGE_SUBSET_PREFIXES.some((p) => c.startsWith(p)));
  assert.deepEqual(sorted(PAGE_CODES), sorted([...page, ...REASON_CODES, 'UI_INTERNAL_ERROR']));
  for (const c of ['UI_DUR_S', 'PH_FROZEN', 'SS_FULL', 'UI_VIZ_LINK_REUSED', 'EPOCH', 'UI_INTERNAL_ERROR']) assert.ok(PAGE_CODES.has(c), c);
  for (const c of PAGE_CODES) assert.ok(!/^(RF|SEC|VIZ|START)_/.test(c), `${c} is not served to the page`);
});

// 12 section 3.11 "Codes defined by this chapter", parsed from the spec: `_X` tokens take the prefix named by the next
// "prefixed `P`"; `PH_*`, `SS_*` and `UI_DUR_*` expand to 10-product's lists; `UI_VIZ_DEMO_CAPTION_<n>` to the defined captions.
const ROW_GROUP: Readonly<Record<string, CodeGroup>> = {
  'CLI': 'cli', 'Page states': 'page', 'Scene labels': 'scene', 'Icons': 'icon', 'Cards': 'card', 'Recording': 'recording',
  'Controls and filters': 'control', 'Log only': 'log', 'Reused': 'reused',
};
/** Codes a ruling adds to a row of the table ahead of the spec text (spec-edit list). None now: R-V67's VIZ_LOG_DROPPED is in the
 *  §3.11 "Log only" row since Plan 8a Task 19, which dropped its entry here. */
const PENDING_SPEC_EDITS: Readonly<Partial<Record<CodeGroup, readonly string[]>>> = {};
function specTable(): Map<CodeGroup, string[]> {
  const v311 = section(specText('12-visualizer.md'), /^### 3\.11 /, /^### /);
  const out = new Map<CodeGroup, string[]>();
  for (const line of v311.split('\n')) {
    const m = /^\| ([^|]+?) \| (.+) \|$/.exec(line);
    if (m === null) continue;
    const label = (m[1] as string).split(' (')[0] as string;
    if (label === 'Group' || label.startsWith('---')) continue;
    const group = ROW_GROUP[label];
    assert.ok(group !== undefined, `unknown row ${label}`);
    const codes: string[] = [];
    let pending: string[] = [];
    for (const t of (m[2] as string).matchAll(/prefixed `([A-Z_]+)`|`([^`]+)`/g)) {
      if (t[1] !== undefined) { codes.push(...pending.map((s) => `${t[1]}${s}`)); pending = []; continue; }
      const tok = t[2] as string;
      if (tok === 'UI_VIZ_DEMO_CAPTION_<n>') { codes.push(...DEMO_CAPTION_CODES); continue; }
      if (!/^[A-Z_][A-Z0-9_*]*$/.test(tok)) continue;   // e.g. the carrier kind `viz`
      if (!tok.startsWith('_') && !/^(UI|RF|SEC|VIZ|PH|SS|START)_/.test(tok)) {
        // R-V43's spec edit adds the reason codes to the Reused row: they are REASON_CODES, kept out of ALL_VIZ_CODES.
        assert.ok(REASON_CODES.has(tok), `${label}: ${tok} is neither a viewer code nor a reason code`);
        continue;
      }
      if (tok.startsWith('_')) pending.push(tok);
      else if (tok === 'PH_*') codes.push(...PH_SPEC.keys());
      else if (tok === 'SS_*') codes.push(...SS_SPEC.keys());
      else if (tok === 'UI_DUR_*') codes.push(...DUR_SPEC);
      else codes.push(tok);
    }
    assert.deepEqual(pending, [], `${label}: a suffix without its prefix`);
    // A code a ruling adds to the table before the spec text has it; once the spec edit lands the code must leave this list.
    for (const code of PENDING_SPEC_EDITS[group] ?? []) {
      assert.ok(!codes.includes(code), `${code} is in the spec's ${label} row now: remove it from PENDING_SPEC_EDITS`);
      codes.push(code);
    }
    out.set(group, codes);
  }
  return out;
}

const CARD_PLACEHOLDERS: ReadonlySet<string> = new Set(['name', 'target', 'n', 'path', 'id', 'label']);
const OTHER_PLACEHOLDERS: ReadonlySet<string> = new Set([
  ...CARD_PLACEHOLDERS, 'people', 'sessions', 'open', 'conflicts', 'zone', 'height', 'reason', 'cmd', 'est_minutes', 'lo', 'hi',
]);
// {height} is a board height, printed as plain digits like every other '#<height>' of the page (the log's position label, the
// rewind bar): an 'id' (String(v)), never an 'n' (Intl.NumberFormat would print '#1,024'; final review §4a, Group B).
const TYPE_OF: Readonly<Record<string, ParamType>> = {
  name: 'name', target: 'name', n: 'n', path: 'path', id: 'id', label: 'label', people: 'n', sessions: 'n', open: 'n', conflicts: 'n',
  zone: 'path', height: 'id', reason: 'reason', cmd: 'cmd', est_minutes: 'n', lo: 'n', hi: 'n', url: 'url',
};
const templatesOf = (e: CatalogEntry): string[] => [e.text, ...Object.values(e.forms ?? {}).filter((x): x is string => typeof x === 'string')];
const placeholdersOf = (s: string): string[] => [...s.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1] as string);
// en wording the spec gives verbatim
const SPEC_WORDING: Readonly<Record<string, string>> = {
  UI_VIZ_OPENED: 'Opened the read-only viewer in your browser. It stops 10 minutes after you close the tab.',
  UI_VIZ_DEMO_BANNER: 'Demo data \u2014 not your team',
  UI_VIZ_ROOM_DOWN: 'cowork-sync is not running on this PC',
  UI_VIZ_LAST_FETCH: 'last fetch {n} min ago',
  UI_VIZ_SEEN_AGO: 'seen {n} min ago',
  UI_VIZ_SEEN_BEFORE_OPEN: 'before this view opened',
  UI_VIZ_SIGN_BASE_MOVE: 'following the saved branch',
  UI_VIZ_HOST_REFUSED: 'the host refused pushes from this PC for a while; sharing has resumed',
  UI_VIZ_TAG_CHECKS: 'waiting for checks',
  UI_VIZ_CHIP_ASKED_AGAIN: 'asked again',
  UI_VIZ_BADGE_RULES: 'different rules',
  UI_VIZ_GRANT_PAUSE: "paused for {name}'s change",
  UI_VIZ_BUBBLE_GO_FIRST: 'go first? ~{est_minutes} min',
  UI_VIZ_SCENE_SUMMARY: '{people} people, {sessions} Claude sessions, {open} requests open, {conflicts} conflicts',
  UI_VIZ_BIG_TABLE: '{n} files',
  // (8a final review, spec batch item 9) the shelf plaque as landed; 12 §3.5.3 adopts it (was "{zone}/… +{n}")
  UI_VIZ_SHELF_DESK: 'more files in {zone}',
  UI_VIZ_CARD_PUBLISH: '{name} shared {n} files',
  UI_VIZ_CARD_SAVE: '{name} saved',
  UI_VIZ_HOLDING: 'holding {label}',
  UI_VIZ_TAG_LINES: 'lines {lo}\u{2013}{hi}',
  UI_VIZ_STOPPED: 'The viewer stopped. Run /cowork view to open it again.',
  UI_VIZ_LINK_EXPIRED: 'This link has expired. Run /cowork view again.',
  UI_VIZ_LINK_REUSED: 'This link was opened twice, so the viewer stopped. If you did not open it twice, another program or user on this PC may '
    + 'have opened it. Run /cowork view again.',
  UI_VIZ_RECORD_NOTICE: "This recording will show your teammates' names, file names and notes.",
  // (rev 2.5, F32; Task 19) the follow codes, as 12 §3.8.1 gives them
  UI_VIZ_CTRL_FOLLOW: 'Follow',
  UI_VIZ_FOLLOWING: 'Following {name}',
  UI_VIZ_NOW_ASKS: 'asks {target} ({id})',
  UI_VIZ_NOW_ASKED_BY: 'asked by {target} ({id})',
  UI_VIZ_NOW_LAST_SHARED: 'last shared: {path} (#{height})',
  UI_VIZ_NOW_LAST_SHARED_TABLE: 'last shared: a change too large to list (#{height})',
  UI_VIZ_NOW_NOTHING: 'Nothing held, asked or shared yet in this view.',
  UI_VIZ_NOW_NOT_HERE: '{name} is not in this room at this point.',
  // (8a batch, after Plan 2's; FEAT-F32-11) the follow end offered to the announcer, as 12 §3.8.1 gives it
  UI_VIZ_FOLLOW_ENDED: 'Stopped following {name}',
};

test('T-VIZ-i18n (en): every code of the 12 \u00a73.11 table is in VIZ_CODES and has an en template; every template fits the viz caps at worst-case parameters; every UI_VIZ_CARD_* template uses only {name}, {target}, {n}, {path}, {id} and {label}; the other codes use only those and {people}, {sessions}, {open}, {conflicts}, {zone}, {height}, {reason}, {cmd}, {est_minutes}, {lo}, {hi} and (UI_VIZ_URL only) {url}', () => {
  // VIZ_CODES is exactly the table, group by group; ALL_VIZ_CODES is their union
  const table = specTable();
  assert.deepEqual(sorted(table.keys()), sorted(Object.keys(VIZ_CODES)));
  const all: string[] = [];
  for (const [group, codes] of table) {
    assert.deepEqual(sorted(VIZ_CODES[group]), sorted(codes), group);
    assert.equal(new Set(VIZ_CODES[group]).size, VIZ_CODES[group].length, `${group}: no duplicate`);
    all.push(...VIZ_CODES[group]);
  }
  assert.equal(new Set(all).size, all.length, 'the groups are disjoint');
  assert.deepEqual(sorted(ALL_VIZ_CODES), sorted(all));
  assert.deepEqual([...DEMO_CAPTION_CODES], [1, 2, 3, 4, 5].map((n) => `UI_VIZ_DEMO_CAPTION_${n}`));
  // EN_VIZ: exactly every table code and every reason code
  assert.deepEqual(sorted(Object.keys(EN_VIZ)), sorted([...ALL_VIZ_CODES, ...REASON_CODES]));
  for (const code of Object.keys(EN_VIZ)) assert.match(code, CODE_RE);
  // placeholders: the allowed set per code, each declared with its type, each declaration used
  for (const [code, e] of Object.entries(EN_VIZ)) {
    const allowed = code.startsWith('UI_VIZ_CARD_') ? CARD_PLACEHOLDERS : OTHER_PLACEHOLDERS;
    const used = new Set<string>();
    for (const t of templatesOf(e)) {
      assert.ok(t.length > 0, code);
      assert.ok(!/[{}]/u.test(t.replace(/\{[a-z_]+\}/g, '')), `${code}: stray brace`);
      assert.ok(!/[<>]/u.test(t), `${code}: no < or > in a template (served text has none, T-VIZ-text)`);
      for (const p of placeholdersOf(t)) {
        assert.ok(allowed.has(p) || (p === 'url' && code === 'UI_VIZ_URL'), `${code}: {${p}}`);
        assert.equal(e.params?.[p], TYPE_OF[p], `${code}: {${p}} is declared as ${TYPE_OF[p]}`);
        used.add(p);
      }
    }
    assert.deepEqual(sorted(Object.keys(e.params ?? {})), sorted(used), `${code}: every declared parameter is used`);
    if (e.plural !== undefined) assert.equal(e.params?.[e.plural], 'n', `${code}: plural on an n parameter`);
  }
  // every template fits the viz caps at worst-case parameters (rendered uncapped, in the terminal channel, which keeps the URL)
  const longestReason = [...REASON_CODES].reduce((a, b) => (entryOf(b).text.length > entryOf(a).text.length ? b : a));
  const worst = (filler: string): Readonly<Record<ParamType, string | number>> => ({
    name: filler.repeat(200), path: filler.repeat(2_000), label: filler.repeat(2_000), id: filler.repeat(2_000), note: filler.repeat(2_000),
    text: filler.repeat(2_000), code: 'C'.repeat(48), n: Number.MAX_SAFE_INTEGER, dur: 1e15, reason: longestReason,
    url: `${'http'}://127.0.0.1:65535/#k=${'f'.repeat(64)}`, cmd: `node "C:\\${'d'.repeat(240)}\\dist\\cli.js" view`,
  });
  for (const filler of ['W', '\u{1F1F0}\u{1F1F7}']) {
    const w = worst(filler);
    for (const [code, e] of Object.entries(EN_VIZ)) {
      for (const n of [1, Number.MAX_SAFE_INTEGER]) {
        const params: Params = Object.fromEntries(Object.entries(e.params ?? {}).map(([k, t]) => [k, k === e.plural ? n : w[t]]));
        const out = render(code, params, 'terminal', 'en');
        assert.ok(graphemeCount(out) <= (CHANNEL_CAPS.viz as number), `${code}: ${graphemeCount(out)} graphemes`);
        assert.ok(out.length <= VIZ_RAW_UNITS.card, `${code}: ${out.length} code units`);
      }
    }
  }
  for (const code of DEMO_CAPTION_CODES) {
    const t = entryOf(code).text;
    assert.ok(graphemeCount(t) >= 1 && graphemeCount(t) <= VIZ_CAPS.caption, code);
    assert.deepEqual(placeholdersOf(t), [], code);
  }
  // en wording the spec fixes
  for (const [code, text] of Object.entries(SPEC_WORDING)) assert.equal(entryOf(code).text, text, code);
  for (const [code, text] of [...PH_SPEC, ...SS_SPEC]) assert.equal(entryOf(code).text, text, code);
  assert.deepEqual(entryOf('PH_FROZEN').params, { reason: 'reason' });
});

// The source scan of VIZ-39 "no code outside the 12 section 3.11 table": every string literal in src/viz/** shaped like a
// viewer-family code. A literal ending in '_' is a prefix (PAGE_SUBSET_PREFIXES), not a code.
const LITERAL_RE = /^(UI|RF|SEC|VIZ|PH|SS|START)_[A-Z0-9_]+$/;
function codeLiterals(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && LITERAL_RE.test(node.text) && !node.text.endsWith('_')) {
      out.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(full));
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('a {height} renders as plain digits, as the log\'s position label and the rewind bar print it (#1024, never #1,024)', () => {
  const withHeight = Object.entries(EN_VIZ).filter(([, e]) => e.params?.['height'] !== undefined).map(([code]) => code).sort();
  assert.deepEqual(withHeight, ['UI_VIZ_LAST_SHARED_HERE', 'UI_VIZ_NOW_LAST_SHARED', 'UI_VIZ_NOW_LAST_SHARED_TABLE']);
  assert.equal(render('UI_VIZ_LAST_SHARED_HERE', { path: 'src/a.ts', height: 1_024 }, 'viz', 'en'), 'last shared here: src/a.ts (#1024)');
  assert.equal(render('UI_VIZ_NOW_LAST_SHARED', { path: 'src/a.ts', height: 17_280 }, 'viz', 'en'), 'last shared: src/a.ts (#17280)');
  assert.equal(render('UI_VIZ_NOW_LAST_SHARED_TABLE', { height: 1_234_567 }, 'viz', 'en'), 'last shared: a change too large to list (#1234567)');
  for (const code of withHeight) assert.doesNotMatch(render(code, { path: 'p', height: 9_007_199_254_740_991 }, 'viz', 'en'), /#\d{1,3},/u, code);
});

test('every code literal in src/viz/** is in ALL_VIZ_CODES', () => {
  assert.deepEqual(
    codeLiterals('planted.ts', "const a = 'UI_VIZ_BOGUS'; const b = `RF_NOPE`; const c = 'UI_VIZ_'; const d = 'ui_viz_x'; const e = { k: 'UI_VIZ_OPENED' };"),
    ['UI_VIZ_BOGUS', 'RF_NOPE', 'UI_VIZ_OPENED'],
  );
  const files = tsFiles(join(ROOT, 'src', 'viz'));
  assert.ok(files.some((f) => f.endsWith('codes.ts')), 'the scan reads src/viz/i18n/codes.ts');
  const outside: string[] = [];
  let seen = 0;
  for (const f of files) {
    for (const lit of codeLiterals(f, readFileSync(f, 'utf8'))) {
      seen += 1;
      if (!ALL_VIZ_CODES.has(lit)) outside.push(`${f}: ${lit}`);
    }
  }
  assert.deepEqual(outside, []);
  assert.ok(seen >= ALL_VIZ_CODES.size, `${seen} code literals scanned`);
});
