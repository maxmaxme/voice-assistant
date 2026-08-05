import { updateDevice, dbErrorToHttp } from '../../utils/db/users'

interface PutBody {
  value?: string
  label?: string
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid device id' })
  }
  const body = await readBody<PutBody>(event)
  // A blank value is a label-only edit (keeps the current identity).
  const value = (body?.value ?? '').trim()
  try {
    if (!updateDevice(id, value, body?.label ?? '')) {
      throw createError({ statusCode: 404, statusMessage: 'Device not found' })
    }
  }
  catch (e) {
    dbErrorToHttp(e)
  }
  return { ok: true }
})
