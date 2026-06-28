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
