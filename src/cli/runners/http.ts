import { H3, serve, assertBodySize } from 'h3';
import type { H3Event } from 'h3';
import { z } from 'zod';
import type { OpenAiAgent } from '../../agent/openaiAgent.ts';
import type { AudioFileStt } from '../../audio/types.ts';
import { normalizeAudioFile, parseContentType } from '../../audio/audioFile.ts';
import { verifyBearerToken } from '../../utils/apiKeyAuth.ts';
import { createLogger } from '../../utils/logger.ts';
import { loggerPlugin } from '../../utils/h3LoggerPlugin.ts';

const log = createLogger('http');

export interface HttpRunnerDeps {
  agent: OpenAiAgent;
  stt: AudioFileStt;
  port: number;
  apiKeys: string[];
}

/** OpenAI Whisper / gpt-4o-transcribe rejects files larger than 25 MB. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

const TextBodySchema = z.object({ text: z.string() });

export async function runHttpMode(deps: HttpRunnerDeps): Promise<void> {
  const { agent, stt, port, apiKeys } = deps;

  if (apiKeys.length === 0) {
    throw new Error('HTTP runner requires at least one API key (HTTP_API_KEYS)');
  }

  const app = new H3()
    .register(loggerPlugin({ log }))
    .post('/audio', async (event: H3Event) => {
      if (!verifyBearerToken(event.req.headers.get('authorization'), apiKeys)) {
        event.res.status = 401;
        return { error: 'Unauthorized' };
      }
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
    })
    .post('/text', async (event: H3Event) => {
      if (!verifyBearerToken(event.req.headers.get('authorization'), apiKeys)) {
        event.res.status = 401;
        return { error: 'Unauthorized' };
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
  log.info('POST /audio for audio, POST /text for text, GET /health for healthcheck');

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
