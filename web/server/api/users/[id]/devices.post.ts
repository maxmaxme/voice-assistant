import { addDevice, dbErrorToHttp, type Channel } from '../../../utils/db/users'

interface PostBody {
  channel?: string
  value?: string
}

const CHANNELS: Channel[] = ['telegram', 'http', 'voice']

export default defineEventHandler(async (event) => {
  const userId = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(userId)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid user id' })
  }
  const body = await readBody<PostBody>(event)
  const channel = body?.channel
  if (!channel || !CHANNELS.includes(channel as Channel)) {
    throw createError({ statusCode: 400, statusMessage: 'channel must be telegram, http or voice' })
  }
  const value = (body?.value ?? '').trim()
  // http mints its own token; telegram/voice need a value from the caller.
  if (channel !== 'http' && !value) {
    const label = channel === 'telegram' ? 'Chat ID' : 'Device token'
    throw createError({ statusCode: 400, statusMessage: `${label} is required.` })
  }
  try {
    return addDevice(userId, channel as Channel, value)
  }
  catch (e) {
    dbErrorToHttp(e)
  }
})
