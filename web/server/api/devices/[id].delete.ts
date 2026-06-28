import { deleteDevice, dbErrorToHttp } from '../../utils/db/users'

export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid device id' })
  }
  try {
    if (!deleteDevice(id)) {
      throw createError({ statusCode: 404, statusMessage: 'Device not found' })
    }
  }
  catch (e) {
    dbErrorToHttp(e)
  }
  return { ok: true }
})
