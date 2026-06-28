import type { SettingsStore } from './types.ts';

/** Built-in agent tools, configured on the web panel's Tools page. Unlike
 *  channels/integrations these are **on by default** (they're core capabilities,
 *  not opt-in 3rd-party) — a stored `'0'` disables one. DB-only, never env. */
export type WeatherUnits = 'metric' | 'imperial';

export interface ToolsConfig {
  /** memory: remember / recall / forget. */
  memory: boolean;
  /** reminders: schedule_action / list_scheduled / cancel_scheduled. */
  reminders: boolean;
  weather: {
    enabled: boolean;
    units: WeatherUnits;
    /** Fallback place when the user names none and the profile has none. '' = none. */
    defaultLocation: string;
  };
}

export const TOOLS_KEYS = {
  memory: 'tools.memory',
  reminders: 'tools.reminders',
  weather: 'tools.weather',
  weatherUnits: 'tools.weather.units',
  weatherLocation: 'tools.weather.location',
} as const;

/** Default on: only an explicit '0' turns a tool off. */
function enabled(value: string | undefined): boolean {
  return value !== '0';
}

export function resolveToolsConfig(store: SettingsStore): ToolsConfig {
  return {
    memory: enabled(store.get(TOOLS_KEYS.memory)),
    reminders: enabled(store.get(TOOLS_KEYS.reminders)),
    weather: {
      enabled: enabled(store.get(TOOLS_KEYS.weather)),
      units: store.get(TOOLS_KEYS.weatherUnits) === 'imperial' ? 'imperial' : 'metric',
      defaultLocation: (store.get(TOOLS_KEYS.weatherLocation) ?? '').trim(),
    },
  };
}
