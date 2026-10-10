import { setSetting, deleteSetting } from '../utils/db/settings'
import { DbNotReadyError } from '../utils/db/client'
import {
  REALTIME_KEYS,
  NOISE_REDUCTIONS,
  TURN_DETECTIONS,
  TRANSCRIPTION_MODELS,
  canonicalizeLanguage,
  canonicalizeNumber,
} from '../utils/realtime'

interface PutBody {
  enabled?: boolean
  // A number-typed <input> serializes filled fields as numbers, blanks as ''.
  outputPacingMs?: string | number
  idleResetMs?: string | number
  followUpMs?: string | number
  requestFollowUpMs?: string | number
  followUpChime?: boolean
  wakeChime?: boolean
  language?: string
  transcription?: boolean
  transcriptionModel?: string
  noiseReduction?: string
  turnDetection?: string
}

export default defineEventHandler(async (event) => {
  const body = (await readBody<PutBody>(event)) ?? {}

  // Canonicalize each numeric field up front: a blank clears the key (built-in
  // default), a valid value is stored as a plain integer string, garbage 400s.
  const numbers = [
    ['Output pacing', REALTIME_KEYS.outputPacingMs, body.outputPacingMs],
    ['Idle reset', REALTIME_KEYS.idleResetMs, body.idleResetMs],
    ['Follow-up window', REALTIME_KEYS.followUpMs, body.followUpMs],
    ['Question follow-up window', REALTIME_KEYS.requestFollowUpMs, body.requestFollowUpMs],
  ] as const
  const canonical: Array<[string, string | null]> = []
  for (const [label, key, value] of numbers) {
    const { canonical: c, error } = canonicalizeNumber(label, value)
    if (error) {
      throw createError({ statusCode: 400, statusMessage: error })
    }
    canonical.push([key, c])
  }

  const { canonical: language, error: languageError } = canonicalizeLanguage(body.language)
  if (languageError) {
    throw createError({ statusCode: 400, statusMessage: languageError })
  }

  const noise = body.noiseReduction ?? ''
  if (noise !== '' && !NOISE_REDUCTIONS.includes(noise)) {
    throw createError({ statusCode: 400, statusMessage: `Noise reduction must be one of ${NOISE_REDUCTIONS.join(', ')}` })
  }

  const turn = body.turnDetection ?? ''
  if (turn !== '' && !TURN_DETECTIONS.includes(turn)) {
    throw createError({ statusCode: 400, statusMessage: `Turn detection must be one of ${TURN_DETECTIONS.join(', ')}` })
  }

  const transcriptionModel = body.transcriptionModel ?? ''
  if (transcriptionModel !== '' && !TRANSCRIPTION_MODELS.includes(transcriptionModel)) {
    throw createError({ statusCode: 400, statusMessage: `Transcription model must be one of ${TRANSCRIPTION_MODELS.join(', ')}` })
  }

  const writeOrClear = (key: string, value: string | null): void => {
    if (value === null) deleteSetting(key)
    else setSetting(key, value)
  }

  try {
    if (body.enabled) setSetting(REALTIME_KEYS.enabled, '1')
    else deleteSetting(REALTIME_KEYS.enabled)
    for (const [key, value] of canonical) writeOrClear(key, value)
    // Chime defaults to off — persist '1' only to turn it on, else clear the key.
    if (body.followUpChime === true) setSetting(REALTIME_KEYS.followUpChime, '1')
    else deleteSetting(REALTIME_KEYS.followUpChime)
    // Wake beep defaults to on — persist '0' only to turn it off, else clear.
    if (body.wakeChime === false) setSetting(REALTIME_KEYS.wakeChime, '0')
    else deleteSetting(REALTIME_KEYS.wakeChime)
    writeOrClear(REALTIME_KEYS.language, language)
    // Transcription defaults to off — persist '1' only to turn it on, else clear.
    if (body.transcription === true) setSetting(REALTIME_KEYS.transcription, '1')
    else deleteSetting(REALTIME_KEYS.transcription)
    // far_field is the built-in default — clear the key instead of storing it.
    writeOrClear(REALTIME_KEYS.noiseReduction, noise === '' || noise === 'far_field' ? null : noise)
    // Built-in defaults (server_vad / whisper-1) clear the key instead of storing it.
    writeOrClear(REALTIME_KEYS.turnDetection, turn === '' || turn === 'server_vad' ? null : turn)
    writeOrClear(
      REALTIME_KEYS.transcriptionModel,
      transcriptionModel === '' || transcriptionModel === 'whisper-1' ? null : transcriptionModel,
    )
  }
  catch (e) {
    if (e instanceof DbNotReadyError) {
      throw createError({ statusCode: 503, statusMessage: e.message })
    }
    throw e
  }

  return { ok: true, restartRequired: true }
})
