import type { SqliteIntegrations } from './sqliteIntegrations.ts';

/** Matches the integration `type` key in the web catalog. */
export const OPENAI_INTEGRATION_TYPE = 'openai';

export type ChatReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';
export type RealtimeReasoningEffort = ChatReasoningEffort | 'xhigh';

export interface OpenAiConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  reasoningEffort: ChatReasoningEffort;
  webSearch: boolean;
  realtime: {
    enabled: boolean;
    model: string;
    voice: string;
    reasoningEffort: RealtimeReasoningEffort;
  };
}

const DEFAULT_MODEL = 'gpt-5-mini';
const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2';
const DEFAULT_REALTIME_VOICE = 'marin';

// Narrow stored strings to the effort unions without a type assertion (the
// catalog validates on save, but the DB type is still `string`).
function chatEffort(v: string | undefined): ChatReasoningEffort {
  switch (v) {
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
      return v;
    default:
      return 'low';
  }
}

function realtimeEffort(v: string | undefined): RealtimeReasoningEffort {
  switch (v) {
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return v;
    default:
      return 'low';
  }
}

/** OpenAI connection + model config from the integration. Null when not
 *  installed, disabled, or missing an API key. OpenAI is mandatory for the
 *  agent, so the bootstrap fails fast on null. */
export function resolveOpenAiConfig(store: SqliteIntegrations): OpenAiConfig | null {
  const row = store.get(OPENAI_INTEGRATION_TYPE);
  if (!row || !row.enabled) {
    return null;
  }
  const c = row.config;
  const apiKey = (c.apiKey ?? '').trim();
  if (!apiKey) {
    return null;
  }
  const val = (k: string): string => (c[k] ?? '').trim();
  return {
    apiKey,
    baseUrl: val('baseUrl') || undefined,
    model: val('model') || DEFAULT_MODEL,
    reasoningEffort: chatEffort(c.reasoningEffort),
    webSearch: c.webSearch === '1',
    realtime: {
      enabled: c.realtimeEnabled === '1',
      model: val('realtimeModel') || DEFAULT_REALTIME_MODEL,
      voice: val('realtimeVoice') || DEFAULT_REALTIME_VOICE,
      reasoningEffort: realtimeEffort(c.realtimeReasoningEffort),
    },
  };
}
