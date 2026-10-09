// Plan 8a Task 14: static checks of the page's source (12 §3.10.5, §3.10.7, §3.11, §9.5; VIZ-34, VIZ-37, VIZ-39, VIZ-40; I18N-07;
// V8, S11). Every string literal of src/viz/client/** is a code, a class of the fixed enum map, an /api/v1/ path, a header name or
// a DOM API name; every fetch is one route's literal path with credentials omit, cache no-store and redirect error, and a route
// whose room id, height or language fails its check makes no request; classes come only from the enum map and canvas colours
// only from the palette; app.css carries the light and dark token sets at ≥ 4.5:1.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';
import { ALL_VIZ_CODES, REASON_CODES } from '../../../src/viz/i18n/codes.js';
import { BODY_HUES, PALETTE, type Rgb } from '../../../src/viz/render/palette.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const CLIENT = 'src/viz/client';
const read = (rel: string): string => readFileSync(path.join(REPO, ...rel.split('/')), 'utf8');
/** The page's modules (12 §3.13; the brief's file list): each must exist. */
const CLIENT_FILES = ['a11y.ts', 'api.ts', 'log.ts', 'main.ts', 'office.ts', 'rewind.ts'];

function clientSources(): Array<{ file: string; sf: ts.SourceFile }> {
  const names = readdirSync(path.join(REPO, CLIENT)).filter((n) => n.endsWith('.ts')).sort();
  for (const f of CLIENT_FILES) assert.ok(names.includes(f), `${CLIENT}/${f} exists`);
  return names.map((n) => {
    const file = `${CLIENT}/${n}`;
    return { file, sf: ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) };
  });
}
const lineOf = (sf: ts.SourceFile, n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
function walk(n: ts.Node, f: (n: ts.Node) => void): void {
  f(n);
  ts.forEachChild(n, (c) => walk(c, f));
}
function unwrap(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x) || ts.isSatisfiesExpression(x)) x = x.expression;
  return x;
}
const memberName = (n: ts.Node): string | null =>
  ts.isPropertyAccessExpression(n) ? n.name.text : ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression) ? n.argumentExpression.text : null;

// ---------------------------------------------------------------------------------------------------------------
// The enum map of classes (a11y.ts CLS) and the closed string types the page shares with the server (wire codes)

/** The values of `export const CLS = Object.freeze({ … })` in a11y.ts: the only classes the page sets. */
function classMap(): Map<string, string> {
  const sf = clientSources().find((s) => s.file.endsWith('/a11y.ts'))!.sf;
  const map = new Map<string, string>();
  walk(sf, (n) => {
    if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.name.text !== 'CLS' || n.initializer === undefined) return;
    let init = unwrap(n.initializer);
    if (ts.isCallExpression(init) && init.arguments[0] !== undefined) init = unwrap(init.arguments[0]);
    assert.ok(ts.isObjectLiteralExpression(init), 'CLS is an object literal');
    for (const p of init.properties) {
      assert.ok(ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && ts.isStringLiteral(p.initializer), `CLS entry at line ${lineOf(sf, p)} is name: 'class'`);
      map.set(p.name.text, p.initializer.text);
    }
  });
  assert.ok(map.size > 10, 'a11y.ts exports the class enum map CLS');
  return map;
}

/** The closed string types of the modules the page shares with the server: every string-literal type member (event kinds, glyphs,
 *  groups, states, payload types, places, languages — the wire codes) and every declared field name (a served field read by its
 *  wire name: only as the key of an element access, the left operand of `in` or the index of an indexed access type). */
