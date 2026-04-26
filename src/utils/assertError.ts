/** Narrow `unknown` from a `catch` clause to `Error`. We treat every thrown
 *  value as an Error — anything else is a programmer mistake and we re-throw
 *  to surface it loudly instead of silently coercing. */
export function assertError(err: unknown): asserts err is Error {
  if (!(err instanceof Error)) {
    throw new Error(`Expected thrown value to be Error, got: ${String(err)}`);
  }
}
