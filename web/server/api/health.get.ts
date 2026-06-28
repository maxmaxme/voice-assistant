import { getDb } from '../utils/db/client'

// Liveness probe for the container healthcheck: confirms the Nitro server is
// serving and the shared SQLite DB opens. A trivial query needs no app tables,
// so it passes even on a fresh / not-yet-migrated DB. Throws (→ 500) only if the
// DB can't be opened, which is exactly when the container should read unhealthy.
export default defineEventHandler(() => {
  getDb().prepare('SELECT 1').get()
  return { status: 'ok' }
})
