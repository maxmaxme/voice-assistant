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
}

export interface InstalledIntegration {
  def: IntegrationDef
  config: Record<string, string>
  secretsSet: Record<string, boolean>
  enabled: boolean
  updatedAt: number
}

export interface IntegrationsResponse {
  installed: InstalledIntegration[]
  available: IntegrationDef[]
}
