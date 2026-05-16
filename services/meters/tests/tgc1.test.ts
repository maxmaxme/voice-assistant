import { describe, it, expect, vi } from 'vitest';
import { Tgc1Portal } from '../src/portals/tgc1.ts';
import type { PortalDeps } from '../src/portals/types.ts';

interface DeviceFixture {
  id: number;
  number: string;
  serviceName: string;
  lastReading: number;
  dtLastReading: string;
  enabled: boolean;
  requiredVerification?: boolean;
  verificationWarning?: boolean;
}

interface MockOptions {
  devicesBefore: DeviceFixture[];
  devicesAfter?: DeviceFixture[];
  debt?: { accountList: string[]; sm: number };
  loginResponse?: Response;
  debtResponse?: Response;
  deviceResponse?: Response;
  createResponse?: (body: { counterId: number; value: number }) => Response;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeFetchMock(opts: MockOptions): ReturnType<typeof vi.fn> {
  let deviceCallCount = 0;
  return vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.endsWith('/api/security/auth/login/fl') && method === 'POST') {
      return opts.loginResponse
        ? opts.loginResponse.clone()
        : jsonResponse({ accessToken: 'TOKEN', type: 'Bearer', refreshToken: 'R' });
    }

    if (url.endsWith('/api/fl/dashboard/debt') && method === 'GET') {
      if (opts.debtResponse) {
        return opts.debtResponse.clone();
      }
      return jsonResponse(opts.debt ?? { accountList: ['ACC'], sm: 0 });
    }

    if (url.endsWith('/api/fl/device') && method === 'GET') {
      deviceCallCount += 1;
      if (opts.deviceResponse) {
        return opts.deviceResponse.clone();
      }
      const list =
        deviceCallCount === 1 ? opts.devicesBefore : (opts.devicesAfter ?? opts.devicesBefore);
      return jsonResponse(list);
    }

    if (url.endsWith('/api/fl/device/create-reading') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { counterId: number; value: number };
      if (opts.createResponse) {
        return opts.createResponse(body);
      }
      return jsonResponse({});
    }

    return new Response('not found', { status: 404 });
  });
}

function makeDeps(overrides: Partial<PortalDeps> = {}): PortalDeps {
  return {
    login: 'u',
    password: 'p',
    lastSubmittedValueFor: () => null,
    today: () => new Date('2026-05-16T09:00:00Z'),
    ...overrides,
  };
}

const todayStr = '16.05.2026';

describe('Tgc1Portal.run — happy path', () => {
  it('logs in, fetches debt + devices, posts readings, verifies', async () => {
    const fetchMock = makeFetchMock({
      debt: { accountList: ['7060001472'], sm: -75.18 },
      devicesBefore: [
        {
          id: 1,
          number: 'M1',
          serviceName: 'ГВС м3',
          lastReading: 15.013,
          dtLastReading: '22.04.2026',
          enabled: true,
        },
        {
          id: 2,
          number: 'M2',
          serviceName: 'Отопление',
          lastReading: 10.54,
          dtLastReading: '22.04.2026',
          enabled: true,
        },
      ],
      devicesAfter: [
        {
          id: 1,
          number: 'M1',
          serviceName: 'ГВС м3',
          lastReading: 15.013,
          dtLastReading: todayStr,
          enabled: false,
        },
        {
          id: 2,
          number: 'M2',
          serviceName: 'Отопление',
          lastReading: 10.54,
          dtLastReading: todayStr,
          enabled: false,
        },
      ],
    });

    const portal = new Tgc1Portal({
      fetch: fetchMock as unknown as typeof fetch,
      verifyDelayMs: 0,
    });
    const out = await portal.run(makeDeps());

    expect(out.info).toEqual({ accountId: '7060001472', balanceText: 'переплата 75.18 руб' });
    expect(out.values).toEqual([
      { meter: 'M1', kind: 'ГВС м3', value: 15.013 },
      { meter: 'M2', kind: 'Отопление', value: 10.54 },
    ]);

    const postCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith('/api/fl/device/create-reading') && init?.method === 'POST',
    );
    expect(postCalls).toHaveLength(2);
    const bodies = postCalls.map(
      ([, init]) => JSON.parse(String(init?.body)) as { counterId: number; value: number },
    );
    expect(bodies).toContainEqual({ counterId: 1, value: 15.013 });
    expect(bodies).toContainEqual({ counterId: 2, value: 10.54 });
  });
});

describe('Tgc1Portal.run — balanceText formatting', () => {
  async function balanceFor(sm: number): Promise<string | null> {
    const fetchMock = makeFetchMock({
      debt: { accountList: ['ACC'], sm },
      devicesBefore: [
        {
          id: 1,
          number: 'M1',
          serviceName: 'X',
          lastReading: 1,
          dtLastReading: '22.04.2026',
          enabled: true,
        },
      ],
      devicesAfter: [
        {
          id: 1,
          number: 'M1',
          serviceName: 'X',
          lastReading: 1,
          dtLastReading: todayStr,
          enabled: false,
        },
      ],
    });
    const portal = new Tgc1Portal({
      fetch: fetchMock as unknown as typeof fetch,
      verifyDelayMs: 0,
    });
    const out = await portal.run(makeDeps());
    return out.info?.balanceText ?? null;
  }

  it('negative sm → переплата', async () => {
    expect(await balanceFor(-12.5)).toBe('переплата 12.50 руб');
  });

  it('positive sm → задолженность', async () => {
    expect(await balanceFor(100)).toBe('задолженность 100.00 руб');
  });

  it('zero sm → расчёты без долга', async () => {
    expect(await balanceFor(0)).toBe('расчёты без долга');
  });
});

