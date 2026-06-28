import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqlitePrompts } from '../../settings/sqlitePrompts.ts';

/**
 * Central catalog of every prompt the agent uses. Each prompt has a stable
 * `name` (also the DB primary key and the label shown in the web UI) and
 * bundled markdown content shipped in `src`.
 *
 * On startup `initPromptRegistry` seeds the DB from the bundled files
 * (`seedIfAbsent`, so user edits survive); thereafter `resolvePrompt` returns
 * the DB row, falling back to the bundled content when the registry hasn't been
 * initialised (e.g. in unit tests) or the row is missing. Changes apply on the
 * next process start — the registry is read once during bootstrap.
 *
 * Bundled prompts are discovered by walking the prompt directories, so dropping
 * a new `.md` in `tools/`, `ha-suffix/`, etc. registers it automatically.
 */
function discoverBundled(): Map<string, string> {
  const out = new Map<string, string>();
  // This module lives in src/agent/prompts/.
  const agentPrompts = fileURLToPath(new URL('.', import.meta.url));
  const cliPrompts = fileURLToPath(new URL('../../cli/prompts/', import.meta.url));

  const addDir = (dir: string, prefix: string): void => {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) {
        continue;
      }
      const name = prefix + file.slice(0, -'.md'.length);
      out.set(name, readFileSync(path.join(dir, file), 'utf8').trim());
    }
  };

  addDir(agentPrompts, ''); // base-system
  addDir(path.join(agentPrompts, 'tools'), 'tools/');
  addDir(path.join(agentPrompts, 'ha-suffix'), 'ha-suffix/');
  addDir(cliPrompts, ''); // voice-addendum, realtime-addendum
  return out;
}

const BUNDLED = discoverBundled();

let store: SqlitePrompts | null = null;

/** Seed the DB from the bundled prompts and route subsequent reads through it. */
export function initPromptRegistry(promptStore: SqlitePrompts): void {
  store = promptStore;
  for (const [name, content] of BUNDLED) {
    promptStore.seedWithDefault(name, content);
  }
}

/** Drop the DB binding — tests use this so a closed test DB isn't read by a
 *  later case, and pre-init reads fall back to bundled content. */
export function resetPromptRegistry(): void {
  store = null;
}

export function bundledPromptNames(): string[] {
  return [...BUNDLED.keys()];
}

/** Resolve a prompt by name: DB row if the registry is initialised and the row
 *  exists, otherwise the bundled file content. Throws for unknown names. */
export function resolvePrompt(name: string): string {
  const fromDb = store?.get(name);
  if (fromDb !== undefined) {
    return fromDb;
  }
  const bundled = BUNDLED.get(name);
  if (bundled === undefined) {
    throw new Error(`Unknown prompt: ${name}`);
  }
  return bundled;
}
