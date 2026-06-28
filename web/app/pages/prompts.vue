<script setup lang="ts">
import type { PromptRow } from '~/types'

const toast = useToast()
const route = useRoute()
const router = useRouter()
const { data: promptList, refresh } = await useFetch<{ prompts: PromptRow[] }>('/api/prompts')

// Initialise synchronously (so content is populated during SSR) from the
// `?prompt=` query when valid — survives F5 — else the first prompt.
const initial = promptList.value?.prompts ?? []
const names = initial.map(p => p.name)
const queryName = typeof route.query.prompt === 'string' ? route.query.prompt : undefined
const startName = queryName && names.includes(queryName) ? queryName : initial[0]?.name
const selected = ref<string | undefined>(startName)
const content = ref(initial.find(p => p.name === startName)?.content ?? '')

const selectedRow = computed(() =>
  promptList.value?.prompts.find(p => p.name === selected.value),
)
const savedContent = computed(() => selectedRow.value?.content ?? '')
const defaultContent = computed(() => selectedRow.value?.defaultContent ?? '')
// vs default → drives the diff, badge and reset. vs saved → drives Save.
const isModified = computed(() => content.value !== defaultContent.value)
const isDirty = computed(() => content.value !== savedContent.value)
const diff = computed(() => lineDiff(defaultContent.value, content.value))

// Grouped select: base prompts on top, then tools, then HA suffixes. Labels
// are non-selectable group headings; values stay the full prompt name.
const groups: { label: string, match: (n: string) => boolean }[] = [
  { label: 'Base', match: n => !n.includes('/') },
  { label: 'Tools', match: n => n.startsWith('tools/') },
  { label: 'Home Assistant', match: n => n.startsWith('ha-suffix/') },
]
// Options are plain strings (the full prompt name = the value); label/separator
// objects form the group headings. This is the shape USelect infers a string
// model from — mixing in {label,value} objects breaks that inference.
type SelectItem = { type: 'label', label: string } | { type: 'separator' } | string
const selectItems = computed<SelectItem[]>(() => {
  const out: SelectItem[] = []
  for (const g of groups) {
    const inGroup = names.filter(g.match)
    if (!inGroup.length) continue
    if (out.length) out.push({ type: 'separator' })
    out.push({ type: 'label', label: g.label })
    out.push(...inGroup)
  }
  return out
})

// Switching prompts loads its saved content and reflects the choice in the URL.
watch(selected, (n) => {
  content.value = savedContent.value
  router.replace({ query: { ...route.query, prompt: n } })
})

const saving = ref(false)
async function save() {
  if (!selected.value) return
  saving.value = true
  try {
    await $fetch('/api/prompts', {
      method: 'PUT',
      body: { name: selected.value, content: content.value },
    })
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

const confirmReset = ref(false)
const resetting = ref(false)
async function resetToDefault() {
  if (!selected.value) return
  resetting.value = true
  try {
    await $fetch('/api/prompts/reset', { method: 'POST', body: { name: selected.value } })
    await refresh()
    content.value = selectedRow.value?.content ?? ''
    toast.add({ title: 'Reset to default', description: 'Applies after the next restart.', color: 'success' })
    confirmReset.value = false
  }
  catch (e: unknown) {
    toast.add({ title: 'Reset failed', description: errMessage(e), color: 'error' })
  }
  finally {
    resetting.value = false
  }
}
</script>

<template>
  <div>
    <header class="mb-8">
      <h1 class="text-3xl font-bold tracking-tight">
        Prompts
      </h1>
      <p class="text-[var(--ui-text-muted)] mt-1">
        Edit the assistant's prompt text. Each has a built-in default you can always restore.
      </p>
    </header>

    <UCard v-if="(promptList?.prompts ?? []).length">
      <div class="space-y-4">
        <UFormField
          label="Prompt"
          hint="name"
        >
          <div class="flex items-center gap-2">
            <USelect
              v-model="selected"
              class="w-full sm:w-80"
              :items="selectItems"
              placeholder="Select a prompt"
            />
            <UBadge
              :color="isModified ? 'warning' : 'neutral'"
              variant="subtle"
            >
              {{ isModified ? 'Modified' : 'Default' }}
            </UBadge>
          </div>
        </UFormField>

        <UTextarea
          v-model="content"
          autoresize
          :rows="10"
          class="w-full font-mono"
          :disabled="!selected"
        />

        <div v-if="isModified">
          <p class="text-sm font-medium mb-1">
            Diff vs default
          </p>
          <div class="rounded-md ring ring-default overflow-x-auto bg-elevated/30 text-xs font-mono leading-relaxed py-2">
            <div
              v-for="(l, idx) in diff"
              :key="idx"
              class="px-3 whitespace-pre-wrap"
              :class="{
                'bg-green-500/15 text-green-700 dark:text-green-300': l.type === 'add',
                'bg-red-500/15 text-red-700 dark:text-red-300': l.type === 'del',
                'text-[var(--ui-text-dimmed)]': l.type === 'same',
              }"
            >
              {{ l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  ' }}{{ l.text }}
            </div>
          </div>
        </div>

        <div class="flex justify-between">
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-rotate-ccw"
            :disabled="!selected || !isModified"
            @click="confirmReset = true"
          >
            Reset to default
          </UButton>
          <UButton
            :loading="saving"
            :disabled="!selected || !isDirty"
            icon="i-lucide-save"
            @click="save"
          >
            Save prompt
          </UButton>
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

    <UModal
      v-model:open="confirmReset"
      title="Reset to default?"
      :description="`This replaces the current text of '${selected}' with its built-in default. Applies after the next restart.`"
    >
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            color="neutral"
            variant="ghost"
            @click="confirmReset = false"
          >
            Cancel
          </UButton>
          <UButton
            color="error"
            icon="i-lucide-rotate-ccw"
            :loading="resetting"
            @click="resetToDefault"
          >
            Reset
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
