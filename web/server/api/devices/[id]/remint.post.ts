import { remintDevice, dbErrorToHttp } from '../../../utils/db'

export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid device id' })
  }
  try {
    const res = remintDevice(id)
    if (!res) {
      throw createError({ statusCode: 400, statusMessage: 'Only HTTP devices can be re-minted.' })
    }
    return res
  }
  catch (e) {
    dbErrorToHttp(e)
  }
})
