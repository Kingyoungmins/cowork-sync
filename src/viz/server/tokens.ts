// Launch and session tokens of the viewer (12-visualizer §3.10.2; VIZ-31). Tokens come from the Random port and live only in
// memory; the launch token is single use within LAUNCH_TTL_MS of own staleness (INV-CLOCK: max(Δwall, Δmono), so time asleep
// counts); a second presentation of a redeemed launch token revokes the session minted from it.
// The default crypto import is deliberate: tests observe crypto.timingSafeEqual on the module object.
import crypto from 'node:crypto';
import { base32c } from '../../board/ids.js';
import { anchorNow, ownStaleness, type Anchor, type Clock } from '../../ports/clock.js';
import { randomHex, type Random } from '../../ports/random.js';

export const LAUNCH_TTL_MS = 120_000;

export type RedeemResult = { ok: true; session: string; instance: string } | { ok: false; why: 'shape' | 'mismatch' | 'expired' | 'reused' };

const TOKEN_RE = /^[0-9a-f]{64}$/;
const TOKEN_BYTES = 32;
/** 5 bytes: glossary §3 `base32c` gives exactly 8 characters (Plan 2's encoder, src/board/ids.ts; ledger carry to Task 15). */
const INSTANCE_BYTES = 5;

function sha256(s: string): Buffer {
  return crypto.createHash('sha256').update(s, 'utf8').digest();
}

/** `^[0-9a-f]{64}$` else false (never throws); then crypto.timingSafeEqual(sha256(presented), sha256(expected)) — always two
 *  32-byte digests, so the comparison time depends on neither token's content nor length. */
export function tokenEquals(presented: string, expected: string): boolean {
  if (typeof presented !== 'string' || !TOKEN_RE.test(presented)) return false;
  return crypto.timingSafeEqual(sha256(presented), sha256(expected));
}

export class TokenAuthority {
  readonly launch: string;
  readonly instance: string;
  private readonly clock: Clock;
  private readonly anchor: Anchor;
  /** Minted at construction, handed out by the one successful redemption. */
  private readonly session: string;
  private redeemedOnce = false;
  private revoked = false;

  /** launch and session: 32 bytes each from random; instance: 8 base32c characters. The TTL anchor is taken here. */
  constructor(random: Random, clock: Clock) {
    this.launch = randomHex(random, TOKEN_BYTES);
    this.session = randomHex(random, TOKEN_BYTES);
    this.instance = base32c(random.bytes(INSTANCE_BYTES));
    this.clock = clock;
    this.anchor = anchorNow(clock);
  }

  /** Single use within 120 s own staleness; a second presentation → 'reused' and the session is revoked. Order: shape, mismatch,
   *  reused (a redeemed token has no TTL left to judge), expired. */
  redeem(presented: string | undefined): RedeemResult {
    if (presented === undefined || !TOKEN_RE.test(presented)) return { ok: false, why: 'shape' };
    if (!tokenEquals(presented, this.launch)) return { ok: false, why: 'mismatch' };
    if (this.redeemedOnce) {
      this.revoked = true;
      return { ok: false, why: 'reused' };
    }
    if (this.launchExpired()) return { ok: false, why: 'expired' };
    this.redeemedOnce = true;
    return { ok: true, session: this.session, instance: this.instance };
  }

  /** True only for the session minted by the one redemption, until a reuse revokes it. */
  checkSession(presented: string | undefined): boolean {
    if (!this.redeemedOnce || this.revoked || presented === undefined) return false;
    return tokenEquals(presented, this.session);
  }

  /** The launch token's 120 s are over (own staleness from construction). */
  launchExpired(): boolean {
    return ownStaleness(this.clock, this.anchor) > LAUNCH_TTL_MS;
  }

  redeemed(): boolean {
    return this.redeemedOnce;
  }
}
