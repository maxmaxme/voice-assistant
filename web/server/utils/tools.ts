// Built-in agent tools: DB-only, read/written via /api/tools. On by default
// (a stored '0' disables). KEEP keys in sync with voice-assistant
// src/settings/toolsConfig.ts.

export const TOOLS_KEYS = {
  memory: 'tools.memory',
  reminders: 'tools.reminders',
  weather: 'tools.weather',
  weatherUnits: 'tools.weather.units',
  weatherLocation: 'tools.weather.location',
} as const

export type WeatherUnits = 'metric' | 'imperial'

export interface ToolsForm {
  memory: boolean
  reminders: boolean
  weather: {
    enabled: boolean
    units: WeatherUnits
    defaultLocation: string
  }
}

function on(value: string | undefined): boolean {
  return value !== '0'
}

export function readTools(all: Record<string, string>): ToolsForm {
  return {
    memory: on(all[TOOLS_KEYS.memory]),
    reminders: on(all[TOOLS_KEYS.reminders]),
    weather: {
      enabled: on(all[TOOLS_KEYS.weather]),
      units: all[TOOLS_KEYS.weatherUnits] === 'imperial' ? 'imperial' : 'metric',
      defaultLocation: all[TOOLS_KEYS.weatherLocation] ?? '',
    },
  }
}
