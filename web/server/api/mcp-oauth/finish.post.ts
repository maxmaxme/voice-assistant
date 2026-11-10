import { finishMcpOauth } from '../../utils/mcpOauth'

// Returns the token to the open form; it's stored only when the user saves,
// through the normal install/edit path (which re-runs the connection test).
export default defineEventHandler(async (event) => {
  const { redirectedUrl } = await readBody<{ redirectedUrl?: string }>(event) ?? {}
  if (!redirectedUrl) {
    throw createError({ statusCode: 400, statusMessage: 'Paste the redirected address' })
  }
  try {
    return await finishMcpOauth(redirectedUrl)
  }
  catch (e) {
    throw createError({ statusCode: 400, statusMessage: e instanceof Error ? e.message || e.name : String(e) })
  }
})
