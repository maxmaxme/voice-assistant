import { deleteIntegration } from '../../utils/db/integrations'
import { DbNotReadyError } from '../../utils/db/client'

export default defineEventHandler((event) => {
  const type = getRouterParam(event, 'type')
  if (!type) {
    throw createError({ statusCode: 400, statusMessage: 'Missing integration type' })
  }
  try {
    if (!deleteIntegration(type)) {
      throw createError({ statusCode: 404, statusMessage: 'Not installed' })
    }
  }
  catch (e) {
    if (e instanceof DbNotReadyError) {
      throw createError({ statusCode: 503, statusMessage: e.message })
    }
    throw e
  }
  return { ok: true }
})
