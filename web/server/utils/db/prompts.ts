import { getDb, tableExists, DbNotReadyError } from './client'

export interface PromptRow {
  name: string
  content: string
  defaultContent: string
  updatedAt: number
}

export function listPrompts(): PromptRow[] {
  if (!tableExists('prompts')) {
    return []
  }
  return getDb()
    .prepare(
      `SELECT name, content, default_content AS defaultContent, updated_at AS updatedAt
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
  getDb()
    .prepare(
      `INSERT INTO prompts (name, content, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    )
    .run(name, content, Date.now())
}

/** Restore a prompt's content from its stored default. Returns false if absent.
 *  voice-assistant refreshes default_content from the bundled .md on each start,
 *  so this app never needs the image files to reset. */
export function resetPrompt(name: string): boolean {
  if (!tableExists('prompts')) {
    throw new DbNotReadyError('prompts')
  }
  const result = getDb()
    .prepare(`UPDATE prompts SET content = default_content, updated_at = ? WHERE name = ?`)
    .run(Date.now(), name)
  return result.changes > 0
}
