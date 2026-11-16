// The revert shrink marks (Plan 3 Task 17; glossary §29.1 decision D2, §29.2 "clean HLD-41 rebase"; 05-holds Algorithm REV step 8,
// §8 Q18; 11-testing TC-F10-17 (d)): per pending revert CS, path → the oid its confirmed write produced (ABSENT for a deletion),
// moved only by a clean rebase whose R[p] before it was the mark's oid. Memory only; pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { RevertMarks } from '../../src/holds/revertCs.js';

const PEER = 'a'.repeat(32);
const CS1 = `${PEER}/human/4`;
const CS2 = `${PEER}/human/5`;
const X = '1'.repeat(40) as Oid;
const Y = '2'.repeat(40) as Oid;
const Z = '3'.repeat(40) as Oid;

test('covers is true only for the exact oid a pending mark holds for the path (ABSENT for a deletion) and false after drop', () => {
  const m = new RevertMarks();
  assert.equal(m.covers('a.ts', X), false, 'no mark yet');
  m.set(CS1, new Map<string, Oid | 'ABSENT'>([['a.ts', X], ['n.ts', ABSENT]]));
  assert.equal(m.covers('a.ts', X), true, 'exactly the written blob');
  assert.equal(m.covers('a.ts', Y), false, 'any other content of the path gets the ordinary guard');
  assert.equal(m.covers('n.ts', ABSENT), true, 'a deletion the revert wrote');
  assert.equal(m.covers('n.ts', X), false, 'content where the revert deleted the file');
  assert.equal(m.covers('b.ts', X), false, 'the oid on another path');
  assert.deepEqual([...m.current(CS1)!], [['a.ts', X], ['n.ts', ABSENT]]);
  assert.deepEqual(m.pending(), [CS1]);
  m.set(CS2, new Map<string, Oid | 'ABSENT'>([['b.ts', Y]]));
  assert.deepEqual(m.pending(), [CS1, CS2]);
  m.drop(CS1);
  assert.equal(m.covers('a.ts', X), false, 'dropped with its CS');
  assert.equal(m.covers('n.ts', ABSENT), false);
  assert.equal(m.current(CS1), null);
  assert.equal(m.covers('b.ts', Y), true, 'another CS keeps its own mark');
  assert.deepEqual(m.pending(), [CS2]);
  // The map handed over is copied: a caller's later change never moves a mark.
  const w = new Map<string, Oid | 'ABSENT'>([['c.ts', Z]]);
  m.set(CS1, w);
  w.set('c.ts', X);
  assert.equal(m.covers('c.ts', Z), true);
  assert.equal(m.covers('c.ts', X), false);
});

test('moveOnCleanRebase moves a path\'s oid only when the mark\'s current oid equals before, and reports false (mark unchanged) otherwise', () => {
  const m = new RevertMarks();
  m.set(CS1, new Map<string, Oid | 'ABSENT'>([['a.ts', X], ['b.ts', Y], ['n.ts', ABSENT]]));
  // TC-F10-17 (d) shape: the pair's R[p] before the rebase is another member's capture, not the mark's oid.
  assert.equal(m.moveOnCleanRebase(CS1, 'a.ts', Z, Y), false, 'R[p] before the rebase was not the mark\'s oid');
  assert.equal(m.covers('a.ts', X), true, 'the mark is unchanged');
  assert.equal(m.covers('a.ts', Y), false);
  assert.equal(m.moveOnCleanRebase(CS2, 'a.ts', X, Z), false, 'no mark for that CS');
  assert.equal(m.moveOnCleanRebase(CS1, 'c.ts', X, Z), false, 'no mark for that path');
  // The clean HLD-41 rebase of the marked blob: the mark follows to the new R[p] (glossary §29.2).
  assert.equal(m.moveOnCleanRebase(CS1, 'a.ts', X, Z), true);
  assert.equal(m.covers('a.ts', Z), true, 'the rebased R[p] is now the exempt content');
  assert.equal(m.covers('a.ts', X), false, 'the written oid no longer is');
  assert.deepEqual([...m.current(CS1)!], [['a.ts', Z], ['b.ts', Y], ['n.ts', ABSENT]], 'only the rebased path moved');
  // A second move starts from the moved oid.
  assert.equal(m.moveOnCleanRebase(CS1, 'a.ts', X, Y), false);
  assert.equal(m.moveOnCleanRebase(CS1, 'a.ts', Z, Y), true);
  assert.equal(m.covers('a.ts', Y), true);
});
