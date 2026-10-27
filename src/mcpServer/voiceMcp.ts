import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { OpenAiFunctionTool } from '../agent/toolBridge.ts';
import { bearerToken } from './bearerToken.ts';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('voice-mcp');

/** What one speaker principal gets, so the voice front-end (pipecat-voice)
 *  talks to the household through one place. */
export interface SpeakerContext {
  /** HA tools (with our ha-suffix rules) + the local registry, scoped to the
   *  speaker. Called only for `tools/list`. */
  tools: () => Promise<OpenAiFunctionTool[]>;
  /** Routed local-vs-HA execution; failures come back as `{"error": …}` JSON. */
  runTool: (name: string, args: unknown) => Promise<string>;
  /** Prompt text by name: `voice-system` (instructions with the speaker's
   *  memory + language) and the descriptions of the device-flow tools the
   *  front-end implements itself. */
  prompts: Record<string, string>;
  /** The speaker-relevant realtime settings (web panel's Realtime page + the
   *  OpenAI integration's realtime model/voice/effort), served as the
   *  `voice://realtime-config` JSON resource so the front-end runs the session
   *  the way the panel says. */
  realtimeConfig: Record<string, unknown>;
}

export const REALTIME_CONFIG_URI = 'voice://realtime-config';

export interface VoiceMcpDeps {
  /** Speaker bearer token → principal (the `voice` identities), or null. */
  authorize: (token: string) => { userId: number } | null;
  speakerContext: (userId: number) => Promise<SpeakerContext>;
}

/**
 * Stateless MCP endpoint (Streamable HTTP, JSON responses) for voice
 * front-ends. Auth is the speaker's own device token, so tools and memory are
 * scoped to that speaker's principal. A fresh
 * server per request: there is no session state to keep, and the speaker
 * context (memory snapshot, web-edited prompts) is read fresh each time.
 */
export async function handleVoiceMcp(req: Request, deps: VoiceMcpDeps): Promise<Response> {
  const token = bearerToken(req.headers.get('authorization') ?? undefined);
  const auth = token ? deps.authorize(token) : null;
  if (!auth) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Built on first use, so initialize / notifications / GET never pay for it.
  let context: Promise<SpeakerContext> | undefined;
  const speaker = (): Promise<SpeakerContext> => (context ??= deps.speakerContext(auth.userId));

  const server = new Server(
    { name: 'voice-assistant', version: '1.0.0' },
    { capabilities: { tools: {}, prompts: {}, resources: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await (await speaker()).tools()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { ...t.parameters, type: 'object' },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const started = Date.now();
    const text = await (await speaker()).runTool(name, args ?? {});
    log.info({ userId: auth.userId, name, ms: Date.now() - started }, `${name} via voice MCP`);
    return { content: [{ type: 'text' as const, text }] };
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: Object.keys((await speaker()).prompts).map((name) => ({ name })),
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const text = (await speaker()).prompts[request.params.name];
    if (text === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `unknown prompt: ${request.params.name}`);
    }
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
  });

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [
      { uri: REALTIME_CONFIG_URI, name: 'realtime-config', mimeType: 'application/json' },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== REALTIME_CONFIG_URI) {
      throw new McpError(ErrorCode.InvalidParams, `unknown resource: ${request.params.uri}`);
    }
    return {
      contents: [
        {
          uri: REALTIME_CONFIG_URI,
          mimeType: 'application/json',
          text: JSON.stringify((await speaker()).realtimeConfig),
        },
      ],
    };
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}
