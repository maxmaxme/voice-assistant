/** A key/value store for non-secret runtime configuration overrides.
 *  Keys are environment-variable names (e.g. `OPENAI_MODEL`); values are
 *  the raw string the env var would carry. Overrides are read by
 *  `loadConfig` at process start and layered over `process.env`. */
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
