<script setup lang="ts">
import type { PromptRow } from '~/types';

const toast = useToast();
const { data: promptList, refresh } = await useFetch<{ prompts: PromptRow[] }>('/api/prompts');

const selected = ref<string | null>(null);
const content = ref('');

watchEffect(() => {
  const list = promptList.value?.prompts ?? [];
  if (!selected.value && list.length) {
    selected.value = list[0]!.name;
  }
});
watch(selected, (name) => {
  content.value = promptList.value?.prompts.find((p) => p.name === name)?.content ?? '';
});

const saving = ref(false);
async function save() {
  if (!selected.value) return;
  saving.value = true;
  try {
    await $fetch(`/api/prompts/${selected.value}`, {
      method: 'PUT',
      body: { content: content.value },
    });
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
      <h1 class="text-3xl font-bold tracking-tight">Prompts</h1>
      <p class="text-[var(--ui-text-muted)] mt-1">Edit the assistant's prompt text. Seeded from the bundled defaults.</p>
    </header>

    <UCard v-if="(promptList?.prompts ?? []).length">
      <div class="space-y-4">
        <UFormField label="Prompt" hint="name">
          <USelect
            v-model="selected"
            class="w-full sm:w-80"
            :items="(promptList?.prompts ?? []).map((p) => p.name)"
            placeholder="Select a prompt"
          />
        </UFormField>
        <UTextarea v-model="content" :rows="22" class="w-full font-mono" :disabled="!selected" />
        <div class="flex justify-end">
          <UButton :loading="saving" :disabled="!selected" icon="i-lucide-save" @click="save"
            >Save prompt</UButton
          >
        </div>
      </div>
    </UCard>

    <UAlert
      v-else
      icon="i-lucide-database"
      color="warning"
      variant="subtle"
      title="No prompts yet"
      description="Start the voice-assistant process once against this database so it seeds the editable prompts."
    />
  </div>
</template>
