import pino, { type Logger, type DestinationStream } from 'pino';
import pinoPretty from 'pino-pretty';

/** Where pino writes — `process.stderr.write` proxy. Two reasons:
 *   1) keeps the codebase's "diagnostic logs to stderr" convention,
 *   2) tests that spy on `process.stderr.write` continue to work after the
 *      pino migration without needing a custom test transport.
 *  Sync, no sonic-boom — performance is irrelevant at our scale. */
const stderrStream: DestinationStream = {
  write(line: string): void {
    process.stderr.write(line);
  },
};

const level = process.env.LOG_LEVEL ?? 'info';

// Pretty-print only when stderr is a TTY *and* we're not running under
// vitest. The test runner relies on raw JSON lines reaching
// `process.stderr.write` (see tests/helpers/captureLogs.ts); pretty output
// would re-format and break substring assertions.
const usePretty = process.stderr.isTTY === true && !process.env.VITEST;

// pino-pretty itself accepts a stream-like destination, so colored
// output still flows through `stderrStream` and out via process.stderr.
const sink: DestinationStream = usePretty
  ? pinoPretty({
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname',
      destination: stderrStream,
    })
  : stderrStream;

export const rootLogger: Logger = pino(
  {
    level,
    // Drop `pid` and `hostname` from every line — noise on a single-process
    // home daemon. Keep `time`.
    base: undefined,
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
