import { createLogger } from '../utils/logger.ts';

const log = createLogger('tool-cache');

/**
 * Tiny per-process cache for HA MCP tool results, scoped to the Realtime
 * bridge's runTool hook. Aimed at `GetLiveContext`, which the model calls
 * for entity discovery before nearly every ambiguous action — a single
 * round-trip costs ~300–500 ms against HA's MCP server.
 *
 * TTL is intentionally short (5 s by default) because GetLiveContext
 * returns live state (sensor readings, light on/off, media_player volume,
 * etc.) — not just a static device list. Within a single turn the model
 * often calls GetLiveContext immediately before an action; the next
 * user-visible turn lands seconds later. 5 s catches the in-turn repeat
 * and the typical "and in the bedroom too" follow-up without going so stale
 * that "check the temperature" returns yesterday's data.
 *
 * Any non-cached tool call (e.g. HassTurnOff) invalidates the cache via
 * {@link clear} — once the model has *acted* on state, the next read
 * must hit HA fresh.
 */
export class ToolResultCache {
  private entries = new Map<string, { value: string; expiresAt: number }>();
  private hits = 0;
  private misses = 0;

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry.value;
  }

  set(key: string, value: string, ttlMs: number): void {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** Drop everything — call after any state-mutating tool. */
  clear(reason: string): void {
    if (this.entries.size > 0) {
      log.debug({ reason, size: this.entries.size }, 'cache cleared');
      this.entries.clear();
    }
  }

  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.entries.size };
  }
}

/** Tools whose results are safe to cache for a few seconds. */
export const CACHEABLE_TOOLS = new Set<string>(['GetLiveContext']);
