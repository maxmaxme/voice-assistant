import type { Page } from 'playwright';
import type { AccountInfo, MeterReading } from '../storage/types.ts';
import type { Portal, PortalDeps } from './types.ts';
import { parseBalance, parseMeterCards } from './tgc1.dom.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('portal:tgc1');

const BASE = 'https://lk.tgc1.ru';
const LOGIN_URL = `${BASE}/fl/login`;
const HOME_URL = `${BASE}/fl`;
const READINGS_URL = `${BASE}/fl/readings`;

function todayDdMmYyyy(today: Date): string {
  const fmt = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  return fmt.format(today);
}

export class Tgc1Portal implements Portal {
  readonly name = 'tgc1' as const;

  async fetchAccountInfo(page: Page): Promise<AccountInfo | null> {
    if (!page.url().startsWith(HOME_URL)) {
      await page.goto(HOME_URL, { waitUntil: 'networkidle' });
    }
    const html = await page.content();
    return parseBalance(html);
  }

  async submit(page: Page, deps: PortalDeps): Promise<MeterReading[]> {
    await this.login(page, deps.login, deps.password);

    await page.goto(READINGS_URL, { waitUntil: 'networkidle' });
    const cards = parseMeterCards(await page.content());
    if (cards.length === 0) {
      throw new Error('No meter cards found on /fl/readings');
    }

    const result: MeterReading[] = [];
    const todayStr = todayDdMmYyyy(deps.today());

    for (const card of cards) {
      const cached = deps.lastSubmittedValueFor(card.meter);
      if (cached !== null && Math.abs(cached - card.lastValue) > 0.001) {
        throw new Error(
          `Cached prev (${cached}) for meter ${card.meter} differs from portal prev (${card.lastValue}) — refuse to submit`,
        );
      }

      const cardLocator = page.locator(`article.meter-card[data-meter="${card.meter}"]`);
      await cardLocator.locator('input[name="value"]').fill(String(card.lastValue));
      await Promise.all([
        page.waitForLoadState('networkidle'),
        cardLocator.getByRole('button', { name: /ДОБАВИТЬ/i }).click(),
      ]);

      // re-read after submit
      const after = parseMeterCards(await page.content()).find((c) => c.meter === card.meter);
      if (!after) {
        throw new Error(`Meter ${card.meter} disappeared after submit`);
      }
      if (after.lastDate !== todayStr) {
        throw new Error(
          `Meter ${card.meter}: lastDate after submit is ${after.lastDate}, expected ${todayStr}`,
        );
      }

      log.info({ meter: card.meter, value: card.lastValue }, 'meter submitted');
      result.push({ meter: card.meter, kind: card.kind, value: card.lastValue });
    }

    return result;
  }

  private async login(page: Page, login: string, password: string): Promise<void> {
    if (page.url().startsWith(HOME_URL)) {
      return;
    }
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
    await page.getByLabel(/логин|email|телефон/i).fill(login);
    await page.getByLabel(/пароль/i).fill(password);
    await Promise.all([
      page.waitForURL((url) => url.toString().startsWith(HOME_URL), { timeout: 15_000 }),
      page.getByRole('button', { name: /войти/i }).click(),
    ]);
  }
}
