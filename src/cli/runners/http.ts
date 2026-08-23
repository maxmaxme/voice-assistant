import { createHash } from 'node:crypto';
import { H3, serve, assertBodySize, getRequestIP } from 'h3';
import type { H3Event } from 'h3';
import { z } from 'zod';
import type { OpenAiAgent } from '../../agent/openaiAgent.ts';
import { Session } from '../../agent/session.ts';
import type { AudioFileStt } from '../../audio/types.ts';
import { normalizeAudioFile, parseContentType } from '../../audio/audioFile.ts';
import { hashToken } from '../../memory/identities.ts';
import { makeScopedProfile, type Scope } from '../../memory/scope.ts';
import type { IdentitiesAdapter } from '../../memory/types.ts';
import type { SqliteProfileMemory } from '../../memory/sqliteProfileMemory.ts';
import type { HttpConfig } from '../../settings/httpConfig.ts';
import { createLogger } from '../../utils/logger.ts';
import { loggerPlugin } from '../../utils/h3LoggerPlugin.ts';
import { createRateLimiter, createSemaphore } from '../../utils/rateLimiter.ts';

const log = createLogger('http');

export interface HttpRunnerDeps {
  /** Agent for `/text` (Apple Shortcut etc.) and `/audio`. No `ask` tool and
   *  no `continue_conversation` in the response — a client that wants a
   *  follow-up just sends the next `/text` with the same `conversation_id`. */
  agent: OpenAiAgent;
  /** Agent for `/assist` — used by the HA bridge driving Voice PE. Has the
   *  `ask` tool and the voice-addendum prompt; response includes
   *  `continue_conversation` so HA can reopen the mic. */
  assistAgent: OpenAiAgent;
  /** Per-conversation Session lookup, shared by `/assist` and `/text`. The
   *  caller owns the key (endpoint-prefixed, and token-scoped on `/text`) and
   *  the idle window after which the chain is dropped. */
  sessionFor: (key: string, idleMs: number) => Session;
  stt: AudioFileStt;
  port: number;
  /** Which endpoints to mount. `/health` is always mounted regardless. A
   *  disabled endpoint is simply not registered → 404. */
  endpoints: HttpConfig;
  identities: IdentitiesAdapter;
  profileStore: SqliteProfileMemory;
  /** Receives a closer for the listener once it's up. The runner promise never
   *  resolves by design, so this seam is the only way shutdown (unified.ts) can
   *  stop accepting connections before the process exits. */
  onListen?: (close: () => Promise<void>) => void;
}

/** Resolve the Bearer token to a memory scope. HTTP auth is DB-gated
 *  (`httpTokenAllowed` rejects unmapped tokens before this is reached), so the
 *  fallback is effectively unreachable; we keep a defensive `{ userId: 0 }`
 *  (personalOwner(0)='user:0' is empty → behaves as household). */
export function resolveHttpScope(
  identities: IdentitiesAdapter,
  authHeader: string | null | undefined,
): Scope {
  const header = authHeader ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const res = token ? identities.resolve('http', hashToken(token)) : null;
  return res ? { userId: res.userId } : { userId: 0 };
}

/** DB-backed HTTP auth: the Bearer token is allowed iff its hash has an
 *  `http` identity. */
export function httpTokenAllowed(
  identities: IdentitiesAdapter,
  authHeader: string | null | undefined,
): boolean {
  const header = authHeader ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  return token ? identities.resolve('http', hashToken(token)) !== null : false;
}

/** OpenAI Whisper / gpt-4o-transcribe rejects files larger than 25 MB. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

/** Per-IP cap on failed Bearer auths. Slows brute-force without locking out
 *  legit users behind NAT. */
const AUTH_FAIL_WINDOW_MS = 5 * 60 * 1000;
const AUTH_FAIL_MAX = 10;

/** Per-token request cap. Bounds OpenAI spend if a key leaks. */
const TOKEN_RATE_WINDOW_MS = 60 * 1000;
const TOKEN_RATE_MAX = 30;

/** Whisper + LLM round-trips are heavy on a Pi; cap concurrent /audio work. */
const AUDIO_CONCURRENCY = 2;

const TextBodySchema = z.object({
  text: z.string(),
  conversation_id: z.string().optional(),
});

const AssistBodySchema = TextBodySchema;

/** `/assist`: short window. An unrelated utterance after a pause starts a
 *  fresh chain (no "still thinks we're talking about X" leak), while natural
 *  follow-ups inside one spoken dialog still chain. */
const ASSIST_SESSION_IDLE_MS = 60 * 1000;

/** `/text`: longer window. Typing on a watch, reading the reply and dictating
 *  again takes far more than a minute, and there is no wake-word cost to a
 *  chain that outlives the topic — the client can always mint a new
 *  `conversation_id`. */
