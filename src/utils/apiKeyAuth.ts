import { timingSafeEqual } from 'node:crypto';

/** Constant-time string equality. Returns false for length mismatch but still
 *  performs a compare to keep timing closer to the equal-length path. */
export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Validate an `Authorization: Bearer <token>` header against an allow-list.
 *  Iterates without short-circuiting so the matched index doesn't leak via
 *  timing. Returns false on missing / malformed header. */
export function verifyBearerToken(
  authHeader: string | null | undefined,
  allowedKeys: readonly string[],
): boolean {
  const header = authHeader ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!token || allowedKeys.length === 0) {
    return false;
  }
  let matched = false;
  for (const k of allowedKeys) {
    if (constantTimeEquals(token, k)) {
      matched = true;
    }
  }
  return matched;
}
