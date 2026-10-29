export interface RealtimeResponse {
  idleResetMs: string
  requestFollowUpMs: string
  followUpChime: boolean
  wakeChime: boolean
  language: string
  transcription: boolean
  transcriptionModel: string
  noiseReduction: string
  turnDetection: string
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
  type: 'text' | 'password' | 'enum' | 'boolean' | 'tools'
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
  multi?: boolean
}

export interface McpToolInfo {
  name: string
  description?: string
}

export interface InstalledIntegration {
  /** Stored row type — `def.type`, or `<def.type>:<name>` for a multi instance. */
  type: string
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
  label: string | null
  createdAt: number
  lastUsedAt: number | null
}

export interface User {
  id: number
  name: string
  isAdmin: boolean
  isSuspended: boolean
  createdAt: number
  devices: Device[]
}

export interface UsersResponse {
  users: User[]
}
