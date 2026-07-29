import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OpenAiAgent } from '../../../src/agent/openaiAgent.ts';
import type { AgentRespondOptions } from '../../../src/agent/types.ts';
import { Session } from '../../../src/agent/session.ts';
import { buildHttpApp, runHttpMode, type HttpAppDeps } from '../../../src/cli/runners/http.ts';
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

function assistRequest(
  body: BodyInit,
  { contentType = 'application/json' }: { contentType?: string } = {},
): Request {
  return new Request('http://localhost/assist', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': contentType,
    },
    body,
  });
}

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

describe('HTTP 500 responses do not leak internals', () => {
  const SECRET = 'OPENAI_SECRET_DETAIL http://internal:1234';

  function throwingAgent(): OpenAiAgent {
    return {
      respond: vi.fn(async () => {
        throw new Error(SECRET);
      }),
    } as unknown as OpenAiAgent;
  }

  it('/text returns a generic error body when the agent throws', async () => {
    const agent = throwingAgent();
    const app = buildHttpApp({ ...deps, agent, assistAgent: agent });
    const res = await app.fetch(textRequest());
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('OPENAI_SECRET_DETAIL');
    expect(body).not.toContain('internal:1234');
    expect(JSON.parse(body)).toEqual({ error: 'Internal error' });
  });

  it('/audio returns a generic error body when the agent throws', async () => {
    const agent = throwingAgent();
    const app = buildHttpApp({ ...deps, agent, assistAgent: agent });
    const res = await app.fetch(audioRequest());
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('OPENAI_SECRET_DETAIL');
    expect(JSON.parse(body)).toEqual({ error: 'Internal error' });
  });

  it('/assist returns a generic error body when the agent throws', async () => {
    const agent = throwingAgent();
    const app = buildHttpApp({ ...deps, agent, assistAgent: agent });
    const res = await app.fetch(
      new Request('http://localhost/assist', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 'hello' }),
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('OPENAI_SECRET_DETAIL');
    expect(JSON.parse(body)).toEqual({ error: 'Internal error' });
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

describe('POST /assist contract', () => {
  it('returns {response, continue_conversation: false} when the reply has no expectsFollowUp', async () => {
    const app = buildHttpApp(deps);
    const res = await app.fetch(assistRequest(JSON.stringify({ text: 'hello' })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ response: 'ok', continue_conversation: false });
    expect(respondCalls).toHaveLength(1);
    expect(respondCalls[0]!.text).toBe('hello');
  });

  it('forwards expectsFollowUp: true as continue_conversation: true', async () => {
    const assistAgent = {
      respond: vi.fn(async () => ({ text: 'which one?', toolsUsed: [], expectsFollowUp: true })),
    } as unknown as OpenAiAgent;
    const app = buildHttpApp({ ...deps, assistAgent });
    const res = await app.fetch(assistRequest(JSON.stringify({ text: 'turn it on' })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ response: 'which one?', continue_conversation: true });
  });

  it('routes conversation_id to per-conversation sessions, falling back to "default"', async () => {
    const sessions = new Map<string, Session>();
    const assistSessionFor = vi.fn((conversationId: string) => {
      let session = sessions.get(conversationId);
      if (!session) {
        session = new Session({ idleTimeoutMs: 60_000 });
        sessions.set(conversationId, session);
      }
      return session;
    });
    const app = buildHttpApp({ ...deps, assistSessionFor });

    await app.fetch(assistRequest(JSON.stringify({ text: 'one', conversation_id: 'conv-a' })));
    await app.fetch(assistRequest(JSON.stringify({ text: 'two', conversation_id: 'conv-a' })));
    await app.fetch(assistRequest(JSON.stringify({ text: 'three', conversation_id: 'conv-b' })));
    await app.fetch(assistRequest(JSON.stringify({ text: 'four' })));

    expect(assistSessionFor.mock.calls.map((c) => c[0])).toEqual([
      'conv-a',
      'conv-a',
      'conv-b',
      'default',
    ]);
    expect(respondCalls).toHaveLength(4);
    const [first, second, third] = respondCalls;
    expect(first!.opts.session).toBe(second!.opts.session);
    expect(third!.opts.session).not.toBe(first!.opts.session);
  });

  it('415s a non-JSON content-type', async () => {
    const app = buildHttpApp(deps);
    const res = await app.fetch(
      assistRequest('text=hello', { contentType: 'application/x-www-form-urlencoded' }),
    );
    expect(res.status).toBe(415);
    expect(respondCalls).toHaveLength(0);
  });

  it('400s invalid JSON', async () => {
    const app = buildHttpApp(deps);
    const res = await app.fetch(assistRequest('{not json'));
    expect(res.status).toBe(400);
    expect(respondCalls).toHaveLength(0);
  });

  it('400s a missing or non-string text field', async () => {
    const app = buildHttpApp(deps);
    const missing = await app.fetch(assistRequest(JSON.stringify({ conversation_id: 'x' })));
    expect(missing.status).toBe(400);
    const nonString = await app.fetch(assistRequest(JSON.stringify({ text: 42 })));
    expect(nonString.status).toBe(400);
    expect(respondCalls).toHaveLength(0);
  });

  it('400s text that is empty after trimming', async () => {
    const app = buildHttpApp(deps);
    const res = await app.fetch(assistRequest(JSON.stringify({ text: '   ' })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Empty "text" field' });
    expect(respondCalls).toHaveLength(0);
  });
});

describe('POST /text error branches', () => {
  it('415s a content-type that is neither form nor JSON', async () => {
    const app = buildHttpApp(deps);
    const res = await app.fetch(
      new Request('http://localhost/text', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'text/plain',
        },
        body: 'hello',
      }),
    );
    expect(res.status).toBe(415);
    expect(respondCalls).toHaveLength(0);
  });

  it('accepts a JSON body', async () => {
    const app = buildHttpApp(deps);
    const res = await app.fetch(
      new Request('http://localhost/text', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 'hello' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(respondCalls.map((c) => c.text)).toEqual(['hello']);
  });

  it('400s a JSON body without a string text field', async () => {
    const app = buildHttpApp(deps);
    const res = await app.fetch(
      new Request('http://localhost/text', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 42 }),
      }),
    );
    expect(res.status).toBe(400);
    expect(respondCalls).toHaveLength(0);
  });

  it('400s a missing or empty text form field', async () => {
    const app = buildHttpApp(deps);
    const formRequest = (body: string): Request =>
      new Request('http://localhost/text', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
      });
    const missing = await app.fetch(formRequest('other=value'));
    expect(missing.status).toBe(400);
    const empty = await app.fetch(formRequest('text=%20%20'));
    expect(empty.status).toBe(400);
    expect(respondCalls).toHaveLength(0);
  });
});

describe('POST /audio error branches', () => {
  it('400s an empty body', async () => {
    const app = buildHttpApp(deps);
    const res = await app.fetch(
      new Request('http://localhost/audio', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'audio/wav',
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'No audio data' });
    expect(respondCalls).toHaveLength(0);
  });

  it("400s 'No speech detected' when the transcript is empty", async () => {
    const stt = { transcribeFile: vi.fn(async () => '   ') };
    const app = buildHttpApp({ ...deps, stt });
    const res = await app.fetch(audioRequest());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'No speech detected' });
    expect(respondCalls).toHaveLength(0);
  });

  it('429s with retry-after 5 when two /audio requests are already in flight', async () => {
    let releaseStt!: () => void;
    const blocked = new Promise<string>((resolve) => {
      releaseStt = () => resolve('transcribed text');
    });
    const stt = { transcribeFile: vi.fn(() => blocked) };
    const app = buildHttpApp({ ...deps, stt });

    const inFlight = [app.fetch(audioRequest()), app.fetch(audioRequest())];
    // Both requests must be past tryAcquire (i.e. inside the stt call) before
    // the third one arrives, or the semaphore may not be saturated yet.
    await vi.waitFor(() => {
      expect(stt.transcribeFile).toHaveBeenCalledTimes(2);
    });

    const third = await app.fetch(audioRequest());
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBe('5');

    releaseStt();
    const results = await Promise.all(inFlight);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(respondCalls).toHaveLength(2);
  });
});

