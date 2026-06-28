<script setup lang="ts">
import type { IntegrationDef, InstalledIntegration, IntegrationsResponse } from '~/types'

useHead({ title: 'Integrations' })

const toast = useToast()
const { data, refresh } = await useFetch<IntegrationsResponse>('/api/integrations')

const formOpen = ref(false)
const formMode = ref<'install' | 'edit'>('install')
const formDef = ref<IntegrationDef>()
const form = reactive<{ values: Record<string, string>, secretsSet: Record<string, boolean> }>({
  values: {},
  secretsSet: {},
})
const saving = ref(false)
// Set from a failed save (server rejects with the connection-test reason).
const testResult = ref<{ ok: boolean, message: string } | null>(null)

function openInstall(def: IntegrationDef) {
  formMode.value = 'install'
  formDef.value = def
  form.values = Object.fromEntries(def.fields.map(f => [f.key, '']))
  form.secretsSet = {}
  testResult.value = null
  formOpen.value = true
}
function openEdit(inst: InstalledIntegration) {
  formMode.value = 'edit'
  formDef.value = inst.def
  form.values = Object.fromEntries(inst.def.fields.map(f => [f.key, inst.config[f.key] ?? '']))
  form.secretsSet = { ...inst.secretsSet }
  testResult.value = null
  formOpen.value = true
}

async function submit() {
  const def = formDef.value
  if (!def) return
  saving.value = true
  try {
    if (formMode.value === 'install') {
      await $fetch('/api/integrations', { method: 'POST', body: { type: def.type, config: { ...form.values } } })
    }
    else {
      await $fetch(`/api/integrations/${def.type}`, { method: 'PUT', body: { config: { ...form.values } } })
    }
    toast.add({ title: formMode.value === 'install' ? 'Installed' : 'Saved', color: 'success' })
    formOpen.value = false
    await refresh()
  }
  catch (e: unknown) {
    // The server re-runs the connection test and rejects (422) on failure —
    // surface it inline so it's clear why nothing was saved.
    testResult.value = { ok: false, message: errMessage(e) }
  }
  finally {
    saving.value = false
  }
}

const deleteTarget = ref<InstalledIntegration>()
const deleting = ref(false)
async function confirmDelete() {
  const def = deleteTarget.value?.def
  if (!def) return
  deleting.value = true
  try {
    await $fetch(`/api/integrations/${def.type}`, { method: 'DELETE' })
    toast.add({ title: 'Removed', color: 'success' })
    deleteTarget.value = undefined
    await refresh()
  }
  catch (e: unknown) {
    toast.add({ title: 'Remove failed', description: errMessage(e), color: 'error' })
  }
  finally {
    deleting.value = false
  }
}

function placeholderFor(key: string): string | undefined {
  if (formMode.value === 'edit' && form.secretsSet[key]) return '•••••••• (leave blank to keep)'
  return formDef.value?.fields.find(f => f.key === key)?.placeholder
}

const togglingType = ref<string | null>(null)
async function setEnabled(inst: InstalledIntegration, enabled: boolean) {
  togglingType.value = inst.def.type
  try {
    await $fetch(`/api/integrations/${inst.def.type}/enabled`, { method: 'POST', body: { enabled } })
    toast.add({ title: enabled ? 'Enabled' : 'Disabled', color: 'success' })
  }
  catch (e: unknown) {
    // e.g. enabling a broken connection (422) — surface and leave it disabled.
    toast.add({ title: 'Failed', description: errMessage(e), color: 'error' })
  }
  finally {
    togglingType.value = null
    await refresh() // reflect the actual stored state (reverts an optimistic flip)
  }
}
</script>

