import { describe, it, expect, vi } from 'vitest';
import { PescPortal, generateTotp } from '../src/portals/pesc.ts';
import type { PortalDeps } from '../src/portals/types.ts';

interface IndicationFixture {
  meterScaleId: number;
  scaleName?: string;
  previousReading?: number;
  unit?: string;
}

interface MeterFixture {
  id: { registration: string };
  name?: string;
  numberOfDigitsRight?: number;
  indications: IndicationFixture[];
}

interface MockOptions {
  cookie?: string;
  /** Inject a custom Response for cookie GET. Default: 200 with Set-Cookie. */
  cookieResponse?: Response;
  /** Inject a custom Response for /v8/users/auth. Default: 200 {auth:"TOK"}. */
  authResponse?: Response;
  groupsResponse?: Response;
  groups?: Array<{ id: number; name?: string; accounts: number[] }>;
  bill?: { amount: number; id?: string };
  billResponse?: Response;
  metersBefore: MeterFixture[];
  metersAfter?: MeterFixture[];
  submitResponse?: (body: Array<{ scaleId: number; value: number }>) => Response;
  /** Capture POST bodies for assertions. */
  submits?: Array<{ registration: string; body: Array<{ scaleId: number; value: number }> }>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function cookieResponse(cookie: string): Response {
  return new Response('{}', {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': `session-cookie=${cookie}; Path=/; HttpOnly`,
    },
  });
}

function makeFetchMock(opts: MockOptions): ReturnType<typeof vi.fn> {
  let metersCallCount = 0;
  return vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.endsWith('/api/v6/users/manual/existence') && method === 'GET') {
      return (opts.cookieResponse ?? cookieResponse(opts.cookie ?? 'COOKIE')).clone();
    }

    if (url.endsWith('/api/v8/users/auth') && method === 'POST') {
      return (opts.authResponse ?? jsonResponse({ auth: 'TOK' })).clone();
    }

    if (url.endsWith('/api/v6/accounts/groups') && method === 'GET') {
      if (opts.groupsResponse) {
        return opts.groupsResponse.clone();
      }
      return jsonResponse(opts.groups ?? [{ id: 1, name: 'My', accounts: [4116588] }]);
    }

    if (/\/api\/v7\/accounts\/\d+\/payments\/at\/current\/amount\/discretion$/.test(url)) {
      if (opts.billResponse) {
        return opts.billResponse.clone();
      }
      return jsonResponse(opts.bill ?? { amount: -75.18, id: 'B1' });
    }

    if (/\/api\/v6\/accounts\/\d+\/meters\/info$/.test(url) && method === 'GET') {
      metersCallCount += 1;
      const list =
        metersCallCount === 1 ? opts.metersBefore : (opts.metersAfter ?? opts.metersBefore);
      return jsonResponse(list);
    }

    const submitMatch = /\/api\/v8\/accounts\/\d+\/meters\/([^/]+)\/reading$/.exec(url);
    if (submitMatch && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '[]')) as Array<{
        scaleId: number;
        value: number;
      }>;
      opts.submits?.push({ registration: submitMatch[1], body });
      if (opts.submitResponse) {
        return opts.submitResponse(body);
      }
      return new Response(null, { status: 204 });
    }

    return new Response('not found', { status: 404 });
  });
}

function makeDeps(overrides: Partial<PortalDeps> = {}): PortalDeps {
  return {
    login: '+79991234567',
    password: 'pw',
    lastSubmittedValueFor: () => null,
    today: () => new Date('2026-05-16T09:00:00Z'),
    ...overrides,
  };
}

