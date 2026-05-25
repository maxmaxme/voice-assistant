import { timingSafeEqual } from 'node:crypto';

export function verifyBearer(header: string | undefined, expected: string): boolean {
  if (!expected || !header) {
    return false;
  }
  if (!header.startsWith('Bearer ')) {
    return false;
  }
  const provided = header.slice('Bearer '.length);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
