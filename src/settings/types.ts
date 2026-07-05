/** A key/value store for non-secret feature config (the `settings` table,
 *  edited via the web panel). Keys are dotted feature names (e.g.
 *  `realtime.enabled`, `tools.weather.units`) read by the dedicated resolvers
 *  in this directory — DB-only, never env-var names, never layered over
 *  `process.env`. Values apply on the next process start. */
export interface SettingsStore {
  get(key: string): string | undefined;
  getAll(): Record<string, string>;
  set(key: string, value: string): void;
  delete(key: string): void;
}

/** A key/value store for facts the running process writes about itself
 *  (not user config). See the `runtime_state` table in `schema.ts`. */
export interface RuntimeStateStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}
