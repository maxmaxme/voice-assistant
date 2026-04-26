// Vitest setup: silence pino by default during test runs. Tests that need to
// inspect log output (typically via a `process.stderr.write` spy) bump the
// level temporarily — see `tests/helpers/captureLogs.ts`.
import { rootLogger } from '../src/utils/logger.ts';

rootLogger.level = 'silent';
