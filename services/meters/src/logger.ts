import pino from 'pino';

const root = pino({
  level: process.env.LOG_LEVEL ?? 'info',
});

export function createLogger(scope: string, bindings: Record<string, unknown> = {}) {
  return root.child({ scope, ...bindings });
}

export type Logger = ReturnType<typeof createLogger>;
