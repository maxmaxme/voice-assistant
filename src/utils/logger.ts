import pino, { type Logger } from 'pino';
import pinoPretty from 'pino-pretty';

const level = process.env.LOG_LEVEL ?? 'info';

// Pretty-print only when stderr is a TTY *and* we're not running under
// vitest. The test runner relies on JSON lines reaching `process.stderr`
// (see tests/helpers/captureLogs.ts); pretty output would re-format and
// break substring assertions.
const usePretty = process.stderr.isTTY === true && !process.env.VITEST;

// Writing into `process.stderr` directly:
//   - keeps the codebase's "diagnostic logs to stderr" convention,
//   - works with `vi.spyOn(process.stderr, 'write')` (sonic-boom would
//     bypass spies because it goes straight to fd 2),
//   - sync — fine at our log volume.
const sink = usePretty
  ? pinoPretty({
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname',
      destination: process.stderr,
    })
  : process.stderr;

export const rootLogger: Logger = pino(
  {
    level,
    // Drop `pid` and `hostname` from every line — noise on a single-process
    // home daemon. Keep `time`.
    base: undefined,
    // Emit `"level":"info"` (string) instead of pino's default integer 30.
    // Dozzle's level_guesser checks the JSON `level` field but type-asserts
    // it to string — integer levels fall through and the severity dots
    // never light up. String labels unlock colouring in Dozzle and stay
    // readable in any other JSON-aware viewer.
    formatters: {
      level: (label) => ({ level: label }),
    },
  },
  sink,
);

/** Build a child logger tagged with a scope. The scope appears as a `scope`
 *  field in JSON output (and as a `[scope]` chip in pretty output). Use one
 *  per module (e.g. `'http'`, `'scheduler'`).
 *
 *  Extra `bindings` are attached to every log line emitted by the child —
 *  use this for per-request context (e.g. `{ chatId, updateId }`). */
export function createLogger(scope: string, bindings?: Record<string, unknown>): Logger {
  return rootLogger.child({ scope, ...bindings });
}