<template>
  <div>
    <header class="mb-8">
      <h1 class="text-3xl font-bold tracking-tight">
        Integrations
      </h1>
      <p class="text-[var(--ui-text-muted)] mt-1">
        Connect external services. Changes apply on the next voice-assistant restart.
      </p>
    </header>

    <section
      v-if="(data?.installed ?? []).length"
      class="mb-10"
    >
      <h2 class="text-sm font-semibold uppercase tracking-wide text-[var(--ui-text-muted)] mb-3">
        Installed
      </h2>
      <div class="space-y-3">
        <UCard
          v-for="inst in data!.installed"
          :key="inst.def.type"
        >
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="font-semibold">{{ inst.def.title }}</span>
                <UBadge
                  :color="inst.enabled ? 'success' : 'neutral'"
                  variant="subtle"
                >
                  {{ inst.enabled ? 'Enabled' : 'Disabled' }}
                </UBadge>
              </div>
              <p class="text-sm text-[var(--ui-text-muted)] mt-1">
                {{ inst.def.description }}
              </p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <USwitch
                :model-value="inst.enabled"
                :loading="togglingType === inst.def.type"
                @update:model-value="(v: boolean) => setEnabled(inst, v)"
              />
              <UButton
                color="neutral"
                variant="outline"
                icon="i-lucide-pencil"
                @click="openEdit(inst)"
              >
                Edit
              </UButton>
              <UButton
                color="error"
                variant="ghost"
                icon="i-lucide-trash-2"
                @click="deleteTarget = inst"
              >
                Remove
              </UButton>
            </div>
          </div>
        </UCard>
      </div>
    </section>

    <section>
      <h2 class="text-sm font-semibold uppercase tracking-wide text-[var(--ui-text-muted)] mb-3">
        Available
      </h2>
      <div
        v-if="(data?.available ?? []).length"
        class="space-y-3"
      >
        <UCard
          v-for="def in data!.available"
          :key="def.type"
        >
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <span class="font-semibold">{{ def.title }}</span>
              <p class="text-sm text-[var(--ui-text-muted)] mt-1">
                {{ def.description }}
              </p>
            </div>
            <UButton
              icon="i-lucide-plus"
              class="shrink-0"
              @click="openInstall(def)"
            >
              Install
            </UButton>
          </div>
        </UCard>
      </div>
      <p
        v-else
        class="text-sm text-[var(--ui-text-muted)]"
      >
        All available integrations are installed.
      </p>
    </section>

    <UModal
      v-model:open="formOpen"
      :title="formMode === 'install' ? `Install ${formDef?.title}` : `Edit ${formDef?.title}`"
    >
      <template #body>
        <div class="space-y-4">
          <UFormField
            v-for="f in formDef?.fields ?? []"
            :key="f.key"
            :label="f.label"
            :description="f.help"
            :required="f.required"
          >
            <UInput
              v-model="form.values[f.key]"
              class="w-full"
              :type="f.type === 'password' ? 'password' : 'text'"
              :placeholder="placeholderFor(f.key)"
            />
          </UFormField>

          <UAlert
            v-if="testResult"
            :color="testResult.ok ? 'success' : 'error'"
            variant="subtle"
            :icon="testResult.ok ? 'i-lucide-check' : 'i-lucide-x'"
            :title="testResult.message"
          />
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            color="neutral"
            variant="ghost"
            @click="formOpen = false"
          >
            Cancel
          </UButton>
          <UButton
            :loading="saving"
            @click="submit"
          >
            {{ formMode === 'install' ? 'Install' : 'Save' }}
          </UButton>
        </div>
      </template>
    </UModal>

    <UModal
      :open="!!deleteTarget"
      title="Remove integration?"
      :description="`This removes '${deleteTarget?.def.title}' and its stored configuration. Applies after the next restart.`"
      @update:open="(v: boolean) => { if (!v) deleteTarget = undefined }"
    >
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            color="neutral"
            variant="ghost"
            @click="deleteTarget = undefined"
          >
            Cancel
          </UButton>
          <UButton
            color="error"
            icon="i-lucide-trash-2"
            :loading="deleting"
            @click="confirmDelete"
          >
            Remove
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
