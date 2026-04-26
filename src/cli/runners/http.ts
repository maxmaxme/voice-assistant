import { H3, serve, assertBodySize } from 'h3';
import type { H3Event } from 'h3';
import type { OpenAiAgent } from '../../agent/openaiAgent.ts';
import type { AudioFileStt } from '../../audio/types.ts';
import { normalizeAudioFile, parseContentType } from '../../audio/audioFile.ts';
import { verifyBearerToken } from '../../utils/apiKeyAuth.ts';
import { createLogger } from '../../utils/logger.ts';

const log = createLogger('http');

export interface HttpRunnerDeps {
  agent: OpenAiAgent;
  stt: AudioFileStt;
  port: number;
  apiKeys: string[];
}

/** OpenAI Whisper / gpt-4o-transcribe rejects files larger than 25 MB. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

export async function runHttpMode(deps: HttpRunnerDeps): Promise<void> {
  const { agent, stt, port, apiKeys } = deps;

  if (apiKeys.length === 0) {
    throw new Error('HTTP runner requires at least one API key (HTTP_API_KEYS)');
  }

  const app = new H3()
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

      log.info(
        { contentType: receivedContentType, bytes: body.length },
        `POST /audio ${receivedContentType} ${body.length} bytes`,
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
    .get('/health', () => {
      return { status: 'ok' };
    });

  log.info({ port }, `listening on http://localhost:${port}`);
  log.info('POST /audio to send audio, GET /health for healthcheck');

  serve(app, { port });

  // The listener runs until the process exits. Shutdown is driven by
  // unified.ts via SIGINT/SIGTERM → dispose() → process.exit(0); we don't
  // install a competing signal handler here.
  return new Promise<void>(() => {});
}
