import { timingSafeEqual } from 'node:crypto';
import { H3, serve, assertBodySize, getRequestHeader, readRawBody, setResponseStatus } from 'h3';
import type { H3Event } from 'h3';
import type { OpenAiAgent } from '../../agent/openaiAgent.ts';
import type { AudioFileStt } from '../../audio/types.ts';
import { normalizeAudioFile, parseContentType } from '../../audio/audioFile.ts';

export interface HttpRunnerDeps {
  agent: OpenAiAgent;
  stt: AudioFileStt;
  port: number;
  apiKeys: string[];
}

/** OpenAI Whisper / gpt-4o-transcribe rejects files larger than 25 MB. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still consume a compare to keep timing closer to the equal-length path.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function verifyApiKey(event: H3Event, apiKeys: string[]): boolean {
  const authHeader = getRequestHeader(event, 'authorization') ?? '';
  const headerKey = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
  if (!headerKey) {
    return false;
  }
  // Constant-time compare against every allowed key. Short-circuiting would
  // leak which prefix matched.
  let matched = false;
  for (const k of apiKeys) {
    if (constantTimeEquals(headerKey, k)) {
      matched = true;
    }
  }
  return matched;
}

export async function runHttpMode(deps: HttpRunnerDeps): Promise<void> {
  const { agent, stt, port, apiKeys } = deps;

  if (apiKeys.length === 0) {
    throw new Error('HTTP runner requires at least one API key (HTTP_API_KEYS)');
  }

  const app = new H3()
    .post('/audio', async (event: H3Event) => {
      if (!verifyApiKey(event, apiKeys)) {
        setResponseStatus(event, 401);
        return { error: 'Unauthorized' };
      }
      try {
        await assertBodySize(event, MAX_BODY_BYTES);
      } catch {
        setResponseStatus(event, 413);
        return { error: `Audio exceeds ${MAX_BODY_BYTES} bytes` };
      }
      const raw = await readRawBody(event, false);
      if (!raw || raw.byteLength === 0) {
        setResponseStatus(event, 400);
        return { error: 'No audio data' };
      }
      const body = Buffer.from(raw);
      const receivedContentType = parseContentType(getRequestHeader(event, 'content-type'));
      const audioFile = normalizeAudioFile(receivedContentType);

      process.stderr.write(`[http] POST /audio ${receivedContentType} ${body.length} bytes\n`);

      try {
        const transcript = (
          await stt.transcribeFile(body, {
            filename: `audio.${audioFile.extension}`,
            contentType: audioFile.contentType,
          })
        ).trim();
        if (!transcript) {
          setResponseStatus(event, 400);
          return { error: 'No speech detected' };
        }

        const reply = await agent.respond(transcript);

        return { response: reply.text, transcript };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[http] audio handling failed: ${message}\n`);
        setResponseStatus(event, 500);
        return { error: message };
      }
    })
    .get('/health', () => {
      return { status: 'ok' };
    });

  process.stderr.write(`[http] listening on http://localhost:${port}\n`);
  process.stderr.write(`[http] POST /audio to send audio, GET /health for healthcheck\n`);

  serve(app, { port });

  // The listener runs until the process exits. Shutdown is driven by
  // unified.ts via SIGINT/SIGTERM → dispose() → process.exit(0); we don't
  // install a competing signal handler here.
  return new Promise<void>(() => {});
}
