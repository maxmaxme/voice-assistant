import { readFileSync } from 'node:fs';

/**
 * Load a prompt fragment from a `.md` file sitting next to the caller.
 *
 * We keep prompts in markdown because they're easier to edit, diff, and
 * preview than escaped TS string literals. Node 24 reads them at module
 * load time via `fs.readFileSync` — no build step, no bundler, the files
 * ship into the docker image via `COPY src ./src`.
 *
 * The returned string is trimmed so callers can concatenate fragments with
 * `\n\n` separators without dragging trailing newlines from the source.
 *
 * Usage:
 *   const PROMPT = loadPrompt('./prompts/foo.md', import.meta.url);
 */
export function loadPrompt(relativePath: string, fromUrl: string): string {
  return readFileSync(new URL(relativePath, fromUrl), 'utf8').trim();
}