const TEXT_SESSION_IDLE_MS = 10 * 60 * 1000;

/** SSE variant of a text reply (`?stream=1`). Frames are one JSON object per
 *  `data:` line: `{delta}` while the model types, then exactly one terminal
 *  `{response}` or `{error}`.
 *
 *  Deltas are **preview text, not a prefix of the answer** — the agent's
 *  tool loop re-streams from scratch on every iteration, so a turn that calls
 *  a tool mid-way emits deltas that get superseded. Clients must render them
 *  as a draft and replace the whole thing with `response`, exactly like the
 *  Telegram draft streamer does. */
function streamTextReply(
  event: H3Event,
  run: (onTextDelta: (delta: string) => void) => Promise<{ text: string }>,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // A client that hangs up mid-turn (Shortcut cancelled, curl ^C) leaves
      // the controller closed while the agent keeps streaming deltas — an
      // enqueue then throws, and unguarded that throw travels back through the
      // OpenAI stream and surfaces as a bogus "handling failed" error.
      let gone = false;
      const send = (frame: unknown): void => {
        if (gone) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        } catch {
          gone = true;
        }
      };
      try {
        const reply = await run((delta) => send({ delta }));
        send({ response: reply.text });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err }, `streaming text handling failed: ${message}`);
        send({ error: 'Internal error' });
      }
      if (!gone) {
        controller.close();
      }
    },
  });
  const headers = new Headers(event.res.headers);
  headers.set('content-type', 'text/event-stream');
  headers.set('cache-control', 'no-cache');
  // Caddy/nginx in front of this would otherwise hold the whole stream.
  headers.set('x-accel-buffering', 'no');
  return new Response(body, { headers });
}

function clientIp(event: H3Event): string {
  return getRequestIP(event, { xForwardedFor: true }) ?? 'unknown';
}

