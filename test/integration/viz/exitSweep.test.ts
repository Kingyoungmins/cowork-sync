// Plan 8a Task 18 step B3: the 8a exit sweep (12 §9.1; roadmap row 8, the 8a exit criterion; F19). It reads the criterion from the
// roadmap file itself and checks that the test tree carries it: every T-VIZ id the row names is the start of a runnable test title
// under test/**/viz/** (`T-VIZ-<id>` followed by `:` or ` (`), browser smoke items (a)–(g) and (i) are tests of browserSmoke.test.ts,
// and the storyboard clause has Task 18 step A's tests. Whether those tests are green on the three CI OS legs (and the smoke on one)
// is what CI's run of them shows; this file runs on each leg too. It also scans the spec files for every item of 8a's spec-edit batch
// (8a plan §Scope rulings "Spec conflicts and gaps" items 1–12, the 12 §9.2–§9.7 edits and the ledger's spec-edit entries, as step
// B2 applied them, each tagged "(8a batch, after Plan 2's; <source>)"); an item rev 2.5 already carries counts as present.
// Task 19 (F32) has landed: its eight T-VIZ-follow-* ids and smoke item (k) are required like every other id (PENDING_TASK_19 is
// empty), and so are the two §3.11 rows Task 19 carried (VIZ_LOG_DROPPED, UI_VIZ_CTRL_POSITION) and item 3's R-V54 clause in 12 §3.13
// (the controller's B3 ruling: 8a's). The pending mechanism stays for later carries, and a pending mark whose item is present fails,
// so a stale mark cannot stay green. Every missing id, smoke item or checklist text fails the sweep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ROADMAP = 'docs/superpowers/plans/2026-10-02-cowork-sync-roadmap.md';
const SMOKE_FILE = 'test/integration/viz/browserSmoke.test.ts';
const SELF = 'test/integration/viz/exitSweep.test.ts';
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8').split('\r\n').join('\n');

/** Roadmap row 8's Task 19 clause (rev 2.5, F32, owner decision D3). */
const TASK_19_IDS: readonly string[] = [
  'follow-camera', 'follow-motion', 'follow-now', 'follow-plan2', 'follow-replay', 'follow-filter', 'follow-keys', 'follow-i18n',
];
/** What this run reports as pending Task 19 instead of failing (Task 18's amendment, F-8a-12): empty since Task 19 landed — its ids
 *  and smoke item (k) are required now. */
const PENDING_TASK_19: { readonly ids: ReadonlySet<string>; readonly smoke: ReadonlySet<string> } = {
  ids: new Set<string>(),
  smoke: new Set<string>(),
};
/** The row's ids outside Task 19's clause (45 when this sweep was written; a parse that finds another number has drifted). */
const ROW_IDS_BEFORE_TASK_19 = 45;

// ---------------------------------------------------------------------------------------------------------------------------------
// Roadmap row 8, the 8a exit criterion

interface Row8a {
  /** T-VIZ ids without the `T-VIZ-` prefix, in row order. */
  readonly ids: string[];
  readonly task19Ids: string[];
  /** Browser smoke item letters. */
  readonly smoke: string[];
  readonly task19Smoke: string[];
  /** The clauses that name no T-VIZ id and no smoke item (the storyboard). */
  readonly other: string[];
}

/** The top-level `;` clauses of a text (a `;` inside parentheses stays in its clause). */
function clauses(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

/** The text with every parenthetical (nested ones too) and the space before it removed. */
function stripParens(s: string): string {
  for (;;) {
    const next = s.replace(/\s*\([^()]*\)/gu, '');
    if (next === s) return s;
    s = next;
  }
}

/** "browser smoke items (a)–(g) and (i)" → a…g, i. */
function smokeItems(clause: string): string[] {
  const m = /browser smoke items? ((?:\([a-z]\)(?:\s*[–-]\s*\([a-z]\))?(?:,\s*|\s+and\s+)?)+)/u.exec(clause);
  if (m === null) return [];
  const out: string[] = [];
  for (const r of (m[1] as string).matchAll(/\(([a-z])\)(?:\s*[–-]\s*\(([a-z])\))?/gu)) {
    const from = (r[1] as string).charCodeAt(0);
    const to = (r[2] ?? (r[1] as string)).charCodeAt(0);
    for (let c = from; c <= to; c++) out.push(String.fromCharCode(c));
  }
  return out;
}

/** "T-VIZ-a (…), -b, -c and -d" → a, b, c, d (parentheticals already stripped). */
function idList(flat: string): string[] {
  const m = /T-VIZ-[a-z0-9]+(?:-[a-z0-9]+)*(?:(?:,\s*|,?\s+and\s+)-[a-z0-9]+(?:-[a-z0-9]+)*)*/u.exec(flat);
  if (m === null) return [];
  return m[0].split(/,?\s+and\s+|,\s*/u).map((s) => s.replace(/^(?:T-VIZ)?-/u, ''));
}

function parseRow8a(roadmap: string): Row8a {
  const row = roadmap.split('\n').find((l) => l.startsWith('| 8 | **Visualizer**'));
  assert.ok(row !== undefined, `${ROADMAP} has row 8 (Visualizer)`);
  const from = row.indexOf('**8a:**');
  const to = row.indexOf('**8b:**', from);
  assert.ok(from >= 0 && to > from, 'row 8 states the 8a exit criterion before the 8b one');
  const out: Row8a = { ids: [], task19Ids: [], smoke: [], task19Smoke: [], other: [] };
  for (const clause of clauses(row.slice(from + '**8a:**'.length, to))) {
    // Task 19's clause opens with its tag, "(rev 2.5, F32, Task 19)".
    const task19 = /^\([^()]*\bTask 19\b[^()]*\)/u.test(clause);
    const ids = idList(stripParens(clause));
    const smoke = smokeItems(clause);
    (task19 ? out.task19Ids : out.ids).push(...ids);
    (task19 ? out.task19Smoke : out.smoke).push(...smoke);
    if (ids.length === 0 && smoke.length === 0) out.other.push(clause);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Test titles under test/**/viz/**

interface Title {
  readonly file: string;
  readonly line: number;
  readonly title: string;
  /** False for `test.skip`/`test.todo` and for a literal `skip: true`/`todo: …` option: such a test never runs, so it carries nothing.
   *  An environment-gated skip (`skip: SKIP`, `skip: !SLOW`) still runs on the leg it is gated to. */
  readonly runnable: boolean;
}

const TEST_FNS: ReadonlySet<string> = new Set(['test', 'it', 'describe', 'suite']);

/** `test(…)`, `it(…)`, `t.test(…)` (a subtest) and `test.skip/.todo/.only(…)`; null for any other call. */
function testCall(callee: ts.Expression): { mod: string | null } | null {
  if (ts.isIdentifier(callee)) return TEST_FNS.has(callee.text) ? { mod: null } : null;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const name = callee.name.text;
  if (TEST_FNS.has(name)) return { mod: null };
  if ((name === 'skip' || name === 'todo' || name === 'only') && ts.isIdentifier(callee.expression) && TEST_FNS.has(callee.expression.text)) {
    return { mod: name };
  }
  return null;
}

/** A title's text: a string literal's, or a template's head followed by NUL (so `T-VIZ-${x}` never matches an id). */
function titleText(arg: ts.Expression | undefined): string | null {
  if (arg === undefined) return null;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) return `${arg.head.text}\u0000`;
  return null;
}

/** True when an options object literal turns the test off unconditionally (`skip: true`, `skip: 'why'`, `todo: …`). */
function literallyOff(arg: ts.Expression | undefined): boolean {
  if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return false;
  return arg.properties.some((p) => {
    if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return false;
    if (p.name.text !== 'skip' && p.name.text !== 'todo') return false;
    const v = p.initializer;
    return v.kind === ts.SyntaxKind.TrueKeyword || ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v);
  });
}

