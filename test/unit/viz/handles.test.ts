// Plan 8a Task 9: display ids and handles (R-V22; 12 §3.10.6, §3.6; VIZ-18): a peer's first 6 hex, a seat's first 6
// characters of base32c(sha256(seat key)), a hold or claim id's first 8 characters; ids of one world that share a prefix
// extend to the shortest unique length, and the first such extension is reported once (the api then publishes reset).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { base32c } from '../../../src/board/ids.js';
import { createHandleTable } from '../../../src/viz/server/project.js';
import { peerOf, seatOf } from '../../helpers/vizModels.js';

const seatHash = (s: string): string => base32c(createHash('sha256').update(s, 'utf8').digest());

test('handles: the first 6 hex of a peer, base32c(sha256(seat key))[0:6] for a seat, the first 8 characters of a hold or claim id; colliding prefixes extend to the shortest unique length and report a collision', () => {
  const h = createHandleTable();
  const a = peerOf('3f2a1b'), b = peerOf('9c8d7e');
  assert.equal(h.peer(a), '3f2a1b');
  assert.equal(h.peer(b), '9c8d7e');
  assert.equal(h.peer(a), '3f2a1b', 'stable on a second lookup');
  const s = seatOf(a, 1);
  assert.equal(h.seat(s), seatHash(s).slice(0, 6));
  assert.match(h.seat(s), /^[0-9A-HJKMNP-TV-Z]{6}$/);
  const hold = '01HQ7ZK3M5N8P2R4T6V8W0X1Y2';
  assert.equal(h.shortId(hold), '01HQ7ZK3');
  assert.equal(h.takeCollision(), false, 'no collision yet');

  // A later id that shares an earlier handle extends both and reports the collision exactly once.
  {
    const h = createHandleTable();
    const a = '3f2a1b' + '0'.repeat(26);
    const b = '3f2a1b' + '9' + '0'.repeat(25);
    assert.equal(h.peer(a), '3f2a1b');
    assert.equal(h.takeCollision(), false);
    assert.equal(h.peer(b), '3f2a1b9', 'the newcomer gets its shortest unique prefix');
    assert.equal(h.peer(a), '3f2a1b0', 'the earlier id extends too');
    assert.equal(h.takeCollision(), true, 'reported');
    assert.equal(h.takeCollision(), false, 'once');

    // Determinism: the handles depend on the set of ids, not on the order they were seen.
    const g = createHandleTable();
    assert.equal(g.peer(b), '3f2a1b');
    assert.equal(g.peer(a), '3f2a1b0');
    assert.equal(g.peer(b), '3f2a1b9');
    assert.equal(g.takeCollision(), true);

    // Hold/claim ids: ULIDs created within ~1 s share their first 8 characters (R-V22).
    const s = createHandleTable();
    const u1 = '01HQ7ZK3AAAAAAAAAAAAAAAAAA', u2 = '01HQ7ZK3ABBBBBBBBBBBBBBBBB', u3 = '01HQ7ZK3ACCCCCCCCCCCCCCCCC';
    assert.equal(s.shortId(u1), '01HQ7ZK3');
    assert.equal(s.shortId(u2), '01HQ7ZK3AB');
    assert.equal(s.shortId(u1), '01HQ7ZK3AA');
    assert.equal(s.shortId(u3), '01HQ7ZK3AC');
    assert.equal(s.takeCollision(), true);
    assert.equal(s.shortId(u2), '01HQ7ZK3AB');
    assert.equal(s.takeCollision(), false, 'u3 extended nobody further');

    // Seats: distinct seat keys of one owner get distinct 6-character handles of their own hashes.
    const t = createHandleTable();
    const k1 = seatOf(peerOf('a1b2c3'), 1), k2 = seatOf(peerOf('a1b2c3'), 2);
    assert.equal(t.seat(k1), seatHash(k1).slice(0, 6));
    assert.equal(t.seat(k2), seatHash(k2).slice(0, 6));
    assert.notEqual(t.seat(k1), t.seat(k2));
    assert.equal(t.takeCollision(), false);

    // Peers, seats and short ids are separate namespaces: a short id equal to a peer prefix does not collide with it.
    const u = createHandleTable();
    u.peer('0123456789abcdef0123456789abcdef');
    u.shortId('0123456789abcdef');
    assert.equal(u.takeCollision(), false);
  }
});
