<script setup lang="ts">
import type { RealtimeResponse } from '~/types'

useHead({ title: 'Realtime' })

const toast = useToast()
const { data, refresh } = await useFetch<RealtimeResponse>('/api/realtime')

const form = reactive<{ enabled: boolean, outputPacingMs: string, idleResetMs: string }>({
  enabled: false,
  outputPacingMs: '',
  idleResetMs: '',
})
watchEffect(() => {
  if (!data.value) return
  form.enabled = data.value.enabled
  form.outputPacingMs = data.value.outputPacingMs
  form.idleResetMs = data.value.idleResetMs
})

const dirty = computed(() =>
  !!data.value
  && (form.enabled !== data.value.enabled
    || form.outputPacingMs !== data.value.outputPacingMs
    || form.idleResetMs !== data.value.idleResetMs),
)

const saving = ref(false)
async function save() {
  saving.value = true
  try {
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
              class="w-full sm:w-60"
              placeholder="90000"
            />
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