function tokenKey(authHeader: string | null | undefined): string {
  const header = authHeader ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  // Hash so the raw token never lands in logs / memory keys.
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** Everything the h3 app needs — `runHttpMode` adds the listener on top.
 *  Split out so tests can drive the endpoints in-process via `app.fetch`. */
export type HttpAppDeps = Omit<HttpRunnerDeps, 'port'>;

export function buildHttpApp(deps: HttpAppDeps): H3 {
  const { agent, assistAgent, sessionFor, stt, endpoints, identities, profileStore } = deps;

  const authFailLimiter = createRateLimiter({
    windowMs: AUTH_FAIL_WINDOW_MS,
    max: AUTH_FAIL_MAX,
  });
  const tokenLimiter = createRateLimiter({
    windowMs: TOKEN_RATE_WINDOW_MS,
    max: TOKEN_RATE_MAX,
  });
  const audioGate = createSemaphore(AUDIO_CONCURRENCY);

  /** Returns null when the request may proceed; otherwise sets the response
   *  status/headers and returns the body to send back. */
  const checkAuthAndRate = (event: H3Event): { error: string } | null => {
    const ip = clientIp(event);
    const authHeader = event.req.headers.get('authorization');

    if (!httpTokenAllowed(identities, authHeader)) {
      // Only failed auths count against the per-IP budget, and only failing
      // requests are throttled by it — a valid token always passes, so a
      // brute-forcing neighbour behind the same NAT can't lock out the
      // legit user.
      const failState = authFailLimiter.check(`fail:${ip}`);
      if (!failState.allowed) {
        event.res.status = 429;
        event.res.headers.set('retry-after', String(failState.retryAfterSec));
        log.warn({ ip }, `auth-fail rate limit hit for ${ip}`);
        return { error: 'Too many authentication failures' };
      }
      // The request log records url/status but not the caller, and a slow
      // prober stays under the rate-limit threshold that does log one — so
      // without this line single 401s are unattributable.
      log.warn({ ip }, `unauthorized request from ${ip}`);
      event.res.status = 401;
      return { error: 'Unauthorized' };
    }

    // Valid token → stamp last-used on its identity. The token is present and
    // mapped (httpTokenAllowed just confirmed it), so the hash always matches a
    // row; touch is a no-op otherwise.
    const header = authHeader ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (bearer) {
      identities.touch('http', hashToken(bearer));
    }

    const tokenState = tokenLimiter.check(`tok:${tokenKey(authHeader)}`);
    if (!tokenState.allowed) {
      event.res.status = 429;
      event.res.headers.set('retry-after', String(tokenState.retryAfterSec));
      log.warn({ ip }, `token rate limit hit (retry in ${tokenState.retryAfterSec}s)`);
      return { error: 'Rate limit exceeded' };
    }
    return null;
  };

  const app = new H3().register(loggerPlugin({ log }));

  // Wildcard origin is safe here: auth is a Bearer token, never a cookie, so
  // there is no ambient credential a hostile page could ride on. Clients with
  // no origin at all (a Pebble PKJS relay page) need `*` — a reflected origin
  // would be `null` for them.
  app.use((event: H3Event) => {
    event.res.headers.set('access-control-allow-origin', '*');
    if (event.req.method !== 'OPTIONS') {
      return;
    }
    event.res.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
    event.res.headers.set('access-control-allow-headers', 'authorization, content-type');
    event.res.headers.set('access-control-max-age', '86400');
    return new Response(null, { status: 204, headers: event.res.headers });
  });

  if (endpoints.audio) {
    app.post('/audio', async (event: H3Event) => {
      const denied = checkAuthAndRate(event);
      if (denied) {
        return denied;
      }

      const release = audioGate.tryAcquire();
      if (!release) {
        event.res.status = 429;
        event.res.headers.set('retry-after', '5');
        log.warn(`audio concurrency limit (${AUDIO_CONCURRENCY}) reached`);
        return { error: 'Server busy, retry shortly' };
      }

      try {
        try {
          await assertBodySize(event, MAX_BODY_BYTES);
        } catch {
          event.res.status = 413;
          return { error: `Audio exceeds ${MAX_BODY_BYTES} bytes` };
        }
        const raw = await event.req.arrayBuffer();
        if (!raw || raw.byteLength === 0) {
          event.res.status = 400;
          return { error: 'No audio data' };
        }
        const body = Buffer.from(raw);
        const receivedContentType = parseContentType(event.req.headers.get('content-type'));
        const audioFile = normalizeAudioFile(receivedContentType);

        // Per-request access log (method/url/status/duration) is emitted by the
        // h3 logger plugin onResponse hook. This debug line just adds payload
        // metadata when chasing down a specific request.
        log.debug(
          { contentType: receivedContentType, bytes: body.length },
          `audio payload ${receivedContentType} ${body.length} bytes`,
        );

        try {
          const transcript = (
            await stt.transcribeFile(body, {
              filename: `audio.${audioFile.extension}`,
              contentType: audioFile.contentType,
            })
          ).trim();
          if (!transcript) {
            event.res.status = 400;
            return { error: 'No speech detected' };
          }

          const scope = resolveHttpScope(identities, event.req.headers.get('authorization'));
          const reply = await agent.respond(transcript, {
            // One-shot endpoint: a fresh session per request. Falling back to
            // the agent's own Session would chain unrelated callers' turns
            // (and their memory-profile instructions) into one conversation.
            session: new Session(),
            profile: makeScopedProfile(profileStore, scope),
            scope,
          });

          return {
            response: reply.text,
            transcript,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err }, `audio handling failed: ${message}`);
          event.res.status = 500;
          // Upstream error text carries internals (provider URLs, request ids,
          // model names) — log it, never echo it to the caller.
          return { error: 'Internal error' };
        }
      } finally {
        release();
      }
    });
  }

  if (endpoints.text) {
    app.post('/text', async (event: H3Event) => {
      // Apple Shortcut "Get contents of URL" with Request Body=Form sends
      // application/x-www-form-urlencoded with the keys as fields; other
      // clients (Pebble relay etc.) find JSON easier. Both carry a `text`
      // field and nothing else is accepted — misconfigured clients get a
      // clear 400 instead of silently injecting `text=...` into the agent.
      const denied = checkAuthAndRate(event);
      if (denied) {
        return denied;
      }
      try {
        await assertBodySize(event, MAX_BODY_BYTES);
      } catch {
        event.res.status = 413;
        return { error: `Text exceeds ${MAX_BODY_BYTES} bytes` };
      }

      const contentType = parseContentType(event.req.headers.get('content-type'));
      const isJson = contentType.startsWith('application/json');
      if (!isJson && !contentType.startsWith('application/x-www-form-urlencoded')) {
        event.res.status = 415;
        return {
          error:
            'Expected Content-Type: application/x-www-form-urlencoded or application/json with a "text" field',
        };
      }
      let text: string;
      let conversationId: string | undefined;
      if (isJson) {
        const raw: unknown = await event.req.json().catch(() => null);
        const parsed = TextBodySchema.safeParse(raw);
        if (!parsed.success) {
          event.res.status = 400;
          return { error: 'Expected JSON body with string "text" field' };
        }
        text = parsed.data.text.trim();
        conversationId = parsed.data.conversation_id;
      } else {
        const form = new URLSearchParams(await event.req.text());
        text = form.get('text')?.trim() ?? '';
        conversationId = form.get('conversation_id') ?? undefined;
      }
      if (!text) {
        event.res.status = 400;
        return { error: 'Missing or empty "text" field' };
      }

      log.debug(
        { contentType, bytes: text.length, conversationId },
        `text payload ${text.length} chars`,
      );

      const authHeader = event.req.headers.get('authorization');
      const scope = resolveHttpScope(identities, authHeader);
      const respondOptions = {
        // Chains follow-ups, so "send X to Y?" / "yes" actually works. The key
        // is token-scoped: two clients that both omit `conversation_id` (or
        // pick the same one) still get separate chains, and one caller can
        // never read another principal's conversation.
        session: sessionFor(
          `text:${tokenKey(authHeader)}:${conversationId ?? 'default'}`,
          TEXT_SESSION_IDLE_MS,
        ),
        profile: makeScopedProfile(profileStore, scope),
        scope,
      };

      if (event.url.searchParams.get('stream') === '1') {
        return streamTextReply(event, (onTextDelta) =>
          agent.respond(text, { ...respondOptions, onTextDelta }),
        );
      }

      try {
        const reply = await agent.respond(text, respondOptions);
        return { response: reply.text };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err }, `text handling failed: ${message}`);
        event.res.status = 500;
        return { error: 'Internal error' };
      }
    });
  }

  if (endpoints.assist) {
    app.post('/assist', async (event: H3Event) => {
      // HA-style contract. Used by the http_conversation_agent HA
      // integration (sibling ha-http-conversation-agent repo) → Voice PE,
      // and available to any other client that wants per-conversation
      // server-side sessions. Always JSON {text: "...",
      // conversation_id?: "..."} — no other shape is accepted. The
      // reply gets spoken aloud (under voice-addendum prompt rules) and
      // `expectsFollowUp` is forwarded as `continue_conversation` so
      // HA's Assist pipeline reopens the mic without a fresh wake-word.
      const denied = checkAuthAndRate(event);
      if (denied) {
        return denied;
      }
      try {
        await assertBodySize(event, MAX_BODY_BYTES);
      } catch {
        event.res.status = 413;
        return { error: `Text exceeds ${MAX_BODY_BYTES} bytes` };
      }

      const contentType = parseContentType(event.req.headers.get('content-type'));
      if (!contentType.startsWith('application/json')) {
        event.res.status = 415;
        return { error: 'Expected Content-Type: application/json with a "text" field' };
      }
      const raw: unknown = await event.req.json().catch(() => null);
      const parsed = AssistBodySchema.safeParse(raw);
      if (!parsed.success) {
        event.res.status = 400;
        return { error: 'Expected JSON body with string "text" field' };
      }
      const text = parsed.data.text.trim();
      if (!text) {
        event.res.status = 400;
        return { error: 'Empty "text" field' };
      }
      // HA's Assist pipeline mints a `conversation_id` per dialog and reuses
      // it across follow-up turns (continue_conversation). When the bridge
      // forwards it we get proper per-dialog isolation; legacy bridges that
      // don't send it collapse to a single shared chain — better than no
      // chain at all for follow-ups, and still bounded by the 60s idle
      // timeout on the session itself.
      const conversationId = parsed.data.conversation_id ?? 'default';
      const session = sessionFor(`assist:${conversationId}`, ASSIST_SESSION_IDLE_MS);

      log.debug(
        { contentType, bytes: text.length, conversationId },
        `assist payload ${text.length} chars`,
      );

      try {
        const scope = resolveHttpScope(identities, event.req.headers.get('authorization'));
        const reply = await assistAgent.respond(text, {
          session,
          profile: makeScopedProfile(profileStore, scope),
          scope,
        });
        return {
          response: reply.text,
          continue_conversation: reply.expectsFollowUp ?? false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err }, `assist handling failed: ${message}`);
        event.res.status = 500;
        return { error: 'Internal error' };
      }
    });
  }

  app.get('/health', () => {
    return { status: 'ok' };
  });

  return app;
}

export async function runHttpMode(deps: HttpRunnerDeps): Promise<void> {
  const { port, endpoints } = deps;
  const app = buildHttpApp(deps);

  const mounted = [
    endpoints.text && 'POST /text',
    endpoints.audio && 'POST /audio',
    endpoints.assist && 'POST /assist',
    'GET /health',
  ].filter(Boolean);
  log.info({ port, endpoints }, `listening on http://localhost:${port}`);
  log.info(`mounted: ${mounted.join(', ')}`);

  // silent: skip srvx's "➜ Listening on …" / "Server closed successfully."
  // chatter; we already log startup ourselves.
  // gracefulShutdown: false so srvx doesn't install its own SIGINT/SIGTERM
  // handler — unified.ts owns shutdown via deps.dispose().
  const server = serve(app, { port, silent: true, gracefulShutdown: false });
  deps.onListen?.(() => server.close());

  // The listener runs until the process exits. Shutdown is driven by
  // unified.ts via SIGINT/SIGTERM → dispose() → process.exit(0); we don't
  // install a competing signal handler here.
  return new Promise<void>(() => {});
}
