// Catalog of integrations the panel can install. Lives in code (not the DB):
// the DB only stores configured instances. Future work reads the configured
// row (e.g. Home Assistant url/token) from the agent core instead of env.

export interface IntegrationField {
  key: string
  label: string
  type: 'text' | 'password' | 'enum' | 'boolean'
  /** Allowed values for `type: 'enum'`. */
  options?: string[]
  /** Concrete default for an enum — when set, the field has no "(default)"
   *  empty choice and is always one of `options`. */
  default?: string
  required?: boolean
  placeholder?: string
  help?: string
}

export interface IntegrationDef {
  type: string
  title: string
  description: string
  fields: IntegrationField[]
  /** Optional live connectivity check, co-located with the integration so
   *  adding one is a single place. Runs server-side; omit if none. */
  test?: (config: Config) => Promise<TestResult> | TestResult
  /** Prompt names this integration owns. Such prompts only show in the Prompts
   *  page while the integration is enabled (the agent gates them too). */
  ownsPrompt?: (name: string) => boolean
}

export const INTEGRATIONS: IntegrationDef[] = [
  {
    type: 'home-assistant',
    title: 'Home Assistant',
    description:
      'Control devices, scenes and automations through your Home Assistant instance via its MCP server.',
    fields: [
      {
        key: 'url',
        label: 'Base URL',
        type: 'text',
        required: true,
        placeholder: 'http://homeassistant.local:8123',
      },
      {
        key: 'token',
        label: 'Long-Lived Access Token',
        type: 'password',
        required: true,
        help: 'Home Assistant → Profile → Security → Long-Lived Access Tokens.',
      },
    ],
    test: testHomeAssistant,
    // The HA addendum + per-tool suffixes belong to this integration.
    ownsPrompt: name => name === 'ha-addendum' || name.startsWith('ha-suffix/'),
  },
  {
    type: 'openai',
    title: 'OpenAI',
    description:
      'API credentials and model configuration for the language and realtime models.',
    fields: [
      {
        key: 'apiKey',
        label: 'API key',
        type: 'password',
        required: true,
        help: 'platform.openai.com → API keys.',
      },
      {
        key: 'baseUrl',
        label: 'Base URL',
        type: 'text',
        placeholder: 'https://api.openai.com/v1',
        help: 'Override only for an OpenAI-compatible endpoint (Azure, proxy, …).',
      },
      { key: 'model', label: 'Model', type: 'text', placeholder: 'gpt-5-mini' },
      {
        key: 'reasoningEffort',
        label: 'Reasoning effort',
        type: 'enum',
        options: ['minimal', 'low', 'medium', 'high'],
        default: 'low',
      },
      {
        key: 'webSearch',
        label: 'Web search tool',
        type: 'boolean',
        help: 'Enables OpenAI hosted web_search. Costs tokens per call.',
      },
      {
        key: 'realtimeModel',
        label: 'Realtime model',
        type: 'enum',
        options: ['gpt-realtime-2', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini'],
        default: 'gpt-realtime-2',
      },
      { key: 'realtimeVoice', label: 'Realtime voice', type: 'text', placeholder: 'marin' },
      {
        key: 'realtimeReasoningEffort',
        label: 'Realtime reasoning effort',
        type: 'enum',
        options: ['minimal', 'low', 'medium', 'high', 'xhigh'],
        default: 'low',
      },
    ],
    test: testOpenai,
  },
  {
    type: 'telegram',
    title: 'Telegram',
    description:
      'Chat with the assistant from a Telegram bot — text and voice messages.',
    fields: [
      {
        key: 'botToken',
        label: 'Bot token',
        type: 'password',
        required: true,
        help: 'Create a bot with @BotFather and paste the token it gives you.',
      },
    ],
    test: testTelegram,
  },
]

/** Which integration (by type) owns a given prompt name, or null if it's a
 *  core prompt owned by no integration. */
export function promptOwner(name: string): string | null {
  for (const def of INTEGRATIONS) {
    if (def.ownsPrompt?.(name)) {
      return def.type
    }
  }
  return null
}

export const INTEGRATION_BY_TYPE: Map<string, IntegrationDef> = new Map(
  INTEGRATIONS.map(i => [i.type, i]),
)

export function secretKeys(def: IntegrationDef): string[] {
  return def.fields.filter(f => f.type === 'password').map(f => f.key)
}

export type Config = Record<string, string>

/** Strip secret values for sending to the client; report which secrets are set
 *  so the UI can show "leave blank to keep". */
export function maskConfig(def: IntegrationDef, config: Config): {
  config: Config
  secretsSet: Record<string, boolean>
} {
  const secrets = new Set(secretKeys(def))
  const out: Config = {}
  const secretsSet: Record<string, boolean> = {}
  for (const f of def.fields) {
    if (secrets.has(f.key)) {
      secretsSet[f.key] = Boolean(config[f.key])
    }
    else {
      out[f.key] = config[f.key] ?? ''
    }
  }
  return { config: out, secretsSet }
}

/** Merge an incoming (possibly partial) config over the existing one: a blank
 *  secret means "keep the current value". Then validate required fields.
 *  Returns the merged config, or an error message. */
export function mergeAndValidate(
  def: IntegrationDef,
  incoming: Config,
  existing: Config = {},
): { config: Config } | { error: string } {
  const secrets = new Set(secretKeys(def))
  const merged: Config = {}
  for (const f of def.fields) {
    const raw = incoming[f.key]
    let value: string
    if (secrets.has(f.key) && (raw === undefined || raw === '')) {
      value = existing[f.key] ?? '' // keep existing secret
    }
    else if (f.type === 'boolean') {
      value = raw === '1' || raw === 'true' ? '1' : ''
    }
    else {
      value = (raw ?? '').trim()
    }
    // Enum with a concrete default is never left empty.
    if (f.type === 'enum' && f.default && value === '') {
      value = f.default
    }
    if (f.type === 'enum' && value !== '' && f.options && !f.options.includes(value)) {
      return { error: `${f.label} must be one of: ${f.options.join(', ')}` }
    }
    if (f.required && !value) {
      return { error: `${f.label} is required` }
    }
    merged[f.key] = value
  }
  return { config: merged }
}

export interface TestResult {
  ok: boolean
  message: string
}

/** Run the integration's own `test` (if any). Server-side, so the token never
 *  reaches the browser. */
export async function testIntegration(type: string, config: Config): Promise<TestResult> {
  const def = INTEGRATION_BY_TYPE.get(type)
  if (!def?.test) {
    return { ok: true, message: 'No connection test available for this integration.' }
  }
  return def.test(config)
}

/** Catalog entry as sent to the client — drops the server-only `test` fn. */
export function publicDef(def: IntegrationDef): Omit<IntegrationDef, 'test'> {
  return { type: def.type, title: def.title, description: def.description, fields: def.fields }
}

async function testHomeAssistant(config: Config): Promise<TestResult> {
  const base = (config.url ?? '').replace(/\/+$/, '')
  if (!base) {
    return { ok: false, message: 'Base URL is required.' }
  }
  try {
    // HA's /api/ returns {"message":"API running."} for an authenticated token.
    const res = await fetch(`${base}/api/`, {
      headers: { Authorization: `Bearer ${config.token ?? ''}` },
      signal: AbortSignal.timeout(5000),
    })
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'Unauthorized — check the access token.' }
    }
    if (!res.ok) {
      return { ok: false, message: `Home Assistant returned HTTP ${res.status}.` }
    }
    return { ok: true, message: 'Connected to Home Assistant.' }
  }
  catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

