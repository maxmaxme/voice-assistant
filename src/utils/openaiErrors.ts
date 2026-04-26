/** True when OpenAI returned 404 because `previous_response_id` no longer
 *  exists (typically: chain older than the 30-day Responses retention
 *  window, or the response was explicitly deleted). The error surfaces
 *  either as an APIError with status 404 + "Previous response with id …
 *  not found", or as a generic Error whose message contains the same. */
export function isPreviousResponseGoneError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') {
    return false;
  }
  const message = 'message' in err ? err.message : undefined;
  if (typeof message !== 'string') {
    return false;
  }
  const looksLikeIt = /previous response/i.test(message) && /not found/i.test(message);
  const status = 'status' in err ? err.status : undefined;
  return looksLikeIt && (status === undefined || status === 404);
}