describe('PescPortal.run', () => {
  it('happy path: logs in, lists meters, submits +0.001 (smallest step at numberOfDigitsRight=3), returns balance and values', async () => {
    const submits: MockOptions['submits'] = [];
    const fetchMock = makeFetchMock({
      submits,
      metersBefore: [
        {
          id: { registration: '12345' },
          numberOfDigitsRight: 3,
          name: 'ХВС',
          indications: [{ meterScaleId: 1, scaleName: 'T1', previousReading: 10 }],
        },
      ],
      metersAfter: [
        {
          id: { registration: '12345' },
          numberOfDigitsRight: 3,
          name: 'ХВС',
          indications: [{ meterScaleId: 1, scaleName: 'T1', previousReading: 10.001 }],
        },
      ],
    });
    const portal = new PescPortal({
      fetch: fetchMock as unknown as typeof fetch,
      verifyDelayMs: 0,
    });

    const result = await portal.run(makeDeps());

    expect(result.alreadySubmitted).toBe(false);
    expect(result.info).toEqual({ accountId: '4116588', balanceText: 'переплата 75.18 руб' });
    expect(result.values).toEqual([{ meter: '12345:1', kind: 'T1', value: 10.001 }]);
    expect(submits).toHaveLength(1);
    expect(submits[0]).toEqual({ registration: '12345', body: [{ scaleId: 1, value: 10.001 }] });
  });

  it('uses session-cookie from Set-Cookie and Bearer from auth response', async () => {
    const fetchMock = makeFetchMock({
      cookie: 'ABC123',
      authResponse: jsonResponse({ auth: 'BEARER-XYZ' }),
      metersBefore: [],
    });
    const portal = new PescPortal({
      fetch: fetchMock as unknown as typeof fetch,
      verifyDelayMs: 0,
    });

    await portal.run(makeDeps());

    // Check that one of the calls after auth carried both Cookie and Authorization headers.
    const calls = fetchMock.mock.calls;
    const groupsCall = calls.find(([url]) => String(url).endsWith('/api/v6/accounts/groups'));
    expect(groupsCall).toBeDefined();
    const init = groupsCall?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.cookie).toBe('session-cookie=ABC123');
    expect(headers?.authorization).toBe('Bearer BEARER-XYZ');
  });

  it('throws when 424 lists no TOTP option (EMAIL/SMS not supported)', async () => {
    const fetchMock = makeFetchMock({
      authResponse: new Response(JSON.stringify({ transactionId: 'TX1', types: ['EMAIL'] }), {
        status: 424,
        headers: { 'content-type': 'application/json' },
      }),
      metersBefore: [],
    });
    const portal = new PescPortal({
      fetch: fetchMock as unknown as typeof fetch,
      totpSecret: 'JBSWY3DPEHPK3PXP',
    });

    await expect(portal.run(makeDeps())).rejects.toThrow(/Only TOTP is supported/);
  });

  it('throws when 424 needs TOTP but no secret is configured', async () => {
    const fetchMock = makeFetchMock({
      authResponse: new Response(
        JSON.stringify({ transactionId: 'TX1', types: ['TOTP', 'EMAIL'] }),
        { status: 424, headers: { 'content-type': 'application/json' } },
      ),
      metersBefore: [],
    });
    const portal = new PescPortal({ fetch: fetchMock as unknown as typeof fetch });

    await expect(portal.run(makeDeps())).rejects.toThrow(/PESC_TOTP_SECRET is not configured/);
  });

  it('solves TOTP challenge: 424 → POST /dfa/{tx}/totp/verify with 6-digit code, uses returned auth', async () => {
    let totpVerifyCall: { url: string; body: string } | undefined;
    let authCallCount = 0;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/v6/users/manual/existence')) {
        return cookieResponse('COOK');
      }
      if (url.endsWith('/api/v8/users/auth') && method === 'POST') {
        authCallCount += 1;
        return new Response(JSON.stringify({ transactionId: 'TX-42', types: ['TOTP', 'EMAIL'] }), {
          status: 424,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/api/v1/dfa/TX-42/totp/verify') && method === 'POST') {
        totpVerifyCall = { url, body: String(init?.body ?? '') };
        return new Response(JSON.stringify({ auth: 'BEARER-AFTER-TOTP', verified: 'V' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/api/v6/accounts/groups')) {
        return new Response(JSON.stringify([{ id: 1, accounts: [42] }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (/payments\/at\/current\/amount\/discretion$/.test(url)) {
        return new Response(JSON.stringify({ amount: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (/\/meters\/info$/.test(url)) {
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    const portal = new PescPortal({
      fetch: fetchMock as unknown as typeof fetch,
      totpSecret: 'JBSWY3DPEHPK3PXP',
      now: () => 59 * 1000, // RFC 6238 test vector @ 59s → 287082
    });

    const result = await portal.run(makeDeps());

    expect(authCallCount).toBe(1);
    expect(totpVerifyCall).toBeDefined();
    const body = JSON.parse(totpVerifyCall?.body ?? '{}') as { code: string };
    expect(body.code).toMatch(/^\d{6}$/);

    // Subsequent API call (accounts/groups) must use the Bearer returned by totp/verify.
    const groupsCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/api/v6/accounts/groups'),
    );
    const headers = (groupsCall?.[1] as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.authorization).toBe('Bearer BEARER-AFTER-TOTP');
    expect(result).toBeDefined();
  });

  it('uses stored value + step when stored > portalPrev (guards against portal regression)', async () => {
    const submits: MockOptions['submits'] = [];
    const fetchMock = makeFetchMock({
      submits,
      metersBefore: [
        {
          id: { registration: '12345' },
          numberOfDigitsRight: 3,
          indications: [{ meterScaleId: 1, scaleName: 'T1', previousReading: 5 }],
        },
      ],
      metersAfter: [
        {
          id: { registration: '12345' },
          numberOfDigitsRight: 3,
          indications: [{ meterScaleId: 1, scaleName: 'T1', previousReading: 20.001 }],
        },
      ],
    });
    const portal = new PescPortal({
      fetch: fetchMock as unknown as typeof fetch,
      verifyDelayMs: 0,
    });

    const result = await portal.run(
      makeDeps({
        lastSubmittedValueFor: (meter) => (meter === '12345:1' ? 20 : null),
      }),
    );

    expect(submits[0].body).toEqual([{ scaleId: 1, value: 20.001 }]);
    expect(result.values[0].value).toBe(20.001);
  });

  it('electricity meter (numberOfDigitsRight=0) increments by +1, not by fractional step', async () => {
    const submits: MockOptions['submits'] = [];
    const fetchMock = makeFetchMock({
      submits,
      metersBefore: [
        {
          id: { registration: '000001UOXR' },
          name: 'Электроэнергия',
          numberOfDigitsRight: 0,
          indications: [
            { meterScaleId: 2, scaleName: 'Day', previousReading: 2143 },
            { meterScaleId: 3, scaleName: 'Night', previousReading: 857 },
          ],
        },
      ],
      metersAfter: [
        {
          id: { registration: '000001UOXR' },
          numberOfDigitsRight: 0,
          indications: [
            { meterScaleId: 2, scaleName: 'Day', previousReading: 2144 },
            { meterScaleId: 3, scaleName: 'Night', previousReading: 858 },
          ],
        },
      ],
    });
    const portal = new PescPortal({
      fetch: fetchMock as unknown as typeof fetch,
      verifyDelayMs: 0,
    });

    await portal.run(makeDeps());

    expect(submits[0]).toEqual({
      registration: '000001UOXR',
      body: [
        { scaleId: 2, value: 2144 },
        { scaleId: 3, value: 858 },
      ],
    });
  });

  it('two-tariff meter: posts one request with two scaleId entries', async () => {
    const submits: MockOptions['submits'] = [];
    const fetchMock = makeFetchMock({
      submits,
      metersBefore: [
        {
          id: { registration: '999' },
          numberOfDigitsRight: 3,
          name: 'Электроэнергия',
          indications: [
            { meterScaleId: 1, scaleName: 'Day', previousReading: 100 },
            { meterScaleId: 2, scaleName: 'Night', previousReading: 50 },
          ],
        },
      ],
      metersAfter: [
        {
          id: { registration: '999' },
          numberOfDigitsRight: 3,
          name: 'Электроэнергия',
          indications: [
            { meterScaleId: 1, scaleName: 'Day', previousReading: 100.001 },
            { meterScaleId: 2, scaleName: 'Night', previousReading: 50.001 },
          ],
        },
      ],
    });
    const portal = new PescPortal({
      fetch: fetchMock as unknown as typeof fetch,
      verifyDelayMs: 0,
    });

    const result = await portal.run(makeDeps());

    expect(submits).toHaveLength(1);
    expect(submits[0]).toEqual({
      registration: '999',
      body: [
        { scaleId: 1, value: 100.001 },
        { scaleId: 2, value: 50.001 },
      ],
    });
    expect(result.values).toHaveLength(2);
  });

  it('throws when verify step shows previousReading did not advance', async () => {
    const fetchMock = makeFetchMock({
      metersBefore: [
        {
          id: { registration: '1' },
          numberOfDigitsRight: 3,
          indications: [{ meterScaleId: 1, previousReading: 5 }],
        },
      ],
      metersAfter: [
        {
          id: { registration: '1' },
          numberOfDigitsRight: 3,
          indications: [{ meterScaleId: 1, previousReading: 5 }], // didn't advance
        },
      ],
    });
    const portal = new PescPortal({
      fetch: fetchMock as unknown as typeof fetch,
      verifyDelayMs: 0,
    });

    await expect(portal.run(makeDeps())).rejects.toThrow(/previousReading after submit/);
  });

  it('skips meter with no indications, leaves submitted empty', async () => {
    const fetchMock = makeFetchMock({
      metersBefore: [{ id: { registration: '1' }, indications: [] }],
    });
    const portal = new PescPortal({
      fetch: fetchMock as unknown as typeof fetch,
      verifyDelayMs: 0,
    });

    const result = await portal.run(makeDeps());

    expect(result.values).toHaveLength(0);
    expect(result.alreadySubmitted).toBe(false);
  });

  it('throws when no group contains any account', async () => {
    const fetchMock = makeFetchMock({
      groups: [{ id: 1, name: 'Empty', accounts: [] }],
      metersBefore: [],
    });
    const portal = new PescPortal({ fetch: fetchMock as unknown as typeof fetch });

    await expect(portal.run(makeDeps())).rejects.toThrow(/No accounts found/);
  });

  it('sends customer:ikus-spb header on every request', async () => {
    const fetchMock = makeFetchMock({ metersBefore: [] });
    const portal = new PescPortal({ fetch: fetchMock as unknown as typeof fetch });
    await portal.run(makeDeps());

    for (const [, init] of fetchMock.mock.calls) {
      const headers = (init as RequestInit | undefined)?.headers as
        | Record<string, string>
        | undefined;
      expect(headers?.customer).toBe('ikus-spb');
    }
  });

  it('sends withtotp and captcha headers on the auth POST', async () => {
    const fetchMock = makeFetchMock({ metersBefore: [] });
    const portal = new PescPortal({ fetch: fetchMock as unknown as typeof fetch });
    await portal.run(makeDeps());

    const authCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/api/v8/users/auth'),
    );
    const headers = (authCall?.[1] as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.withtotp).toBe('true');
    expect(headers?.captcha).toBe('none');
  });

  it('formats balanceText: positive amount = задолженность, zero = расчёты без долга', async () => {
    const debt = makeFetchMock({
      bill: { amount: 42.5 },
      metersBefore: [],
    });
    const portal = new PescPortal({ fetch: debt as unknown as typeof fetch });
    const r = await portal.run(makeDeps());
    expect(r.info?.balanceText).toBe('задолженность 42.50 руб');

    const zero = makeFetchMock({ bill: { amount: 0 }, metersBefore: [] });
    const portal2 = new PescPortal({ fetch: zero as unknown as typeof fetch });
    const r2 = await portal2.run(makeDeps());
    expect(r2.info?.balanceText).toBe('расчёты без долга');
  });
});

describe('PescPortal proxyUrl', () => {
  it('constructor with proxyUrl builds without throwing (ProxyAgent factory smoke test)', () => {
    expect(() => new PescPortal({ proxyUrl: 'http://127.0.0.1:7890' })).not.toThrow();
  });

  it('explicit fetch wins over proxyUrl (tests stay deterministic)', async () => {
    const fetchMock = makeFetchMock({ metersBefore: [] });
    const portal = new PescPortal({
      fetch: fetchMock as unknown as NonNullable<
        ConstructorParameters<typeof PescPortal>[0]
      >['fetch'],
      proxyUrl: 'http://does-not-exist.invalid:1',
    });
    // If the proxy URL had taken precedence we'd ECONNREFUSED here.
    await expect(portal.run(makeDeps())).resolves.toBeDefined();
  });
});

describe('generateTotp', () => {
  // RFC 6238 test vectors use a 20-byte ASCII key "12345678901234567890".
  // In base32 that is GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ.
  const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  it('matches RFC 6238 reference @ T=59 → 287082', () => {
    expect(generateTotp(SECRET, 59 * 1000)).toBe('287082');
  });

  it('matches RFC 6238 reference @ T=1111111109 → 081804', () => {
    expect(generateTotp(SECRET, 1111111109 * 1000)).toBe('081804');
  });

  it('tolerates spaces and lowercase in the secret', () => {
    expect(generateTotp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', 59 * 1000)).toBe('287082');
  });

  it('always returns 6 zero-padded digits', () => {
    const code = generateTotp(SECRET, Date.now());
    expect(code).toMatch(/^\d{6}$/);
  });
});