/** The test titles of a source text (comments and other strings are not titles). */
function titlesIn(rel: string, text: string): Title[] {
  const src = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Title[] = [];
  const visit = (node: ts.Node): void => {
    // A test call has its title and a function or options after it (a one-argument `x.test('…')` is RegExp#test, not a test).
    if (ts.isCallExpression(node) && node.arguments.length >= 2) {
      const call = testCall(node.expression);
      const title = call === null ? null : titleText(node.arguments[0]);
      if (call !== null && title !== null) {
        const runnable = call.mod !== 'skip' && call.mod !== 'todo' && !literallyOff(node.arguments[1]);
        out.push({ file: rel, line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1, title, runnable });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}
const titlesOf = (rel: string): Title[] => titlesIn(rel, read(rel));

/** Every `*.test.ts` under a directory named `viz` below test/ (test/**\/viz/**), repository-relative with `/`, this file excluded. */
function vizTestFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, inViz: boolean): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, inViz || e.name === 'viz');
      else if (inViz && e.name.endsWith('.test.ts')) out.push(relative(ROOT, p).split(sep).join('/'));
    }
  };
  walk(join(ROOT, 'test'), false);
  return out.filter((f) => f !== SELF);
}

/** The exit criterion's title rule: `T-VIZ-<id>` followed by `:` or ` (`. */
const carries = (title: string, id: string): boolean => title.startsWith(`T-VIZ-${id}:`) || title.startsWith(`T-VIZ-${id} (`);

// ---------------------------------------------------------------------------------------------------------------------------------
// The spec-edit batch checklist

const S12 = 'docs/spec/12-visualizer.md';
const G00 = 'docs/spec/00-glossary.md';
const E01 = 'docs/spec/01-engine.md';
const C06 = 'docs/spec/06-claude.md';
const L08 = 'docs/spec/08-lifecycle.md';
const S09 = 'docs/spec/09-security.md';
const P10 = 'docs/spec/10-product.md';
const T11 = 'docs/spec/11-testing.md';
const TAG = "(8a batch, after Plan 2's";
/** The tag's inline form, `*8a batch, after Plan 2's; <source>:*`, inside a parenthetical or after `;`. */
const INLINE = "*8a batch, after Plan 2's";

interface Item {
  /** The batch item (8a plan list number and ruling, the 12 §9.x section, or the ledger entry) and where it lands. */
  readonly item: string;
  readonly file: string;
  /** Text that must be in the file (an exact substring, or a pattern). */
  readonly has: ReadonlyArray<string | RegExp>;
  /** Text that must not be. */
  readonly lacks?: readonly string[];
  /** Reported as pending (node:test `todo`) instead of failing while the text is missing, with this reason. */
  readonly pending?: string;
}

