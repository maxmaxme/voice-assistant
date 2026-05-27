import type { OpenAiFunctionTool } from './toolBridge.ts';

export const WEATHER_TOOL_NAME = 'get_weather';

interface GeocodeResult {
  results?: {
    latitude: number;
    longitude: number;
    name: string;
    country?: string;
    admin1?: string;
    timezone?: string;
  }[];
}

interface ForecastResult {
  daily: {
    time: string[];
    temperature_2m_min: number[];
    temperature_2m_max: number[];
    weather_code: number[];
    precipitation_probability_max?: number[];
    wind_speed_10m_max?: number[];
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'number');
}

function parseGeocode(raw: unknown): GeocodeResult {
  if (!isRecord(raw)) {
    throw new Error('get_weather: geocoding response is not an object');
  }
  const results = raw.results;
  if (results === undefined) {
    return {};
  }
  if (!Array.isArray(results)) {
    throw new Error('get_weather: geocoding `results` is not an array');
  }
  const parsed = results.map((r) => {
    if (!isRecord(r)) {
      throw new Error('get_weather: geocoding entry is not an object');
    }
    if (
      typeof r.latitude !== 'number' ||
      typeof r.longitude !== 'number' ||
      typeof r.name !== 'string'
    ) {
      throw new Error('get_weather: geocoding entry missing latitude/longitude/name');
    }
    return {
      latitude: r.latitude,
      longitude: r.longitude,
      name: r.name,
      country: typeof r.country === 'string' ? r.country : undefined,
      admin1: typeof r.admin1 === 'string' ? r.admin1 : undefined,
      timezone: typeof r.timezone === 'string' ? r.timezone : undefined,
    };
  });
  return { results: parsed };
}

function parseForecast(raw: unknown): ForecastResult {
  if (!isRecord(raw)) {
    throw new Error('get_weather: forecast response is not an object');
  }
  const daily = raw.daily;
  if (!isRecord(daily)) {
    throw new Error('get_weather: forecast `daily` missing');
  }
  const time = daily.time;
  if (!Array.isArray(time) || !time.every((x) => typeof x === 'string')) {
    throw new Error('get_weather: forecast `daily.time` invalid');
  }
  if (
    !isNumberArray(daily.temperature_2m_min) ||
    !isNumberArray(daily.temperature_2m_max) ||
    !isNumberArray(daily.weather_code)
  ) {
    throw new Error('get_weather: forecast `daily` arrays invalid');
  }
  return {
    daily: {
      time,
      temperature_2m_min: daily.temperature_2m_min,
      temperature_2m_max: daily.temperature_2m_max,
      weather_code: daily.weather_code,
      precipitation_probability_max: isNumberArray(daily.precipitation_probability_max)
        ? daily.precipitation_probability_max
        : undefined,
      wind_speed_10m_max: isNumberArray(daily.wind_speed_10m_max)
        ? daily.wind_speed_10m_max
        : undefined,
    },
  };
}

export interface WeatherToolResult {
  location: string;
  date: string;
  summary: string;
  tempMinC: number;
  tempMaxC: number;
  precipitationProbabilityPct: number | null;
  windMaxKmh: number | null;
}

export function buildWeatherTool(): OpenAiFunctionTool {
  return {
    type: 'function',
    name: WEATHER_TOOL_NAME,
    description:
      'Get the weather forecast for a place on a specific day. ' +
      'Use whenever the user asks about weather ("погода завтра в Мадриде", ' +
      '"what\'s the weather like on Friday in Paris", "будет ли дождь в выходные"). ' +
      'Resolve relative days against the server timezone shown in the system prompt: ' +
      '"сегодня"/"today" → that date, "завтра"/"tomorrow" → +1 day, etc. ' +
      'DEFAULTS — do NOT ask the user for these, fill them in yourself: ' +
      'if the user did not name a day, use today (server TZ); ' +
      'if the user did not name a place, look in the `Known user profile` block of ' +
      'the system prompt for a key that names where the user is based and pass that ' +
      'value verbatim (e.g. "Madrid"). NEVER pass a profile key name (like "home_city") ' +
      'as the location string. ' +
      'Only ask for clarification if neither a default nor context can resolve the value. ' +
      'Forecast is available up to ~16 days ahead.',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'Free-form place name, e.g. "Madrid", "Санкт-Петербург", "Berlin, Germany".',
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
  deps: { fetch?: typeof fetch } = {},
): Promise<WeatherToolResult> {
  const fetchImpl = deps.fetch ?? fetch;
  const location = typeof args.location === 'string' ? args.location.trim() : '';
  const date = typeof args.date === 'string' ? args.date.trim() : '';
  if (!location) {
    throw new Error('get_weather: `location` is required');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('get_weather: `date` must be ISO YYYY-MM-DD');
  }

  // Open-Meteo geocoding is language-sensitive: "Мадрид" only matches with
  // `language=ru`, "Madrid" with `language=en`. Pick by script, then fall
  // back to the other language so the model doesn't have to retry.
  const isCyrillic = /[Ѐ-ӿ]/.test(location);
  const langOrder = isCyrillic ? ['ru', 'en'] : ['en', 'ru'];
  let place: NonNullable<GeocodeResult['results']>[number] | undefined;
  for (const lang of langOrder) {
    const geoUrl =
      `https://geocoding-api.open-meteo.com/v1/search?count=1&format=json&language=${lang}&name=` +
      encodeURIComponent(location);
    const geoRes = await fetchImpl(geoUrl);
    if (!geoRes.ok) {
      throw new Error(`get_weather: geocoding HTTP ${geoRes.status}`);
    }
    const geo: GeocodeResult = parseGeocode(await geoRes.json());
    place = geo.results?.[0];
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
    timezone: 'auto',
    start_date: date,
    end_date: date,
  });
  const wxRes = await fetchImpl(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
  if (!wxRes.ok) {
    throw new Error(`get_weather: forecast HTTP ${wxRes.status}`);
  }
  const wx: ForecastResult = parseForecast(await wxRes.json());
  const d = wx.daily;
  if (!d || !Array.isArray(d.time) || d.time.length === 0) {
    throw new Error(`get_weather: no forecast for ${date} at ${place.name}`);
  }

  const code = d.weather_code[0];
  const locationLabel = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
  return {
    location: locationLabel,
    date,
    summary: WEATHER_CODE_SUMMARY[code] ?? `code ${code}`,
    tempMinC: d.temperature_2m_min[0],
    tempMaxC: d.temperature_2m_max[0],
    precipitationProbabilityPct: d.precipitation_probability_max?.[0] ?? null,
    windMaxKmh: d.wind_speed_10m_max?.[0] ?? null,
  };
}
