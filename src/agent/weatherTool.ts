import { z } from 'zod';
import type { OpenAiFunctionTool } from './toolBridge.ts';

export const WEATHER_TOOL_NAME = 'get_weather';

// Optional upstream fields are lenient: a malformed one is dropped, not fatal.
const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
const numbers = z.array(z.number());

const GeocodeSchema = z.object({
  results: z
    .array(
      z.object({
        latitude: z.number(),
        longitude: z.number(),
        name: z.string(),
        country: lenient(z.string()),
        admin1: lenient(z.string()),
      }),
    )
    .optional(),
});

const ForecastSchema = z.object({
  daily: z.object({
    time: z.array(z.string()),
    temperature_2m_min: numbers,
    temperature_2m_max: numbers,
    weather_code: numbers,
    precipitation_probability_max: lenient(numbers),
    wind_speed_10m_max: lenient(numbers),
  }),
  current: lenient(
    z.object({
      time: z.string(), // local ISO datetime, e.g. "2026-06-29T14:00"
      temperature_2m: z.number(),
      weather_code: z.number(),
      wind_speed_10m: z.number(),
    }),
  ),
});

function parseUpstream<T extends z.ZodType>(schema: T, raw: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`get_weather: ${what} response invalid: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

export type WeatherUnits = 'metric' | 'imperial';

export function buildWeatherTool(): OpenAiFunctionTool {
  return {
    type: 'function',
    name: WEATHER_TOOL_NAME,
    description:
      'Get the OUTDOOR weather forecast for a geographic place on a specific day. ' +
      'NOT for conditions indoors: a question about a room in the home (CO2, air quality, ' +
      'indoor temperature, humidity) is a Home Assistant sensor query, never a weather call. ' +
      'Use whenever the user asks about weather ("weather in Madrid tomorrow", ' +
      '"what\'s the weather like on Friday in Paris", "will it rain this weekend"). ' +
      'You are not told the current date — call get_current_time first, then resolve ' +
      'relative days against it: "today" → that date, "tomorrow" → +1 day, etc. ' +
      'DEFAULTS — do NOT ask the user for these, fill them in yourself: ' +
      'if the user did not name a day, use today (server TZ); ' +
      'if the user did not name a place, look in the `Known user profile` block of ' +
      'the system prompt for a key that names where the user is based and pass that ' +
      'value verbatim (e.g. "Madrid"). NEVER pass a profile key name (like "home_city") ' +
      'as the location string. ' +
      'Only ask for clarification if neither a default nor context can resolve the value. ' +
      'Forecast is available up to ~16 days ahead. ' +
      'When the date is today, the result also includes a `current` object (temperature, ' +
      'conditions, wind right now) — use it for "weather now" / "currently" questions, and ' +
      'use the daily min/max range for "today overall" or future days.',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description:
            'Free-form place name in any language, e.g. "Madrid", "Saint Petersburg", "Berlin, Germany".',
        },
        date: {
          type: 'string',
          description: 'ISO date YYYY-MM-DD (in the local timezone of the requested place).',
        },
      },
      required: ['location', 'date'],
      additionalProperties: false,
    },
  };
}

const WEATHER_CODE_SUMMARY: Record<number, string> = {
  0: 'clear sky',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'depositing rime fog',
  51: 'light drizzle',
  53: 'moderate drizzle',
  55: 'dense drizzle',
  56: 'light freezing drizzle',
  57: 'dense freezing drizzle',
  61: 'slight rain',
  63: 'moderate rain',
  65: 'heavy rain',
  66: 'light freezing rain',
  67: 'heavy freezing rain',
  71: 'slight snow',
  73: 'moderate snow',
  75: 'heavy snow',
  77: 'snow grains',
  80: 'slight rain showers',
  81: 'moderate rain showers',
  82: 'violent rain showers',
  85: 'slight snow showers',
  86: 'heavy snow showers',
  95: 'thunderstorm',
  96: 'thunderstorm with slight hail',
  99: 'thunderstorm with heavy hail',
};

export async function executeWeatherTool(
  args: Record<string, unknown>,
  deps: { fetch?: typeof fetch; units?: WeatherUnits; defaultLocation?: string } = {},
) {
  const fetchImpl = deps.fetch ?? fetch;
  // Bound each upstream call: undici's default timeout is minutes, and a hung
  // Open-Meteo would stall the whole agent turn (a dead speaker on the voice
  // path). 10s is generous for a geocode/forecast round-trip.
  const requestTimeoutMs = 10_000;
  const imperial = deps.units === 'imperial';
  // Fall back to the configured default place when the model passes none.
  const argLocation = typeof args.location === 'string' ? args.location.trim() : '';
  const location = argLocation || (deps.defaultLocation ?? '').trim();
  const date = typeof args.date === 'string' ? args.date.trim() : '';
  if (!location) {
    throw new Error('get_weather: `location` is required');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('get_weather: `date` must be ISO YYYY-MM-DD');
  }

  // Open-Meteo geocoding is language-sensitive: a Cyrillic-script name only
  // matches with `language=ru`, a Latin one with `language=en`. Pick by script,
  // then fall back to the other language so the model doesn't have to retry.
  const isCyrillic = /[Ѐ-ӿ]/.test(location);
  const langOrder = isCyrillic ? ['ru', 'en'] : ['en', 'ru'];
  let place: NonNullable<z.infer<typeof GeocodeSchema>['results']>[number] | undefined;
  for (const lang of langOrder) {
    const geoUrl =
      `https://geocoding-api.open-meteo.com/v1/search?count=1&format=json&language=${lang}&name=` +
      encodeURIComponent(location);
    const geoRes = await fetchImpl(geoUrl, { signal: AbortSignal.timeout(requestTimeoutMs) });
    if (!geoRes.ok) {
      throw new Error(`get_weather: geocoding HTTP ${geoRes.status}`);
    }
    place = parseUpstream(GeocodeSchema, await geoRes.json(), 'geocoding').results?.[0];
    if (place) {
      break;
    }
  }
  if (!place) {
    throw new Error(`get_weather: unknown location "${location}"`);
  }

  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    daily: [
      'temperature_2m_min',
      'temperature_2m_max',
      'weather_code',
      'precipitation_probability_max',
      'wind_speed_10m_max',
    ].join(','),
    current: ['temperature_2m', 'weather_code', 'wind_speed_10m'].join(','),
    timezone: 'auto',
    temperature_unit: imperial ? 'fahrenheit' : 'celsius',
    wind_speed_unit: imperial ? 'mph' : 'kmh',
    start_date: date,
    end_date: date,
  });
  const wxRes = await fetchImpl(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, {
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!wxRes.ok) {
    throw new Error(`get_weather: forecast HTTP ${wxRes.status}`);
  }
  const wx = parseUpstream(ForecastSchema, await wxRes.json(), 'forecast');
  const d = wx.daily;
  if (d.time.length === 0) {
    throw new Error(`get_weather: no forecast for ${date} at ${place.name}`);
  }

  const code = d.weather_code[0];
  const locationLabel = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
  // Attach current conditions only when the requested day is the place's
  // current local day — otherwise "now" is irrelevant to a future-date forecast.
  const cur = wx.current;
  return {
    location: locationLabel,
    date,
    summary: WEATHER_CODE_SUMMARY[code] ?? `code ${code}`,
    tempMin: d.temperature_2m_min[0],
    tempMax: d.temperature_2m_max[0],
    tempUnit: imperial ? '°F' : '°C',
    precipitationProbabilityPct: d.precipitation_probability_max?.[0] ?? null,
    windMax: d.wind_speed_10m_max?.[0] ?? null,
    windUnit: imperial ? 'mph' : 'km/h',
    current:
      cur && cur.time.slice(0, 10) === date
        ? {
            temp: cur.temperature_2m,
            summary: WEATHER_CODE_SUMMARY[cur.weather_code] ?? `code ${cur.weather_code}`,
            wind: cur.wind_speed_10m,
            time: cur.time,
          }
        : undefined,
  };
}
