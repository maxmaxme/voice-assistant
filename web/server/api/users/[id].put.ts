import { updateUser, dbErrorToHttp } from '../../utils/db'

interface PutBody {
  name?: string
  isAdmin?: boolean
}

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid user id' })
  }
  const body = await readBody<PutBody>(event)
  const name = (body?.name ?? '').trim()
  if (!name) {
    throw createError({ statusCode: 400, statusMessage: 'Name is required.' })
  }
  try {
    if (!updateUser(id, name, Boolean(body?.isAdmin))) {
      throw createError({ statusCode: 404, statusMessage: 'User not found' })
    }
  }
  catch (e) {
    dbErrorToHttp(e)
  }
  return { ok: true }
})
