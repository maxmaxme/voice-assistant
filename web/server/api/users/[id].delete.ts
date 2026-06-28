import { deleteUser, dbErrorToHttp } from '../../utils/db/users'

export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid user id' })
  }
  try {
    if (!deleteUser(id)) {
      throw createError({ statusCode: 404, statusMessage: 'User not found' })
    }
  }
  catch (e) {
    dbErrorToHttp(e)
  }
  return { ok: true }
})
