import { createHmac } from 'node:crypto';
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { AccountInfo, MeterReading } from '../storage/types.ts';
import type { Portal, PortalDeps } from './types.ts';
import { createLogger } from '../logger.ts';

/**
 * Minimal fetch contract that both the global Node 24 fetch and undici's
 * fetch satisfy structurally. Letting us swap in a proxied undici fetch
 * for the pesc portal without dragging through the (subtly different)
 * lib.dom Response/ReadableStream type hierarchies.
 */
interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  readonly headers: {
    get(name: string): string | null;
    getSetCookie?(): string[];
  };
}
type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};
type FetchImpl = (input: string, init?: FetchInit) => Promise<FetchResponse>;

const log = createLogger('portal:pesc');

const BASE = 'https://ikus.pesc.ru';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36';

const COOKIE_NAME = 'session-cookie';
const CUSTOMER = 'ikus-spb';
const VERIFY_DELAY_MS = 1500;
const INTEGER_INCREMENT = 1;
const DEFAULT_DECIMALS = 3;

interface AccountGroupDto {
  id: number;
  name?: string;
  accounts: number[];
}

interface BillDto {
  amount?: number;
  id?: string;
}

interface MeterDto {
  id: { registration: string };
  name?: string;
  subserviceId?: number;
  /** Number of decimal places the meter supports (0 for whole-unit meters
   * like electricity in kWh, 3 for water/heat). */
  numberOfDigitsRight?: number;
  indications: IndicationDto[];
}

interface IndicationDto {
  meterScaleId: number;
  scaleName?: string;
  previousReading?: number;
  previousReadingDate?: string;
  unit?: string;
}

interface AuthDto {
  auth?: string;
}

interface TwoFactorDto {
  transactionId?: string;
  types?: string[];
}

// ─── Portal options ─────────────────────────────────────────────────────────

export interface PescOptions {
  fetch?: FetchImpl;
  verifyDelayMs?: number;
  /**
   * Base32 TOTP shared secret captured from pesc.ru security settings.
   * When provided, the portal handles the HTTP 424 2FA challenge fully
   * unattended: generates an RFC 6238 6-digit code and POSTs it to the
   * `/dfa/{txId}/totp/verify` endpoint. Without this, 2FA-enabled accounts
   * cannot be driven by the bot.
   */
  totpSecret?: string;
  /**
   * HTTP CONNECT proxy URL (e.g. `http://sing-box-ru:7890`). When set,
   * every fetch in this portal is routed via an undici ProxyAgent — pesc
   * geo-blocks non-RU IPs, so on Pi we tunnel only the pesc-portal
   * traffic through a sidecar sing-box container. The tgc1 portal is
   * unaffected.
   */
  proxyUrl?: string;
  /**
   * Overridable clock for TOTP code generation — tests only.
   */
  now?: () => number;
}

export class PescPortal implements Portal {
  readonly name = 'pesc' as const;
  private readonly fetchImpl: FetchImpl;
  private readonly verifyDelayMs: number;
  private readonly totpSecret: string | undefined;
  private readonly nowFn: () => number;

  constructor(opts: PescOptions = {}) {
    this.verifyDelayMs = opts.verifyDelayMs ?? VERIFY_DELAY_MS;
    this.totpSecret = opts.totpSecret;
    this.nowFn = opts.now ?? Date.now;

    if (opts.fetch !== undefined) {
      // Test/custom fetch — proxyUrl is ignored, the caller provides their
      // own transport.
      this.fetchImpl = opts.fetch;
    } else if (opts.proxyUrl !== undefined && opts.proxyUrl !== '') {
      // Route every fetch in this portal through the configured HTTP proxy.
      // We pin the dispatcher onto each request rather than calling
      // setGlobalDispatcher — keeps the tgc1 portal and the notifier on the
      // direct default dispatcher.
      const dispatcher: Dispatcher = new ProxyAgent({ uri: opts.proxyUrl });
      this.fetchImpl = (input, init) => undiciFetch(input, { ...init, dispatcher });
    } else {
      this.fetchImpl = (input, init) => undiciFetch(input, init);
    }
  }

