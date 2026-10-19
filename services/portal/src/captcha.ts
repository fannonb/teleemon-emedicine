// Self-hosted proof-of-work challenge for the public booking page (X01): no third-party captcha
// script, so no tracker. The browser finds a nonce whose SHA-256 over "challenge:nonce" starts with
// `difficulty` zero bits (about a second on a phone); the server checks it once. Each challenge is
// HMAC-signed, expires after 10 minutes and can be used only once.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const POW_DIFFICULTY = Number(process.env.TELEEMON_POW_DIFFICULTY ?? 16);
const TTL_MS = 10 * 60000;

export interface Challenge {
  readonly challenge: string;
  readonly difficulty: number;
  readonly expires: number;
  readonly signature: string;
}

export interface Solution extends Challenge {
  readonly nonce: string;
}

export class ProofOfWork {
  private readonly used = new Map<string, number>();
  constructor(private readonly secret: string) {
    if (secret.length < 32) throw new Error('TELEEMON_PORTAL_SECRET must be at least 32 characters. Run `npm run setup -- --portal-only`.');
  }

  issue(now = Date.now()): Challenge {
    const challenge = randomBytes(16).toString('hex');
    const expires = now + TTL_MS;
    return { challenge, difficulty: POW_DIFFICULTY, expires, signature: this.sign(challenge, POW_DIFFICULTY, expires) };
  }

  /** Why the solution is refused, or undefined. A valid solution is consumed. */
  verify(s: Partial<Solution> | undefined, now = Date.now()): string | undefined {
    if (!s?.challenge || !s.signature || typeof s.nonce !== 'string' || typeof s.expires !== 'number' || typeof s.difficulty !== 'number') return 'Please complete the check before booking.';
    const expected = Buffer.from(this.sign(s.challenge, s.difficulty, s.expires), 'hex');
    const given = Buffer.from(s.signature, 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'Please complete the check before booking.';
    if (s.difficulty < POW_DIFFICULTY) return 'Please complete the check before booking.';
    if (s.expires < now) return 'The check expired. Please try again.';
    if (this.used.has(s.challenge)) return 'Please complete the check again.';
    if (s.nonce.length > 32 || !leadingZeroBits(createHash('sha256').update(`${s.challenge}:${s.nonce}`).digest(), s.difficulty)) return 'Please complete the check before booking.';
    this.used.set(s.challenge, s.expires);
    for (const [k, exp] of this.used) if (exp < now) this.used.delete(k);
    return undefined;
  }

  private sign(challenge: string, difficulty: number, expires: number): string {
    return createHmac('sha256', this.secret).update(`pow:${challenge}:${difficulty}:${expires}`).digest('hex');
  }
}

export function leadingZeroBits(hash: Uint8Array, bits: number): boolean {
  for (let i = 0; i < bits; i++) {
    if ((hash[i >> 3] >> (7 - (i & 7))) & 1) return false;
  }
  return true;
}

/** Test helper: solves a challenge the way the browser does. */
export function solve(c: Challenge): Solution {
  for (let n = 0; ; n++) {
    if (leadingZeroBits(createHash('sha256').update(`${c.challenge}:${n}`).digest(), c.difficulty)) return { ...c, nonce: String(n) };
  }
}
