import { listPrompts, listIntegrations } from '../../utils/db'
import { promptOwner } from '../../utils/integrations'

export default defineEventHandler(() => {
  const enabled = new Set(listIntegrations().filter(i => i.enabled).map(i => i.type))
  // Core prompts (no owner) always show; integration-owned prompts only while
  // that integration is enabled. Rows are kept in the DB either way — just
  // hidden here — so edits survive a disable/enable.
  const prompts = listPrompts().filter((p) => {
    const owner = promptOwner(p.name)
    return owner === null || enabled.has(owner)
  })
  return { prompts }
})
