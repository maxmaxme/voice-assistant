import { setPrompt, getPrompt } from '../utils/db/prompts'
import { DbNotReadyError } from '../utils/db/client'

interface PutBody {
  name?: string
  content?: string
}

// Name travels in the body, not the path: prompt names contain slashes
// (`tools/forget`, `ha-suffix/HassTurnOn`) which a single path segment can't carry.
export default defineEventHandler(async (event) => {
  const body = await readBody<PutBody>(event)
  if (!body?.name || typeof body.content !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'Expected { name, content }' })
  }
  // Only edit prompts voice-assistant has seeded — refuse arbitrary new names so
  // a typo can't create an orphan row the app never reads.
  if (!getPrompt(body.name)) {
    throw createError({ statusCode: 404, statusMessage: `No prompt named '${body.name}'` })
  }
  try {
    setPrompt(body.name, body.content)
  }
  catch (e) {
    if (e instanceof DbNotReadyError) {
      throw createError({ statusCode: 503, statusMessage: e.message })
    }
    throw e
  }
  return { ok: true, restartRequired: true }
})
