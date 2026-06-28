<script setup lang="ts">
import type { ToolsResponse } from '~/types'

useHead({ title: 'Tools' })

const toast = useToast()
const { data, refresh } = await useFetch<ToolsResponse>('/api/tools')

const form = reactive<ToolsResponse>({
  memory: true,
  reminders: true,
  weather: { enabled: true, units: 'metric', defaultLocation: '' },
})
watchEffect(() => {
  if (!data.value) return
  form.memory = data.value.memory
  form.reminders = data.value.reminders
  form.weather = { ...data.value.weather }
})

const dirty = computed(() => !!data.value && JSON.stringify(form) !== JSON.stringify(data.value))

const unitItems = [
  { label: 'Metric (°C, km/h)', value: 'metric' },
  { label: 'Imperial (°F, mph)', value: 'imperial' },
]

const saving = ref(false)
async function save() {
  saving.value = true
  try {
    await $fetch('/api/tools', { method: 'PUT', body: { ...form } })
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
        Tools
      </h1>
      <p class="text-[var(--ui-text-muted)] mt-1">
        Built-in agent capabilities. On by default — turn off what you don't want the agent to do.
        Changes apply on the next restart.
      </p>
    </header>

    <div class="space-y-6">
      <UCard>
        <div class="space-y-5">
          <UFormField
            label="Memory"
            description="remember / recall / forget — lets the agent store and recall facts about you."
          >
            <USwitch v-model="form.memory" />
          </UFormField>
          <UFormField
            label="Reminders & schedules"
            description="schedule_action / list / cancel — one-shot reminders and recurring (cron) goals."
          >
            <USwitch v-model="form.reminders" />
          </UFormField>
          <UFormField
            label="Weather"
            description="get_weather — forecast for a place/day via Open-Meteo (no API key)."
          >
            <USwitch v-model="form.weather.enabled" />
          </UFormField>
        </div>
      </UCard>

      <UCard v-if="form.weather.enabled">
        <template #header>
          <h2 class="font-semibold">
            Weather settings
          </h2>
        </template>
        <div class="space-y-5">
          <UFormField
            label="Units"
            description="How temperatures and wind speed are reported."
          >
            <USelect
              v-model="form.weather.units"
              class="w-full sm:w-72"
              :items="unitItems"
            />
          </UFormField>
          <UFormField
            label="Default location"
            description="Used when neither the request nor your profile names a place. Leave blank to require one."
          >
            <UInput
              v-model="form.weather.defaultLocation"
              class="w-full sm:w-72"
              placeholder="e.g. Madrid"
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
