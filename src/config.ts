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
  wakeWord: z.object({
    pythonPath: z.string().default('.venv/bin/python'),
    scriptPath: z.string().default('scripts/wake_word_daemon.py'),
    keyword: z.string().default('hey_jarvis'),
    threshold: z.coerce.number().min(0).max(1).default(0.5),
    debug: z
      .union([z.string(), z.boolean()])
      .default(false)
      .transform((v) => v === true || v === '1' || v === 'true'),
    followUp: z
      .union([z.string(), z.boolean()])
      .default(false)
      .transform((v) => v === true || v === '1' || v === 'true'),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

const PATH_TO_ENV: Record<string, string> = {
  'ha.url': 'HA_URL',
  'ha.token': 'HA_TOKEN',
  'openai.apiKey': 'OPENAI_API_KEY',
  'openai.model': 'OPENAI_MODEL',
  'memory.dbPath': 'MEMORY_DB_PATH',
  'telegram.botToken': 'TELEGRAM_BOT_TOKEN',
  'telegram.chatId': 'TELEGRAM_CHAT_ID',
  'telegram.allowedChatIds': 'TELEGRAM_ALLOWED_CHAT_IDS',
  'http.apiKeys': 'HTTP_API_KEYS',
  'wakeWord.pythonPath': 'WAKE_WORD_PYTHON',
  'wakeWord.scriptPath': 'WAKE_WORD_SCRIPT',
  'wakeWord.keyword': 'WAKE_WORD_KEYWORD',
  'wakeWord.threshold': 'WAKE_WORD_THRESHOLD',
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
    wakeWord: {
      pythonPath: process.env.WAKE_WORD_PYTHON,
      scriptPath: process.env.WAKE_WORD_SCRIPT,
      keyword: process.env.WAKE_WORD_KEYWORD,
      threshold: process.env.WAKE_WORD_THRESHOLD,
      debug: process.env.WAKE_WORD_DEBUG,
      followUp: process.env.WAKE_WORD_FOLLOWUP,
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
  if (data.telegram.allowedChatIds.length === 0) {
    const fromChat = Number(data.telegram.chatId);
    data.telegram.allowedChatIds = Number.isFinite(fromChat) ? [fromChat] : [];
  }
  return data;
}
