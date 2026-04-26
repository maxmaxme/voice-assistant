import { definePlugin, onRequest, onResponse, onError } from 'h3';
import type { Logger } from 'pino';

interface Options {
  /** Pino logger to attach to. A child logger with `scope: <whatever>`
   *  works fine — every line will inherit that scope. */
  log: Logger;
}

/** Logs every HTTP request as one record per request:
 *    on request start  → context.startedAt = now
 *    on response       → info  level: method url status duration
 *    on uncaught error → error level: method url message
 *  Pretty output groups the bindings into a chip; JSON output keeps them as
 *  fields for jq/Loki. */
export const loggerPlugin = definePlugin<Options>((h3, { log }) => {
  h3.use(
    onRequest((event) => {
      const ctx = event.context;
      ctx.startedAt = Date.now();
    }),
  );

  h3.use(
    onResponse((response, event) => {
      const ctx = event.context;
      // @ts-expect-error custom property
      const durationMs = ctx.startedAt ? Date.now() - ctx.startedAt : undefined;
      const method = event.req.method;
      const url = event.url.pathname;
      const status = response.status;
      const fields = { method, url, status, durationMs };
      const msg = `${method} ${url} → ${status}${
        durationMs !== undefined ? ` (${durationMs}ms)` : ''
      }`;
      // 5xx is server's fault; 4xx is client's; 2xx/3xx is fine.
      if (status >= 500) {
        log.error(fields, msg);
      } else if (status >= 400) {
        log.warn(fields, msg);
      } else {
        log.info(fields, msg);
      }
    }),
  );

  h3.use(
    onError((error, event) => {
      log.error(
        {
          method: event.req.method,
          url: event.url.pathname,
          err: error,
        },
        `${event.req.method} ${event.url.pathname} threw: ${error.message}`,
      );
    }),
  );
});
