import * as fs from 'node:fs';
import * as path from 'node:path';
import { H3, serve } from 'h3';
import type { H3Event } from 'h3';
import type { OpenAiAgent } from '../../agent/openaiAgent.ts';
import type { Session } from '../../agent/session.ts';
import type { MemoryStore } from '../../memory/types.ts';
import type { Config } from '../../config.ts';

export interface HttpRunnerDeps {
  agent: OpenAiAgent;
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
  const { port, config } = deps;

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

      console.log(`[http] Received audio POST`);
      console.log(`[http] Content-Type: ${event.node!.req.headers['content-type']}`);
      console.log(`[http] Content-Length: ${body.length} bytes`);
      console.log(`[http] User-Agent: ${event.node!.req.headers['user-agent']}`);

      // Save to temp file for debugging
      const tempFile = path.join('/tmp', `audio-${Date.now()}.wav`);
      fs.writeFileSync(tempFile, body);
      console.log(`[http] Saved to ${tempFile}`);

      return { status: 'received', size: body.length };
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
