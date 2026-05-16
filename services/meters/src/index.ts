import { parseArgs } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runOnce } from './runOnce.ts';
import { openSubmissionsStore } from './storage/sqlite.ts';
import { TelegramNotifier } from './notify/telegram.ts';
import { Tgc1Portal } from './portals/tgc1.ts';
import { withBrowser } from './browser.ts';
import { createLogger } from './logger.ts';
import type { Portal } from './portals/types.ts';

const log = createLogger('index');

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      portal: { type: 'string', default: 'tgc1' },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(`Usage: node src/index.ts [--portal=tgc1] [--force]

Options:
  --portal=NAME   Which portal to drive (default: tgc1).
  --force         Ignore the targetDay gate and the done/blocked row status.
                  Still respects the per-period attempts cap.
`);
    return;
  }

  const dataDir = env('METERS_DATA_DIR', '/app/data');
  await mkdir(dataDir, { recursive: true });

  const store = openSubmissionsStore(join(dataDir, 'meters.sqlite'));
  const notifier = new TelegramNotifier({
    token: env('TELEGRAM_BOT_TOKEN'),
    chatId: env('TELEGRAM_CHAT_ID'),
  });

  const tgc1 = new Tgc1Portal();
  const allPortals: Portal[] = [tgc1];
  const portals = allPortals.filter((p) => p.name === values.portal);
  if (portals.length === 0) {
    throw new Error(`Unknown portal: ${values.portal}`);
  }

  const proxyUrl = env('PROXY_URL', 'socks5://sing-box-ru:1080');
  const screenshotDir = join(dataDir, 'screenshots');
  const headed = env('METERS_HEADED', '0') === '1';

  try {
    await runOnce({
      store,
      notifier,
      portals,
      withPage: (_unused, fn) =>
        withBrowser({ proxyUrl, headed, screenshotDir }, (sess) =>
          fn({ page: sess.page, screenshotOnFailure: sess.screenshotOnFailure }),
        ),
      portalDepsFor: (name) => {
        if (name === 'tgc1') {
          return {
            login: env('TGC1_LOGIN'),
            password: env('TGC1_PASSWORD'),
            lastSubmittedValueFor: (meter) => store.lastSubmittedValueFor('tgc1', meter),
            today: () => new Date(),
          };
        }
        throw new Error(`No deps configured for portal: ${name}`);
      },
      now: new Date(),
      force: values.force,
    });
  } finally {
    store.close();
  }
}

main().catch((err) => {
  log.error({ err }, 'fatal');
  process.exit(1);
});
