import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OpenAiAgent } from '../../../src/agent/openaiAgent.ts';
import type { AgentRespondOptions } from '../../../src/agent/types.ts';
import { Session } from '../../../src/agent/session.ts';
import { buildHttpApp, type HttpAppDeps } from '../../../src/cli/runners/http.ts';
import { IdentitiesStore, hashToken } from '../../../src/memory/identities.ts';
import { SqliteProfileMemory } from '../../../src/memory/sqliteProfileMemory.ts';
import { freshTestDb } from '../../memory/helpers.ts';

const TOKEN = 'good-token';

interface RespondCall {
  text: string;
  opts: AgentRespondOptions;
}

function fakeAgent(calls: RespondCall[]): OpenAiAgent {
  return {
    respond: vi.fn(async (text: string, opts: AgentRespondOptions = {}) => {
      calls.push({ text, opts });
      return { text: 'ok', toolsUsed: [] };
    }),
  } as unknown as OpenAiAgent;
}

let respondCalls: RespondCall[];
let deps: HttpAppDeps;

beforeEach(() => {
  const { db } = freshTestDb();
  const identities = new IdentitiesStore(db);
  const user = identities.addUser('Max');
  identities.attachIdentity('http', hashToken(TOKEN), user);

  respondCalls = [];
  const agent = fakeAgent(respondCalls);
  deps = {
    agent,
    assistAgent: agent,
    assistSessionFor: () => new Session({ idleTimeoutMs: 60_000 }),
    stt: { transcribeFile: vi.fn(async () => 'transcribed text') },
    endpoints: { text: true, audio: true, assist: true },
    identities,
    profileStore: new SqliteProfileMemory(db),
  };
});

function textRequest(token: string | null = TOKEN): Request {
  return new Request('http://localhost/text', {
    method: 'POST',
    headers: {
      ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ text: 'hello' }).toString(),
  });
}

function audioRequest(token: string | null = TOKEN): Request {
  return new Request('http://localhost/audio', {
    method: 'POST',
    headers: {
      ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'audio/wav',
    },
    body: Buffer.from([1, 2, 3, 4]),
  });
}

describe('HTTP auth-fail rate limiting', () => {
  it('does not throttle valid-token requests (only auth failures count)', async () => {
    const app = buildHttpApp(deps);
    // More requests than the auth-fail budget (10 per 5 min per IP). All carry
    // a valid token, so none of them may hit the fail limiter.
    for (let i = 0; i < 15; i++) {
      const res = await app.fetch(textRequest());
      expect(res.status).toBe(200);
    }
    expect(respondCalls).toHaveLength(15);
  });

  it('429s repeated auth failures from one IP, but a valid token still passes', async () => {
    const app = buildHttpApp(deps);
    for (let i = 0; i < 10; i++) {
      const res = await app.fetch(textRequest('wrong-token'));
      expect(res.status).toBe(401);
    }
    const blocked = await app.fetch(textRequest('wrong-token'));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();

    // The legit user behind the same NAT is not locked out.
    const legit = await app.fetch(textRequest());
    expect(legit.status).toBe(200);
  });
});

describe('HTTP per-request sessions', () => {
  it('/text gives every request its own fresh session — no chain is shared across tokens', async () => {
    const app = buildHttpApp(deps);
    await app.fetch(textRequest());
    await app.fetch(textRequest());

    expect(respondCalls).toHaveLength(2);
    const [first, second] = respondCalls;
    // A shared (or absent) session would chain the second caller's turn onto
    // the first one's previous_response_id — leaking the conversation.
    expect(first!.opts.session).toBeInstanceOf(Session);
    expect(second!.opts.session).toBeInstanceOf(Session);
    expect(first!.opts.session).not.toBe(second!.opts.session);
    expect(second!.opts.session!.isFresh()).toBe(true);
  });

  it('/audio gives every request its own fresh session', async () => {
    const app = buildHttpApp(deps);
    const res = await app.fetch(audioRequest());
    expect(res.status).toBe(200);
    await app.fetch(audioRequest());

    expect(respondCalls).toHaveLength(2);
    expect(respondCalls[0]!.opts.session).toBeInstanceOf(Session);
    expect(respondCalls[0]!.opts.session).not.toBe(respondCalls[1]!.opts.session);
  });
});
