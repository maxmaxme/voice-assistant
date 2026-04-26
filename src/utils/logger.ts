import pino, { type Logger, type DestinationStream } from 'pino';

/** Where pino writes. Routed through `process.stderr.write` so:
 *   1) the codebase keeps its "diagnostic logs to stderr" convention,
 *   2) tests that spy on `process.stderr.write` continue to work after the
 *      pino migration without needing a custom test transport.
 *  Sync, no sonic-boom — performance is irrelevant at our scale. */
const stderrStream: DestinationStream = {
  write(line: string): void {
    process.stderr.write(line);
  },
};

const level = process.env.LOG_LEVEL ?? 'info';

export const rootLogger: Logger = pino(
  {
    level,
    // Drop `pid` and `hostname` from every line — noise on a single-process
    // home daemon. Keep `time`.
    base: undefined,
  },
  stderrStream,
);

/** Build a child logger tagged with a scope. The scope appears as a `scope`
 *  field in JSON output. Use one per module (e.g. `'http'`, `'scheduler'`).
 *
 *  Extra `bindings` are attached to every log line emitted by the child —
 *  use this for per-request context (e.g. `{ chatId, updateId }`). */
export function createLogger(scope: string, bindings?: Record<string, unknown>): Logger {
  return rootLogger.child({ scope, ...bindings });
}
