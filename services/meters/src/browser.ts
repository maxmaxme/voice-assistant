import { chromium, type Browser, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from './logger.ts';

const log = createLogger('browser');

export interface BrowserOptions {
  proxyUrl: string; // e.g. socks5://sing-box-ru:1080
  headed: boolean;
  screenshotDir: string;
}

export interface BrowserSession {
  page: Page;
  screenshotOnFailure(label: string): Promise<string | null>;
}

export async function withBrowser<T>(
  opts: BrowserOptions,
  fn: (sess: BrowserSession) => Promise<T>,
): Promise<T> {
  await mkdir(opts.screenshotDir, { recursive: true });

  const browser: Browser = await chromium.launch({
    headless: !opts.headed,
    proxy: { server: opts.proxyUrl },
  });
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: 'ru-RU',
  });
  const page = await ctx.newPage();

  const sess: BrowserSession = {
    page,
    async screenshotOnFailure(label) {
      try {
        const path = join(opts.screenshotDir, `${label}-${Date.now()}.png`);
        await page.screenshot({ path, fullPage: true });
        return path;
      } catch (err) {
        log.warn({ err }, 'screenshotOnFailure failed');
        return null;
      }
    },
  };

  try {
    return await fn(sess);
  } finally {
    await browser.close().catch(() => undefined);
  }
}
