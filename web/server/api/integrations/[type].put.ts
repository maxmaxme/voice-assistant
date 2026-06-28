import { getIntegration, upsertIntegration } from '../../utils/db/integrations'
import { DbNotReadyError } from '../../utils/db/client'
import { INTEGRATION_BY_TYPE, mergeAndValidate, testIntegration } from '../../utils/integrations'

interface PutBody {
  config?: Record<string, string>
}

export default defineEventHandler(async (event) => {
  const type = getRouterParam(event, 'type')
  const def = type ? INTEGRATION_BY_TYPE.get(type) : undefined
  if (!def) {
    throw createError({ statusCode: 400, statusMessage: 'Unknown integration type' })
  }
  const body = await readBody<PutBody>(event)
  try {
    const existing = getIntegration(def.type)
    if (!existing) {
      throw createError({ statusCode: 404, statusMessage: 'Not installed' })
    }
    // Blank secret fields keep their current value (see mergeAndValidate).
    const result = mergeAndValidate(def, body?.config ?? {}, existing.config)
    if ('error' in result) {
      throw createError({ statusCode: 400, statusMessage: result.error })
    }
    const test = await testIntegration(def.type, result.config)
    if (!test.ok) {
      throw createError({ statusCode: 422, statusMessage: `Connection test failed: ${test.message}` })
    }
    upsertIntegration(def.type, result.config)
  }
  catch (e) {
    if (e instanceof DbNotReadyError) {
      throw createError({ statusCode: 503, statusMessage: e.message })
    }
    throw e
  }
  return { ok: true }
})
