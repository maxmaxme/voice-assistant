// Catalog of integrations the panel can install. Lives in code (not the DB):
// the DB only stores configured instances. Future work reads the configured
// row (e.g. Home Assistant url/token) from the agent core instead of env.

export interface IntegrationField {
  key: string
  label: string
  type: 'text' | 'password'
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
  },
]

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
    const next = incoming[f.key]
    if (secrets.has(f.key) && (next === undefined || next === '')) {
      merged[f.key] = existing[f.key] ?? '' // keep existing secret
    }
    else {
      merged[f.key] = (next ?? '').trim()
    }
    if (f.required && !merged[f.key]) {
      return { error: `${f.label} is required` }
    }
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
