<script setup lang="ts">
import type { HttpResponse } from '~/types'

useHead({ title: 'Assist' })

const toast = useToast()
const { data, refresh } = await useFetch<HttpResponse>('/api/http')

const form = reactive<{ assist: boolean }>({ assist: false })
watchEffect(() => {
  if (!data.value) return
  form.assist = data.value.assist
})

const dirty = computed(() => !!data.value && form.assist !== data.value.assist)

const saving = ref(false)
async function save() {
  saving.value = true
  try {
    await $fetch('/api/http', { method: 'PUT', body: { assist: form.assist } })
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
        Assist
      </h1>
      <p class="text-[var(--ui-text-muted)] mt-1">
        The <code>/assist</code> endpoint — a Home Assistant conversation agent backend.
        HA forwards Assist queries here and speaks the reply. Changes apply on the next restart.
      </p>
    </header>

    <div class="space-y-6">
      <UCard>
        <UFormField
          label="Assist endpoint (/assist)"
          description="POST JSON { text, conversation_id? } → { response, continue_conversation }. Keeps a per-conversation session; the reply is phrased for text-to-speech."
        >
          <USwitch v-model="form.assist" />
        </UFormField>
      </UCard>

      <UCard>
        <template #header>
          <h2 class="font-semibold">
            Set it up in Home Assistant
          </h2>
        </template>

        <div class="space-y-4 text-sm text-[var(--ui-text-muted)]">
          <ol class="space-y-2 list-decimal pl-5">
            <li>
              Enable the <code>/assist</code> endpoint above and restart.
            </li>
            <li>
              Mint an HTTP token under
              <NuxtLink
                to="/users"
                class="text-[var(--ui-primary)] underline underline-offset-2"
              >Users</NuxtLink>
              (HTTP device) — HA sends it as <code>Authorization: Bearer &lt;token&gt;</code>.
            </li>
            <li>
              In Home Assistant, install
              <a
                href="https://github.com/maxmaxme/ha-http-conversation-agent"
                target="_blank"
                rel="noreferrer"
                class="text-[var(--ui-primary)] underline underline-offset-2"
              >ha-http-conversation-agent</a>
              via HACS (Custom repository → Integration), then restart HA.
            </li>
            <li>
              Add the integration (Settings → Devices &amp; Services → Add) and point it at
              <code>http://&lt;this-host&gt;:3000/assist</code> with the token from step 2.
            </li>
            <li>
              In your Assist pipeline (Settings → Voice assistants), pick this integration as the
              <span class="font-medium text-[var(--ui-text)]">Conversation agent</span>. It forwards
              each query to <code>/assist</code> and reads <code>continue_conversation</code> back to
              reopen the mic without a new wake word.
            </li>
          </ol>
          <p>
            Note: Voice PE speakers running our firmware bypass this entirely — they stream straight to
            <NuxtLink
              to="/realtime"
              class="text-[var(--ui-primary)] underline underline-offset-2"
            >HA Voice</NuxtLink>. <code>/assist</code> is for HA's own Assist pipeline / other clients.
          </p>
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
