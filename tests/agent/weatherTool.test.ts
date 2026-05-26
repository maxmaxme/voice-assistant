import { describe, it, expect, vi } from 'vitest';
import {
  buildWeatherTool,
  executeWeatherTool,
  WEATHER_TOOL_NAME,
} from '../../src/agent/weatherTool.ts';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe('weatherTool', () => {
  it('exposes a function tool with the expected name', () => {
    const t = buildWeatherTool();
    expect(t.name).toBe(WEATHER_TOOL_NAME);
    expect(t.parameters.required).toEqual(['location', 'date']);
  });

  it('geocodes the location and returns daily forecast fields', async () => {
    const calls: string[] = [];
    const fakeFetch = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('geocoding-api')) {
        return jsonResponse({
          results: [{ latitude: 40.4, longitude: -3.7, name: 'Madrid', country: 'Spain' }],
        });
      }
      return jsonResponse({
        daily: {
          time: ['2026-05-27'],
          temperature_2m_min: [14.2],
          temperature_2m_max: [27.8],
          weather_code: [3],
          precipitation_probability_max: [10],
          wind_speed_10m_max: [12.5],
        },
      });
    });

    const r = await executeWeatherTool(
      { location: 'Madrid', date: '2026-05-27' },
      { fetch: fakeFetch as unknown as typeof fetch },
    );

    expect(r).toEqual({
      location: 'Madrid, Spain',
      date: '2026-05-27',
      summary: 'overcast',
      tempMinC: 14.2,
      tempMaxC: 27.8,
      precipitationProbabilityPct: 10,
      windMaxKmh: 12.5,
    });
    expect(calls[0]).toContain('name=Madrid');
    expect(calls[1]).toContain('latitude=40.4');
    expect(calls[1]).toContain('start_date=2026-05-27');
  });

  it('rejects missing location', async () => {
    await expect(executeWeatherTool({ location: '', date: '2026-05-27' })).rejects.toThrow(
      /location/,
    );
  });

  it('rejects malformed date', async () => {
    await expect(executeWeatherTool({ location: 'Madrid', date: 'tomorrow' })).rejects.toThrow(
      /YYYY-MM-DD/,
    );
  });

  it('throws when geocoding yields no results', async () => {
    const fakeFetch = vi.fn(async () => jsonResponse({ results: [] }));
    await expect(
      executeWeatherTool(
        { location: 'Atlantis', date: '2026-05-27' },
        { fetch: fakeFetch as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/unknown location/);
  });

  it('surfaces a non-2xx forecast as an error', async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      if (url.includes('geocoding-api')) {
        return jsonResponse({ results: [{ latitude: 0, longitude: 0, name: 'X' }] });
      }
      return jsonResponse({}, false, 503);
    });
    await expect(
      executeWeatherTool(
        { location: 'X', date: '2026-05-27' },
        { fetch: fakeFetch as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/forecast HTTP 503/);
  });
});
