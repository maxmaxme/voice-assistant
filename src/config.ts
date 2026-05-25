import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  ha: z.object({
    url: z.string().url(),
    token: z.string().min(1),
  }),
  openai: z.object({
    apiKey: z.string().min(1),
    model: z.string().default('gpt-4o'),
    reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).default('low'),
  }),
  memory: z.object({
    dbPath: z.string().default('data/assistant.db'),
  }),
  telegram: z.object({
    botToken: z.string().min(1),
    chatId: z.string().min(1),
    allowedChatIds: z.array(z.number().int()).default([]),
  }),
  http: z.object({
    apiKeys: z.array(z.string()).min(1),
  }),
  realtime: z.object({
    enabled: z.boolean().default(false),
    port: z.coerce.number().int().min(1).max(65535).default(3001),
    token: z.string().default(''),
    model: z.string().default('gpt-realtime-2'),
    voice: z.string().default('marin'),
    reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).default('low'),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

const PATH_TO_ENV: Record<string, string> = {
  'ha.url': 'HA_URL',
  'ha.token': 'HA_TOKEN',
  'openai.apiKey': 'OPENAI_API_KEY',
  'openai.model': 'OPENAI_MODEL',
  'openai.reasoningEffort': 'OPENAI_REASONING_EFFORT',
  'memory.dbPath': 'MEMORY_DB_PATH',
  'telegram.botToken': 'TELEGRAM_BOT_TOKEN',
  'telegram.chatId': 'TELEGRAM_CHAT_ID',
  'telegram.allowedChatIds': 'TELEGRAM_ALLOWED_CHAT_IDS',
  'http.apiKeys': 'HTTP_API_KEYS',
  'realtime.enabled': 'REALTIME_ENABLED',
  'realtime.port': 'REALTIME_PORT',
  'realtime.token': 'VA_DEVICE_TOKEN',
  'realtime.model': 'OPENAI_REALTIME_MODEL',
  'realtime.voice': 'OPENAI_REALTIME_VOICE',
  'realtime.reasoningEffort': 'OPENAI_REALTIME_REASONING_EFFORT',
};

export function loadConfig(): Config {
  const allowedRaw = process.env.TELEGRAM_ALLOWED_CHAT_IDS;
  const allowedChatIds = allowedRaw
    ? allowedRaw.split(',').map((s) => {
        const n = Number(s.trim());
        if (!Number.isFinite(n)) {
          throw new Error(`TELEGRAM_ALLOWED_CHAT_IDS: not a number: ${s}`);
        }
        return n;
      })
    : undefined;

  const apiKeysRaw = process.env.HTTP_API_KEYS;
  const apiKeys = apiKeysRaw
    ? apiKeysRaw
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k.length > 0)
    : [];

  const raw = {
    ha: {
      url: process.env.HA_URL,
      token: process.env.HA_TOKEN,
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL,
      reasoningEffort: process.env.OPENAI_REASONING_EFFORT,
    },
    memory: {
      dbPath: process.env.MEMORY_DB_PATH,
    },
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
      allowedChatIds,
    },
    http: {
      apiKeys,
    },
    realtime: {
      enabled: process.env.REALTIME_ENABLED === '1',
      port: process.env.REALTIME_PORT,
      token: process.env.VA_DEVICE_TOKEN,
      model: process.env.OPENAI_REALTIME_MODEL,
      voice: process.env.OPENAI_REALTIME_VOICE,
      reasoningEffort: process.env.OPENAI_REALTIME_REASONING_EFFORT,
    },
  };
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((i) => {
        const path = i.path.join('.');
        const envName = PATH_TO_ENV[path] ?? path;
        return `${envName} (${path})`;
      })
      .join(', ');
    throw new Error(`Invalid config: ${fields}: ${parsed.error.message}`);
  }
  const data = parsed.data;
  if (data.realtime.enabled && !data.realtime.token) {
    throw new Error('REALTIME_ENABLED=1 but VA_DEVICE_TOKEN is empty');
  }
  if (data.telegram.allowedChatIds.length === 0) {
    const fromChat = Number(data.telegram.chatId);
    data.telegram.allowedChatIds = Number.isFinite(fromChat) ? [fromChat] : [];
  }
  return data;
}
