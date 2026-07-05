import { describe, it, expect } from 'vitest';
import { H3 } from 'h3';
import { loggerPlugin } from '../../src/utils/h3LoggerPlugin.ts';
import { createLogger } from '../../src/utils/logger.ts';
import { captureLogs } from '../helpers/captureLogs.ts';

function buildApp(): H3 {
  const app = new H3().register(loggerPlugin({ log: createLogger('http-test') }));
  app.get('/ok', () => ({ status: 'ok' }));
  app.get('/boom', () => {
    throw new Error('kaboom');
  });
  return app;
}

describe('h3 logger plugin', () => {
  it('emits one access-log record per response with method/url/status', async () => {
    const app = buildApp();
    const capture = captureLogs();
    try {
      const res = await app.fetch(new Request('http://localhost/ok'));
      expect(res.status).toBe(200);

      const records = capture
        .text()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const access = records.filter((r) => r.method === 'GET' && r.url === '/ok');
      expect(access).toHaveLength(1);
      expect(access[0]).toMatchObject({ method: 'GET', url: '/ok', status: 200 });
      expect(access[0]!.msg).toContain('GET /ok → 200');
    } finally {
      capture.restore();
    }
  });

  it('logs 404s at warn and handler throws at error level', async () => {
    const app = buildApp();
    const capture = captureLogs();
    try {
      const missing = await app.fetch(new Request('http://localhost/nope'));
      expect(missing.status).toBe(404);
      const boom = await app.fetch(new Request('http://localhost/boom'));
      expect(boom.status).toBe(500);

      const records = capture
        .text()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      // The root logger formats levels as labels, not pino's numeric codes.
      const notFound = records.find((r) => r.url === '/nope' && r.status === 404);
      expect(notFound?.level).toBe('warn');
      // An uncaught handler throw goes through the onError hook (no
      // onResponse record), so the access log for it has no `status` field.
      const failed = records.find((r) => r.url === '/boom' && r.level === 'error');
      expect(failed?.msg).toContain('GET /boom threw: kaboom');
    } finally {
      capture.restore();
    }
  });
});
