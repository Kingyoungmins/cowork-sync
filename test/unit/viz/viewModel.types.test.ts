// Plan 8a Task 4: server/viewModel.ts is the served-JSON allowlist (12 §3.10.6, R-V26). It is in the page's client program
// (R-V35), so it imports nothing, and its EventVM is the projection of the closed SceneEvent set (R-V23: at: Pos for the
// three position fields; R-V47: owner on the pet events).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { SCENE_EVENT_KINDS, type SceneEvent, type SceneEventKind } from '../../../src/viz/model/events.js';
import type { ActorStateVM, CardVM, EventVM, LayoutDeltaVM, LayoutVM, Pos, StreamPayload, Tick as TickVM } from '../../../src/viz/server/viewModel.js';
import type { Tick } from '../../../src/viz/server/models.js';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
/** The member of a kind-tagged union whose kind set contains K (distributive, so grouped kinds resolve). */
type MemberOf<U, K> = U extends { kind: infer UK } ? (K extends UK ? U : never) : never;

const VIEW_MODEL = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'viz', 'server', 'viewModel.ts');

// Type level: the kinds are the same closed set ...
const kindsMirror: Equals<EventVM['kind'], SceneEventKind> = true;
// ... and each kind carries the same field names, with at in place of height, sub and k (R-V23).
type FieldsMirror = {
  [K in SceneEventKind]: Equals<Exclude<keyof MemberOf<EventVM, K>, 'at' | 'seed'>, Exclude<keyof MemberOf<SceneEvent, K>, 'height' | 'sub' | 'k' | 'seed'>>;
};
const fieldsMirror: Equals<FieldsMirror[SceneEventKind], true> = true;
const posIsTriple: Equals<Pos, [height: number, sub: number, k: number]> = true;
const eventAt: Equals<MemberOf<EventVM, 'publish'>['at'], Pos> = true;
// R-V47: the pet events carry their owner's handle; R-V25: position-typed recency; R-V51: Desk.first on the wire.
const petOwner: Equals<MemberOf<EventVM, 'pet_spawn'>['owner'], string> = true;
const lastPublish: Equals<ActorStateVM['lastPublish'], Pos | null> = true;
const lastClaimOp: Equals<ActorStateVM['lastClaimOp'], Pos | null> = true;
const deskFirst: Equals<LayoutVM['desks'][number]['first'], number> = true;
const deltaDesks: Equals<LayoutDeltaVM['desks'], LayoutVM['desks']> = true;
const seenMs: Equals<CardVM['seen_ms'], number | null> = true;
// models.ts declares an identical Tick (viewModel.ts imports nothing).
const tickSame: Equals<Tick, TickVM> = true;
const payloadTypes: Equals<StreamPayload['type'], 'timeline' | 'room_snapshot' | 'layout' | 'overlay' | 'room' | 'reset' | 'bye'> = true;

/** Every module-reaching construct in a source file: import/export-from declarations, import types, import()/require() calls, references. */
function moduleReferences(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const found: string[] = [];
  for (const r of [...sf.referencedFiles, ...sf.typeReferenceDirectives, ...sf.libReferenceDirectives]) found.push(`/// reference ${r.fileName}`);
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n)) found.push(n.getText(sf));
    else if (ts.isExportDeclaration(n) && n.moduleSpecifier !== undefined) found.push(n.getText(sf));
    else if (ts.isImportTypeNode(n)) found.push(n.getText(sf));
    else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
      found.push(n.getText(sf));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

test('viewModel.ts imports nothing and every EventVM kind mirrors a SceneEvent kind', () => {
  assert.equal(kindsMirror && fieldsMirror && posIsTriple && eventAt && petOwner && lastPublish && lastClaimOp && deskFirst && deltaDesks && seenMs && tickSame && payloadTypes, true);
  const text = readFileSync(VIEW_MODEL, 'utf8');
  assert.deepEqual(moduleReferences(VIEW_MODEL, text), []);
  assert.doesNotMatch(text, /events(\.js|\.ts)?['"]/, 'viewModel.ts never names model/events');
  // The detector itself finds each form it looks for.
  assert.equal(moduleReferences('x.ts', "import type { A } from './events.js';").length, 1);
  assert.equal(moduleReferences('x.ts', "export type { A } from './events.js';").length, 1);
  assert.equal(moduleReferences('x.ts', "type A = import('./events.js').SceneEvent;").length, 1);
  assert.equal(moduleReferences('x.ts', '/// <reference types="node" />\nexport {};').length, 1);
  // The runtime kind list is the same closed set the type mirrors.
  assert.equal(SCENE_EVENT_KINDS.length, 32);
});
