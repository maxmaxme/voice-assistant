import { readFileSync } from 'node:fs'
import { micDumpPath } from '../../utils/micDumps'

// Serves one dump for the <audio> player — its own menu covers downloading, and
// the inline filename names the saved file. Honours a single byte Range: Safari
// won't play an <audio> source that ignores Range. Dumps are ≤ ~2 MB, so
// reading whole is fine.
export default defineEventHandler((event) => {
  const name = getRouterParam(event, 'name') ?? ''
  const path = micDumpPath(name)
  if (!path) {
    throw createError({ statusCode: 400, statusMessage: 'Not a mic dump name' })
  }
  let file: Buffer
  try {
    file = readFileSync(path)
  }
  catch {
    // Pruned by the assistant (it keeps only the newest 20) since the list loaded.
    throw createError({ statusCode: 404, statusMessage: 'Mic dump not found' })
  }

  setResponseHeaders(event, {
    'Content-Type': 'audio/wav',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600, immutable',
    'Content-Disposition': `inline; filename="${name}"`,
  })

  const range = /^bytes=(\d*)-(\d*)$/.exec(getRequestHeader(event, 'range') ?? '')
  if (!range || (!range[1] && !range[2])) {
    setResponseHeader(event, 'Content-Length', file.length)
    return file
  }
  // `bytes=-N` = the last N bytes; otherwise start-[end].
  const start = range[1] ? Number(range[1]) : Math.max(file.length - Number(range[2]), 0)
  const end = range[1] && range[2] ? Math.min(Number(range[2]), file.length - 1) : file.length - 1
  if (start >= file.length || start > end) {
    setResponseStatus(event, 416)
    setResponseHeader(event, 'Content-Range', `bytes */${file.length}`)
    return ''
  }
  setResponseStatus(event, 206)
  setResponseHeaders(event, {
    'Content-Range': `bytes ${start}-${end}/${file.length}`,
    'Content-Length': end - start + 1,
  })
  return file.subarray(start, end + 1)
})
