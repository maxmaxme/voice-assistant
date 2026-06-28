<script setup lang="ts">
const links = [
  { label: 'Settings', icon: 'i-lucide-sliders-horizontal', to: '/settings' },
  { label: 'HA Voice', icon: 'i-lucide-radio', to: '/realtime' },
  { label: 'Prompts', icon: 'i-lucide-message-square-text', to: '/prompts' },
  { label: 'Integrations', icon: 'i-lucide-plug', to: '/integrations' },
  { label: 'Users', icon: 'i-lucide-users', to: '/users' },
]

const route = useRoute()
const isActive = (to: string): boolean => route.path === to || route.path.startsWith(to + '/')

// `import.meta.dev` is true in the dev server, false in the built prod image —
// recolour the sidebar so a local tab is never confused with the Pi.
const isLocal = import.meta.dev
</script>

<template>
  <div class="min-h-screen flex bg-[var(--ui-bg-muted)] text-[var(--ui-text)]">
    <aside
      class="w-60 shrink-0 text-white flex flex-col"
      :class="isLocal ? 'bg-emerald-700' : 'bg-violet-700'"
    >
      <div class="flex items-center gap-2.5 px-6 h-16">
        <UIcon
          name="i-lucide-mic"
          class="size-6"
        />
        <span class="text-lg font-semibold tracking-tight">Voice Assistant</span>
        <span
          v-if="isLocal"
          class="ml-auto text-[10px] font-bold tracking-wider bg-black/25 rounded px-1.5 py-0.5"
        >LOCAL</span>
      </div>
      <nav class="flex-1 px-3 mt-2 space-y-1">
        <NuxtLink
          v-for="l in links"
          :key="l.to"
          :to="l.to"
          class="flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors"
          :class="isActive(l.to) ? 'bg-white/15 font-medium' : 'text-white/80 hover:bg-white/10'"
        >
          <UIcon
            :name="l.icon"
            class="size-5"
          />
          <span>{{ l.label }}</span>
        </NuxtLink>
      </nav>
      <div class="px-3 py-4 space-y-2">
        <RestartButton />
        <p class="px-3 text-xs text-white/45 leading-relaxed">
          Changes apply on the next voice-assistant restart.
        </p>
      </div>
    </aside>

    <main class="flex-1 min-w-0 overflow-auto">
      <div class="max-w-4xl mx-auto px-8 py-10">
        <slot />
      </div>
    </main>
  </div>
</template>
