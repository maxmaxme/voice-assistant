import { vi, type MockInstance } from 'vitest';
import { rootLogger } from '../../src/utils/logger.ts';

export interface LogCapture {
  /** Spy on process.stderr.write — every line pino emits ends up here. */
  spy: MockInstance<typeof process.stderr.write>;
  /** Concatenation of all writes as a single string. Convenient for
   *  `expect(text).toMatch(/foo/)` style assertions. */
  text(): string;
  /** Restore stubs and root level. Always call this in a `finally`. */
  restore(): void;
}

/** Capture pino output for a test. Bumps `rootLogger.level` to `'trace'` so
 *  every record passes the floor (the global vitest setup pins it to
 *  `'silent'` for cleanliness), spies on `process.stderr.write` (where pino
 *  is wired to write, see `src/utils/logger.ts`), and returns a teardown.
 *
 *  Tests opting into log inspection must call `restore()` afterwards. */
export function captureLogs(): LogCapture {
  const previousLevel = rootLogger.level;
  rootLogger.level = 'trace';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  return {
    spy,
    text(): string {
      return spy.mock.calls.map((c) => String(c[0])).join('');
    },
    restore(): void {
      spy.mockRestore();
      rootLogger.level = previousLevel;
    },
  };
}
