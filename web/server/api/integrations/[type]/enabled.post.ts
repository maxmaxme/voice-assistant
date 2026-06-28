import { getIntegration, setIntegrationEnabled, DbNotReadyError } from '../../../utils/db'
import { INTEGRATION_BY_TYPE, testIntegration } from '../../../utils/integrations'

interface Body {
  enabled?: boolean
}

export default defineEventHandler(async (event) => {
  const type = getRouterParam(event, 'type')
  const def = type ? INTEGRATION_BY_TYPE.get(type) : undefined
  if (!def) {
    throw createError({ statusCode: 400, statusMessage: 'Unknown integration type' })
  }
  const body = await readBody<Body>(event)
  const enabled = body?.enabled === true
  try {
    const existing = getIntegration(def.type)
    if (!existing) {
      throw createError({ statusCode: 404, statusMessage: 'Not installed' })
    }
    // Enabling re-checks the connection (don't activate a broken integration —
    // the agent would crash-loop trying to connect). Disabling never tests.
    if (enabled) {
      const test = await testIntegration(def.type, existing.config)
      if (!test.ok) {
        throw createError({ statusCode: 422, statusMessage: `Connection test failed: ${test.message}` })
      }
    }
    setIntegrationEnabled(def.type, enabled)
  }
  catch (e) {
    if (e instanceof DbNotReadyError) {
      throw createError({ statusCode: 503, statusMessage: e.message })
    }
    throw e
  }
  return { ok: true, restartRequired: true }
})
