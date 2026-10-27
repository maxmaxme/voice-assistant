<script setup lang="ts">
import type { RealtimeResponse } from '~/types'

useHead({ title: 'Realtime' })

const toast = useToast()
const { data, refresh } = await useFetch<RealtimeResponse>('/api/realtime')

const form = reactive<RealtimeResponse>({
  idleResetMs: '',
  requestFollowUpMs: '',
  followUpChime: false,
  wakeChime: true,
  language: '',
  transcription: false,
  transcriptionModel: 'whisper-1',
  noiseReduction: 'far_field',
  turnDetection: 'server_vad',
})
watchEffect(() => {
  if (!data.value) return
  Object.assign(form, data.value)
})

const dirty = computed(() =>
  !!data.value
  && (Object.keys(form) as Array<keyof RealtimeResponse>).some(k => form[k] !== data.value![k]),
)

// The API stores durations in ms; people think in seconds. These wrappers show
// seconds and write ms back, keeping '' (= built-in default) as ''. Anything
// unparseable is passed through raw so the server's validation names the field.
type MsKey = 'idleResetMs' | 'requestFollowUpMs'
function seconds(key: MsKey) {
  return computed<string>({
    get: () => (form[key] === '' ? '' : String(Number(form[key]) / 1000)),
    set: (v: string | number | null | undefined) => {
      if (v === '' || v === null || v === undefined) {
        form[key] = ''
        return
      }
      const n = typeof v === 'number' ? v : Number(v.replace(',', '.'))
      form[key] = Number.isFinite(n) ? String(Math.round(n * 1000)) : String(v)
    },
  })
}
const requestFollowUpSec = seconds('requestFollowUpMs')
const idleResetSec = seconds('idleResetMs')

const turnDetectionItems = [
  { label: 'After a short pause', value: 'server_vad', description: 'Answers after ~1 s of silence' },
  { label: 'Smart — patient', value: 'semantic_low', description: 'Waits up to 8 s if you sound unfinished' },
  { label: 'Smart — balanced', value: 'semantic_medium', description: 'Waits up to 4 s' },
  { label: 'Smart — quick', value: 'semantic_high', description: 'Waits up to 2 s' },
]

const noiseReductionItems = [
  { label: 'Speaker across the room', value: 'far_field', description: 'Best for smart speakers' },
  { label: 'Close mic', value: 'near_field', description: 'Headset or a mic next to you' },
  { label: 'Off', value: 'off', description: 'Raw audio, no filtering' },
]

const transcriptionModelItems = [
  { label: 'gpt-4o-mini-transcribe', value: 'gpt-4o-mini-transcribe', description: 'Accurate and cheap' },
  { label: 'gpt-4o-transcribe', value: 'gpt-4o-transcribe', description: 'Most accurate, costs more' },
  { label: 'whisper-1', value: 'whisper-1', description: 'Older, invents text on silence' },
]

const devices = [
  { name: 'Home Assistant Voice PE', href: 'https://www.home-assistant.io/voice-pe/', config: 'home-assistant-voice.va-direct.yaml' },
  { name: 'M5Stack Atom Echo S3R', href: 'https://docs.m5stack.com/en/core/Atom_EchoS3R', config: 'atom-echo-s3r.va-direct.yaml' },
]

// Setup is a one-off, so it starts folded away.
const setupOpen = ref(false)
const advancedOpen = ref(false)

