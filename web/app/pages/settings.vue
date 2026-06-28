<script setup lang="ts">
import type { SettableKey, SettingsResponse } from '~/types';

// Reka UI's SelectItem rejects an empty-string value, so an unset (use the
// env/default) enum is represented by this sentinel in the widget and mapped
// back to '' on write.
const DEFAULT_VALUE = '__default__';

const toast = useToast();
const { data: settings, refresh } = await useFetch<SettingsResponse>('/api/settings');

const form = reactive<Record<string, string>>({});
watchEffect(() => {
  if (!settings.value) return;
  for (const k of settings.value.settable) {
    form[k.key] = settings.value.values[k.key] ?? '';
  }
});

const groups: { id: SettableKey['group']; label: string }[] = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'realtime', label: 'Realtime (Voice PE)' },
  { id: 'general', label: 'General' },
];
function keysIn(group: string): SettableKey[] {
  return settings.value?.settable.filter((k) => k.group === group) ?? [];
}

const saving = ref(false);
async function save() {
  saving.value = true;
  try {
    await $fetch('/api/settings', { method: 'PUT', body: { values: { ...form } } });
    toast.add({ title: 'Saved', description: 'Applies after the next restart.', color: 'success' });
    await refresh();
  } catch (e: unknown) {
    toast.add({ title: 'Save failed', description: errMessage(e), color: 'error' });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div>
    <header class="mb-8">
      <h1 class="text-3xl font-bold tracking-tight">Settings</h1>
      <p class="text-[var(--ui-text-muted)] mt-1">Non-secret runtime configuration. Secrets stay in .env.</p>
    </header>

    <div class="space-y-6">
      <UCard v-for="g in groups" :key="g.id">
        <template #header>
          <span class="font-semibold">{{ g.label }}</span>
        </template>
        <div class="grid sm:grid-cols-2 gap-x-6 gap-y-5">
          <UFormField
            v-for="k in keysIn(g.id)"
            :key="k.key"
            :label="k.label"
            :description="k.help"
            :hint="k.key"
          >
            <USwitch
              v-if="k.kind === 'boolean'"
              :model-value="form[k.key] === '1'"
              @update:model-value="(v: boolean) => (form[k.key] = v ? '1' : '')"
            />
            <USelect
              v-else-if="k.kind === 'enum'"
              class="w-full"
              :model-value="form[k.key] === '' ? DEFAULT_VALUE : form[k.key]"
              :items="[
                { label: '(default)', value: DEFAULT_VALUE },
                ...(k.options ?? []).map((o) => ({ label: o, value: o })),
              ]"
              @update:model-value="(v: string) => (form[k.key] = v === DEFAULT_VALUE ? '' : v)"
            />
            <UInput
              v-else
              v-model="form[k.key]" 
              class="w-full"
              :type="k.kind === 'number' ? 'number' : 'text'"
              placeholder="(default)"
            />
          </UFormField>
        </div>
      </UCard>

      <div class="flex justify-end">
        <UButton :loading="saving" icon="i-lucide-save" @click="save">Update</UButton>
      </div>
    </div>
  </div>
</template>
