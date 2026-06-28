<script setup lang="ts">
import type { RealtimeResponse } from '~/types'

useHead({ title: 'HA Voice' })

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
        HA Voice
      </h1>
      <p class="text-[var(--ui-text-muted)] mt-1">
        The direct-streaming voice path for
        <a
          href="https://www.home-assistant.io/voice-pe/"
          target="_blank"
          rel="noreferrer"
          class="text-[var(--ui-primary)] underline underline-offset-2"
        >Home Assistant Voice PE</a>
        speakers running the
        <a
          href="https://github.com/maxmaxme/home-assistant-voice-pe"
          target="_blank"
          rel="noreferrer"
          class="text-[var(--ui-primary)] underline underline-offset-2"
        >home-assistant-voice-pe</a>
        firmware. Only those speakers connect to it. Changes apply on the next restart.
      </p>
    </header>

    <div class="space-y-6">
      <UCard>
        <UFormField
          label="Enabled"
          description="Start the realtime WebSocket server for Voice PE speakers. Leave off if you only use chat. Each speaker authenticates with its own device token — add one under Users."
        >
          <USwitch v-model="form.enabled" />
        </UFormField>
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
