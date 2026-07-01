import { getConfigLoadedAt } from '../utils/db/runtimeState'
import { getLastEditAt } from '../utils/db/configStatus'

// Drift indicator for the "Apply changes (restart)" button: has the running
// voice-assistant process loaded the config as it currently stands in the DB?
//   upToDate === true  → loaded config is current
//   upToDate === false → edits saved since the last load, restart pending
//   upToDate === null  → process never ran against this DB (state unknown)
export default defineEventHandler(() => {
  const loadedAt = getConfigLoadedAt()
  const lastEditAt = getLastEditAt()
  const upToDate
    = loadedAt === null ? null : lastEditAt === null ? true : loadedAt >= lastEditAt
  return { loadedAt, lastEditAt, upToDate }
})
