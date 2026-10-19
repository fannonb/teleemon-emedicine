// Solves the booking page's proof-of-work check in the browser (services/portal/src/captcha.ts).
// No third-party captcha script, so nothing tracks the visitor.

export interface Challenge {
  readonly challenge: string;
  readonly difficulty: number;
  readonly expires: number;
  readonly signature: string;
}

function leadingZeroBits(hash: Uint8Array, bits: number): boolean {
  for (let i = 0; i < bits; i++) if ((hash[i >> 3] >> (7 - (i & 7))) & 1) return false;
  return true;
}

export async function solveChallenge(c: Challenge, signal?: AbortSignal): Promise<Challenge & { nonce: string }> {
  const encoder = new TextEncoder();
  for (let n = 0; n < 50_000_000; n++) {
    if (signal?.aborted) throw new Error('cancelled');
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`${c.challenge}:${n}`)));
    if (leadingZeroBits(hash, c.difficulty)) return { ...c, nonce: String(n) };
  }
  throw new Error('The check could not be completed. Please reload the page.');
}
