/** Race async work against a deadline. Resolves `'completed'` when the work
 *  settles (fulfilled OR rejected — shutdown paths must not throw) and
 *  `'timeout'` when the deadline fires first. Never rejects. */
export async function raceWithTimeout(
  work: Promise<unknown>,
  ms: number,
): Promise<'completed' | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  const settled = work.then(
    () => 'completed' as const,
    () => 'completed' as const,
  );
  try {
    return await Promise.race([settled, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
