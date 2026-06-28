export interface RealtimeResponse {
  enabled: boolean
  outputPacingMs: string
  idleResetMs: string
}

export interface HttpResponse {
  text: boolean
  audio: boolean
  assist: boolean
}

export interface TelegramResponse {
  enabled: boolean
}

export interface ToolsResponse {
  memory: boolean
  reminders: boolean
  weather: {
    enabled: boolean
    units: 'metric' | 'imperial'
    defaultLocation: string
  }
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
  type: 'text' | 'password' | 'enum' | 'boolean'
  options?: string[]
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

export type Channel = 'telegram' | 'http' | 'voice'

export interface Device {
  id: number
  channel: Channel
  identity: string
  createdAt: number
  lastUsedAt: number | null
}

export interface User {
  id: number
  name: string
  isAdmin: boolean
  createdAt: number
  devices: Device[]
}

export interface UsersResponse {
  users: User[]
}