async function testTelegram(config: Config): Promise<TestResult> {
  const token = (config.botToken ?? '').trim()
  if (!token) {
    return { ok: false, message: 'Bot token is required.' }
  }
  try {
    // getMe validates the token without side effects and returns the bot's name.
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(5000),
    })
    if (res.status === 401) {
      return { ok: false, message: 'Unauthorized — check the bot token.' }
    }
    if (!res.ok) {
      return { ok: false, message: `Telegram returned HTTP ${res.status}.` }
    }
    const body = await res.json() as { ok?: boolean, result?: { username?: string } }
    if (!body.ok) {
      return { ok: false, message: 'Telegram rejected the bot token.' }
    }
    const handle = body.result?.username
    return { ok: true, message: handle ? `Connected as @${handle}.` : 'Connected to Telegram.' }
  }
  catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

async function testOpenai(config: Config): Promise<TestResult> {
  const base = ((config.baseUrl ?? '').trim() || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const key = (config.apiKey ?? '').trim()
  if (!key) {
    return { ok: false, message: 'API key is required.' }
  }
  try {
    // GET /models authenticates the key without spending tokens.
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    })
    if (res.status === 401) {
      return { ok: false, message: 'Unauthorized — check the API key.' }
    }
    if (!res.ok) {
      return { ok: false, message: `OpenAI returned HTTP ${res.status}.` }
    }
    return { ok: true, message: 'Connected to OpenAI.' }
  }
  catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
