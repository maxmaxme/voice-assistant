import { resetPrompt, DbNotReadyError } from '../../utils/db'

interface ResetBody {
  name?: string
}

export default defineEventHandler(async (event) => {
  const body = await readBody<ResetBody>(event)
  if (!body?.name) {
    throw createError({ statusCode: 400, statusMessage: 'Expected { name }' })
  }
  try {
    if (!resetPrompt(body.name)) {
      throw createError({ statusCode: 404, statusMessage: `No prompt named '${body.name}'` })
    }
  }
  catch (e) {
    if (e instanceof DbNotReadyError) {
      throw createError({ statusCode: 503, statusMessage: e.message })
    }
    throw e
  }
  return { ok: true, restartRequired: true }
})