describe('413 body-size limit', () => {
  const OVERSIZED = Buffer.alloc(25 * 1024 * 1024 + 1);

  it('413s /text bodies over 25MB', async () => {
    const app = buildHttpApp(deps);
    const res = await app.fetch(
      new Request('http://localhost/text', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: OVERSIZED,
      }),
    );
    expect(res.status).toBe(413);
    expect(respondCalls).toHaveLength(0);
  });

  it('413s /audio bodies over 25MB', async () => {
    const app = buildHttpApp(deps);
    const res = await app.fetch(
      new Request('http://localhost/audio', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'audio/wav',
        },
        body: OVERSIZED,
      }),
    );
    expect(res.status).toBe(413);
    expect(respondCalls).toHaveLength(0);
  });
});

describe('disabled endpoints', () => {
  it('404s a disabled endpoint while /health stays up', async () => {
    const app = buildHttpApp({ ...deps, endpoints: { text: false, audio: false, assist: false } });
    const text = await app.fetch(textRequest());
    expect(text.status).toBe(404);
    const health = await app.fetch(new Request('http://localhost/health'));
    expect(health.status).toBe(200);
    expect(respondCalls).toHaveLength(0);
  });
});

describe('GET /health', () => {
  it("200s {status: 'ok'} without auth", async () => {
    const app = buildHttpApp(deps);
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('runHttpMode shutdown seam', () => {
  it('hands the server closer to onListen so shutdown can stop the listener', async () => {
    let close: (() => Promise<void>) | null = null;
    // Port 0 → ephemeral port; the runner promise never resolves by design.
    void runHttpMode({
      ...deps,
      port: 0,
      onListen: (c) => {
        close = c;
      },
    });
    await vi.waitFor(() => {
      expect(close).not.toBeNull();
    });
    await expect(close!()).resolves.toBeUndefined();
  });
});

describe('CORS', () => {
  it('answers a preflight without auth and allows the endpoint headers', async () => {
    const app = buildHttpApp(deps);
    const res = await app.fetch(
      new Request('http://localhost/text', {
        method: 'OPTIONS',
        headers: {
          origin: 'null',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type',
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(respondCalls).toHaveLength(0);
  });

  it('sets the origin header on real responses too', async () => {
    const app = buildHttpApp(deps);
    const ok = await app.fetch(new Request('http://localhost/health'));
    expect(ok.headers.get('access-control-allow-origin')).toBe('*');
    const denied = await app.fetch(new Request('http://localhost/text', { method: 'POST' }));
    expect(denied.status).toBe(401);
    expect(denied.headers.get('access-control-allow-origin')).toBe('*');
  });
});