describe('Tgc1Portal.run — enabled flag semantics', () => {
  it('treats enabled=false + dtLastReading==today as success (no POST)', async () => {
    const fetchMock = makeFetchMock({
      debt: { accountList: ['ACC'], sm: 0 },
      devicesBefore: [
        {
          id: 1,
          number: 'M1',
          serviceName: 'X',
          lastReading: 5,
          dtLastReading: todayStr,
          enabled: false,
        },
      ],
    });
    const portal = new Tgc1Portal({
      fetch: fetchMock as unknown as typeof fetch,
      verifyDelayMs: 0,
    });
    const out = await portal.run(makeDeps());
    expect(out.values).toEqual([{ meter: 'M1', kind: 'X', value: 5 }]);

    const posts = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith('/api/fl/device/create-reading') && init?.method === 'POST',
    );
    expect(posts).toHaveLength(0);
  });

  it('throws if enabled=false and dtLastReading is not today', async () => {
    const fetchMock = makeFetchMock({
      debt: { accountList: ['ACC'], sm: 0 },
      devicesBefore: [
        {
          id: 1,
          number: 'M1',
          serviceName: 'X',
          lastReading: 5,
          dtLastReading: '01.05.2026',
          enabled: false,
        },
      ],
    });
    const portal = new Tgc1Portal({
      fetch: fetchMock as unknown as typeof fetch,
      verifyDelayMs: 0,
    });
    await expect(portal.run(makeDeps())).rejects.toThrow(/not accepting/);
  });
});

describe('Tgc1Portal.run — cached prev mismatch', () => {
  it('throws before POSTing when cache disagrees with portal', async () => {
    const fetchMock = makeFetchMock({
      debt: { accountList: ['ACC'], sm: 0 },
      devicesBefore: [
        {
          id: 1,
          number: 'M1',
          serviceName: 'X',
          lastReading: 15.013,
          dtLastReading: '22.04.2026',
          enabled: true,
        },
      ],
    });
    const portal = new Tgc1Portal({
      fetch: fetchMock as unknown as typeof fetch,
      verifyDelayMs: 0,
    });
    await expect(
      portal.run(makeDeps({ lastSubmittedValueFor: (m) => (m === 'M1' ? 99 : null) })),
    ).rejects.toThrow(/Cached prev/);
    const posts = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/create-reading'));
    expect(posts).toHaveLength(0);
  });
});

describe('Tgc1Portal.run — error surfaces', () => {
  it('surfaces ApiError details when create-reading returns 400', async () => {
    const fetchMock = makeFetchMock({
      debt: { accountList: ['ACC'], sm: 0 },
      devicesBefore: [
        {
          id: 1,
          number: 'M1',
          serviceName: 'X',
          lastReading: 5,
          dtLastReading: '22.04.2026',
          enabled: true,
        },
      ],
      createResponse: () =>
        jsonResponse(
          {
            message: 'Validation Failed',
            details: [{ field: 'value', errorMessage: 'must be positive' }],
          },
          400,
        ),
    });
    const portal = new Tgc1Portal({
      fetch: fetchMock as unknown as typeof fetch,
      verifyDelayMs: 0,
    });
    await expect(portal.run(makeDeps())).rejects.toThrow(
      /HTTP 400: Validation Failed \(value=must be positive\)/,
    );
  });

  it('surfaces non-JSON 403 (WAF) verbatim', async () => {
    const fetchMock = makeFetchMock({
      devicesBefore: [],
      loginResponse: new Response('<html>Доступ запрещён</html>', { status: 403 }),
    });
    const portal = new Tgc1Portal({
      fetch: fetchMock as unknown as typeof fetch,
      verifyDelayMs: 0,
    });
    await expect(portal.run(makeDeps())).rejects.toThrow(/HTTP 403/);
  });

  it('throws when post succeeds but dtLastReading does not advance', async () => {
    const fetchMock = makeFetchMock({
      debt: { accountList: ['ACC'], sm: 0 },
      devicesBefore: [
        {
          id: 1,
          number: 'M1',
          serviceName: 'X',
          lastReading: 5,
          dtLastReading: '22.04.2026',
          enabled: true,
        },
      ],
      devicesAfter: [
        {
          id: 1,
          number: 'M1',
          serviceName: 'X',
          lastReading: 5,
          dtLastReading: '22.04.2026',
          enabled: true,
        },
      ],
    });
    const portal = new Tgc1Portal({
      fetch: fetchMock as unknown as typeof fetch,
      verifyDelayMs: 0,
    });
    await expect(portal.run(makeDeps())).rejects.toThrow(/dtLastReading after submit/);
  });
});

describe('Tgc1Portal.run — header contract', () => {
  it('sends UA / accept / origin / authorization on authenticated calls', async () => {
    const fetchMock = makeFetchMock({
      debt: { accountList: ['ACC'], sm: 0 },
      devicesBefore: [
        {
          id: 1,
          number: 'M1',
          serviceName: 'X',
          lastReading: 1,
          dtLastReading: todayStr,
          enabled: false,
        },
      ],
    });
    const portal = new Tgc1Portal({
      fetch: fetchMock as unknown as typeof fetch,
      verifyDelayMs: 0,
    });
    await portal.run(makeDeps());

    const debtCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/api/fl/dashboard/debt'),
    );
    expect(debtCall).toBeDefined();
    const headers = (debtCall?.[1] as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.authorization).toBe('Bearer TOKEN');
    expect(headers?.accept).toBe('application/json');
    expect(headers?.origin).toBe('https://lk.tgc1.ru');
    expect(headers?.['user-agent']).toMatch(/Chrome\/138/);
  });
});
