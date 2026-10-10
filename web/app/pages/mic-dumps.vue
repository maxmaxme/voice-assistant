<script setup lang="ts">
import type { MicDump, MicDumpsResponse } from '~/types'

useHead({ title: 'Mic dumps' })

const { data, refresh, status } = await useFetch<MicDumpsResponse>('/api/mic-dumps')

const fileUrl = (d: MicDump, download = false): string =>
  `/api/mic-dumps/${encodeURIComponent(d.name)}${download ? '?download=1' : ''}`

const fmtDuration = (ms: number): string => `${(ms / 1000).toFixed(1)} s`
const fmtDb = (db: number): string => `${db.toFixed(1)} dBFS`

// Rough health reading for tuning a speaker's mic gain: clipping means too much
// gain (or shouting at it), a low speech-over-noise gap means the noise floor is
// riding up with the gain or the speaker is too far / too quiet.
function verdict(d: MicDump): { label: string, color: 'success' | 'warning' | 'error' } | null {
  const l = d.levels
  if (!l) return null
  if (l.clippedPct >= 0.1) return { label: 'clipping', color: 'error' }
  if (l.speechDb < -40) return { label: 'quiet', color: 'warning' }
  if (l.speechDb - l.noiseDb < 10) return { label: 'noisy', color: 'warning' }
  return { label: 'ok', color: 'success' }
}
</script>

<template>
  <div>
    <header class="mb-8 flex items-start justify-between gap-4">
      <div>
        <h1 class="text-3xl font-bold tracking-tight">
          Mic dumps
        </h1>
        <p class="text-[var(--ui-text-muted)] mt-1">
          The exact audio each speaker sent for a voice turn — 16 kHz mono, as OpenAI heard it. The assistant keeps the newest 20.
        </p>
      </div>
      <UButton
        color="neutral"
        variant="outline"
        icon="i-lucide-refresh-cw"
        class="shrink-0"
        :loading="status === 'pending'"
        @click="refresh()"
      >
        Refresh
      </UButton>
    </header>

    <div
      v-if="(data?.dumps ?? []).length"
      class="space-y-3"
    >
      <UCard
        v-for="d in data!.dumps"
        :key="d.name"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-semibold">{{ d.speaker }}</span>
              <UBadge
                v-if="verdict(d)"
                :color="verdict(d)!.color"
                variant="subtle"
              >
                {{ verdict(d)!.label }}
              </UBadge>
            </div>
            <span class="text-xs text-[var(--ui-text-muted)]">{{ d.recordedAt }} · {{ fmtDuration(d.durationMs) }}</span>
          </div>
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-download"
            class="shrink-0"
            :to="fileUrl(d, true)"
            external
            download
          >
            Download
          </UButton>
        </div>

        <audio
          :src="fileUrl(d)"
          controls
          preload="none"
          class="mt-3 w-full"
        />

        <dl
          v-if="d.levels"
          class="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm"
        >
          <div>
            <dt class="text-xs text-[var(--ui-text-muted)]">
              Speech
            </dt>
            <dd>{{ fmtDb(d.levels.speechDb) }}</dd>
          </div>
          <div>
            <dt class="text-xs text-[var(--ui-text-muted)]">
              Noise floor
            </dt>
            <dd>{{ fmtDb(d.levels.noiseDb) }}</dd>
          </div>
          <div>
            <dt class="text-xs text-[var(--ui-text-muted)]">
              Speech − noise
            </dt>
            <dd>{{ (d.levels.speechDb - d.levels.noiseDb).toFixed(1) }} dB</dd>
          </div>
          <div>
            <dt class="text-xs text-[var(--ui-text-muted)]">
              Peak · clipped
            </dt>
            <dd :class="d.levels.clippedPct >= 0.1 ? 'text-[var(--ui-error)]' : ''">
              {{ fmtDb(d.levels.peakDb) }} · {{ d.levels.clippedPct }}%
            </dd>
          </div>
        </dl>
      </UCard>
    </div>

    <UAlert
      v-else-if="data?.available"
      icon="i-lucide-audio-lines"
      color="neutral"
      variant="subtle"
      title="No dumps yet"
      description="Talk to a speaker — each voice turn is written here once it ends."
    />

    <UAlert
      v-else
      icon="i-lucide-mic-off"
      color="warning"
      variant="subtle"
      title="Mic dumps are off"
      description="Set MIC_DUMP_DIR on the voice-assistant container to turn the debug tap on. This panel reads mic-dumps/ next to the database (or its own MIC_DUMP_DIR)."
    />
  </div>
</template>
