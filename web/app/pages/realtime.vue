<script setup lang="ts">
import type { RealtimeResponse } from '~/types'

useHead({ title: 'Realtime' })

const toast = useToast()
const { data, refresh } = await useFetch<RealtimeResponse>('/api/realtime')

const form = reactive<{ enabled: boolean, outputPacingMs: string, idleResetMs: string, followUpMs: string, requestFollowUpMs: string, followUpChime: boolean, wakeChime: boolean, language: string, transcription: boolean, noiseReduction: string }>({
  enabled: false,
  outputPacingMs: '',
  idleResetMs: '',
  followUpMs: '',
  requestFollowUpMs: '',
  followUpChime: false,
  wakeChime: true,
  language: '',
  transcription: false,
  noiseReduction: 'far_field',
})
watchEffect(() => {
  if (!data.value) return
  form.enabled = data.value.enabled
  form.outputPacingMs = data.value.outputPacingMs
  form.idleResetMs = data.value.idleResetMs
  form.followUpMs = data.value.followUpMs
  form.requestFollowUpMs = data.value.requestFollowUpMs
  form.followUpChime = data.value.followUpChime
  form.wakeChime = data.value.wakeChime
  form.language = data.value.language
  form.transcription = data.value.transcription
  form.noiseReduction = data.value.noiseReduction
})

const dirty = computed(() =>
  !!data.value
  && (form.enabled !== data.value.enabled
    || form.outputPacingMs !== data.value.outputPacingMs
    || form.idleResetMs !== data.value.idleResetMs
    || form.followUpMs !== data.value.followUpMs
    || form.requestFollowUpMs !== data.value.requestFollowUpMs
    || form.followUpChime !== data.value.followUpChime
    || form.wakeChime !== data.value.wakeChime
    || form.language !== data.value.language
    || form.transcription !== data.value.transcription
    || form.noiseReduction !== data.value.noiseReduction),
)

