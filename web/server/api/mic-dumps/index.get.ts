import { existsSync } from 'node:fs'
import { listMicDumps, micDumpDir } from '../../utils/micDumps'

export default defineEventHandler(() => {
  // `available: false` = no dump directory at all, i.e. the assistant's
  // MIC_DUMP_DIR tap is off (or has never fired) — not an error.
  return { available: existsSync(micDumpDir()), dumps: listMicDumps() }
})
