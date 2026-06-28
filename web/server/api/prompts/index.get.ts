import { listPrompts } from '../../utils/db/prompts'
import { listIntegrations } from '../../utils/db/integrations'
import { getAllSettings } from '../../utils/db/settings'
import { promptOwner } from '../../utils/integrations'
import { readTools, toolPromptOwner } from '../../utils/tools'

export default defineEventHandler(() => {
  const enabled = new Set(listIntegrations().filter(i => i.enabled).map(i => i.type))
  const tools = readTools(getAllSettings())
  // Core prompts (no owner) always show. Integration-owned prompts show only
  // while that integration is enabled; tool-owned prompts only while that tool
  // is on. Rows are kept in the DB either way — just hidden here — so edits
  // survive a disable/enable.
  const prompts = listPrompts().filter((p) => {
    const intOwner = promptOwner(p.name)
    if (intOwner !== null && !enabled.has(intOwner)) return false
    const tOwner = toolPromptOwner(p.name)
    if (tOwner !== null && !tools[tOwner]) return false
    return true
  })
  return { prompts }
})
