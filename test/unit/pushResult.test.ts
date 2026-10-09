import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NONRETRYABLE_STREAK } from '../../src/git/classify.js';
import { ABSENT, parseOid, type OidOrAbsent } from '../../src/git/oid.js';
import type { PushRefStatus } from '../../src/git/push.js';
import { classifyPublish, type PublishObservation } from '../../src/engine/pushResult.js';

const T = parseOid('a'.repeat(40));
const T2 = parseOid('b'.repeat(40));

function obs(o: Partial<PublishObservation>): PublishObservation {
  return { boardStatus: 'rejected', refetchedBoard: T, lease: T, ourWriterOnChain: false, previousStreak: 0, ...o };
}

test('classifyPublish: landed over lease_lost over transient; nonretryable at the third; status none with the board unchanged is network with the streak unchanged', () => {
  // landed: our writer (or an op id) on T′'s first-parent chain after the lease beats a moved ref and a rejection line.
  assert.deepEqual(classifyPublish(obs({ ourWriterOnChain: true, refetchedBoard: T2, previousStreak: 2 })), { outcome: 'landed', streak: 0 });
  assert.deepEqual(classifyPublish(obs({ ourWriterOnChain: true, boardStatus: 'none', refetchedBoard: T2 })), { outcome: 'landed', streak: 0 });
  // A porcelain 'ok' for the board ref is a landing (ENG-44), whatever the streak was.
  assert.deepEqual(classifyPublish(obs({ boardStatus: 'ok', previousStreak: 2 })), { outcome: 'landed', streak: 0 });
  // lease_lost: T′ ≠ T beats a rejection line; the streak resets (PRO-54).
  assert.deepEqual(classifyPublish(obs({ refetchedBoard: T2, previousStreak: 2 })), { outcome: 'lease_lost', streak: 0 });
  assert.deepEqual(classifyPublish(obs({ refetchedBoard: ABSENT, previousStreak: 1 })), { outcome: 'lease_lost', streak: 0 });
  assert.deepEqual(classifyPublish(obs({ lease: ABSENT, refetchedBoard: T })), { outcome: 'lease_lost', streak: 0 });
  assert.deepEqual(classifyPublish(obs({ boardStatus: 'none', refetchedBoard: T2, previousStreak: 1 })), { outcome: 'lease_lost', streak: 0 });
  // transient: a per-ref rejection with the board unchanged; the 3rd consecutive one is nonretryable (glossary §26.2 item 2).
  assert.deepEqual(classifyPublish(obs({ previousStreak: 0 })), { outcome: 'transient', streak: 1 });
  assert.deepEqual(classifyPublish(obs({ previousStreak: 1 })), { outcome: 'transient', streak: 2 });
  assert.deepEqual(classifyPublish(obs({ previousStreak: NONRETRYABLE_STREAK - 1 })), { outcome: 'nonretryable', streak: NONRETRYABLE_STREAK });
  assert.deepEqual(classifyPublish(obs({ lease: ABSENT, refetchedBoard: ABSENT })), { outcome: 'transient', streak: 1 }, 'ABSENT == ABSENT is unchanged');
  // network: no porcelain line for the board ref and the board unchanged; never counted in the streak (ENG-44).
  for (const prev of [0, 1, 2]) {
    assert.deepEqual(classifyPublish(obs({ boardStatus: 'none', previousStreak: prev })), { outcome: 'network', streak: prev });
  }
  assert.deepEqual(classifyPublish(obs({ boardStatus: 'none', lease: ABSENT, refetchedBoard: ABSENT, previousStreak: 1 })), { outcome: 'network', streak: 1 });
  // Malformed observations throw instead of guessing.
  assert.throws(() => classifyPublish(obs({ boardStatus: 'odd' as PushRefStatus })), TypeError);
  assert.throws(() => classifyPublish(obs({ refetchedBoard: 'xyz' as OidOrAbsent })), TypeError);
  assert.throws(() => classifyPublish(obs({ lease: '' as OidOrAbsent })), TypeError);
  assert.throws(() => classifyPublish(obs({ ourWriterOnChain: 1 as unknown as boolean })), TypeError);
  assert.throws(() => classifyPublish(obs({ previousStreak: -1 })), RangeError);
  assert.throws(() => classifyPublish(obs({ boardStatus: 'none', previousStreak: 1.5 })), RangeError);
});

test('spreading rejection text onto the observation changes nothing', () => {
  // glossary §25 F9 / F11 host texts; message text never decides (PRO-54, L-CLASSIFY-TEXT).
  const texts = [
    "! [remote rejected] main -> refs/cowork/main/board (cannot lock ref 'refs/cowork/main/board': is at b but expected a)",
    '! [remote rejected] refs/cowork/main/board (failed)',
    'remote: fatal error in commit_refs',
    '! [rejected] refs/cowork/main/board (stale info)',
    'The requested URL returned error: 429',
  ];
  const statuses: PushRefStatus[] = ['ok', 'rejected', 'none'];
  const boards: OidOrAbsent[] = [T, T2, ABSENT];
  for (const boardStatus of statuses) {
    for (const refetchedBoard of boards) {
      for (const lease of [T, ABSENT] as OidOrAbsent[]) {
        for (const ourWriterOnChain of [false, true]) {
          for (const previousStreak of [0, 1, 2]) {
            const plain = obs({ boardStatus, refetchedBoard, lease, ourWriterOnChain, previousStreak });
            const want = classifyPublish(plain);
            for (const text of texts) {
              const noisy = { ...plain, stderr: Buffer.from(text, 'utf8'), stderrText: text, message: text, reason: text };
              assert.deepEqual(classifyPublish(noisy), want, `${JSON.stringify(plain)} + ${text}`);
            }
          }
        }
      }
    }
  }
});
