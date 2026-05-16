import { parseArgs } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOnce } from './runOnce.ts';
import { openSubmissionsStore } from './storage/sqlite.ts';
import { TelegramNotifier } from './notify/telegram.ts';
import { Tgc1Portal } from './portals/tgc1.ts';
import { PescPortal } from './portals/pesc.ts';
import { createLogger } from './logger.ts';
import type { Portal } from './portals/types.ts';

const log = createLogger('index');

// Auto-load .env when running outside the container. In production the file
// is injected by docker-compose's `env_file`, so the lookups below are
// no-ops — but they save `set -a; source .env; set +a` dance locally.
// Uses Node 24's built-in `process.loadEnvFile()` — no dependency.
loadEnvIfPresent();

function loadEnvIfPresent(): void {
  // src/index.ts → services/meters/.env, repo-root/.env (in that order).
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, '..', '.env'), join(here, '..', '..', '..', '.env')];
  for (const p of candidates) {
    try {
      process.loadEnvFile(p);
    } catch {
      // File missing or unreadable — fine, fall through.
    }
  }
}

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
      portal: { type: 'string' },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(`Usage: node src/index.ts [--portal=tgc1|pesc] [--force]

Options:
  --portal=NAME   Drive only the named portal. If omitted, every portal with
                  a configured *_LOGIN env is driven in order.
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

  const allPortals: Portal[] = [];
  if (process.env.TGC1_LOGIN !== undefined && process.env.TGC1_LOGIN !== '') {
    allPortals.push(new Tgc1Portal());
  }
  if (process.env.PESC_LOGIN !== undefined && process.env.PESC_LOGIN !== '') {
    allPortals.push(
      new PescPortal({
        totpSecret: process.env.PESC_TOTP_SECRET,
        proxyUrl: process.env.PESC_PROXY_URL,
      }),
    );
  }

  const portals =
    values.portal === undefined ? allPortals : allPortals.filter((p) => p.name === values.portal);
  if (portals.length === 0) {
    throw new Error(
      values.portal === undefined
        ? 'No portals enabled — set TGC1_LOGIN and/or PESC_LOGIN'
        : `Portal not enabled or unknown: ${values.portal}`,
    );
  }

  try {
    await runOnce({
      store,
      notifier,
      portals,
      portalDepsFor: (name) => {
        if (name === 'tgc1') {
          return {
            login: env('TGC1_LOGIN'),
            password: env('TGC1_PASSWORD'),
            lastSubmittedValueFor: (meter) => store.lastSubmittedValueFor('tgc1', meter),
            today: () => new Date(),
          };
        }
        if (name === 'pesc') {
          return {
            login: env('PESC_LOGIN'),
            password: env('PESC_PASSWORD'),
            lastSubmittedValueFor: (meter) => store.lastSubmittedValueFor('pesc', meter),
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
