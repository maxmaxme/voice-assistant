import { getIntegration, setIntegrationEnabled } from '../../../utils/db/integrations'
import { DbNotReadyError } from '../../../utils/db/client'
import { defFor, testIntegration } from '../../../utils/integrations'

interface Body {
  enabled?: boolean
}

export default defineEventHandler(async (event) => {
  const type = getRouterParam(event, 'type')
  if (!type || !defFor(type)) {
    throw createError({ statusCode: 400, statusMessage: 'Unknown integration type' })
  }
  const body = await readBody<Body>(event)
  const enabled = body?.enabled === true
  try {
    const existing = getIntegration(type)
    if (!existing) {
      throw createError({ statusCode: 404, statusMessage: 'Not installed' })
    }
    // Enabling re-checks the connection (don't activate a broken integration —
    // the agent would crash-loop trying to connect). Disabling never tests.
    if (enabled) {
      const test = await testIntegration(type, existing.config)
      if (!test.ok) {
        throw createError({ statusCode: 422, statusMessage: `Connection test failed: ${test.message}` })
      }
    }
    setIntegrationEnabled(type, enabled)
  }
  catch (e) {
    if (e instanceof DbNotReadyError) {
      throw createError({ statusCode: 503, statusMessage: e.message })
    }
    throw e
  }
  return { ok: true, restartRequired: true }
})
