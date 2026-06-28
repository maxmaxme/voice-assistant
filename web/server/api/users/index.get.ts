import { listUsers } from '../../utils/db/users'

export default defineEventHandler(() => {
  // Tolerates a not-yet-migrated DB: listUsers returns [] when the table is absent.
  return { users: listUsers() }
})
