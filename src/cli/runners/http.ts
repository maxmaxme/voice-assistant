import { createHash } from 'node:crypto';
import { H3, serve, assertBodySize, getRequestIP } from 'h3';
import type { H3Event } from 'h3';
import { z } from 'zod';
import type { OpenAiAgent } from '../../agent/openaiAgent.ts';
import type { AudioFileStt, Tts } from '../../audio/types.ts';
import { normalizeAudioFile, parseContentType } from '../../audio/audioFile.ts';
import { streamPcmToWavChunks } from '../../audio/wavWriter.ts';
import { verifyBearerToken } from '../../utils/apiKeyAuth.ts';
import { createLogger } from '../../utils/logger.ts';
import { loggerPlugin } from '../../utils/h3LoggerPlugin.ts';
import { createRateLimiter, createSemaphore } from '../../utils/rateLimiter.ts';

const log = createLogger('http');

export interface HttpRunnerDeps {
  agent: OpenAiAgent;
  stt: AudioFileStt;
  /**
   * Used by `/converse` to synthesise the agent's reply back into audio for
   * thin clients (custom Voice PE firmware, mac smoke-test scripts, etc.).
   * `/audio` and `/text` ignore this — they always return JSON text.
   */
  tts: Tts;
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

/**
 * Encode arbitrary (possibly non-ASCII, possibly long) text for transport in
 * an HTTP response header. URL-encode the value so byte safety is guaranteed,
 * and truncate to keep stacks happy — Node defaults to ~16 KB per header but
 * intermediaries (proxies, ESPHome HTTP client buffer) cap much lower.
 */
function encodeHeader(text: string): string {
  const MAX = 512;
  const encoded = encodeURIComponent(text);
  return encoded.length > MAX ? encoded.slice(0, MAX) : encoded;
}

function tokenKey(authHeader: string | null | undefined): string {
  const header = authHeader ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  // Hash so the raw token never lands in logs / memory keys.
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export async function runHttpMode(deps: HttpRunnerDeps): Promise<void> {
  const { agent, stt, tts, port, apiKeys } = deps;

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

          return { response: reply.text, transcript };
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
    .post('/converse', async (event: H3Event) => {
      // Single-shot voice roundtrip for thin clients (custom Voice PE
      // firmware, mac smoke tests, etc.): accepts an utterance, returns a
      // playable WAV with the agent's spoken reply. Unlike `/audio` which
      // returns JSON, this endpoint does the full STT → agent → TTS pipeline
      // server-side so the device only has to play bytes.
      //
      // The reply is *streamed*: the WAV header goes out the moment TTS
      // emits its first PCM chunk, and subsequent chunks are forwarded
      // verbatim. Decoders that respect EOF (afplay, ffmpeg, ESPHome's
      // media_player) start playback while OpenAI is still synthesising the
      // tail of the utterance — cuts ~1 sec off perceived latency on a
      // 3-4 sec reply versus the buffer-then-send variant.
      const denied = checkAuthAndRate(event);
      if (denied) {
        return denied;
      }

      const release = audioGate.tryAcquire();
      if (!release) {
        event.res.status = 429;
        event.res.headers.set('retry-after', '5');
        log.warn(`converse concurrency limit (${AUDIO_CONCURRENCY}) reached`);
        return { error: 'Server busy, retry shortly' };
      }

      // The stream takes over `release()` once we hand back the Response —
      // anything before that point releases on the `finally` below.
      let streamOwnsRelease = false;
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

        log.debug(
          { contentType: receivedContentType, bytes: body.length },
          `converse payload ${receivedContentType} ${body.length} bytes`,
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
          if (!reply.text.trim()) {
            event.res.status = 204;
            return null;
          }

          // Tie TTS to an AbortController so a client disconnect mid-stream
          // tears down the OpenAI call instead of letting it run to
          // completion (and burn tokens) into a dead socket.
          const aborter = new AbortController();
          const ttsStream = tts.stream(reply.text, { signal: aborter.signal });

          // Pull `release` into a local binding so the closure below knows
          // it's non-null (TS narrowing across `if (!release)` doesn't carry
          // into nested function expressions).
          const releaseFn: () => void = release;
          const iter = streamPcmToWavChunks(ttsStream.chunks, ttsStream.sampleRate);
          let cleaned = false;
          const cleanup = (): void => {
            if (cleaned) {
              return;
            }
            cleaned = true;
            aborter.abort();
            releaseFn();
          };

          const responseStream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const { value, done } = await iter.next();
                if (done) {
                  controller.close();
                  cleanup();
                } else {
                  controller.enqueue(value);
                }
              } catch (err) {
                controller.error(err);
                cleanup();
              }
            },
            cancel() {
              // Client disconnected mid-stream. Drop the OpenAI call and
              // release the concurrency gate immediately.
              cleanup();
              void iter.return?.(undefined);
            },
          });

          streamOwnsRelease = true;
          return new Response(responseStream, {
            status: 200,
            headers: {
              'content-type': 'audio/wav',
              'x-transcript': encodeHeader(transcript),
              'x-response': encodeHeader(reply.text),
              // No content-length — implicit chunked transfer encoding,
              // RIFF/data sizes in the WAV header are placeholders so the
              // decoder reads until EOF.
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ err }, `converse handling failed: ${message}`);
          event.res.status = 500;
          return { error: message };
        }
      } finally {
        if (!streamOwnsRelease) {
          release();
        }
      }
    })
    .post('/text', async (event: H3Event) => {
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
      let text: string;
      if (contentType.startsWith('application/json')) {
        const raw: unknown = await event.req.json().catch(() => null);
        const parsed = TextBodySchema.safeParse(raw);
        if (!parsed.success) {
          event.res.status = 400;
          return { error: 'Expected JSON body with string "text" field' };
        }
        text = parsed.data.text;
      } else {
        text = await event.req.text();
      }
      text = text.trim();
      if (!text) {
        event.res.status = 400;
        return { error: 'No text provided' };
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
    .get('/health', () => {
      return { status: 'ok' };
    });

  log.info({ port }, `listening on http://localhost:${port}`);
  log.info(
    'POST /audio (audio in → text out), POST /converse (audio in → audio out), POST /text (text in → text out), GET /health',
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