  async run(deps: PortalDeps): Promise<{
    info: AccountInfo | null;
    values: MeterReading[];
    alreadySubmitted: boolean;
  }> {
    log.debug({ base: BASE }, 'fetching session cookie');
    const cookie = await this.fetchSessionCookie();
    log.debug(
      {
        cookieLen: cookie.length,
        totpConfigured: this.totpSecret !== undefined && this.totpSecret !== '',
      },
      'cookie acquired, logging in',
    );
    const bearer = await this.login(cookie, deps.login, deps.password);
    log.debug({ bearerLen: bearer.length }, 'login ok, fetching account groups');

    const accountId = await this.fetchFirstAccountId(cookie, bearer);
    log.debug({ accountId }, 'resolved account id');

    const info = await this.fetchAccountInfo(cookie, bearer, accountId);
    log.debug({ info }, 'account info');
    const meters = await this.fetchMeters(cookie, bearer, accountId);
    log.debug({ count: meters.length, meters }, 'meters/info response');

    const submitted: MeterReading[] = [];

    for (const meter of meters) {
      if (meter.indications.length === 0) {
        log.warn({ meter: meter.id.registration }, 'meter has no indications, skipping');
        continue;
      }

      // numberOfDigitsRight tells us the meter's decimal precision:
      // 0 = whole units (electricity in kWh), 3 = thousandths (water m³).
      // pesc rejects same-as-prev readings, so we bump by the smallest
      // legal step the meter can express — that's 10^-decimals for
      // fractional meters and 1 for integer-only ones.
      const decimals = meter.numberOfDigitsRight ?? DEFAULT_DECIMALS;
      const step = decimals === 0 ? INTEGER_INCREMENT : Math.pow(10, -decimals);

      const payload: Array<{ scaleId: number; value: number }> = [];

      for (const ind of meter.indications) {
        const key = `${meter.id.registration}:${String(ind.meterScaleId)}`;
        const portalPrev = ind.previousReading ?? 0;
        const stored = deps.lastSubmittedValueFor(key);

        // Guard against the portal silently regressing or our stored copy
        // being ahead. Take the higher of the two as the base.
        const base = Math.max(portalPrev, stored ?? 0);
        const value = round(base + step, decimals);

        payload.push({ scaleId: ind.meterScaleId, value });
        submitted.push({
          meter: key,
          kind: ind.scaleName ?? meter.name ?? 'unknown',
          value,
        });
      }

      await this.submitReading(cookie, bearer, accountId, meter.id.registration, payload);
      log.info({ meter: meter.id.registration, scales: payload.length }, 'reading submitted');
    }

    // Verify by re-fetching meters/info and checking that previousReading
    // advanced for every scale we just posted.
    if (submitted.length > 0) {
      await sleep(this.verifyDelayMs);
      const after = await this.fetchMeters(cookie, bearer, accountId);
      for (const reading of submitted) {
        const [regStr, scaleStr] = reading.meter.split(':');
        const scaleId = Number(scaleStr);
        const m = after.find((x) => x.id.registration === regStr);
        const ind = m?.indications.find((i) => i.meterScaleId === scaleId);
        if (ind === undefined) {
          throw new Error(`Meter ${reading.meter} disappeared after submit`);
        }
        const actual = ind.previousReading ?? 0;
        if (Math.abs(actual - reading.value) > 0.0001) {
          throw new Error(
            `Meter ${reading.meter}: previousReading after submit is ${String(actual)}, expected ${String(reading.value)}`,
          );
        }
      }
    }

    return { info, values: submitted, alreadySubmitted: false };
  }

  // ─── HTTP helpers ─────────────────────────────────────────────────────────

  private async fetchSessionCookie(): Promise<string> {
    const res = await this.fetchImpl(`${BASE}/api/v6/users/manual/existence`, {
      method: 'GET',
      headers: {
        'user-agent': UA,
        accept: 'application/json, text/plain, */*',
        customer: CUSTOMER,
      },
    });
    if (!res.ok) {
      throw new Error(`GET /v6/users/manual/existence → HTTP ${String(res.status)}`);
    }
    const cookie = extractCookieValue(res.headers, COOKIE_NAME);
    if (cookie === undefined) {
      throw new Error(`Set-Cookie missing ${COOKIE_NAME} after GET existence`);
    }
    return cookie;
  }

  private async login(cookie: string, username: string, password: string): Promise<string> {
    const res = await this.fetchImpl(`${BASE}/api/v8/users/auth`, {
      method: 'POST',
      headers: {
        ...this.headers(cookie, undefined, true),
        withtotp: 'true',
        captcha: 'none',
      },
      body: JSON.stringify({ type: 'PHONE', login: username, password }),
    });
    const text = await res.text();

    if (res.status === 424) {
      const parsed = tryParseJson<TwoFactorDto>(text);
      const txId = parsed?.transactionId;
      const types = parsed?.types ?? [];
      if (txId === undefined) {
        throw new Error(`2FA required but transactionId missing: ${text.slice(0, 200)}`);
      }
      if (!types.includes('TOTP')) {
        throw new Error(
          `2FA required on pesc.ru (types=${types.join(',')}). Only TOTP is supported by this bot; enable TOTP in account settings.`,
        );
      }
      if (this.totpSecret === undefined || this.totpSecret === '') {
        throw new Error(
          '2FA required on pesc.ru and TOTP is offered, but PESC_TOTP_SECRET is not configured.',
        );
      }
      log.debug({ txId }, '2FA challenge: solving via TOTP');
      return this.solveTotp(cookie, txId);
    }

    if (!res.ok) {
      throw new Error(`POST /v8/users/auth → HTTP ${String(res.status)}: ${text.slice(0, 200)}`);
    }
    const parsed = parseJson<AuthDto>(text);
    if (parsed.auth === undefined || parsed.auth === '') {
      throw new Error('POST /v8/users/auth: response missing "auth" token');
    }
    return parsed.auth;
  }

