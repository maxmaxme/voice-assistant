import { getIntegration, upsertIntegration } from '../../utils/db/integrations'
import { DbNotReadyError } from '../../utils/db/client'
import { defFor, mergeAndValidate, testIntegration } from '../../utils/integrations'

interface PutBody {
  config?: Record<string, string>
}

export default defineEventHandler(async (event) => {
  const type = getRouterParam(event, 'type')
  const def = type ? defFor(type) : undefined
  if (!type || !def) {
    throw createError({ statusCode: 400, statusMessage: 'Unknown integration type' })
  }
  const body = await readBody<PutBody>(event)
  let message: string
  try {
    const existing = getIntegration(type)
    if (!existing) {
      throw createError({ statusCode: 404, statusMessage: 'Not installed' })
    }
    // Blank secret fields keep their current value (see mergeAndValidate).
    // An instance's name is its row key — it can't change on edit.
    const incoming = def.multi ? { ...body?.config, name: existing.config.name ?? '' } : body?.config ?? {}
    const result = mergeAndValidate(def, incoming, existing.config)
    if ('error' in result) {
      throw createError({ statusCode: 400, statusMessage: result.error })
    }
    const test = await testIntegration(type, result.config)
    if (!test.ok) {
      throw createError({ statusCode: 422, statusMessage: `Connection test failed: ${test.message}` })
    }
    upsertIntegration(type, result.config)
    message = test.message
  }
  catch (e) {
    if (e instanceof DbNotReadyError) {
      throw createError({ statusCode: 503, statusMessage: e.message })
    }
    throw e
  }
  return { ok: true, message }
})
