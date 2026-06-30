import { getDb, tableExists, DbNotReadyError } from './client'

export interface PromptRow {
  name: string
  content: string
  defaultContent: string
  updatedAt: number
}

/** Strip trailing whitespace / CRLF so an edit that only differs from the
 *  default by a trailing newline still counts as "equals the default". Bundled
 *  defaults are stored already trimmed. */
function normalize(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/[ \t\n]+$/, '')
}

export function listPrompts(): PromptRow[] {
  if (!tableExists('prompts')) {
    return []
  }
  // An empty `content` is the "not customized" sentinel — voice-assistant reads
  // the bundled default for it. Surface that default as the effective content so
  // the editor shows the real prompt and the "Modified" badge reads correctly.
  return getDb()
    .prepare(
      `SELECT name,
              CASE WHEN content = '' THEN default_content ELSE content END AS content,
              default_content AS defaultContent,
              updated_at AS updatedAt
       FROM prompts ORDER BY name`,
    )
    .all() as PromptRow[]
}

export function getPrompt(name: string): PromptRow | null {
  if (!tableExists('prompts')) {
    return null
  }
  const row = getDb()
    .prepare(
      `SELECT name, content, default_content AS defaultContent, updated_at AS updatedAt
       FROM prompts WHERE name = ?`,
    )
    .get(name) as PromptRow | undefined
  return row ?? null
}

export function setPrompt(name: string, content: string): void {
  if (!tableExists('prompts')) {
    throw new DbNotReadyError('prompts')
  }
  const db = getDb()
  const row = db.prepare(`SELECT default_content AS d FROM prompts WHERE name = ?`).get(name) as
    | { d: string }
    | undefined
  // Store the empty "not customized" sentinel whenever the edit matches the
  // current default — then voice-assistant reads the bundled code default and
  // the prompt keeps following future code changes instead of freezing a copy.
  const toStore = row && normalize(content) === normalize(row.d) ? '' : content
  db.prepare(
    `INSERT INTO prompts (name, content, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
  ).run(name, toStore, Date.now())
}

/** Reset a prompt to its default by clearing `content` to the empty sentinel.
 *  Reads then fall back to the bundled code default — and keep following future
 *  code changes, unlike copying today's default_content into content. Returns
 *  false if absent. */
export function resetPrompt(name: string): boolean {
  if (!tableExists('prompts')) {
    throw new DbNotReadyError('prompts')
  }
  const result = getDb()
    .prepare(`UPDATE prompts SET content = '', updated_at = ? WHERE name = ?`)
    .run(Date.now(), name)
  return result.changes > 0
}
