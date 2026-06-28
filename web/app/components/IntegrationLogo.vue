<script setup lang="ts">
const props = defineProps<{
  type: string
  alt: string
  size?: number
}>()

// Logos live in app/assets (Vite-bundled, not static), so their final URLs are
// resolved at build time here rather than referenced by a server-sent path.
// Maps the integration `type` to the bundled file basename; unmapped types fall
// back to a generic icon.
const FILE_BY_TYPE: Record<string, string> = {
  'home-assistant': 'ha',
  'openai': 'chatgpt',
  'telegram': 'Telegram_logo.svg',
}
const urls = import.meta.glob('../assets/integrations/*.png', { eager: true, import: 'default' })
const byFile: Record<string, string> = {}
for (const [path, url] of Object.entries(urls)) {
  const base = path.split('/').pop()!.replace(/\.png$/, '')
  byFile[base] = url as string
}

const src = computed(() => byFile[FILE_BY_TYPE[props.type] ?? ''])
const px = computed(() => `${props.size ?? 40}px`)
</script>

<template>
  <div
    class="shrink-0 flex items-center justify-center rounded-lg bg-[var(--ui-bg-elevated)] overflow-hidden"
    :style="{ width: px, height: px }"
  >
    <img
      v-if="src"
      :src="src"
      :alt="alt"
      class="w-full h-full object-contain"
    >
    <UIcon
      v-else
      name="i-lucide-puzzle"
      class="size-5 text-[var(--ui-text-muted)]"
    />
  </div>
</template>
