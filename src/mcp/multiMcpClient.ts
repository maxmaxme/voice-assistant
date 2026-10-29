import { createLogger } from '../utils/logger.ts';
import type { McpClient, McpTool, McpToolResult } from './types.ts';

const log = createLogger('multi-mcp');

/** A slow custom server must not stall every turn; HA keeps its old semantics. */
const EXTRA_LIST_TIMEOUT_MS = 10_000;

/** OpenAI rejects the whole request on one bad function name. */
const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export interface ExtraMcpServer {
  name: string;
  client: McpClient;
  /** Upstream tool names the filter applies to. */
  tools: ReadonlySet<string>;
  /** true: expose only `tools`; false: expose everything except `tools`. */
  only: boolean;
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** The primary client (HA, or the null client) plus user-added MCP servers.
 *  Primary tools keep their names and errors; each extra server's tools are
 *  exposed as `<name>__<tool>`, and a failing extra only drops its own tools. */
export class MultiMcpClient implements McpClient {
  private readonly primary: McpClient;
  private readonly extras: ExtraMcpServer[];
  private routes = new Map<string, { client: McpClient; tool: string }>();

  constructor(primary: McpClient, extras: ExtraMcpServer[]) {
    this.primary = primary;
    this.extras = extras;
  }

  async connect(): Promise<void> {
    await this.primary.connect();
    await Promise.all(this.extras.map((e) => connectExtra(e)));
  }

  async listTools(): Promise<McpTool[]> {
    const [own, ...rest] = await Promise.all([
      this.primary.listTools(),
      ...this.extras.map((e) =>
        withDeadline(e.client.listTools(), EXTRA_LIST_TIMEOUT_MS).catch((err: unknown) => {
          log.warn({ server: e.name, err: String(err) }, 'mcp server listTools failed, skipping');
          return [];
        }),
      ),
    ]);
    const taken = new Set(own.map((t) => t.name));
    const routes = new Map<string, { client: McpClient; tool: string }>();
    const merged = [...own];
    this.extras.forEach((e, i) => {
      for (const t of rest[i] ?? []) {
        if (e.tools.has(t.name) !== e.only) {
          continue;
        }
        const name = `${e.name}__${t.name}`;
        if (!VALID_TOOL_NAME.test(name) || taken.has(name)) {
          log.warn({ server: e.name, tool: t.name }, 'mcp tool skipped: invalid or clashing name');
          continue;
        }
        taken.add(name);
        routes.set(name, { client: e.client, tool: t.name });
        merged.push({ ...t, name });
      }
    });
    this.routes = routes;
    return merged;
  }

  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const route = this.routes.get(name);
    return route ? route.client.callTool(route.tool, args) : this.primary.callTool(name, args);
  }

  async disconnect(): Promise<void> {
    await Promise.allSettled(
      [this.primary, ...this.extras.map((e) => e.client)].map((c) => c.disconnect()),
    );
  }
}

/** Best-effort: a server that is down at boot just has no tools until
 *  HttpMcpClient's reconnect-on-failure brings it back on a later listTools. */
export async function connectExtra(e: ExtraMcpServer): Promise<void> {
  try {
    await e.client.connect();
  } catch (err) {
    log.warn({ server: e.name, err: String(err) }, 'mcp server connect failed');
  }
}
