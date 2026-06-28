import { describe, it, expect } from 'vitest';
import {
  buildCurrentTimeTool,
  executeCurrentTimeTool,
  GET_CURRENT_TIME_TOOL_NAME,
} from '../../src/agent/timeTool.ts';

describe('timeTool', () => {
  it('exposes a no-argument function tool', () => {
    const t = buildCurrentTimeTool();
    expect(t.name).toBe(GET_CURRENT_TIME_TOOL_NAME);
    expect(t.parameters.required).toEqual([]);
    expect(t.parameters.properties).toEqual({});
  });

  it('returns the current instant in several forms', () => {
    // 2026-06-29T00:30:15Z — a fixed instant so the assertion is deterministic.
    const now = Date.UTC(2026, 5, 29, 0, 30, 15);
    const r = executeCurrentTimeTool({ now });
    expect(r.unixMs).toBe(now);
    expect(r.iso).toBe('2026-06-29T00:30:15.000Z');
    expect(typeof r.timezone).toBe('string');
    expect(r.timezone.length).toBeGreaterThan(0);
    expect(typeof r.weekday).toBe('string');
    // local string carries the date + a GMT offset.
    expect(r.local).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT[+-]\d{2}:\d{2}/);
  });
});
