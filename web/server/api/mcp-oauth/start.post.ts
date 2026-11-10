import { startMcpOauth } from '../../utils/mcpOauth'

export default defineEventHandler(async (event) => {
  const { url } = await readBody<{ url?: string }>(event) ?? {}
  if (!url) {
    throw createError({ statusCode: 400, statusMessage: 'URL is required' })
  }
  try {
    return await startMcpOauth(url)
  }
  catch (e) {
    throw createError({ statusCode: 502, statusMessage: `OAuth start failed: ${e instanceof Error ? e.message || e.name : String(e)}` })
  }
})
