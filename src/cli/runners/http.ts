import { H3, serve } from 'h3';
import type { H3Event } from 'h3';
import type { OpenAiAgent } from '../../agent/openaiAgent.ts';
import type { Session } from '../../agent/session.ts';
import type { MemoryStore } from '../../memory/types.ts';
import type { Config } from '../../config.ts';
import type { AudioFileStt } from '../../audio/types.ts';
import { normalizeAudioFile, parseContentType } from '../../audio/audioFile.ts';

export interface HttpRunnerDeps {
  agent: OpenAiAgent;
  stt: AudioFileStt;
  session: Session;
  memory: MemoryStore;
  port: number;
  config: Config;
}

function verifyApiKey(event: H3Event, apiKeys: string[]): boolean {
  const authHeader = event.node!.req.headers.authorization || '';
  const headerKey = authHeader.replace('Bearer ', '');
  return apiKeys.includes(headerKey);
}

export async function runHttpMode(deps: HttpRunnerDeps): Promise<void> {
  const { agent, stt, port, config } = deps;

  const app = new H3()
    .post('/audio', async (event: H3Event) => {
      if (!verifyApiKey(event, config.http.apiKeys)) {
        event.node!.res!.statusCode = 401;
        return { error: 'Unauthorized' };
      }
      const buffer = await event.req!.arrayBuffer();
      if (!buffer || buffer.byteLength === 0) {
        event.node!.res!.statusCode = 400;
        return { error: 'No audio data' };
      }
      const body = Buffer.from(buffer);
      const receivedContentType = parseContentType(event.node!.req.headers['content-type']);
      const audioFile = normalizeAudioFile(receivedContentType);

      console.log(`[http] POST /audio ${receivedContentType} ${body.length} bytes`);

      try {
        const transcript = (
          await stt.transcribeFile(body, {
            filename: `audio.${audioFile.extension}`,
            contentType: audioFile.contentType,
          })
        ).trim();
        if (!transcript) {
          event.node!.res!.statusCode = 400;
          return { error: 'No speech detected' };
        }

        const reply = await agent.respond(transcript);

        return { response: reply.text, transcript };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[http] Audio handling failed: ${message}`);
        event.node!.res!.statusCode = 500;
        return { error: message };
      }
    })
    .get('/health', () => {
      return { status: 'ok' };
    });

  console.log(`[http] Server listening on http://localhost:${port}`);
  console.log(`[http] POST /audio to send audio, GET /health for healthcheck`);

  const listener = serve(app, { port });

  return new Promise<void>(() => {
    process.on('SIGINT', () => {
      console.log('[http] Shutting down');
      listener.close();
      process.exit(0);
    });
  });
}
