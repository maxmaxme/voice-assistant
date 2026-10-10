import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// Read-only view of the WAVs voice-assistant's mic-dump debug tap
// (src/realtime/micDump.ts) writes: 16 kHz mono PCM16 behind a 44-byte header,
// named `<date>_<time>-<speaker>[-<session><turn>].wav`. The assistant owns the
// directory (writes + prunes to the newest 20); this app only lists and serves.

const SAMPLE_RATE = 16000
const HEADER_BYTES = 44
// 20 ms RMS windows — long enough to average out a waveform, short enough that
// the quietest ones are the pauses between words.
const WINDOW = SAMPLE_RATE / 50
const CLIP_LEVEL = 32700

/** Only names the assistant itself produces — keeps path traversal impossible. */
const NAME_RE = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})-([a-z0-9-]+)\.wav$/

export interface MicDumpLevels {
  /** Loudest sample, dBFS (0 = full scale). */
  peakDb: number
  /** Share of samples at full scale, percent. */
  clippedPct: number
  /** 95th-percentile 20 ms RMS — roughly the speech level, dBFS. */
  speechDb: number
  /** 10th-percentile 20 ms RMS — roughly the noise floor, dBFS. */
  noiseDb: number
}

export interface MicDump {
  name: string
  /** `2026-10-10 16:27:00`, server timezone (as written by the assistant). */
  recordedAt: string
  speaker: string
  durationMs: number
  bytes: number
  levels: MicDumpLevels | null
}

/** Where the assistant writes dumps. Explicit MIC_DUMP_DIR wins (same name the
 *  assistant reads); otherwise `mic-dumps/` next to the shared DB, which is
 *  where the stack mounts it. */
export function micDumpDir(): string {
  if (process.env.MIC_DUMP_DIR) {
    return resolve(process.cwd(), process.env.MIC_DUMP_DIR)
  }
  const db = process.env.VA_DB_PATH || useRuntimeConfig().vaDbPath
  return join(dirname(resolve(process.cwd(), db)), 'mic-dumps')
}

/** Absolute path of a dump, or null if the name isn't one the assistant writes. */
export function micDumpPath(name: string): string | null {
  return NAME_RE.test(name) ? join(micDumpDir(), name) : null
}

const toDb = (v: number): number => Math.round(20 * Math.log10(Math.max(v, 1) / 32768) * 10) / 10

function measure(file: Buffer): MicDumpLevels | null {
  const samples = Math.floor((file.length - HEADER_BYTES) / 2)
  if (samples < WINDOW) {
    return null
  }
  let peak = 0
  let clipped = 0
  const rms: number[] = []
  let sumSq = 0
  for (let i = 0; i < samples; i++) {
    const s = file.readInt16LE(HEADER_BYTES + i * 2)
    const a = Math.abs(s)
    if (a > peak) peak = a
    if (a >= CLIP_LEVEL) clipped++
    sumSq += s * s
    if ((i + 1) % WINDOW === 0) {
      rms.push(Math.sqrt(sumSq / WINDOW))
      sumSq = 0
    }
  }
  rms.sort((a, b) => a - b)
  return {
    peakDb: toDb(peak),
    clippedPct: Math.round((clipped / samples) * 10000) / 100,
    speechDb: toDb(rms[Math.floor(rms.length * 0.95)]!),
    noiseDb: toDb(rms[Math.floor(rms.length * 0.1)]!),
  }
}

// Dumps are immutable once written, so levels are cached per name + mtime.
const levelsCache = new Map<string, MicDumpLevels | null>()

/** Newest first. Empty when the directory doesn't exist (tap off / never fired). */
export function listMicDumps(): MicDump[] {
  const dir = micDumpDir()
  let names: string[]
  try {
    names = readdirSync(dir)
  }
  catch {
    return []
  }
  const dumps: (MicDump & { mtime: number })[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const m = NAME_RE.exec(name)
    if (!m) continue
    const path = join(dir, name)
    const st = statSync(path)
    const key = `${name}:${st.mtimeMs}`
    seen.add(key)
    if (!levelsCache.has(key)) {
      levelsCache.set(key, measure(readFileSync(path)))
    }
    dumps.push({
      name,
      recordedAt: `${m[1]} ${m[2]}:${m[3]}:${m[4]}`,
      // Collision suffix (`-<session><turn>`) can't be told apart from a
      // hyphenated speaker slug, so the speaker is shown as the full tail.
      speaker: m[5]!,
      durationMs: Math.round(((st.size - HEADER_BYTES) / 2 / SAMPLE_RATE) * 1000),
      bytes: st.size,
      levels: levelsCache.get(key) ?? null,
      mtime: st.mtimeMs,
    })
  }
  for (const key of levelsCache.keys()) {
    if (!seen.has(key)) levelsCache.delete(key)
  }
  return dumps
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ mtime: _mtime, ...d }) => d)
}
