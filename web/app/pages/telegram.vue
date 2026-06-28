<script setup lang="ts">
import type { TelegramResponse } from '~/types'

useHead({ title: 'Telegram' })

const toast = useToast()
const { data, refresh } = await useFetch<TelegramResponse>('/api/telegram')

const form = reactive<{ enabled: boolean }>({ enabled: false })
watchEffect(() => {
  if (!data.value) return
  form.enabled = data.value.enabled
})

const dirty = computed(() => !!data.value && form.enabled !== data.value.enabled)

const saving = ref(false)
async function save() {
  saving.value = true
  try {
    await $fetch('/api/telegram', { method: 'PUT', body: { enabled: form.enabled } })
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
        Telegram
      </h1>
      <p class="text-[var(--ui-text-muted)] mt-1">
        Chat with the assistant from a Telegram bot — text, voice and photos. Changes apply on the next restart.
      </p>
    </header>

    <div class="space-y-6">
      <UCard>
        <UFormField
          label="Enabled"
          description="Run the Telegram bot. Off by default — installing the integration only stores the token; this is what actually starts the bot."
        >
          <USwitch v-model="form.enabled" />
        </UFormField>
      </UCard>

      <UCard>
        <template #header>
          <h2 class="font-semibold">
            Setup
          </h2>
        </template>
        <div class="space-y-2 text-sm text-[var(--ui-text-muted)]">
          <ul class="space-y-2 list-disc pl-5">
            <li>
              Create a bot with
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noreferrer"
                class="text-[var(--ui-primary)] underline underline-offset-2"
              >@BotFather</a>
              and paste its token into the Telegram
              <NuxtLink
                to="/integrations"
                class="text-[var(--ui-primary)] underline underline-offset-2"
              >integration</NuxtLink>.
            </li>
            <li>
              Bind each allowed chat to a user under
              <NuxtLink
                to="/users"
                class="text-[var(--ui-primary)] underline underline-offset-2"
              >Users</NuxtLink>
              (Telegram device = the chat id). Unknown chats are ignored — there is no auto-provisioning.
            </li>
            <li>
              Turn on the toggle above and restart. The bot runs only with a token configured
              <span class="font-medium text-[var(--ui-text)]">and</span> this toggle on.
            </li>
          </ul>
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
