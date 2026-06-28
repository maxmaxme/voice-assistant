export interface SettableKey {
  key: string
  label: string
  kind: 'string' | 'number' | 'enum' | 'boolean'
  options?: string[]
  group: 'openai' | 'realtime' | 'general'
  help?: string
}

export interface SettingsResponse {
  settable: SettableKey[]
  values: Record<string, string>
}

export interface PromptRow {
  name: string
  content: string
  defaultContent: string
  updatedAt: number
}
