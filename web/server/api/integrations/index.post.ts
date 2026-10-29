import { getIntegration, upsertIntegration } from '../../utils/db/integrations'
import { DbNotReadyError } from '../../utils/db/client'
import { INTEGRATION_BY_TYPE, mergeAndValidate, rowTypeFor, testIntegration } from '../../utils/integrations'

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
  let message: string
  try {
    const result = mergeAndValidate(def, body.config ?? {})
    if ('error' in result) {
      throw createError({ statusCode: 400, statusMessage: result.error })
    }
    const row = rowTypeFor(def, result.config)
    if ('error' in row) {
      throw createError({ statusCode: 400, statusMessage: row.error })
    }
    if (getIntegration(row.type)) {
      throw createError({ statusCode: 409, statusMessage: 'Already installed' })
    }
    // Refuse to persist a config that doesn't actually connect.
    const test = await testIntegration(row.type, result.config)
    if (!test.ok) {
      throw createError({ statusCode: 422, statusMessage: `Connection test failed: ${test.message}` })
    }
    upsertIntegration(row.type, result.config)
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