function wireCodes(): { codes: Set<string>; fields: Set<string> } {
  const files = [
    'src/viz/server/viewModel.ts', 'src/viz/model/events.ts', 'src/viz/model/scene.ts', 'src/viz/model/layout.ts', 'src/viz/model/labels.ts',
    'src/viz/model/cards.ts', 'src/i18n/render.ts', 'src/viz/render/sprites.ts', 'src/viz/render/raster.ts',
    ...readdirSync(path.join(REPO, 'src/viz/ui')).filter((n) => n.endsWith('.ts')).map((n) => `src/viz/ui/${n}`),
  ];
  const codes = new Set<string>(), fields = new Set<string>();
  for (const f of files) {
    const sf = ts.createSourceFile(f, read(f), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    walk(sf, (n) => {
      if (ts.isLiteralTypeNode(n) && ts.isStringLiteral(n.literal)) codes.add(n.literal.text);
      if ((ts.isPropertySignature(n) || ts.isPropertyDeclaration(n)) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) fields.add(n.name.text);
    });
  }
  return { codes, fields };
}

/** The header names the page sends (12 §3.10.2, §3.10.5) — also the page's one sessionStorage key. */
const HEADER_NAMES: ReadonlySet<string> = new Set(['X-Cowork-Session', 'X-Cowork-Launch', 'Last-Event-ID']);
/** DOM API names the page uses: element tags, event types, attribute and ARIA tokens, fetch init values, the canvas context, the
 *  range input, the canvas text baseline, media queries, the canvas font chunk and typeof results. Never a word a user reads. */
const DOM_NAMES: ReadonlySet<string> = new Set([
  'div', 'span', 'button', 'canvas', 'ul', 'li', 'select', 'option', 'input', 'header', 'section', 'blockquote', 'nav', 'footer', 'aside',
  'click', 'keydown', 'resize', 'scroll', 'change', 'focus', 'blur', 'pointermove',
  'role', 'img', 'status', 'polite', 'aria-label', 'aria-live', 'aria-pressed', 'aria-current', 'aria-valuetext', 'true',
  'data-motion', 'data-state', 'data-code', 'reduced',
  'omit', 'no-store', 'error', 'GET', 'POST', '2d', 'range', 'top',
  '(prefers-reduced-motion: reduce)', '(prefers-color-scheme: dark)', 'px', 'px system-ui, sans-serif', 'string', 'number', 'object',
]);
const API_PREFIX = '/api/v1/';
/** The query and path chunks of the two templated routes (12 §3.10.5). */
const API_CHUNKS: ReadonlySet<string> = new Set(['/timeline?from=', '&to=']);
const HAS_LETTER = /\p{L}/u;

type Verdict = 'no letters' | 'code' | 'class' | 'api' | 'header' | 'wire' | 'field' | 'dom' | null;
interface Vocab { classes: ReadonlySet<string>; wire: { codes: ReadonlySet<string>; fields: ReadonlySet<string> }; }
function classify(text: string, v: Vocab, fieldPosition = false): Verdict {
  if (!HAS_LETTER.test(text)) return 'no letters';
  if (ALL_VIZ_CODES.has(text) || REASON_CODES.has(text)) return 'code';
  if (v.classes.has(text)) return 'class';
  if (text.startsWith(API_PREFIX) || API_CHUNKS.has(text)) return 'api';
  if (HEADER_NAMES.has(text)) return 'header';
  if (DOM_NAMES.has(text)) return 'dom';
  if (v.wire.codes.has(text)) return 'wire';
  if (fieldPosition && v.wire.fields.has(text)) return 'field';
  return null;
}

/** Every string literal, no-substitution template and template chunk of a source, except module specifiers; `field` when the literal
 *  is the key of an element access, the left operand of `in` or the index of an indexed access type. */
function literalsOf(sf: ts.SourceFile): Array<{ text: string; line: number; field: boolean }> {
  const out: Array<{ text: string; line: number; field: boolean }> = [];
  walk(sf, (n) => {
    if (n.parent !== undefined && (ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent)) && n === n.parent.moduleSpecifier) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const p = n.parent;
      const field = (ts.isElementAccessExpression(p) && p.argumentExpression === n)
        || (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InKeyword && p.left === n)
        || (ts.isLiteralTypeNode(p) && ts.isIndexedAccessTypeNode(p.parent) && p.parent.indexType === p);   // T['field']
      out.push({ text: n.text, line: lineOf(sf, n), field });
    }
    if (ts.isTemplateExpression(n)) {
      out.push({ text: n.head.text, line: lineOf(sf, n), field: false });
      for (const s of n.templateSpans) out.push({ text: s.literal.text, line: lineOf(sf, s), field: false });
    }
  });
  return out;
}

