import { getIntegration, upsertIntegration, DbNotReadyError } from '../../utils/db'
import { INTEGRATION_BY_TYPE, mergeAndValidate, testIntegration } from '../../utils/integrations'

interface PostBody {
  type?: string
  config?: Record<string, string>
}

export default defineEventHandler(async (event) => {
  const body = await readBody<PostBody>(event)
  const def = body?.type ? INTEGRATION_BY_TYPE.get(body.type) : undefined
  if (!def) {
    throw createError({ statusCode: 400, statusMessage: 'Unknown integration type' })
  }
  try {
    if (getIntegration(def.type)) {
      throw createError({ statusCode: 409, statusMessage: 'Already installed' })
    }
    const result = mergeAndValidate(def, body.config ?? {})
    if ('error' in result) {
      throw createError({ statusCode: 400, statusMessage: result.error })
    }
    // Refuse to persist a config that doesn't actually connect.
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
