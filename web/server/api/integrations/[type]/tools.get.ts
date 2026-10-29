import { getIntegration } from '../../../utils/db/integrations'
import { DbNotReadyError } from '../../../utils/db/client'
import { defFor, listMcpTools } from '../../../utils/integrations'

// The live tool list of an installed MCP server, for the Edit dialog's picker.
// Server-side so the stored token never reaches the browser.
export default defineEventHandler(async (event) => {
  const type = getRouterParam(event, 'type')
  if (!type || defFor(type)?.type !== 'mcp') {
    throw createError({ statusCode: 400, statusMessage: 'Not an MCP server integration' })
  }
  try {
    const existing = getIntegration(type)
    if (!existing) {
      throw createError({ statusCode: 404, statusMessage: 'Not installed' })
    }
    return { tools: await listMcpTools(existing.config) }
  }
  catch (e) {
    if (e instanceof DbNotReadyError) {
      throw createError({ statusCode: 503, statusMessage: e.message })
    }
    if (e instanceof Error && !('statusCode' in e)) {
      throw createError({ statusCode: 502, statusMessage: `MCP server unreachable: ${e.message}` })
    }
    throw e
  }
})
