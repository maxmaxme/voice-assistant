import type { AccountInfo, MeterReading } from '../storage/types.ts';
import type { Portal, PortalDeps } from './types.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('portal:tgc1');

const BASE = 'https://lk.tgc1.ru';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36';

const VERIFY_DELAY_MS = 1500;

interface DeviceDto {
  id: number;
  number: string;
  serviceName: string;
  lastReading: number;
  dtLastReading: string;
  enabled: boolean;
  requiredVerification?: boolean;
  verificationWarning?: boolean;
  personalAccountNumber?: string;
}

interface DebtDto {
  accountList: string[];
  sm: number;
}

interface LoginDto {
  accessToken: string;
  type: 'Bearer';
  refreshToken: string;
}

interface ApiError {
  message?: string;
  details?: Array<{ field: string | null; errorMessage: string }>;
}

export interface Tgc1Options {
  fetch?: typeof fetch;
  verifyDelayMs?: number;
}

export class Tgc1Portal implements Portal {
  readonly name = 'tgc1' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly verifyDelayMs: number;

  constructor(opts: Tgc1Options = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.verifyDelayMs = opts.verifyDelayMs ?? VERIFY_DELAY_MS;
  }

  async run(deps: PortalDeps): Promise<{
    info: AccountInfo | null;
    values: MeterReading[];
    alreadySubmitted: boolean;
  }> {
    const token = await this.login(deps.login, deps.password);
    const info = await this.fetchAccountInfo(token);
    const devices = await this.fetchDevices(token);

    if (devices.length === 0) {
      throw new Error('No counters on the account');
    }

    const todayStr = todayDdMmYyyy(deps.today());
    const submitted: MeterReading[] = [];
    const newlyPosted: number[] = [];

    for (const d of devices) {
      const cached = deps.lastSubmittedValueFor(d.number);
      if (cached !== null && Math.abs(cached - d.lastReading) > 0.001) {
        throw new Error(
          `Cached prev (${String(cached)}) for meter ${d.number} differs from portal (${String(d.lastReading)}) — refuse to submit`,
        );
      }

      if (d.verificationWarning || d.requiredVerification) {
        log.warn(
          {
            meter: d.number,
            requiredVerification: d.requiredVerification,
            verificationWarning: d.verificationWarning,
          },
          'meter has verification warning, proceeding anyway',
        );
      }

      if (!d.enabled) {
        if (d.dtLastReading === todayStr) {
          log.info({ meter: d.number }, 'already submitted today, treating as success');
          submitted.push({ meter: d.number, kind: d.serviceName, value: d.lastReading });
          continue;
        }
        throw new Error(
          `Meter ${d.number} not accepting readings (enabled=false, dtLastReading=${d.dtLastReading})`,
        );
      }

      await this.createReading(token, d.id, d.lastReading);
      log.info({ meter: d.number, value: d.lastReading }, 'meter submitted');
      submitted.push({ meter: d.number, kind: d.serviceName, value: d.lastReading });
      newlyPosted.push(d.id);
    }

    if (newlyPosted.length > 0) {
      await sleep(this.verifyDelayMs);
      const after = await this.fetchDevices(token);
      for (const id of newlyPosted) {
        const a = after.find((x) => x.id === id);
        if (!a) {
          throw new Error(`Meter id=${String(id)} disappeared after submit`);
        }
        if (a.dtLastReading !== todayStr) {
          throw new Error(
            `Meter ${a.number}: dtLastReading after submit is ${a.dtLastReading}, expected ${todayStr}`,
          );
        }
      }
    }

    return { info, values: submitted, alreadySubmitted: newlyPosted.length === 0 };
  }

  private async login(username: string, password: string): Promise<string> {
    const body = await this.json<LoginDto>(
      'POST',
      '/api/security/auth/login/fl',
      undefined,
      { username, password },
      '/fl/login',
    );
    return body.accessToken;
  }

  private async fetchAccountInfo(token: string): Promise<AccountInfo | null> {
    const body = await this.json<DebtDto>(
      'GET',
      '/api/fl/dashboard/debt',
      token,
      undefined,
      '/fl/',
    );
    if (!body.accountList || body.accountList.length === 0) {
      return null;
    }
    const sm = body.sm;
    const balanceText =
      sm < 0
        ? `переплата ${Math.abs(sm).toFixed(2)} руб`
        : sm > 0
          ? `задолженность ${sm.toFixed(2)} руб`
          : 'расчёты без долга';
    return { accountId: body.accountList.join(', '), balanceText };
  }

  private async fetchDevices(token: string): Promise<DeviceDto[]> {
    return this.json<DeviceDto[]>('GET', '/api/fl/device', token, undefined, '/fl/readings');
  }

  private async createReading(token: string, counterId: number, value: number): Promise<void> {
    await this.json<unknown>(
      'POST',
      '/api/fl/device/create-reading',
      token,
      { counterId, value },
      '/fl/readings',
    );
  }

  private async json<T>(
    method: 'GET' | 'POST',
    path: string,
    token: string | undefined,
    body: unknown,
    referer: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      'user-agent': UA,
      accept: 'application/json',
      origin: BASE,
      referer: BASE + referer,
    };
    if (token !== undefined) {
      headers.authorization = `Bearer ${token}`;
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const res = await this.fetchImpl(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) {
      const parsed = tryParseApiError(text);
      const detail = parsed?.details?.map((d) => `${d.field ?? '?'}=${d.errorMessage}`).join(', ');
      const msg = parsed?.message ?? text.slice(0, 200);
      const suffix = detail !== undefined && detail.length > 0 ? ` (${detail})` : '';
      throw new Error(`${method} ${path} → HTTP ${String(res.status)}: ${msg}${suffix}`);
    }

    if (text.length === 0) {
      return parseJson<T>('{}');
    }
    return parseJson<T>(text);
  }
}

function parseJson<T>(text: string): T {
  // JSON.parse returns `any`; the call-site type parameter narrows it.
  return JSON.parse(text);
}

function tryParseApiError(text: string): ApiError | undefined {
  try {
    return parseJson<ApiError>(text);
  } catch {
    return undefined;
  }
}

function todayDdMmYyyy(today: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(today);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
