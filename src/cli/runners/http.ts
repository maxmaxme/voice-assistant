import { createHash } from 'node:crypto';
import { H3, serve, assertBodySize, getRequestIP } from 'h3';
import type { H3Event } from 'h3';
import { z } from 'zod';
import type { OpenAiAgent } from '../../agent/openaiAgent.ts';
import type { AudioFileStt } from '../../audio/types.ts';
import { normalizeAudioFile, parseContentType } from '../../audio/audioFile.ts';
import { verifyBearerToken } from '../../utils/apiKeyAuth.ts';
import { createLogger } from '../../utils/logger.ts';
import { loggerPlugin } from '../../utils/h3LoggerPlugin.ts';
import { createRateLimiter, createSemaphore } from '../../utils/rateLimiter.ts';

const log = createLogger('http');

export interface HttpRunnerDeps {
  /** Agent for `/text` (Apple Shortcut etc.) and `/audio`. No `ask` tool,
   *  no `continue_conversation` in the response — these endpoints are one-shot. */
  agent: OpenAiAgent;
  /** Agent for `/assist` — used by the HA bridge driving Voice PE. Has the
   *  `ask` tool and the voice-addendum prompt; response includes
   *  `continue_conversation` so HA can reopen the mic. */
  assistAgent: OpenAiAgent;
  stt: AudioFileStt;
  port: number;
  apiKeys: string[];
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

const TextBodySchema = z.object({ text: z.string() });

function clientIp(event: H3Event): string {
  return getRequestIP(event, { xForwardedFor: true }) ?? 'unknown';
}

function tokenKey(authHeader: string | null | undefined): string {
  const header = authHeader ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  // Hash so the raw token never lands in logs / memory keys.
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export async function runHttpMode(deps: HttpRunnerDeps): Promise<void> {
  const { agent, assistAgent, stt, port, apiKeys } = deps;

  if (apiKeys.length === 0) {
    throw new Error('HTTP runner requires at least one API key (HTTP_API_KEYS)');
  }

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

    // Pre-check: too many bad attempts from this IP recently.
    const ipState = authFailLimiter.check(`probe:${ip}`);
    if (!ipState.allowed) {
      event.res.status = 429;
      event.res.headers.set('retry-after', String(ipState.retryAfterSec));
      log.warn({ ip }, `auth-fail rate limit hit for ${ip}`);
      return { error: 'Too many authentication failures' };
    }

    if (!verifyBearerToken(authHeader, apiKeys)) {
      // Count this failure (one extra check beyond the probe above).
      authFailLimiter.check(`fail:${ip}`);
      event.res.status = 401;
      return { error: 'Unauthorized' };
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

  const app = new H3()
    .register(loggerPlugin({ log }))
    .post('/audio', async (event: H3Event) => {
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

          const reply = await agent.respond(transcript);

          return {
            response: reply.text,
            transcript,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err }, `audio handling failed: ${message}`);
          event.res.status = 500;
          return { error: message };
        }
      } finally {
        release();
      }
    })
    .post('/text', async (event: H3Event) => {
      // Apple Shortcut "Get contents of URL" with Request Body=Form sends
      // application/x-www-form-urlencoded with the keys as fields. We
      // extract `text` from that. No other body shape is accepted —
      // misconfigured clients get a clear 400 instead of silently
      // injecting `text=...` strings into the agent.
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
      if (!contentType.startsWith('application/x-www-form-urlencoded')) {
        event.res.status = 415;
        return {
          error: 'Expected Content-Type: application/x-www-form-urlencoded with a "text" field',
        };
      }
      const body = await event.req.text();
      const text = new URLSearchParams(body).get('text')?.trim() ?? '';
      if (!text) {
        event.res.status = 400;
        return { error: 'Missing or empty "text" form field' };
      }

      log.debug({ contentType, bytes: text.length }, `text payload ${text.length} chars`);

      try {
        const reply = await agent.respond(text);
        return { response: reply.text };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err }, `text handling failed: ${message}`);
        event.res.status = 500;
        return { error: message };
      }
    })
    .post('/assist', async (event: H3Event) => {
      // HA bridge (voice_assistant_bridge custom component, lives in the
      // home-infra repo) → Voice PE. The bridge always sends
      // application/json {text: "..."} — no other shape is accepted. The
      // reply gets spoken aloud, so the voice-addendum prompt rules
      // apply. We also forward `expectsFollowUp` as `continue_conversation`
      // so HA's Assist pipeline reopens the mic without a fresh wake-word.
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
      const parsed = TextBodySchema.safeParse(raw);
      if (!parsed.success) {
        event.res.status = 400;
        return { error: 'Expected JSON body with string "text" field' };
      }
      const text = parsed.data.text.trim();
      if (!text) {
        event.res.status = 400;
        return { error: 'Empty "text" field' };
      }

      log.debug({ contentType, bytes: text.length }, `assist payload ${text.length} chars`);

      try {
        const reply = await assistAgent.respond(text);
        return {
          response: reply.text,
          continue_conversation: reply.expectsFollowUp ?? false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err }, `assist handling failed: ${message}`);
        event.res.status = 500;
        return { error: message };
      }
    })
    .get('/health', () => {
      return { status: 'ok' };
    });

  log.info({ port }, `listening on http://localhost:${port}`);
  log.info(
    'POST /audio (audio bytes), POST /text (plain text), POST /assist (HA bridge / Voice PE), GET /health',
  );

  // silent: skip srvx's "➜ Listening on …" / "Server closed successfully."
  // chatter; we already log startup ourselves.
  // gracefulShutdown: false so srvx doesn't install its own SIGINT/SIGTERM
  // handler — unified.ts owns shutdown via deps.dispose().
  serve(app, { port, silent: true, gracefulShutdown: false });

  // The listener runs until the process exits. Shutdown is driven by
  // unified.ts via SIGINT/SIGTERM → dispose() → process.exit(0); we don't
  // install a competing signal handler here.
  return new Promise<void>(() => {});
}
