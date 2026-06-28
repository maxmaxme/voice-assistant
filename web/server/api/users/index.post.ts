import { createUser, dbErrorToHttp } from '../../utils/db/users'

interface PostBody {
  name?: string
  isAdmin?: boolean
}

export default defineEventHandler(async (event) => {
  const body = await readBody<PostBody>(event)
  const name = (body?.name ?? '').trim()
  if (!name) {
    throw createError({ statusCode: 400, statusMessage: 'Name is required.' })
  }
  try {
    const id = createUser(name, Boolean(body?.isAdmin))
    return { id }
  }
  catch (e) {
    dbErrorToHttp(e)
  }
})
