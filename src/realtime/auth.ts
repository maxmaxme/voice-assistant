/** Extract the raw token from an `Authorization: Bearer <token>` header, or null
 *  when the header is absent, not a Bearer scheme, or the token is empty. The
 *  realtime WS authenticates by hash-looking-up this token against the `voice`
 *  identities (see `authorizeSpeaker`), so we never compare against a shared
 *  secret here. */
export function bearerToken(header: string | undefined): string | null {
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  return token || null;
}