/** Members and calls through which text reaches a reader: the DOM's text and labels, the canvas, the live region. */
const TEXT_MEMBERS: ReadonlySet<string> = new Set(['textContent', 'innerText', 'title', 'placeholder', 'ariaLabel', 'alt', 'label', 'nodeValue']);
const TEXT_ATTRIBUTES: ReadonlySet<string> = new Set(['aria-label', 'aria-valuetext', 'aria-description', 'title', 'alt', 'placeholder']);
const TEXT_CALLS: ReadonlySet<string> = new Set(['fillText', 'strokeText', 'createTextNode', 'append', 'prepend', 'announce', 'plate', 'plateAt']);
/** A literal with a letter (a word) handed straight to a text sink: a rendered string or data must be there instead. */
function textSinkOffenders(file: string, sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const wordy = (e: ts.Expression | undefined): boolean => {
    if (e === undefined) return false;
    const x = unwrap(e);
    if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return HAS_LETTER.test(x.text);
    if (ts.isTemplateExpression(x)) return [x.head.text, ...x.templateSpans.map((s) => s.literal.text)].some((c) => HAS_LETTER.test(c));
    if (ts.isConditionalExpression(x)) return wordy(x.whenTrue) || wordy(x.whenFalse);
    if (ts.isBinaryExpression(x)) return wordy(x.left) || wordy(x.right);
    return false;
  };
  walk(sf, (n) => {
    const at = `${file}:${lineOf(sf, n)}`;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const m = memberName(unwrap(n.left));
      if (m !== null && TEXT_MEMBERS.has(m) && wordy(n.right)) out.push(`${at} ${m} = ${n.right.getText(sf)}`);
    }
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      const name = ts.isIdentifier(callee) ? callee.text : memberName(callee);
      const a0 = n.arguments[0];
      if (name === 'setAttribute' && a0 !== undefined && ts.isStringLiteral(a0) && TEXT_ATTRIBUTES.has(a0.text) && wordy(n.arguments[1])) {
        out.push(`${at} setAttribute(${a0.getText(sf)}, ${n.arguments[1]!.getText(sf)})`);
      }
      if (name !== null && TEXT_CALLS.has(name) && n.arguments.some((a) => wordy(a))) out.push(`${at} ${name}(${n.arguments.map((a) => a.getText(sf)).join(', ')})`);
    }
  });
  return out;
}

