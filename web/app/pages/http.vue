<script setup lang="ts">
import type { HttpResponse } from '~/types'

useHead({ title: 'HTTP API' })

const toast = useToast()
const { data, refresh } = await useFetch<HttpResponse>('/api/http')

const form = reactive<{ text: boolean, audio: boolean }>({ text: false, audio: false })
watchEffect(() => {
  if (!data.value) return
  form.text = data.value.text
  form.audio = data.value.audio
})

const dirty = computed(() =>
  !!data.value && (form.text !== data.value.text || form.audio !== data.value.audio),
)

const saving = ref(false)
async function save() {
  saving.value = true
  try {
    await $fetch('/api/http', { method: 'PUT', body: { text: form.text, audio: form.audio } })
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

const endpoints = [
  {
    method: 'POST',
    path: '/text',
    body: 'form field text=…',
    returns: '{ response }',
    note: 'Plain one-shot turn. The simplest endpoint — any HTTP client (Apple Shortcut, curl).',
  },
  {
    method: 'POST',
    path: '/audio',
    body: 'raw audio bytes (Content-Type sets the format)',
    returns: '{ response, transcript }',
    note: 'Transcribed (Whisper) then answered.',
  },
  {
    method: 'GET',
    path: '/health',
    body: '—',
    returns: '{ status: "ok" }',
    note: 'No auth, always available (used by the container healthcheck).',
  },
]

const curl = `curl -X POST http://<host>:3000/text \\
  -H "Authorization: Bearer <token>" \\
  --data-urlencode "text=turn on the kitchen light"`
</script>

<template>
  <div>
    <header class="mb-8">
      <h1 class="text-3xl font-bold tracking-tight">
        HTTP API
      </h1>
      <p class="text-[var(--ui-text-muted)] mt-1">
        A small HTTP server for non-Voice-PE clients (Apple Shortcuts, curl, custom bridges).
        <code>/health</code> is always on; each input endpoint is toggled separately.
        Changes apply on the next restart.
      </p>
    </header>

    <div class="space-y-6">
      <UCard>
        <div class="space-y-5">
          <UFormField
            label="Text endpoint (/text)"
            description="POST a form field text=… and get { response }."
          >
            <USwitch v-model="form.text" />
          </UFormField>
          <UFormField
            label="Audio endpoint (/audio)"
            description="POST raw audio bytes; transcribed via Whisper, returns { response, transcript }."
          >
            <USwitch v-model="form.audio" />
          </UFormField>
        </div>
      </UCard>

      <UCard>
        <template #header>
          <h2 class="font-semibold">
            How to integrate
          </h2>
        </template>

        <div class="space-y-5 text-sm">
          <p class="text-[var(--ui-text-muted)]">
            <span class="font-medium text-[var(--ui-text)]">Auth.</span>
            Every request (except <code>/health</code>) needs
            <code>Authorization: Bearer &lt;token&gt;</code>. Mint a token under
            <NuxtLink
              to="/users"
              class="text-[var(--ui-primary)] underline underline-offset-2"
            >Users</NuxtLink>
            (HTTP device) — only its hash is stored; an unknown token gets 401.
            A disabled endpoint returns 404.
          </p>

          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
              <thead class="text-xs uppercase tracking-wide text-[var(--ui-text-muted)]">
                <tr class="border-b border-[var(--ui-border)]">
                  <th class="py-2 pr-3 font-medium">
                    Endpoint
                  </th>
                  <th class="py-2 pr-3 font-medium">
                    Body
                  </th>
                  <th class="py-2 pr-3 font-medium">
                    Returns
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="e in endpoints"
                  :key="e.path"
                  class="border-b border-[var(--ui-border)] align-top"
                >
                  <td class="py-2 pr-3 whitespace-nowrap">
                    <code class="font-medium">{{ e.method }} {{ e.path }}</code>
                  </td>
                  <td class="py-2 pr-3 text-[var(--ui-text-muted)]">
                    {{ e.body }}
                  </td>
                  <td class="py-2 pr-3">
                    <code class="text-[var(--ui-text-muted)]">{{ e.returns }}</code>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <ul class="space-y-1 text-[var(--ui-text-muted)] list-disc pl-5">
            <li
              v-for="e in endpoints"
              :key="e.path"
            >
              <code>{{ e.path }}</code> — {{ e.note }}
            </li>
          </ul>

          <p class="text-[var(--ui-text-muted)]">
            Looking for the Home Assistant Assist endpoint? It's on the
            <NuxtLink
              to="/assist"
              class="text-[var(--ui-primary)] underline underline-offset-2"
            >Assist</NuxtLink>
            page.
          </p>

          <div>
            <p class="font-medium mb-1">
              Example
            </p>
            <pre class="overflow-x-auto bg-[var(--ui-bg-muted)] rounded-md p-3 text-xs"><code>{{ curl }}</code></pre>
          </div>
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