const CHECKLIST: readonly Item[] = [
  // Item 1: git facts.
  { item: '1 R-V09: no for-each-ref -z (12 §3.3.1, §3.3.2)', file: S12, has: [`${TAG}; R-V09: git has no \`for-each-ref -z\``, '`for-each-ref --format=%(objectname) %(refname) refs/cowork-remote/`'] },
  { item: '1 R-V10: the git floor read with the subcommand version (12 §3.2 item 3)', file: S12, has: ['the git floor (the subcommand `version`, R-V10)'] },
  { item: '1 R-V09, R-V10, R-V31: the allowlist forms exactly (12 VIZ-07)', file: S12, has: [`${INLINE}; R-V09, R-V10, R-V31, R-V05:* \`version\`; \`rev-parse --verify -q <ref>\``, '`rev-list --first-parent [--skip=<n>] --max-count=<n>'] },
  { item: '1 R-V09, R-V10, R-V31: L-VIZ-GIT (12 §9.5)', file: S12, has: [`New L-VIZ-GIT:** every \`runGit\` argv in \`src/viz/**\` matches the §3.3.2 allowlist (${INLINE}; R-V09, R-V10, R-V31, R-V05:*`] },
  { item: '1 R-V09, R-V10, R-V31: L-VIZ-GIT (11 §3.10)', file: T11, has: [`| L-VIZ-GIT | *${TAG}; 12 §9.5, R-V09, R-V10, R-V31, R-V05)*`, 'for-each-ref --format=%(objectname) %(refname) refs/cowork-remote/'] },
  // Item 2: reads.
  { item: '2 R-V05: cat-file --batch-check beside --batch (12 §3.3.2)', file: S12, has: [`${TAG}; R-V05)* two processes per batch of ≤ 1,280 board commits — one \`cat-file --batch-check\``] },
  { item: '2 R-V05: BoardRead carries csPaths, no BoardCommitData.csPaths (12 §3.3.2, §9.7)', file: S12, has: ['`BoardRead` (which extends it) carries instead of a `BoardCommitData.csPaths` field (R-V05)', '`BoardRead extends BoardCommitData`'] },
  { item: '2 R-V05: the §3.12 and T-VIZ-poll counts', file: S12, has: [`${TAG}; R-V05)* 1 \`cat-file --batch-check\` and 1 \`cat-file --batch\``, `${INLINE}; R-V05:* \`rev-list\` + 1 \`cat-file --batch-check\` + 1 \`cat-file --batch\`)`] },
  { item: '2 R-V06: the runner watchdog for viewer git (12 VIZ-07)', file: S12, has: ["every call MUST be killed after 120 s (the runner's watchdog, R-V06)"] },
  { item: '2 R-V30: bounded reads through the BoundedReader (12 §3.3.2)', file: S12, has: [`${TAG}; R-V30)* **Bounded reads.**`, '`O_RDONLY | O_NOFOLLOW | O_NONBLOCK`'] },
  { item: '2 R-V31: the fast-forward check (12 §3.9.2)', file: S12, has: ['`rev-list --first-parent --max-count=1281 <new tip>`'] },
  { item: '2 R-V19: malformed and missing reads, the export encodings (12 §6, §3.9.3)', file: S12, has: [`${TAG}; R-V19, R-V74)* A board commit the batched read reports malformed`, `${TAG}; R-V19)* A board object, or a live commit, missing from the store`, `${TAG}; R-V19)* Two failures are encoded so that the demo's timeline stays byte-identical`] },
  { item: '2 R-V69, R-V74: 32 MiB per call and item-by-item re-check (12 §3.3.2)', file: S12, has: ['*(R-V69, R-V74)* One call keeps at most 32 MiB of `--batch` output', 'a git-fatal item reading as malformed `unreadable`'] },
  // Item 3: process and CLI.
  { item: '3 R-V11: the data directory and its checks (12 §3.2 item 2)', file: S12, has: [`${TAG}; R-V11, F-8a-2, Task 11 rulings)* **The data directory in 8a.**`, 'protected DACL (`icacls` by absolute path', '\\System32\\whoami.exe /user /fo csv /nh`'] },
  { item: '3 R-V13: git resolved by the CLI, --git <abs> (12 §3.2 item 2)', file: S12, has: [`${TAG}; R-V13, R-V39)* **The git executable.**`, 'It passes that realpath as `--git <abs>`'] },
  { item: '3 R-V13: VIZ-02 and VIZ-07', file: S12, has: [`${TAG}; R-V13, Task 11 and gate-P merge rulings)* With \`--repo\`, the CLI MUST resolve git itself`] },
  { item: '3 R-V13: the viewer PATH and --git (09 §3.4)', file: S09, has: [`${TAG}; R-V13)* With \`--repo\`, the viewer's \`PATH\` is the CLI's filtered list too`] },
  { item: '3 R-V54: EN_VIZ_CLI and cli/paths.ts (12 §3.13)', file: S12, has: [`${TAG}; R-V54, 8a list item 3, Task 18 step B3 ruling)* **The CLI's own strings and paths.**`, 'EN_VIZ_CLI', '`cli/paths.ts`'] },
  { item: '3 discoverRooms without its data directory in 8a (12 §3.3.1)', file: S12, has: [`${TAG}; 8a list item 3)* In 8a, \`discoverRooms(repos, deps)\` takes no data directory`] },
  { item: '3 R-V46: "you" and self from status.json (12 §3.3.2, §3.3.3, §3.3.6)', file: S12, has: [`${TAG}; R-V46)* "You" and the fold's \`self\` come from the \`peer\` file`, `${INLINE}; R-V46:* else the last parsed \`status.json\` \`peer_id\``] },
  // Item 4: model.
  { item: '4 R-V18: footprint spawns and k (12 §3.3.5)', file: S12, has: [`${TAG}; R-V18)* First come the footprint \`pet_spawn\` events`] },
  { item: '4 R-V19, R-V25: the Frame flags (12 §3.3.4)', file: S12, has: [`${TAG}; R-V25, R-V19) transient flags for the store, never in a timeline:`] },
  { item: '4 R-V17: caps and event{incident} rows (12 §3.4)', file: S12, has: [`${TAG}; R-V17)* an effective \`caps\` op`, `${TAG}; R-V17)* an effective \`event{kind: incident}\``] },
  { item: '4 R-V25: ActorState and position-typed recency (12 §3.3.7)', file: S12, has: ['lastDesk: DeskRef | null;', 'lastClaimOp: Position | null;', `${TAG}; R-V25) recency is compared with comparePos`] },
  { item: '4 R-V21: the incident-rebuild layout (12 §3.3.5, §3.5.3)', file: S12, has: [`${TAG}; R-V21) the layout to extend, default empty`, `${TAG}; R-V21)* An incident rebuild (VIZ-14) extends the room's current layout`] },
  { item: '4 R-V42: same-epoch rejoin (12 §3.4 join rows)', file: S12, has: [`${TAG}; R-V42)* an effective \`join\` that moves \`PeerRec.status\` from \`left\` or \`absent\` back to \`active\` in the same epoch`] },
  { item: '4 R-V44: conflict{breach} from an event before Plan 4 (12 §3.4)', file: S12, has: [`${TAG}; R-V44)*`, "`conflict{conflict: 'breach', source: 'event', on: <the writer's character>"] },
  { item: '4 R-V45: the per-frame rules badge and the sub-1,002 order (12 §3.3.5, §3.4)', file: S12, has: [`ghost, unghost, rules, relaxed *${TAG}; R-V45: the derived rules badge)*`, `${TAG}; R-V45)* compared between \`before\` and \`after\` on every frame`] },
  { item: '4 R-V47: owner on pet_spawn and pet_poof (12 §3.3.7, §3.10.6)', file: S12, has: [`${TAG}; R-V47) the reducer takes the owner`, '`owner: Handle` (R-V47)'] },
  { item: '4 R-V51: Desk.first (12 §3.3.7, §3.5.3, §3.10.6)', file: S12, has: [`${TAG}; R-V51) the height of the frame that first touched it`, `${TAG}; R-V51)* A desk is drawn dashed on a past scene`, `${TAG}; R-V51) Desk.first`] },
  { item: '4 VIZ-10: Node only for node:crypto hashing in the server-only model files', file: S12, has: [`${TAG}; 8a list item 4)* \`node:crypto\` hashing in the server-only model files`] },
  // Item 5: server and API.
  { item: '5 R-V22: handles of 6–32 characters, the fragment regex, the T-VIZ-api exemption (12 §2, §3.8, §3.10.6, §7)', file: S12, has: ['both get the shortest unique longer prefix (up to all 32', `\`^[0-9a-f]{6,32}$\` *${TAG}; R-V22: was \`{6}\``, `${TAG}; R-V22)* A world re-sent after a \`reset\` caused by a handle collision`, `${INLINE}; R-V22:* except the cards of a world re-sent after a \`reset\``] },
  { item: '5 R-V23: the EventVM position shape (12 §3.10.6)', file: S12, has: ["an EventVM carries `at: Pos` in place of the three fields height, sub and k, which the page's ui/unproject.ts restores"] },
  { item: '5 R-V24: down without a live marker (12 §3.3.6)', file: S12, has: [`${INLINE}; R-V24:* in 8a, for a \`--repo\` room, whose argument stands in for the \`live\` marker`] },
  { item: '5 R-V28: seen anchors and tick glyphs (12 §3.8, §3.9.1)', file: S12, has: [`${TAG}; R-V28)* The basis of \`seen_ms\` is a **seen anchor**`, `${TAG}; R-V28)* A served tick's glyph is fixed by its event kind`] },
  { item: '5 R-V29: one segment per page request (12 §3.10.5)', file: S12, has: [`${INLINE}; R-V29:* was "by whole segments"`, `${TAG}; R-V29, R-V49, Task 8 rulings)* **Timeline pages, precisely.**`] },
  { item: "5 R-V49: layout deltas and the page's idempotent apply (12 §3.10.6)", file: S12, has: [`${INLINE}; R-V49:* a delta whose \`version\` is at most the page's version is a no-op`] },
  { item: "5 R-V43: closed code sets and the Reused row's reason codes (12 §3.10.6, §3.11)", file: S12, has: [`${TAG}; R-V43)* **Closed code sets.**`, `${TAG}; R-V43) the reason codes rendered inside a \`reason\` parameter`] },
  { item: '5 R-V50: the served path budget and raw-unit caps (12 §3.10.6, §3.11)', file: S12, has: [`${TAG}; R-V50)* **Path budget.**`, 'at most 16,384 bytes', '`VIZ_RAW_UNITS` = 4 × its cap in UTF-16 code units'] },
  { item: '5 R-V50: raw-unit caps (00 §28, §19 viewer row)', file: G00, has: [`${TAG}; R-V50)* before the grapheme cap every string is cut to 4 × its cap`] },
  { item: '5 R-V52: name tags (12 §3.6, VIZ-18)', file: S12, has: [`${TAG}; R-V52, Task 9 and FS rulings)* Collisions are computed on comparison forms`, `${INLINE}; R-V52:* the whole handle, never cut by the name cap`] },
  { item: '5 R-V53: the viz over-cap ellipsis (12 §3.11)', file: S12, has: [`${TAG}; R-V53)* A rendered \`viz\` result over the channel cap (400) is end-ellipsized`] },
  { item: "5 R-V48: Node's own responses (12 §3.10.3)", file: S12, has: [`${TAG}; R-V48)* **Responses Node writes before the handler.**`, '`checkContinue` and `checkExpectation`'] },
  { item: '5 R-V55: the two URL templates (12 §9.5)', file: S12, has: [`${TAG}; R-V55)* As landed (L-VIZ-URL): exactly two templates`] },
  { item: '5 R-V55: INV-EGRESS (09)', file: S09, has: [`| **INV-EGRESS** | *${TAG}; 12 §9.3, R-V55)*`] },
  { item: '5 R-V55: L-NET and L-VIZ-URL (11 §3.10)', file: T11, has: [`${TAG}; 12 §9.5, R-V34, R-V55)* Exceptions: the \`node:http\` module load`, `| L-VIZ-URL | *${TAG}; R-V55)*`] },
  // Item 6: lint ids and the interfaces 8a writes differently.
  {
    item: '6 the L-VIZ-* lint ids (11 §3.10)', file: T11,
    has: ['| L-VIZ-DOM | *(8a batch', '| L-VIZ-GIT | *(8a batch', '| L-VIZ-IMPORT | *(8a batch', '| L-VIZ-NET | *(8a batch', '| L-VIZ-URL | *(8a batch', '| L-VIZ-TYPES | *(8a batch'],
  },
  {
    item: '6 the interfaces as landed, model/labels.ts (12 §3.13)', file: S12,
    has: [
      `${TAG}; 8a list item 6, R-V56, gate-P merge ruling (b), F-8a-2, F-8a-3)* **As landed in Plan 8a**`, '`RoomSource` has `tip(): Promise<TipInfo | null>`',
      '`startPoll(stores, sink, clock)` returns `() => Promise<void>`', '`main(argv, assets)`', '`parseDemoLog(buf, captionCodes)`', 'The new model file `model/labels.ts`',
    ],
  },
  // Item 7: budgets.
  { item: '7 R-V41: CI-exact versus 2× and the manual check (12 §3.12, §7)', file: S12, has: [`${TAG}; R-V41)* **Where the budgets are checked.**`, `${TAG}; R-V41, Task 15 rulings)* On CI (\`COWORK_VIZ_SLOW=1\`, the \`viz-slow\` workflow)`] },
  { item: '7 R-V41: the viewer suites (11 §3.11)', file: T11, has: [`${TAG}; 12 §9.5, R-V37, R-V41, Task 15 and Task 17 rulings)* **Viewer suites.**`] },
  // Item 8: the roadmap's execution-order sentence (the ahead tasks did run ahead).
  { item: '8 R-V01: the execution-order sentence (roadmap)', file: ROADMAP, has: [`Plan 8a starts when plan 2 has landed (its tasks that touch no Plan 2 file may start earlier) *${TAG}; R-V01)*`] },
  { item: '8 R-V01: the §9.1 note (12)', file: S12, has: [`${TAG}; 8a list item 8, R-V01)* The roadmap's execution-order sentence`] },
  // Item 9 is withdrawn (X-92, the owner's choice): rev 2.5 carries the owner's text instead.
  { item: "9 withdrawn: rev 2.5's owner choice on claims (12 header)", file: S12, has: ['**Owner choice of 2026-10-08: claims in the viewer (RECONCILIATION X-92, the alternative).**', 'The viewer never re-seeds its fold from a checkpoint'] },
  // Item 10 (X-94): a hold id's shortest unique prefix; 10-product §2 already admits a unique prefix (rev 2.5).
  { item: '10 X-94: hold ids by the shortest unique prefix of at least 8 (12 §3.8)', file: S12, has: [`${TAG}; 8a list item 10, X-94)* the shortest unique prefix of at least 8 characters of its hold id`] },
  { item: '10 X-94: show ids admit a unique prefix (10 §2, rev 2.5)', file: P10, has: ['a unique prefix of at least 6 characters of any of them'] },
  // Item 11: the batch form.
  { item: "11 the batch form: against rev 2.5, after Plan 2's, before Plan 3's (12 header)", file: S12, has: ["**Plan 8a spec-edit batch (2026-10-10), after Plan 2's batch.**", 'in the one order Plan 2 → 8a → 3 → 4 → 5 → 6 → 7 → 8b'] },
  { item: '11 the batch form (09 change line)', file: S09, has: ["Changed by Plan 8a's spec-edit batch (2026-10-10, after Plan 2's batch)"] },
  // Item 12: no "provisional" on D3.
  { item: '12 D3 is final in 12 §9.1', file: S12, has: ['(rev 2.5, F32; owner decision D3 of 2026-10-08) a last Task 19', `${TAG}; 8a list item 12)*`], lacks: ['F32; provisional'] },
  { item: '12 D3 is final in the roadmap', file: ROADMAP, has: ['(rev 2.5, F32; owner decision D3, decided 2026-10-08)'], lacks: ['provisional'] },
  // 12 §9.2–§9.7.
  { item: '§9.2 applied (12)', file: S12, has: [`**Applied.** *${TAG})* Merged as glossary §28`] },
  { item: '§9.2 glossary §28 Visualizer (00)', file: G00, has: ['## 28. Visualizer (2026-10-06; superseded by §29 where they differ)', `${TAG})* The pending section of 12-visualizer §9.2`] },
  { item: '§9.3 applied (12)', file: S12, has: [`**Applied.** *${TAG})* Every bullet below is in 09-security`] },
  {
    item: '§9.3 09-security: E8, channel viz, the opener display set, threat rows', file: S09,
    has: [`| E8 | none (inbound loopback listener) *${TAG}; 12 §9.3)*`, `*${TAG}; 12 §9.3)* **Channel \`viz\`.**`, `${TAG}; 12 §9.3)* The browser opener of 12-visualizer additionally receives \`DISPLAY\``, `${TAG}; 12 §9.3)* Other local users and web pages against the viewer's loopback listener`],
  },
  { item: '§9.4 applied (12)', file: S12, has: [`**Applied.** *${TAG})* Every bullet below is in 10-product`] },
  {
    item: '§9.4 10-product: channel viz, INV-UX-READONLY, UX-01, §3.3, §3.18', file: P10,
    has: [`| \`viz\` *${TAG}; 12 §9.4)* | the viewer page (12-visualizer)`, `\`wrap\` and *${TAG}; 12 §9.4)* \`view\` change no ref`, `${TAG}; 12 §9.4: \`viz\` and the client added)`, `${TAG}; 12 §9.4)* No command file is added for \`view\``, `${INLINE}: promoted from 12 §9.4 into this row:*`],
  },
  { item: '§9.4 08-lifecycle §2.6: the view flags', file: L08, has: [`\`view\`: \`--no-open\`, \`--demo[=<file>]\`, \`--repo <path>\` (12-visualizer; read-only) *${TAG}; 12 §9.4)*`] },
  { item: '§9.5 applied (12)', file: S12, has: [`**Applied.** *${TAG})* Every bullet below is in 11-testing §3.10 and §3.11`] },
  {
    item: '§9.5 11-testing: L-PORTS, the viewer exemptions', file: T11,
    has: [`${INLINE}; 12 §9.5, R-V34:* and the viewer CLI's \`src/viz/cli/spawn.ts\``, `${TAG}; 12 §9.5, R-V30, R-V34, Task 15 ruling)* **Viewer exemptions from the Plan 1 rules.**`],
  },
  { item: '§9.6 applied (12)', file: S12, has: [`**Applied.** *${TAG})* \`view\` is in 06-claude §3.9 row (d)'s advisory list`] },
  { item: '§9.6 06-claude §3.9 row (d)', file: C06, has: [`and \`view\` *${TAG}; 12 §9.6: read-only`] },
  { item: '§9.7 landed (12)', file: S12, has: [`**Landed in Plan 8a.** *${TAG}; R-V02…R-V08, R-V69, R-V74)*`] },
  // The ledger's spec-edit entries.
  { item: 'ledger R-V57: Layout.version per desk, cell and home spot (12 §3.3.7)', file: S12, has: [`${TAG}; R-V57) per home-spot entry added`] },
  { item: 'ledger R-V58: Strings.templates (12 §3.10.6)', file: S12, has: ['templates: Record<string, CatalogEntry>;', `${TAG}; R-V58) the template`] },
  { item: 'ledger (Task 1): join before caps in the demo format (12 §3.9.3)', file: S12, has: [`${TAG}; Task 1 ruling:`, "join before caps, because the fold rejects a caps op before the writer's join)"] },
  { item: 'ledger R-V61: reserved key segments escaped (12 §3.5.3, §3.3.7)', file: S12, has: [`${TAG}; R-V61) a key segment built from a path that is exactly`, `${TAG}; R-V61: key segments are escaped as §3.5.3 says)`] },
  { item: 'ledger R-V62: the outline mix (12 §3.6)', file: S12, has: [`${TAG}; R-V62: was 0.62`, '`#CF7CAA`'] },
  { item: 'ledger R-V63: the colour-vision baseline (12 §3.6)', file: S12, has: [`${TAG}; R-V63)* this section's own seven body hues before any adjustment`] },
  { item: 'ledger (Task 12): seat-variant tones and the hollow parcel (12 §3.6, §3.4)', file: S12, has: [`${TAG}; Task 12 ruling)* The seat-variant marks are drawn in the pet's highlight and body tones`, `${INLINE}; Task 12 ruling:* drawn as a distinct hollow parcel`] },
  { item: 'ledger R-V65, R-V72: stream backpressure and the ring byte cap (12 §3.10.5)', file: S12, has: [`${TAG}; R-V65, R-V72, Task 10 rulings)* **Backpressure.**`, '`RING_MAX_BYTES` = `SSE_BUFFER_MAX` = 1,048,576'] },
  { item: 'ledger R-V65, R-V72: the viewer numbers (00 §28 §20)', file: G00, has: [`${TAG})* the resume ring also ≤ 1 MiB`] },
  { item: 'ledger (Tasks 11, gate P): the protected data directory and killTree as landed (12 §3.2)', file: S12, has: [`${TAG}; Task 11 and gate-P merge rulings)* As landed, \`killTree(child, platform, systemRoot)\``] },
  { item: 'ledger R-V66: error bodies (12 §3.10.4)', file: S12, has: [`${INLINE}; R-V66:* for 401, 404, 421 and 500, on API and shell paths alike`] },
  { item: 'ledger R-V67: the blocked rotation and its marker (12 §3.10.10)', file: S12, has: [`${TAG}; R-V67)* While a rotation is blocked`, 'one marker `{code: VIZ_LOG_DROPPED, n}`'] },
  { item: 'ledger R-V67: VIZ_LOG_DROPPED in the §3.11 Log only row (landed with T-VIZ-i18n, Task 19)', file: S12, has: [/^\| Log only \|[^\n]*`VIZ_LOG_DROPPED`/mu] },
  { item: 'ledger (Task 11): {cmd} quoted for the shell (10 §3.3)', file: P10, has: [`${TAG}; Task 11 ruling)* Every word of a \`{cmd}\` line is quoted for the shell`] },
  { item: 'ledger R-V71: a frozen daemon re-posts its freeze event (12 §3.3.5)', file: S12, has: [`${INLINE}; R-V71, X-106:* a daemon that stays frozen re-posts its current \`freeze\` event`] },
  { item: 'ledger R-V71: ENG-17 (01)', file: E01, has: [`${TAG}; R-V71, X-106)* While a reason stays set, the engine MUST re-post its current \`freeze\` event`] },
  { item: 'ledger R-V73: ClaimState.at (12 §3.3.7)', file: S12, has: [`${TAG}; R-V73) the position of the claim's newest`] },
  { item: 'ledger (Task 6): the BOARD_FULL badge for one height (12 §3.4)', file: S12, has: [`${TAG}; Task 6 ruling)* A \`BOARD_FULL\` event makes \`full\` at its op line`] },
  { item: 'ledger (FS): default-ignorables dropped in every channel (12 §3.11)', file: S12, has: [`${TAG}; FS ruling)* \`sanitize\` drops every default-ignorable code point in every channel`] },
  { item: 'ledger (FS): SEC-34 (09)', file: S09, has: [`${TAG}; FS ruling)* and, in every channel, every other format character and every \`Default_Ignorable_Code_Point\``] },
  { item: 'ledger (Task 7): a heartbeat ahead of the monotonic clock reads as down (12 §3.3.6, VIZ-13)', file: S12, has: [`${TAG}; Task 7 ruling)* or ahead of that clock by more than \`loop_period_ms\``, `${INLINE}; Task 7 ruling:* or a heartbeat ahead of that clock`] },
  { item: 'ledger (Task 7): 01 §3.16', file: E01, has: [`${TAG}; Task 7 ruling)* So is a heartbeat ahead of the reader's machine-monotonic clock`] },
  { item: "ledger (Task 14): the rewind slider's accessible name (12 §3.9.1)", file: S12, has: [`${TAG}; Task 14 ruling)* The rewind slider's accessible name is the replay position \`#<height>\``] },
  {
    item: 'ledger (Task 14): UI_VIZ_CTRL_POSITION in the §3.11 Controls and filters row (landed with codes.ts, en.ts and the slider, Task 19)', file: S12,
    has: [/^\| Controls and filters \|[^\n]*`UI_VIZ_CTRL_POSITION`/mu],
  },
  // Task 19 (F32): the eight follow codes moved from §9.9 into the §3.11 rows (FEAT-F32-09), with the follow-end announcement
  // UI_VIZ_FOLLOW_ENDED (FEAT-F32-11; Task 19 fix round 1); §9.9 keeps no F32 bullet.
  {
    item: 'Task 19 (F32): the follow codes in the §3.11 Scene labels and Controls rows, none left in §9.9', file: S12,
    has: [/^\| Scene labels \|[^\n]*`UI_VIZ_FOLLOWING`, `UI_VIZ_NOW_ASKS`, `UI_VIZ_NOW_ASKED_BY`, `UI_VIZ_NOW_LAST_SHARED`, `UI_VIZ_NOW_LAST_SHARED_TABLE`, `UI_VIZ_NOW_NOTHING`, `UI_VIZ_NOW_NOT_HERE`, \(8a batch, after Plan 2's; FEAT-F32-11\) `UI_VIZ_FOLLOW_ENDED` \|$/mu,
      `${TAG}; FEAT-F32-11)* The selected room's follow start and end are offered to the announcer`,
      /^\| Controls and filters \|[^\n]*`UI_VIZ_CTRL_FOLLOW`/mu],
    lacks: ['- **F32 — 8a Task 19'],
  },
  {
    item: 'ledger (Task 8): retention, page folds, incident thaw, UI_INTERNAL_ERROR (12 §3.3.3, §3.9.1, VIZ-14, §3.10.10)', file: S12,
    has: [`${TAG}; Task 8 ruling)* "The newest 2,048 heights"`, `${TAG}; R-V29, Task 8 ruling)* The 255 folds are the seek cost (VIZ-26)`, `${TAG}; Task 8 ruling, R-V21)* "A fresh heartbeat"`, `${TAG}; Task 8 ruling)* \`UI_INTERNAL_ERROR\` (§3.11 "Reused") is also a code of this log`],
  },
  { item: 'ledger (Task 16): export-demo refs and the captions file (12 §3.9.3)', file: S12, has: [`${INLINE}; Task 16 rulings:* as landed, a peer clone's \`refs/cowork-remote/<enc(b)>/board\``, `${INLINE}; Task 16 ruling:* LF or CRLF, with or without a BOM)`] },
  { item: 'ledger (gate P (a)): L-PID-KILL two exceptions (11)', file: T11, has: [`${TAG}; gate-P merge ruling (a): two exceptions)* The second is the viewer CLI's POSIX process-group kill`] },
  { item: 'ledger (gate P (b)): killTree(child, platform, systemRoot) (12 §3.13)', file: S12, has: ['`killTree(child, platform, systemRoot)` takes the held child, not a pid'] },
  {
    item: 'ledger (Task 15): the command line, the heap cap, viz-stderr.txt, settled RSS (12 §3.2, §3.10.10, §3.12)', file: S12,
    has: [`${TAG}; Task 15 rulings)* **The command line and stderr.**`, `${TAG}; Task 15 rulings)* measured as the settled RSS`, `${TAG}; Task 15 rulings)* \`log/\` also holds \`viz-stderr.txt\``],
  },
  { item: 'ledger (Task 15): viz-stderr.txt (00 §28)', file: G00, has: [`${TAG}; Task 15 rulings)* Beside them, \`log/viz-stderr.txt\``] },
  { item: 'ledger R-V16: the handshake order (12 §3.2 item 3)', file: S12, has: [`${TAG}; R-V16, Task 15 ruling)* The ready line comes before any folding`] },
];

const contains = (text: string, needle: string | RegExp): boolean => (typeof needle === 'string' ? text.includes(needle) : needle.test(text));

// ---------------------------------------------------------------------------------------------------------------------------------

test('exit sweep: every T-VIZ id named in roadmap row 8 (8a) is carried by a test title starting with T-VIZ-<id> and is green on the three OS legs; browser smoke (a)–(g) and (i) green on one leg', async (t) => {
  const row = parseRow8a(read(ROADMAP));
  const files = vizTestFiles();
  const titles = files.flatMap(titlesOf);
  const smokeTitles = titlesOf(SMOKE_FILE);

  await t.test('the title rule: T-VIZ-<id> then ":" or " (", nothing longer', () => {
    assert.ok(carries('T-VIZ-log: cards', 'log'));
    assert.ok(carries('T-VIZ-log (cards): x', 'log'));
    assert.ok(!carries('T-VIZ-logs (unit): x', 'log'), 'T-VIZ-logs does not carry T-VIZ-log');
    assert.ok(!carries('T-VIZ-golden-board: x', 'golden'), 'a longer id does not carry a shorter one');
    assert.ok(!carries('T-VIZ-log', 'log'), 'the bare id is not a title of the rule');
    assert.ok(!carries('see T-VIZ-log: x', 'log'), 'the title starts with the id');
    assert.ok(!carries('T-VIZ-\u0000', ''), 'a template title with a substitution after T-VIZ- carries nothing');
    const sample = [
      "test('T-VIZ-a: runs', () => {});",
      "test.skip('T-VIZ-b: skipped', () => {});",
      "test('T-VIZ-c: off', { skip: true }, () => {});",
      "it('T-VIZ-d (todo): off', { todo: 'later' }, () => {});",
      "test('T-VIZ-e (gated): runs on its leg', { skip: SKIP, timeout: 1 }, async (t) => { await t.test('T-VIZ-f: a subtest', () => {}); });",
      "// test('T-VIZ-g: a comment', () => {});",
      "const s = 'T-VIZ-h: a string that is no title'; assert.ok(/x/.test('T-VIZ-i: neither is a RegExp#test argument'));",
      'for (const x of xs) test(`T-VIZ-${x}: generated`, () => {});',
    ].join('\n');
    assert.deepEqual(titlesIn('sample.test.ts', sample).map((x) => [x.title, x.runnable, x.line]), [
      ['T-VIZ-a: runs', true, 1], ['T-VIZ-b: skipped', false, 2], ['T-VIZ-c: off', false, 3], ['T-VIZ-d (todo): off', false, 4],
      ['T-VIZ-e (gated): runs on its leg', true, 5], ['T-VIZ-f: a subtest', true, 5], ['T-VIZ-\u0000', true, 8],
    ]);
  });

  await t.test('roadmap row 8 (8a) parses into its T-VIZ ids, smoke items, Task 19 clause and the storyboard clause', () => {
    assert.equal(row.ids.length, ROW_IDS_BEFORE_TASK_19, `the row's ids: ${row.ids.join(', ')}`);
    assert.equal(new Set(row.ids).size, row.ids.length, 'no id twice');
    for (const id of row.ids) assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    assert.deepEqual([row.ids[0], row.ids.at(-1)], ['timeline-fixtures', 'i18n'], 'the list from its first id to its last');
    assert.deepEqual(row.smoke, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'i']);
    assert.deepEqual(row.task19Ids, [...TASK_19_IDS], "Task 19's clause");
    assert.deepEqual(row.task19Smoke, ['k']);
    assert.equal(row.other.length, 1, `one clause besides the lists: ${JSON.stringify(row.other)}`);
    assert.match(row.other[0] as string, /^the Plan 2 storyboard of 12 §3\.9\.3 renders in `en`/u);
    for (const id of PENDING_TASK_19.ids) assert.ok(row.task19Ids.includes(id), `pending ${id} is one of Task 19's ids`);
    for (const s of PENDING_TASK_19.smoke) assert.ok(row.task19Smoke.includes(s), `pending (${s}) is Task 19's smoke item`);
    assert.ok(files.length >= 80 && files.includes(SMOKE_FILE), `the scan reads test/**/viz/** (${files.length} files)`);
  });

  const required = [...row.ids, ...row.task19Ids.filter((id) => !PENDING_TASK_19.ids.has(id))];
  await t.test(`every required T-VIZ id of the row (${required.length}) starts a runnable test title`, (s) => {
    const missing = required.filter((id) => !titles.some((x) => x.runnable && carries(x.title, id)));
    const offOnly = missing.filter((id) => titles.some((x) => carries(x.title, id)));
    assert.deepEqual(missing, [], `missing: ${missing.map((id) => `T-VIZ-${id}`).join(', ')}${offOnly.length > 0 ? ` (only skipped or todo titles: ${offOnly.join(', ')})` : ''}`);
    const n = required.map((id) => titles.filter((x) => carries(x.title, id)).length);
    s.diagnostic(`${required.length} ids carried by ${n.reduce((a, b) => a + b, 0)} titles in ${files.length} files under test/**/viz/**`);
  });

  const smokeRequired = [...row.smoke, ...row.task19Smoke.filter((s) => !PENDING_TASK_19.smoke.has(s))];
  await t.test(`browser smoke items (${smokeRequired.join(', ')}) are runnable tests of ${SMOKE_FILE}`, () => {
    const missing = smokeRequired.filter((s) => !smokeTitles.some((x) => x.runnable && x.title.startsWith(`(${s}) `)));
    assert.deepEqual(missing, [], `missing smoke items: ${missing.map((s) => `(${s})`).join(', ')}`);
  });

  await t.test("the storyboard clause is carried by Task 18 step A's tests", () => {
    const has = (file: string, title: string): boolean => titlesOf(file).some((x) => x.runnable && x.title === title);
    assert.ok(has('test/integration/viz/storyboard.test.ts', 'the storyboard shows every Plan 2 fact 12 §3.9.3 lists'));
    assert.ok(has('test/integration/viz/demoE2E.test.ts', 'node dist/cli.js view --demo works end to end'));
  });

  // Pending Task 19: a todo while missing; once present, a failure that asks for the pending mark to go (a stale mark never stays green).
  const pendingTest = async (name: string, present: boolean, reason: string): Promise<void> => {
    await t.test(name, present ? {} : { todo: reason }, () => {
      assert.ok(!present, `present now: remove it from the pending list (${reason})`);
    });
  };
  for (const id of row.task19Ids.filter((x) => PENDING_TASK_19.ids.has(x))) {
    await pendingTest(`Task 19 (F32): T-VIZ-${id}`, titles.some((x) => x.runnable && carries(x.title, id)), 'pending Task 19');
  }
  for (const s of row.task19Smoke.filter((x) => PENDING_TASK_19.smoke.has(x))) {
    await pendingTest(`Task 19 (F32): browser smoke item (${s})`, smokeTitles.some((x) => x.runnable && x.title.startsWith(`(${s}) `)), 'pending Task 19');
  }

  await t.test(`the spec files hold every item of 8a's spec-edit batch (${CHECKLIST.length} items)`, async (c) => {
    const text = new Map<string, string>();
    const of = (file: string): string => {
      let s = text.get(file);
      if (s === undefined) text.set(file, (s = read(file)));
      return s;
    };
    const failed: string[] = [];
    for (const it of CHECKLIST) {
      const s = of(it.file);
      const absent = it.has.filter((n) => !contains(s, n)).map(String);
      const stray = (it.lacks ?? []).filter((n) => s.includes(n));
      const ok = absent.length === 0 && stray.length === 0;
      if (it.pending !== undefined) {
        const reason = it.pending;
        await c.test(it.item, ok ? {} : { todo: reason }, () => {
          assert.ok(!ok, `present now: drop its pending mark (${reason})`);
        });
        continue;
      }
      if (!ok) failed.push(`${it.item} [${it.file}]${absent.length > 0 ? ` lacks ${JSON.stringify(absent)}` : ''}${stray.length > 0 ? ` still has ${JSON.stringify(stray)}` : ''}`);
    }
    assert.deepEqual(failed, [], `spec-edit items not in the spec:\n${failed.join('\n')}`);
  });
});