test('T-VIZ-lints (I18N-07): src/viz/client/** contains no human-text literal', () => {
  const v: Vocab = { classes: new Set(classMap().values()), wire: wireCodes() };
  const offenders: string[] = [];
  let n = 0;
  for (const { file, sf } of clientSources()) {
    for (const l of literalsOf(sf)) {
      n++;
      if (classify(l.text, v, l.field) === null) offenders.push(`${file}:${l.line} ${JSON.stringify(l.text)}`);
    }
    offenders.push(...textSinkOffenders(file, sf));
  }
  assert.deepEqual(offenders, []);
  assert.ok(n > 100, `${n} literals classified`);
  // The classifier refuses human text (negative self-test): words, sentences and labels that are not codes; a field name only in a
  // field position; and no word reaches a text sink as a literal.
  for (const human of ['Live', 'Reconnecting\u{2026}', 'Load earlier', 'seen 3 min ago', 'Play', 'Demo data \u{2014} not your team', 'Zoom in']) {
    assert.equal(classify(human, v), null, human);
  }
  assert.equal(classify('templates', v), null, 'a field name outside a field position');
  assert.equal(classify('templates', v, true), 'field');
  for (const code of ['UI_VIZ_STOPPED', 'UI_VIZ_CTRL_LIVE', 'EPOCH']) assert.equal(classify(code, v), 'code', code);
  assert.equal(classify('ZZZ_NOT_A_CODE', v), null, 'a code-shaped string outside the \u{00A7}3.11 table');
  const planted = ts.createSourceFile('planted.ts', [
    "node.textContent = 'you';", "b.title = ok ? 'live' : x;", "ctx.fillText('caught up', 0, 0);", "b.setAttribute('aria-label', 'zoom');",
    "list.append('new');", 'node.textContent = `${n} files`;', "node.textContent = t('UI_VIZ_YOU');", 'node.textContent = `#${h}`;',
  ].join('\n'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.equal(textSinkOffenders('planted.ts', planted).length, 6);
});

test('R-V33: src/viz/client/** keeps no timeline assembly and no log merging of its own: segments, pages, seek caches, reducers and the live queue live in ui/roomView.ts, the merged chips in ui/logModel.ts', () => {
  const offenders: string[] = [];
  for (const { file, sf } of clientSources()) {
    walk(sf, (n) => {
      const at = `${file}:${lineOf(sf, n)}`;
      // Constructing the model's reducer or the seek cache, or reading a view's segments, is timeline assembly.
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && ['SceneReducer', 'SeekCache'].includes(n.expression.text)) offenders.push(`${at} new ${n.expression.text}`);
      if (ts.isPropertyAccessExpression(n) && ['segments', 'events'].includes(n.name.text) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'view') {
        offenders.push(`${at} ${n.getText(sf)}`);
      }
      if ((ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ['reduceScene', 'liveSnap'].includes(n.expression.text))) offenders.push(`${at} ${n.expression.text}()`);
      // The merged row's chips (12 §3.8 "Activity cards") are LogModel.rows()'s alone.
      if (ts.isIdentifier(n) && n.text === 'CHIPS_MAX') offenders.push(`${at} CHIPS_MAX`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('every slider and selector the page creates has an accessible name (12 §3.11 "Screen readers"; VIZ-40)', () => {
  const missing: string[] = [];
  let controls = 0;
  for (const { file, sf } of clientSources()) {
    // The identifiers that get an aria-label in this file.
    const named = new Set<string>();
    walk(sf, (x) => {
      if (!ts.isCallExpression(x) || memberName(x.expression) !== 'setAttribute' || !ts.isPropertyAccessExpression(x.expression)) return;
      const a0 = x.arguments[0];
      if (ts.isIdentifier(x.expression.expression) && a0 !== undefined && ts.isStringLiteral(a0) && a0.text === 'aria-label') named.add(x.expression.expression.text);
    });
    walk(sf, (x) => {
      if (!ts.isVariableDeclaration(x) || !ts.isIdentifier(x.name) || x.initializer === undefined) return;
      const init = unwrap(x.initializer);
      const tag = ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'el' && init.arguments[0] !== undefined && ts.isStringLiteral(init.arguments[0])
        ? init.arguments[0].text : null;
      if (tag !== 'input' && tag !== 'select') return;
      controls++;
      if (!named.has(x.name.text)) missing.push(`${file}:${lineOf(sf, x)} ${x.name.text}`);
    });
  }
  assert.ok(controls >= 3, `${controls} sliders and selectors (the rewind slider, the speed and the language)`);
  assert.deepEqual(missing, []);
});

// ---------------------------------------------------------------------------------------------------------------
// fetch (VIZ-34, VIZ-37; V8, S11)

interface FetchSite { file: string; line: number; path: string; spans: string[]; init: Map<string, string | null>; spread: boolean; }
function fetchSites(): FetchSite[] {
  const out: FetchSite[] = [];
  for (const { file, sf } of clientSources()) {
    walk(sf, (n) => {
      if (!ts.isIdentifier(n) || n.text !== 'fetch') return;
      const call = n.parent;
      assert.ok(ts.isCallExpression(call) && call.expression === n, `${file}:${lineOf(sf, n)} fetch is only ever called`);
      const a0 = unwrap(call.arguments[0]!);
      let p: string, spans: string[] = [];
      if (ts.isStringLiteral(a0) || ts.isNoSubstitutionTemplateLiteral(a0)) p = a0.text;
      else {
        assert.ok(ts.isTemplateExpression(a0), `${file}:${lineOf(sf, n)} fetch's path is a literal or a template`);
        p = a0.head.text;
        spans = a0.templateSpans.map((s) => s.literal.text);
      }
      const a1 = call.arguments[1] === undefined ? undefined : unwrap(call.arguments[1]);
      assert.ok(a1 !== undefined && ts.isObjectLiteralExpression(a1), `${file}:${lineOf(sf, n)} fetch has an init object literal`);
      const init = new Map<string, string | null>();
      let spread = false;
      for (const prop of a1.properties) {
        if (ts.isSpreadAssignment(prop)) spread = true;
        else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) init.set(prop.name.text, ts.isStringLiteral(prop.initializer) ? prop.initializer.text : null);
        else if (ts.isShorthandPropertyAssignment(prop)) init.set(prop.name.text, null);
      }
      out.push({ file, line: lineOf(sf, n), path: p, spans, init, spread });
    });
  }
  return out;
}

/** The page's ConnIo, bundled from src/viz/client/api.ts as a module (it touches no DOM at load) and imported here. */
async function loadApi(): Promise<{ createConnIo(): {
  request(route: unknown, init: { method: 'GET' | 'POST'; headers: Record<string, string> }): Promise<{ status: number; json: unknown }>;
  stream(headers: Record<string, string>): Promise<{ status: number; read(): Promise<string | null>; cancel(): void }>;
  timer(ms: number, f: () => void): () => void;
  storage: { get(): { session: string | null; room: string | null }; set(v: { session?: string; room?: string }): void; clear(): void };
} }> {
  const r = await build({ absWorkingDir: REPO, entryPoints: [path.join(REPO, CLIENT, 'api.ts')], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
  const code = r.outputFiles[0]!.text;
  return import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`);
}

/** The init fields a page fetch sets (Node's RequestInit type has no `cache`). */
type Call = { url: string; init: { method?: string; headers?: unknown; credentials?: string; cache?: string; redirect?: string } };
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });
function stubFetch(answer: (url: string) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: (init ?? {}) as Call['init'] });
    return answer(String(url));
  }) as typeof fetch;
  return calls;
}

test('T-VIZ-lints: every fetch in the client is one ApiRoute\'s literal /api/v1/ path or literal-headed template, with credentials omit, cache no-store and redirect error; the stream is read with fetch and getReader, never EventSource', async () => {
  const sites = fetchSites();
  assert.deepEqual([...new Set(sites.map((s) => s.file))], [`${CLIENT}/api.ts`], 'only api.ts fetches');
  const routes = sites.map((s) => [s.path, ...s.spans].join('${}')).sort();
  assert.deepEqual(routes, [
    '/api/v1/rooms/${}/timeline?from=${}&to=${}', '/api/v1/session', '/api/v1/stream', '/api/v1/strings?lang=${}', '/api/v1/world',
  ], 'one fetch per ApiRoute and the stream, each a literal path or a template with a literal /api/v1/ head');
  for (const s of sites) {
    const at = `${s.file}:${s.line}`;
    assert.equal(s.spread, false, `${at}: no spread in the init`);
    assert.equal(s.init.get('credentials'), 'omit', `${at}: credentials 'omit'`);
    assert.equal(s.init.get('cache'), 'no-store', `${at}: cache 'no-store'`);
    assert.equal(s.init.get('redirect'), 'error', `${at}: redirect 'error'`);
    assert.ok(s.init.has('method') && s.init.has('headers'), `${at}: method and headers`);
  }
  // No EventSource anywhere in the page; the stream body is read with getReader.
  let reader = 0;
  for (const { file, sf } of clientSources()) {
    walk(sf, (n) => {
      if (ts.isIdentifier(n)) assert.notEqual(n.text, 'EventSource', `${file}:${lineOf(sf, n)}`);
      if (file.endsWith('/api.ts') && memberName(n) === 'getReader') reader++;
    });
  }
  assert.equal(reader, 1, 'api.ts reads the stream body with getReader');

  // Behaviour: a route failing its check makes no request; a valid one makes exactly its request.
  const { createConnIo } = await loadApi();
  const io = createConnIo();
  const calls = stubFetch(() => new Response('{"ok":1}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const get = { method: 'GET' as const, headers: { 'X-Cowork-Session': 'a'.repeat(64) } };
  const bad: unknown[] = [
    { r: 'timeline', room: 'rABCDEFG', from: 0, to: 1 }, { r: 'timeline', room: 'rABCDEFGI', from: 0, to: 1 }, { r: 'timeline', room: 'src/a.ts', from: 0, to: 1 },
    { r: 'timeline', room: 'rABCDEFGH/../x', from: 0, to: 1 }, { r: 'timeline', room: 'rABCDEFGH', from: -1, to: 1 }, { r: 'timeline', room: 'rABCDEFGH', from: 1.5, to: 2 },
    { r: 'timeline', room: 'rABCDEFGH', from: 0, to: 12_345_678_901 }, { r: 'timeline', room: 'rABCDEFGH', from: Number.NaN, to: 1 },
    { r: 'timeline', room: 'rABCDEFGH', from: '0', to: 1 }, { r: 'strings', lang: 'de' }, { r: 'strings', lang: 'en&x=1' }, { r: 'files', path: '/etc' },
  ];
  for (const route of bad) {
    await assert.rejects(io.request(route, get), `${JSON.stringify(route)} is refused`);
  }
  assert.equal(calls.length, 0, 'no request for a route failing its check');
  const ok = await io.request({ r: 'timeline', room: 'rABCDEFGH', from: 0, to: 255 }, get);
  assert.deepEqual(ok, { status: 200, json: { ok: 1 } });
  await io.request({ r: 'strings', lang: 'zh-CN' }, get);
  await io.request({ r: 'world' }, get);
  await io.request({ r: 'session' }, { method: 'POST', headers: { 'X-Cowork-Launch': 'b'.repeat(64) } });
  assert.deepEqual(calls.map((c) => c.url), ['/api/v1/rooms/rABCDEFGH/timeline?from=0&to=255', '/api/v1/strings?lang=zh-CN', '/api/v1/world', '/api/v1/session']);
  for (const c of calls) {
    assert.equal(c.init.credentials, 'omit');
    assert.equal(c.init.cache, 'no-store');
    assert.equal(c.init.redirect, 'error');
  }
  assert.equal(calls[3]!.init.method, 'POST');
  assert.deepEqual(calls[3]!.init.headers, { 'X-Cowork-Launch': 'b'.repeat(64) });
  // A body that is not JSON reads as null; the stream decodes UTF-8 across chunk boundaries.
  stubFetch(() => new Response('not json', { status: 500 }));
  assert.deepEqual(await io.request({ r: 'world' }, get), { status: 500, json: null });
  const bytes = Buffer.from('data: \u{AC00}\n\n', 'utf8');
  const streamCalls = stubFetch(() => new Response(new ReadableStream({
    start(c): void { c.enqueue(bytes.subarray(0, 7)); c.enqueue(bytes.subarray(7)); c.close(); },
  }), { status: 200 }));
  const s = await io.stream({ 'X-Cowork-Session': 'a'.repeat(64), 'Last-Event-ID': '0' });
  assert.equal(s.status, 200);
  let text = '';
  for (let chunk = await s.read(); chunk !== null; chunk = await s.read()) text += chunk;
  assert.equal(text, 'data: \u{AC00}\n\n');
  assert.deepEqual(streamCalls.map((c) => [c.url, c.init.credentials, c.init.cache, c.init.redirect]), [['/api/v1/stream', 'omit', 'no-store', 'error']]);
  // sessionStorage is absent here: the storage reads as empty, keeps an in-memory copy for the page's own requests, never throws.
  assert.deepEqual(io.storage.get(), { session: null, room: null });
  io.storage.set({ session: 'c'.repeat(64) });
  io.storage.set({ room: 'rABCDEFGH' });
  assert.deepEqual(io.storage.get(), { session: 'c'.repeat(64), room: 'rABCDEFGH' });
  io.storage.clear();
  assert.deepEqual(io.storage.get(), { session: null, room: null });
});

// ---------------------------------------------------------------------------------------------------------------
// Classes and colours (12 §3.10.7 "Client"; VIZ-37)

/** The classes app.css declares: every `.name` in a selector (comments removed). */
function cssClasses(css: string): Set<string> {
  const out = new Set<string>();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of text.matchAll(/([^{}]+)\{/g)) {
    for (const c of m[1]!.matchAll(/\.([a-z][a-z0-9-]*)/g)) out.add(c[1]!);
  }
  return out;
}
const hex = (c: Rgb): string => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

test('data never selects a CSS class outside the enum map and colours come only from palette indices', () => {
  const cls = classMap();
  const values = new Set(cls.values());
  const css = read(`${CLIENT}/app.css`);
  // The enum map and the stylesheet name the same classes.
  assert.deepEqual([...values].sort(), [...cssClasses(css)].sort(), 'CLS values = the classes app.css declares');

  const offenders: string[] = [];
  let sites = 0;
  const isClsMember = (e: ts.Expression): boolean => {
    const x = unwrap(e);
    return ts.isPropertyAccessExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === 'CLS' && cls.has(x.name.text);
  };
  // Tables (in any page module) whose every value is a CLS member (HUE_CLS, …): an index into one selects a member.
  const tables = new Set<string>();
  for (const { sf } of clientSources()) {
    walk(sf, (n) => {
      if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.initializer === undefined) return;
      let init = unwrap(n.initializer);
      if (ts.isCallExpression(init) && init.arguments.length === 1) init = unwrap(init.arguments[0]!);
      const vals = ts.isArrayLiteralExpression(init) ? [...init.elements]
        : ts.isObjectLiteralExpression(init) ? init.properties.map((p) => (ts.isPropertyAssignment(p) ? p.initializer : null)) : null;
      if (vals !== null && vals.length > 0 && vals.every((v) => v !== null && ts.isExpression(v) && isClsMember(v))) tables.add(n.name.text);
    });
  }
  assert.ok(tables.has('HUE_CLS'), 'the look swatches select from HUE_CLS');
  for (const { file, sf } of clientSources()) {
    // A class expression: a CLS member, an index into a table of them, a choice of those, a parameter typed Cls, or no class (null).
    const ok = (e: ts.Expression): boolean => {
      const x = unwrap(e);
      if (isClsMember(x) || x.kind === ts.SyntaxKind.NullKeyword) return true;
      if (ts.isElementAccessExpression(x) && ts.isIdentifier(x.expression) && tables.has(x.expression.text)) return true;
      if (ts.isConditionalExpression(x)) return ok(x.whenTrue) && ok(x.whenFalse);
      if (ts.isIdentifier(x)) {
        // Every parameter or variable of that name in the file is typed Cls (TypeScript then admits only enum-map values).
        let decls = 0, typed = 0;
        walk(sf, (d) => {
          if ((ts.isParameter(d) || ts.isVariableDeclaration(d)) && ts.isIdentifier(d.name) && d.name.text === x.text) {
            decls++;
            if (d.type !== undefined && /^Cls(\s*\|\s*null)?$/.test(d.type.getText(sf))) typed++;
          }
        });
        return decls > 0 && typed === decls;
      }
      return false;
    };
    walk(sf, (n) => {
      const at = `${file}:${lineOf(sf, n)}`;
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && memberName(n.left) === 'className') {
        sites++;
        if (!ok(n.right)) offenders.push(`${at} className = ${n.right.getText(sf)}`);
      }
      if (ts.isCallExpression(n)) {
        const callee = unwrap(n.expression);
        const m = memberName(callee);
        if (m !== null && ['add', 'remove', 'toggle', 'replace', 'contains'].includes(m) && ts.isPropertyAccessExpression(callee) && memberName(callee.expression) === 'classList') {
          sites++;
          const classArgs = m === 'toggle' ? n.arguments.slice(0, 1) : n.arguments;
          for (const a of classArgs) if (!ok(a)) offenders.push(`${at} classList.${m}(${a.getText(sf)})`);
        }
        if (ts.isIdentifier(callee) && callee.text === 'el' && n.arguments[1] !== undefined) {
          sites++;
          if (!ok(n.arguments[1])) offenders.push(`${at} el(…, ${n.arguments[1].getText(sf)})`);
        }
        if (m === 'setAttribute' && n.arguments[0] !== undefined && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text.toLowerCase() === 'class') {
          offenders.push(`${at} setAttribute('class', …)`);
        }
      }
    });
  }
  assert.deepEqual(offenders, []);
  assert.ok(sites > 20, `${sites} class sites checked`);

  // Colours: no colour literal in the page; every canvas colour is cssColour(<a palette value>); no DOM colour is ever written.
  const colourLiteral = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|\b(?:white|black|red|green|blue|gray|grey|orange|yellow|transparent)\b/i;
  const PALETTE_EXPORTS = new Set(['PALETTE', 'ENV', 'FIXED', 'BODY_HUES', 'ICON_TONES', 'ORANGE_BANG', 'mix']);
  const colourOffenders: string[] = [];
  let canvasColours = 0;
  for (const { file, sf } of clientSources()) {
    for (const l of literalsOf(sf)) if (colourLiteral.test(l.text)) colourOffenders.push(`${file}:${l.line} ${JSON.stringify(l.text)}`);
    // Names bound to palette values in this file: palette imports, and consts whose initializer reads one.
    const paletteNames = new Set<string>();
    walk(sf, (n) => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text.endsWith('/render/palette.js')) {
        const b = n.importClause?.namedBindings;
        if (b !== undefined && ts.isNamedImports(b)) for (const s of b.elements) if (PALETTE_EXPORTS.has((s.propertyName ?? s.name).text)) paletteNames.add(s.name.text);
      }
    });
    const readsPalette = (e: ts.Node): boolean => {
      let hit = false;
      walk(e, (x) => { if (ts.isIdentifier(x) && paletteNames.has(x.text)) hit = true; });
      return hit;
    };
    walk(sf, (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined && readsPalette(n.initializer)) paletteNames.add(n.name.text);
    });
    walk(sf, (n) => {
      if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
      const m = memberName(n.left);
      const at = `${file}:${lineOf(sf, n)}`;
      if (m === 'fillStyle' || m === 'strokeStyle' || m === 'shadowColor') {
        canvasColours++;
        const r = unwrap(n.right);
        const viaHelper = ts.isCallExpression(r) && ts.isIdentifier(r.expression) && r.expression.text === 'cssColour' && r.arguments.length === 1 && readsPalette(r.arguments[0]!);
        if (!viaHelper) colourOffenders.push(`${at} ${m} = ${n.right.getText(sf)}`);
      }
      const left = unwrap(n.left);
      if ((ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) && memberName(unwrap(left.expression)) === 'style'
        && m !== null && /colou?r|background|fill|stroke|border|outline|shadow/i.test(m)) {
        colourOffenders.push(`${at} style.${m} written`);
      }
    });
  }
  assert.deepEqual(colourOffenders, []);
  assert.ok(canvasColours > 0, 'the canvas text plates take their colours from the palette');
  // The look swatches of the log are the seven body hues by index: .hue-<i> in app.css is PALETTE.bodies[i].
  for (let i = 0; i < BODY_HUES.length; i++) {
    const m = new RegExp(`\\.hue-${i}\\s*\\{[^}]*background(?:-color)?:\\s*(#[0-9a-fA-F]{6})`).exec(css.replace(/\/\*[\s\S]*?\*\//g, ''));
    assert.ok(m !== null, `.hue-${i} has a background`);
    assert.equal(m[1]!.toLowerCase(), hex(PALETTE.bodies[i]!), `.hue-${i} is PALETTE.bodies[${i}]`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// app.css tokens (12 §3.6 "Environment palette", §3.11 "Contrast"; VIZ-40)

const toRgb = (h: string): Rgb => {
  const s = h.slice(1);
  const full = s.length === 3 ? [...s].map((c) => c + c).join('') : s;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
};
const luminance = (c: Rgb): number => {
  const lin = c.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
};
const contrast = (a: Rgb, b: Rgb): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
/** The custom properties of the first `<selector> { … }` block in text. */
function tokens(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

test('app.css defines the light and dark token sets with chrome text contrast ≥ 4.5:1 and the apricot accent never as text colour', () => {
  const css = read(`${CLIENT}/app.css`).replace(/\/\*[\s\S]*?\*\//g, '');
  const light = /(?:^|\})\s*:root\s*\{([^}]*)\}/.exec(css);
  assert.ok(light !== null, 'a :root token block');
  const darkMedia = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}\s*\}/.exec(css);
  assert.ok(darkMedia !== null, 'a :root token block under @media (prefers-color-scheme: dark)');
  const themes = { light: tokens(light[1]!), dark: tokens(darkMedia[1]!) };
  for (const [name, t] of Object.entries(themes)) {
    assert.equal(t.get('--accent')?.toUpperCase(), '#D97757', `${name}: the accent is the apricot #D97757`);
    const fgs = [...t].filter(([k]) => k.startsWith('--fg'));
    const bgs = [...t].filter(([k]) => k.startsWith('--bg'));
    assert.ok(fgs.length >= 2 && bgs.length >= 2, `${name}: text (--fg*) and background (--bg*) tokens`);
    for (const [k, v] of [...fgs, ...bgs]) assert.match(v, /^#[0-9a-fA-F]{6}$/, `${name} ${k} is a hex colour`);
    for (const [fk, fv] of fgs) {
      for (const [bk, bv] of bgs) {
        const c = contrast(toRgb(fv), toRgb(bv));
        assert.ok(c >= 4.5, `${name}: ${fk} on ${bk} is ${c.toFixed(2)}:1`);
      }
    }
  }
  // The two sets name the same tokens.
  assert.deepEqual([...themes.light.keys()].sort(), [...themes.dark.keys()].sort());
  // Every text colour is a --fg token; the accent (and its hex) is never a text colour.
  const colours = [...css.matchAll(/(?<![-\w])color\s*:\s*([^;}]+)/g)].map((m) => m[1]!.trim());
  assert.ok(colours.length > 0);
  for (const v of colours) assert.match(v, /^var\(--fg[a-z0-9-]*\)$/, `color: ${v}`);
  assert.doesNotMatch(css, /(?<![-\w])color\s*:\s*(?:var\(--accent\)|#d97757)/i);
  // VIZ-40 holds for the text as drawn: no declaration composites chrome text below its token pair (an opacity under 1 or a filter
  // would draw a --fg/--bg pair that passes above at less than 4.5:1 — the reconnecting live pill at opacity 0.6 read 3.90:1 in the
  // light theme). The reconnecting pill stays distinct by its muted text and dashed border.
  const declarations = [...css.matchAll(/\{([^{}]*)\}/g)].flatMap((m) => m[1]!.split(';')).map((d) => d.split(':').map((x) => x.trim()));
  for (const [prop, value] of declarations) {
    if (prop === 'opacity') assert.ok(Number(value) >= 1, `opacity: ${value} composites text below its contrast`);
    assert.notEqual(prop, 'filter', `filter: ${value}`);
  }
  assert.match(css, /\.live-off\s*\{[^}]*(?<![-\w])color:\s*var\(--fg-muted\)/, 'the reconnecting live pill: muted text');
  assert.match(css, /\.live-off\s*\{[^}]*border-style:\s*dashed/, 'the reconnecting live pill: a dashed border');
  // The canvases are pixelated (12 §3.7); focus is visible (VIZ-40).
  assert.match(css, /image-rendering:\s*pixelated/);
  assert.match(css, /:focus-visible\s*\{[^}]*outline:[^;}]*var\(--accent\)/);
  // The drawer below 1,100 px (12 §3.8) and the 340 px panel.
  assert.match(css, /@media\s*\(max-width:\s*1099px\)/);
  assert.match(css, /340px/);
});
