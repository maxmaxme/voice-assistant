<script setup lang="ts">
const { data: cap } = await useFetch<{ available: boolean }>('/api/restart')

interface ConfigStatus {
  loadedAt: number | null
  lastEditAt: number | null
  upToDate: boolean | null
}
const { data: status, refresh: refreshStatus } = await useFetch<ConfigStatus>('/api/config-status')

// Poll so the indicator flips to "up to date" a few seconds after a restart,
// and reflects edits made on other pages, without a manual reload.
let poll: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  poll = setInterval(refreshStatus, 5000)
})
onBeforeUnmount(() => {
  if (poll) clearInterval(poll)
})

const statusLabel = computed(() => {
  const s = status.value
  if (!s || s.upToDate === null) return 'Load state unknown'
  return s.upToDate ? 'Config up to date' : 'Changes pending — restart to apply'
})
const dotClass = computed(() => {
  const s = status.value
  if (!s || s.upToDate === null) return 'bg-white/40'
  return s.upToDate ? 'bg-green-400' : 'bg-amber-400'
})

const toast = useToast()
const open = ref(false)
const restarting = ref(false)

async function confirm() {
  restarting.value = true
  try {
    await $fetch('/api/restart', { method: 'POST' })
    toast.add({
      title: 'Restart triggered',
      description: 'voice-assistant is bouncing and will pick up your changes.',
      color: 'success',
    })
    open.value = false
    refreshStatus()
  }
  catch (e: unknown) {
    toast.add({ title: 'Restart failed', description: errMessage(e), color: 'error' })
  }
  finally {
    restarting.value = false
  }
}
</script>

<template>
  <div v-if="cap?.available">
    <div
      v-if="status"
      class="flex items-center gap-2 px-3 pb-2 text-xs text-white/60"
    >
      <span
        class="inline-block size-2 rounded-full shrink-0"
        :class="dotClass"
      />
      <span>{{ statusLabel }}</span>
    </div>
    <UButton
      block
      color="neutral"
      variant="solid"
      icon="i-lucide-rotate-cw"
      class="bg-white/15 text-white hover:bg-white/25 ring-0 justify-center"
      @click="open = true"
    >
      Apply changes (restart)
    </UButton>

    <UModal
      v-model:open="open"
      title="Restart voice-assistant?"
      description="Settings, prompts and integrations apply on the next start. This bounces the process to pick them up — any in-progress conversation is interrupted for a few seconds."
    >
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            color="neutral"
            variant="ghost"
            @click="open = false"
          >
            Cancel
          </UButton>
          <UButton
            icon="i-lucide-rotate-cw"
            :loading="restarting"
            @click="confirm"
          >
            Restart
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