  private async solveTotp(cookie: string, transactionId: string): Promise<string> {
    if (this.totpSecret === undefined) {
      throw new Error('solveTotp called without totpSecret — guarded above');
    }
    const code = generateTotp(this.totpSecret, this.nowFn());
    const path = `/api/v1/dfa/${transactionId}/totp/verify`;
    const res = await this.fetchImpl(`${BASE}${path}`, {
      method: 'POST',
      headers: this.headers(cookie, undefined, true),
      body: JSON.stringify({ code }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`POST ${path} → HTTP ${String(res.status)}: ${text.slice(0, 200)}`);
    }
    const parsed = parseJson<AuthDto>(text);
    if (parsed.auth === undefined || parsed.auth === '') {
      throw new Error(`POST ${path}: response missing "auth" token`);
    }
    return parsed.auth;
  }

  private async fetchFirstAccountId(cookie: string, bearer: string): Promise<number> {
    const groups = await this.getJson<AccountGroupDto[]>('/api/v6/accounts/groups', cookie, bearer);
    for (const g of groups) {
      if (g.accounts.length > 0) {
        return g.accounts[0];
      }
    }
    throw new Error('No accounts found in any group on pesc.ru');
  }

  private async fetchAccountInfo(
    cookie: string,
    bearer: string,
    accountId: number,
  ): Promise<AccountInfo | null> {
    const path = `/api/v7/accounts/${String(accountId)}/payments/at/current/amount/discretion`;
    let bill: BillDto;
    try {
      bill = await this.getJson<BillDto>(path, cookie, bearer);
    } catch (err) {
      log.warn({ err: readMessage(err) }, 'failed to fetch bill amount, leaving info null');
      return null;
    }
    const amount = bill.amount ?? 0;
    const balanceText =
      amount < 0
        ? `переплата ${Math.abs(amount).toFixed(2)} руб`
        : amount > 0
          ? `задолженность ${amount.toFixed(2)} руб`
          : 'расчёты без долга';
    return { accountId: String(accountId), balanceText };
  }

  private async fetchMeters(
    cookie: string,
    bearer: string,
    accountId: number,
  ): Promise<MeterDto[]> {
    const path = `/api/v6/accounts/${String(accountId)}/meters/info`;
    return this.getJson<MeterDto[]>(path, cookie, bearer);
  }

  private async submitReading(
    cookie: string,
    bearer: string,
    accountId: number,
    registration: string,
    payload: Array<{ scaleId: number; value: number }>,
  ): Promise<void> {
    const path = `/api/v8/accounts/${String(accountId)}/meters/${registration}/reading`;
    const res = await this.fetchImpl(`${BASE}${path}`, {
      method: 'POST',
      headers: this.headers(cookie, bearer, true),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`POST ${path} → HTTP ${String(res.status)}: ${text.slice(0, 200)}`);
    }
  }

  private async getJson<T>(path: string, cookie: string, bearer: string): Promise<T> {
    const res = await this.fetchImpl(`${BASE}${path}`, {
      method: 'GET',
      headers: this.headers(cookie, bearer, false),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GET ${path} → HTTP ${String(res.status)}: ${text.slice(0, 200)}`);
    }
    return parseJson<T>(text);
  }

  private headers(
    cookie: string,
    bearer: string | undefined,
    json: boolean,
  ): Record<string, string> {
    const h: Record<string, string> = {
      cookie: `${COOKIE_NAME}=${cookie}`,
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      customer: CUSTOMER,
    };
    if (bearer !== undefined) {
      h.authorization = `Bearer ${bearer}`;
    }
    if (json) {
      h['content-type'] = 'application/json';
    }
    return h;
  }
}

// ─── Stand-alone helpers ────────────────────────────────────────────────────

function extractCookieValue(headers: FetchResponse['headers'], name: string): string | undefined {
  // Node 24 exposes Headers#getSetCookie() which returns each Set-Cookie line
  // separately, unlike the legacy single-string concat from headers.get().
  const lines =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (headers.get('set-cookie') ?? '').split(/,\s*(?=[\w-]+=)/);
  for (const line of lines) {
    const match = /^([^=]+)=([^;]*)/.exec(line);
    if (match && match[1] === name) {
      return match[2];
    }
  }
  return undefined;
}

function parseJson<T>(text: string): T {
  return JSON.parse(text);
}

function tryParseJson<T>(text: string): T | undefined {
  try {
    return parseJson<T>(text);
  } catch {
    return undefined;
  }
}

function readMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function round(n: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── TOTP (RFC 6238, HMAC-SHA1, 30 s period, 6 digits) ─────────────────────

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotp(secretBase32: string, nowMs: number): string {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(nowMs / 1000 / 30);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(counterBuf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const truncated =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(truncated % 1_000_000).padStart(6, '0');
}

function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (cleaned.length === 0) {
    throw new Error('TOTP secret is empty after normalisation');
  }
  let bits = '';
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}
