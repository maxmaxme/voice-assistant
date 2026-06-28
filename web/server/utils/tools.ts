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

export type GatedTool = 'memory' | 'reminders'

// Prompt names each tool owns, so the Prompts page can hide them when the tool
// is off. KEEP in sync with src/agent/prompts/tools/*. (weather has no prompt —
// its description is inline.)
const TOOL_PROMPTS: Record<GatedTool, string[]> = {
  memory: ['tools/remember', 'tools/recall', 'tools/forget'],
  reminders: ['tools/schedule-action', 'tools/list-scheduled', 'tools/cancel-scheduled'],
}

/** Which tool owns a prompt name, or null if it's not a tool prompt. */
export function toolPromptOwner(name: string): GatedTool | null {
  for (const tool of Object.keys(TOOL_PROMPTS) as GatedTool[]) {
    if (TOOL_PROMPTS[tool].includes(name)) return tool
  }
  return null
}