const saving = ref(false)
async function save() {
  saving.value = true
  try {
    // The server canonicalizes numeric fields (locale comma → integer), so a
    // raw form dump is fine; `refresh()` below pulls back the stored value.
    await $fetch('/api/realtime', { method: 'PUT', body: { ...form } })
    toast.add({ title: 'Saved', description: 'Applies on each speaker\'s next session.', color: 'success' })
    await refresh()
  }
  catch (e: unknown) {
    toast.add({ title: 'Save failed', description: errMessage(e), color: 'error' })
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <div>
    <header class="mb-8">
      <h1 class="text-3xl font-bold tracking-tight">
        Realtime
      </h1>
      <p class="text-[var(--ui-text-muted)] mt-1">
        How your voice speakers talk to the assistant. The speaker streams your voice to the
        voice front-end (pipecat-voice); one OpenAI Realtime session listens, thinks and answers
        out loud, with its tools and prompt served from here. Changes apply on each speaker's
        next session — after its idle reset, no restart needed.
      </p>
    </header>

    <div class="flex flex-col gap-6">
      <UCard class="order-2">
        <template #header>
          <button
            type="button"
            class="flex w-full items-center justify-between gap-2 text-left"
            @click="setupOpen = !setupOpen"
          >
            <span class="flex items-center gap-2">
              <UIcon
                name="i-lucide-plug-zap"
                class="size-5 text-[var(--ui-text-muted)]"
              />
              <h2 class="font-semibold">Connect a speaker</h2>
            </span>
            <UIcon
              name="i-lucide-chevron-down"
              class="size-5 text-[var(--ui-text-muted)] transition-transform"
              :class="setupOpen ? 'rotate-180' : ''"
            />
          </button>
        </template>

        <template
          v-if="setupOpen"
          #default
        >
          <ol class="space-y-5 text-sm">
            <li class="flex gap-3">
              <span class="step">1</span>
              <div class="space-y-2">
                <p class="font-medium">
                  Flash the firmware
                </p>
                <p class="text-[var(--ui-text-muted)]">
                  Build the matching config from
                  <a
                    href="https://github.com/maxmaxme/home-assistant-voice-pe"
                    target="_blank"
                    rel="noreferrer"
                    class="text-[var(--ui-primary)] underline underline-offset-2"
                  >home-assistant-voice-pe</a>:
                </p>
                <ul class="space-y-1">
                  <li
                    v-for="d in devices"
                    :key="d.config"
                  >
                    <a
                      :href="d.href"
                      target="_blank"
                      rel="noreferrer"
                      class="font-medium underline underline-offset-2"
                    >{{ d.name }}</a>
                    <span class="text-[var(--ui-text-muted)]"> → <code>{{ d.config }}</code></span>
                  </li>
                </ul>
              </div>
            </li>
            <li class="flex gap-3">
              <span class="step">2</span>
              <div class="space-y-1">
                <p class="font-medium">
                  Register its token
                </p>
                <p class="text-[var(--ui-text-muted)]">
                  Each speaker has its own token, set as <code>va_device_token</code> in the
                  firmware's <code>secrets.yaml</code>. Add the same value as a
                  <NuxtLink
                    to="/users"
                    class="text-[var(--ui-primary)] underline underline-offset-2"
                  >Voice device under Users</NuxtLink>
                  — speakers with an unknown token are turned away. This part applies instantly.
                </p>
              </div>
            </li>
            <li class="flex gap-3">
              <span class="step">3</span>
              <div class="space-y-1">
                <p class="font-medium">
                  Point it at the voice front-end
                </p>
                <p class="text-[var(--ui-text-muted)]">
                  Speakers connect to pipecat-voice at <code>ws://&lt;host&gt;:3002/voice</code>
                  (the firmware's <code>va_url</code>). The model, voice and reasoning effort
                  are set on the
                  <NuxtLink
                    to="/integrations"
                    class="text-[var(--ui-primary)] underline underline-offset-2"
                  >OpenAI integration</NuxtLink>.
                </p>
              </div>
            </li>
          </ol>
        </template>
      </UCard>

      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-messages-square"
              class="size-5 text-[var(--ui-text-muted)]"
            />
            <h2 class="font-semibold">
              Conversation
            </h2>
          </div>
        </template>

        <div class="space-y-5">
          <UFormField
            label="Your language"
            description="Two-letter code of the language you speak to the speakers (ru, en, es…). Without it the model may hear you as accented English."
          >
            <UInput
              v-model="form.language"
              class="w-full sm:w-60"
              placeholder="auto-detect"
            />
          </UFormField>

          <UFormField
            label="Keep listening after a question"
            description="When the assistant asks you something, the mic stays open this long for your answer. 0 = always say the wake word."
          >
            <UInput
              v-model="requestFollowUpSec"
              type="number"
              min="0"
              step="0.5"
              class="w-full sm:w-60"
              placeholder="10"
            >
              <template #trailing>
                <span class="text-xs text-[var(--ui-text-muted)]">sec</span>
              </template>
            </UInput>
          </UFormField>

          <UFormField
            label="Start a new conversation after"
            description="After this long with no talking, the assistant forgets the current exchange and your next request starts fresh."
          >
            <UInput
              v-model="idleResetSec"
              type="number"
              min="0"
              step="1"
              class="w-full sm:w-60"
              placeholder="90"
            >
              <template #trailing>
                <span class="text-xs text-[var(--ui-text-muted)]">sec</span>
              </template>
            </UInput>
          </UFormField>
        </div>
      </UCard>

      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-ear"
              class="size-5 text-[var(--ui-text-muted)]"
            />
            <h2 class="font-semibold">
              Hearing you
            </h2>
          </div>
        </template>

        <div class="space-y-5">
          <UFormField
            label="When you've finished speaking"
            description="How the assistant decides your turn is over. The smart modes judge from your words whether you're done, so a pause mid-sentence doesn't cut you off; a plain pause is the most predictable."
          >
            <USelect
              v-model="form.turnDetection"
              class="w-full sm:w-80"
              :items="turnDetectionItems"
            />
          </UFormField>

          <UFormField
            label="Noise filter"
            description="Cleans up the mic audio before the assistant listens to it."
          >
            <USelect
              v-model="form.noiseReduction"
              class="w-full sm:w-80"
              :items="noiseReductionItems"
            />
          </UFormField>
        </div>
      </UCard>

      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-bell"
              class="size-5 text-[var(--ui-text-muted)]"
            />
            <h2 class="font-semibold">
              Sounds
            </h2>
          </div>
        </template>

        <div class="space-y-5">
          <UFormField
            label="Wake beep"
            description="Beep when the speaker hears the wake word."
          >
            <USwitch v-model="form.wakeChime" />
          </UFormField>

          <UFormField
            label="Question chime"
            description="Chime when the assistant has asked you a question and is waiting for the answer."
          >
            <USwitch v-model="form.followUpChime" />
          </UFormField>
        </div>
      </UCard>

      <UCard>
        <template #header>
          <button
            type="button"
            class="flex w-full items-center justify-between gap-2 text-left"
            @click="advancedOpen = !advancedOpen"
          >
            <span class="flex items-center gap-2">
              <UIcon
                name="i-lucide-sliders-horizontal"
                class="size-5 text-[var(--ui-text-muted)]"
              />
              <h2 class="font-semibold">Advanced &amp; debugging</h2>
            </span>
            <UIcon
              name="i-lucide-chevron-down"
              class="size-5 text-[var(--ui-text-muted)] transition-transform"
              :class="advancedOpen ? 'rotate-180' : ''"
            />
          </button>
        </template>

        <template
          v-if="advancedOpen"
          #default
        >
          <div class="space-y-5">
            <UFormField
              label="Log what I say"
              description="Write a text transcript of each request to the logs. The assistant doesn't need it to understand you — it's an extra paid pass per request, so turn it on only while debugging."
            >
              <USwitch v-model="form.transcription" />
            </UFormField>

            <UFormField
              v-if="form.transcription"
              label="Transcription model"
            >
              <USelect
                v-model="form.transcriptionModel"
                class="w-full sm:w-80"
                :items="transcriptionModelItems"
              />
            </UFormField>
          </div>
        </template>
      </UCard>

      <div class="order-1 flex justify-end">
        <UButton
          :loading="saving"
          :disabled="!dirty"
          icon="i-lucide-save"
          @click="save"
        >
          Save
        </UButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.step {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 9999px;
  background: var(--ui-bg-elevated);
  font-size: 0.75rem;
  font-weight: 600;
}
</style>