const saving = ref(false)
async function save() {
  saving.value = true
  try {
    // The server canonicalizes numeric fields (locale comma → integer), so a
    // raw form dump is fine; `refresh()` below pulls back the stored value.
    await $fetch('/api/realtime', { method: 'PUT', body: { ...form } })
    toast.add({ title: 'Saved', description: 'Applies after the next restart.', color: 'success' })
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
        The direct-streaming voice path for thin-client voice devices running the
        <a
          href="https://github.com/maxmaxme/home-assistant-voice-pe"
          target="_blank"
          rel="noreferrer"
          class="text-[var(--ui-primary)] underline underline-offset-2"
        >home-assistant-voice-pe</a>
        firmware. Only those devices connect to it.
      </p>
    </header>

    <div class="space-y-6">
      <UCard>
        <UFormField
          label="Enabled"
          description="Start the realtime WebSocket server for voice devices. Leave off if you only use chat. Each device authenticates with its own device token — add one under Users."
        >
          <USwitch v-model="form.enabled" />
        </UFormField>
      </UCard>

      <UCard>
        <template #header>
          <h2 class="font-semibold">
            How it works
          </h2>
        </template>

        <div class="space-y-5 text-sm">
          <p class="text-[var(--ui-text-muted)]">
            A speaker streams microphone audio directly to voice-assistant over a
            WebSocket. The bridge runs an OpenAI <span class="font-medium text-[var(--ui-text)]">Realtime</span>
            session (speech-to-text, the model, and text-to-speech in one duplex
            stream) and calls Home Assistant tools over MCP. HA is only a tool
            backend here — its own voice pipeline is bypassed entirely.
          </p>

          <ul class="space-y-2 text-[var(--ui-text-muted)] list-disc pl-5">
            <li>
              <span class="font-medium text-[var(--ui-text)]">Connection.</span>
              Speakers open <code>ws://&lt;host&gt;:3001/voice</code> (the port is
              <code>REALTIME_PORT</code>, default 3001).
            </li>
            <li>
              <span class="font-medium text-[var(--ui-text)]">Auth.</span>
              Each speaker presents its own bearer token on the WebSocket
              handshake. Register that token as a
              <NuxtLink
                to="/users"
                class="text-[var(--ui-primary)] underline underline-offset-2"
              >Voice device under Users</NuxtLink>
              (only its hash is stored); an unknown token is rejected. The same
              value goes in the firmware's <code>secrets.yaml</code> as
              <code>va_device_token</code>.
            </li>
            <li>
              <span class="font-medium text-[var(--ui-text)]">Firmware.</span>
              Flash the
              <a
                href="https://github.com/maxmaxme/home-assistant-voice-pe"
                target="_blank"
                rel="noreferrer"
                class="text-[var(--ui-primary)] underline underline-offset-2"
              >home-assistant-voice-pe</a>
              firmware to a supported device (see below).
            </li>
            <li>
              <span class="font-medium text-[var(--ui-text)]">Model & voice.</span>
              The realtime model, voice and reasoning effort live on the
              <NuxtLink
                to="/integrations"
                class="text-[var(--ui-primary)] underline underline-offset-2"
              >OpenAI integration</NuxtLink>; the pacing/idle timings are below.
            </li>
            <li>
              <span class="font-medium text-[var(--ui-text)]">To go live.</span>
              Turn on the toggle above and register at least one Voice device —
              then restart.
            </li>
          </ul>
        </div>
      </UCard>

      <UCard>
        <template #header>
          <h2 class="font-semibold">
            Supported devices
          </h2>
        </template>

        <div class="space-y-4 text-sm">
          <p class="text-[var(--ui-text-muted)]">
            Flash the
            <a
              href="https://github.com/maxmaxme/home-assistant-voice-pe"
              target="_blank"
              rel="noreferrer"
              class="text-[var(--ui-primary)] underline underline-offset-2"
            >home-assistant-voice-pe</a>
            firmware to one of these, then register its device token under
            <NuxtLink
              to="/users"
              class="text-[var(--ui-primary)] underline underline-offset-2"
            >Users</NuxtLink>.
          </p>

          <ul class="space-y-3">
            <li>
              <a
                href="https://www.home-assistant.io/voice-pe/"
                target="_blank"
                rel="noreferrer"
                class="font-medium text-[var(--ui-text)] underline underline-offset-2"
              >Home Assistant Voice PE</a>
              <span class="text-[var(--ui-text-muted)]">
                — flash <code>home-assistant-voice.va-direct.yaml</code></span>
            </li>
            <li>
              <a
                href="https://docs.m5stack.com/en/core/Atom_EchoS3R"
                target="_blank"
                rel="noreferrer"
                class="font-medium text-[var(--ui-text)] underline underline-offset-2"
              >M5Stack Atom Echo S3R</a>
              <span class="text-[var(--ui-text-muted)]">
                — flash <code>atom-echo-s3r.va-direct.yaml</code></span>
            </li>
          </ul>
        </div>
      </UCard>

      <UCard v-if="form.enabled">
        <div class="space-y-5">
          <UFormField
            label="Output pacing (ms)"
            description="Re-clock reply audio into fixed frames of this many ms (0 = forward verbatim). Smooths bursty playback. Blank = default (20)."
          >
            <UInput
              v-model="form.outputPacingMs"
              type="number"
              min="0"
              step="1"
              class="w-full sm:w-60"
              placeholder="20"
            />
          </UFormField>

          <UFormField
            label="Idle reset (ms)"
            description="Reset the conversation session after this many ms of silence. Blank = default (90000)."
          >
            <UInput
              v-model="form.idleResetMs"
              type="number"
              min="0"
              step="1"
              class="w-full sm:w-60"
              placeholder="90000"
            />
          </UFormField>

          <UFormField
            label="Follow-up window (ms)"
            description="After any spoken reply, reopen the mic for this many ms so the user can continue without a wake word. 0 disables it (wake word every turn). Not opened after wait_for_user. Blank = default (8000)."
          >
            <UInput
              v-model="form.followUpMs"
              type="number"
              min="0"
              step="1"
              class="w-full sm:w-60"
              placeholder="8000"
            />
          </UFormField>

          <UFormField
            label="Question follow-up window (ms)"
            description="When the assistant explicitly asks a question (request_follow_up), always reopen the mic for this many ms — even if the window above is 0, since a question needs an answer. 0 disables it too. Blank = default (10000)."
          >
            <UInput
              v-model="form.requestFollowUpMs"
              type="number"
              min="0"
              step="1"
              class="w-full sm:w-60"
              placeholder="10000"
            />
          </UFormField>

          <UFormField
            label="Follow-up chime"
            description="Play a chime when the assistant explicitly asks you a question and waits for your answer. The ambient after-every-reply window stays silent regardless."
          >
            <USwitch v-model="form.followUpChime" />
          </UFormField>

          <UFormField
            label="Spoken language"
            description="Two-letter code of the language spoken to the device (ru, en, es…). Tells the model which language to expect — without it a non-English household gets heard as accented English — and pins the transcription language. Blank = auto-detect."
          >
            <UInput
              v-model="form.language"
              class="w-full sm:w-60"
              placeholder="auto"
            />
          </UFormField>

          <UFormField
            label="Noise reduction"
            description="OpenAI's server-side input filter, applied before voice detection. far_field for across-the-room speakers, near_field for a headset or close mic, off to send raw audio."
          >
            <USelect
              v-model="form.noiseReduction"
              class="w-full sm:w-60"
              :items="['far_field', 'near_field', 'off']"
            />
          </UFormField>

          <UFormField
            label="Transcribe user audio"
            description="Run Whisper over the user's audio to log what was heard. Diagnostics only — the model does its own speech recognition regardless, so this is extra cost per turn."
          >
            <USwitch v-model="form.transcription" />
          </UFormField>

          <UFormField
            label="Wake sound"
            description="Play the local beep on the device when the wake word fires. Pushed to the device on connect (applies after it reconnects)."
          >
            <USwitch v-model="form.wakeChime" />
          </UFormField>
        </div>
      </UCard>

      <div class="flex justify-end">
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
