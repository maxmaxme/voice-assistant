<script setup lang="ts">
import type { HttpResponse } from '~/types'

useHead({ title: 'HTTP API' })

const toast = useToast()
const { data, refresh } = await useFetch<HttpResponse>('/api/http')

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
    await $fetch('/api/http', { method: 'PUT', body: { ...form } })
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
    method: 'POST',
    path: '/assist',
    body: 'JSON { text, conversation_id? }',
    returns: '{ response, continue_conversation }',
    note: 'Keeps a per-conversation_id session; continue_conversation hints the client to reopen the mic.',
  },
  {
    method: 'GET',
    path: '/health',
    body: '—',
    returns: '{ status: "ok" }',
    note: 'No auth.',
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
        A small HTTP server for non-Voice-PE clients (Apple Shortcuts, curl, custom bridges). Changes apply on the next restart.
      </p>
    </header>

    <div class="space-y-6">
      <UCard>
        <UFormField
          label="Enabled"
          description="Start the HTTP server (/text, /audio, /assist, /health). Leave off if you only use Telegram or Voice. Listens on HTTP_SERVER_PORT (default 3000)."
        >
          <USwitch v-model="form.enabled" />
        </UFormField>
      </UCard>

      <UCard>
        <template #header>
          <h2 class="font-semibold">
            How to integrate
          </h2>
        </template>

        <div class="space-y-5 text-sm">
          <div>
            <p class="text-[var(--ui-text-muted)]">
              <span class="font-medium text-[var(--ui-text)]">Auth.</span>
              Every request (except <code>/health</code>) needs
              <code>Authorization: Bearer &lt;token&gt;</code>. Mint a token under
              <NuxtLink
                to="/users"
                class="text-[var(--ui-primary)] underline underline-offset-2"
              >Users</NuxtLink>
              (HTTP device) — only its hash is stored; an unknown token gets 401.
            </p>
          </div>

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
            <span class="font-medium text-[var(--ui-text)]">Home Assistant.</span>
            To use <code>/assist</code> as an Assist conversation agent, install
            <a
              href="https://github.com/maxmaxme/ha-http-conversation-agent"
              target="_blank"
              rel="noreferrer"
              class="text-[var(--ui-primary)] underline underline-offset-2"
            >ha-http-conversation-agent</a>
            via HACS and point it at this server — it forwards Assist queries to
            <code>/assist</code> and reads <code>continue_conversation</code> back.
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
