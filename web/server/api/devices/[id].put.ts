import { updateDevice, dbErrorToHttp } from '../../utils/db/users'

interface PutBody {
  value?: string
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid device id' })
  }
  const body = await readBody<PutBody>(event)
  const value = (body?.value ?? '').trim()
  if (!value) {
    throw createError({ statusCode: 400, statusMessage: 'A value is required.' })
  }
  try {
    if (!updateDevice(id, value)) {
      throw createError({ statusCode: 404, statusMessage: 'Device not found' })
    }
  }
  catch (e) {
    dbErrorToHttp(e)
  }
  return { ok: true }
})
