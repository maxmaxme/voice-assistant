import { openSync, writeSync, closeSync, statSync, constants } from 'node:fs'

// DB-backed settings/prompts/integrations apply on the next voice-assistant
// start (no hot reload), so "Apply changes" just bounces the process. We don't
// touch docker from this container (no socket by design): we write "restart" to
// a host FIFO that va-update-listener.service reads and acts on. The write is
// non-blocking — a missing or busy listener fails fast instead of hanging the
// request (a blocking FIFO open would freeze the Nitro event loop).
export default defineEventHandler(() => {
  const fifo = process.env.VA_UPDATE_FIFO
  if (!fifo) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Restart is not available in this environment.',
    })
  }

  try {
    if (!statSync(fifo).isFIFO()) {
      throw createError({ statusCode: 503, statusMessage: 'Restart trigger is not a FIFO.' })
    }
  }
  catch (e) {
    if (e && typeof e === 'object' && 'statusCode' in e) throw e
    throw createError({ statusCode: 503, statusMessage: 'Restart trigger is unavailable.' })
  }

  let fd: number
  try {
    fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK)
  }
  catch {
    throw createError({
      statusCode: 503,
      statusMessage: 'The update listener is not reading (down or busy). Try again in a moment.',
    })
  }
  try {
    writeSync(fd, 'restart\n')
  }
  finally {
    closeSync(fd)
  }

  return { ok: true }
})
